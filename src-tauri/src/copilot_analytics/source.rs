use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection};

const MAX_ROWS: usize = 200_000;
pub const PROMPT_LIMIT: usize = 5_000;

pub struct Turn {
    pub session: String,
    pub index: i64,
    pub timestamp: i64,
    pub date: String,
    pub weekday: usize,
    pub hour: usize,
    pub prompt: String,
    pub truncated: bool,
}

pub struct Usage {
    pub session: String,
    pub timestamp: i64,
    pub date: String,
    pub model: String,
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost: Option<i64>,
    pub duration: Option<f64>,
    pub ttft: Option<f64>,
}

pub struct FileActivity {
    pub session: String,
    pub timestamp: i64,
    pub path: String,
    pub tool: String,
}

pub struct Data {
    pub window: i64,
    pub start: i64,
    pub dates: Vec<String>,
    pub previous_dates: Vec<String>,
    pub calculated_at: String,
    pub repository: Option<String>,
    pub repositories: Vec<String>,
    pub session_repos: HashMap<String, String>,
    pub turns: Vec<Turn>,
    pub usage: Vec<Usage>,
    pub files: Vec<FileActivity>,
    pub usage_available: bool,
    pub files_available: bool,
    pub prompts_available: bool,
    pub warnings: Vec<String>,
    pub first_turns: HashMap<String, i64>,
    pub session_sources: HashMap<String, String>,
    pub source: String,
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<BTreeSet<String>> {
    // Table identifiers only come from literals in this module.
    conn.prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get(1))?
        .collect()
}

fn optional(cols: &BTreeSet<String>, name: &str, fallback: &str) -> String {
    if cols.contains(name) {
        name.into()
    } else {
        fallback.into()
    }
}

fn require(cols: &BTreeSet<String>, table: &str, names: &[&str]) -> rusqlite::Result<()> {
    for name in names {
        if !cols.contains(*name) {
            return Err(rusqlite::Error::InvalidColumnName(format!(
                "{table}.{name} is unavailable in this Copilot store"
            )));
        }
    }
    Ok(())
}

fn bounded(count: usize) -> rusqlite::Result<()> {
    if count > MAX_ROWS {
        return Err(rusqlite::Error::InvalidParameterName(
            "Too much history for one report; select fewer days or one repository.".into(),
        ));
    }
    Ok(())
}

pub fn load(
    conn: &Connection,
    window: i64,
    repository: Option<&str>,
    now: &str,
) -> rusqlite::Result<Data> {
    let session_cols = columns(conn, "sessions")?;
    let turn_cols = columns(conn, "turns")?;
    let usage_cols = columns(conn, "assistant_usage_events")?;
    let file_cols = columns(conn, "session_files")?;
    require(&session_cols, "sessions", &["id"])?;
    require(
        &turn_cols,
        "turns",
        &["session_id", "timestamp", "turn_index"],
    )?;
    let repo_expr = format!(
        "COALESCE(NULLIF({}, ''), NULLIF({}, ''), 'Unassigned')",
        optional(&session_cols, "repository", "NULL"),
        optional(&session_cols, "cwd", "NULL")
    );
    let mut session_repos: HashMap<String, String> = conn
        .prepare(&format!("SELECT id, {repo_expr} FROM sessions"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let repo_aliases = repository_aliases(conn, &session_cols)?;
    for repo in session_repos.values_mut() {
        if let Some(canonical) = repo_aliases.get(&path_key(repo)) {
            *repo = canonical.clone();
        }
    }
    let (start, previous_start, end, calculated_at): (i64, i64, i64, String) = conn.query_row(
        "SELECT unixepoch(?1, 'localtime', 'start of day', ?2, 'utc'),
                unixepoch(?1, 'localtime', 'start of day', ?3, 'utc'),
                unixepoch(?1) + 1, strftime('%Y-%m-%dT%H:%M:%SZ', ?1)",
        params![
            now,
            format!("-{} days", window - 1),
            format!("-{} days", window * 2 - 1)
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let dates = conn
        .prepare(
            "WITH RECURSIVE days(d, n) AS (
                SELECT date(?1, 'unixepoch', 'localtime'), 1
                UNION ALL SELECT date(d, '+1 day'), n + 1 FROM days WHERE n < ?2
             ) SELECT d FROM days",
        )?
        .query_map(params![start, window], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    let previous_dates = conn
        .prepare(
            "WITH RECURSIVE days(d, n) AS (
                SELECT date(?1, 'unixepoch', 'localtime'), 1
                UNION ALL SELECT date(d, '+1 day'), n + 1 FROM days WHERE n < ?2
             ) SELECT d FROM days",
        )?
        .query_map(params![previous_start, window], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    let usage_available = !usage_cols.is_empty();
    let files_available = !file_cols.is_empty();
    let prompts_available = turn_cols.contains("user_message");
    let mut warnings = Vec::new();
    if !usage_available {
        warnings.push(
            "This store has no model-usage table. Credits, tokens and latency are unavailable."
                .into(),
        );
    }
    if !files_available {
        warnings.push("This store has no file-activity table.".into());
    }
    if !prompts_available {
        warnings
            .push("Prompt content is unavailable; prompt coaching cannot be calculated.".into());
    }
    let mut repositories = BTreeSet::new();
    let matches = |id: &str| {
        repository.is_none_or(|repo| {
            session_repos
                .get(id)
                .map(String::as_str)
                .unwrap_or("Unassigned")
                == repo
        })
    };
    let mut turns = Vec::new();
    let prompt = optional(&turn_cols, "user_message", "NULL");
    let mut stmt = conn.prepare(&format!(
        "SELECT session_id, turn_index, unixepoch(timestamp),
                date(timestamp, 'localtime'), strftime('%w', timestamp, 'localtime'),
                strftime('%H', timestamp, 'localtime'), substr({prompt}, 1, 8001)
         FROM turns WHERE julianday(timestamp) >= julianday(?1, 'unixepoch')
         AND julianday(timestamp) < julianday(?2, 'unixepoch')
         ORDER BY julianday(timestamp) DESC, session_id, turn_index"
    ))?;
    let mut rows = stmt.query(params![previous_start, end])?;
    let mut prompt_count = 0;
    while let Some(row) = rows.next()? {
        let session: String = row.get(0)?;
        repositories.insert(
            session_repos
                .get(&session)
                .cloned()
                .unwrap_or("Unassigned".into()),
        );
        if !matches(&session) {
            continue;
        }
        let timestamp = row.get(2)?;
        let raw: Option<String> = if timestamp >= start && prompt_count < PROMPT_LIMIT {
            prompt_count += 1;
            row.get(6)?
        } else {
            None
        };
        let raw = raw.unwrap_or_default();
        let truncated = raw.chars().count() > 8_000;
        turns.push(Turn {
            session,
            index: row.get(1)?,
            timestamp,
            date: row.get(3)?,
            weekday: row
                .get::<_, String>(4)?
                .parse()
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
            hour: row
                .get::<_, String>(5)?
                .parse()
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
            prompt: raw.chars().take(8_000).collect(),
            truncated,
        });
        bounded(turns.len())?;
    }
    // A session continuing from before the window must not be classified as a new task start.
    let first_turns = conn
        .prepare("SELECT session_id, MIN(turn_index) FROM turns GROUP BY session_id")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<String, i64>>>()?;
    let mut usage = Vec::new();
    if usage_available {
        require(
            &usage_cols,
            "assistant_usage_events",
            &["session_id", "created_at"],
        )?;
        for field in [
            "input_tokens",
            "output_tokens",
            "total_nano_aiu",
            "duration_ms",
            "time_to_first_token_ms",
            "cache_read_tokens",
            "cache_write_tokens",
        ] {
            if !usage_cols.contains(field) {
                warnings.push(format!(
                    "Model-usage field {field} is unavailable in this store."
                ));
            }
        }
        let fields = [
            ("model", "'Unknown'"),
            ("input_tokens", "NULL"),
            ("output_tokens", "NULL"),
            ("cache_read_tokens", "0"),
            ("cache_write_tokens", "0"),
            ("total_nano_aiu", "NULL"),
            ("duration_ms", "NULL"),
            ("time_to_first_token_ms", "NULL"),
        ]
        .map(|(name, fallback)| optional(&usage_cols, name, fallback))
        .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT session_id, unixepoch(created_at), date(created_at, 'localtime'), {fields}
             FROM assistant_usage_events WHERE julianday(created_at) >= julianday(?1, 'unixepoch')
             AND julianday(created_at) < julianday(?2, 'unixepoch')"
        ))?;
        let mut rows = stmt.query(params![previous_start, end])?;
        while let Some(row) = rows.next()? {
            let session: String = row.get(0)?;
            repositories.insert(
                session_repos
                    .get(&session)
                    .cloned()
                    .unwrap_or("Unassigned".into()),
            );
            if !matches(&session) {
                continue;
            }
            usage.push(Usage {
                session,
                timestamp: row.get(1)?,
                date: row.get(2)?,
                model: row
                    .get::<_, Option<String>>(3)?
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Unknown".into()),
                input: row.get::<_, Option<i64>>(4)?.filter(|n| *n >= 0),
                output: row.get::<_, Option<i64>>(5)?.filter(|n| *n >= 0),
                cache_read: row.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0),
                cache_write: row.get::<_, Option<i64>>(7)?.unwrap_or(0).max(0),
                cost: row.get::<_, Option<i64>>(8)?.filter(|n| *n >= 0),
                duration: row
                    .get::<_, Option<f64>>(9)?
                    .filter(|n| n.is_finite() && *n >= 0.0),
                ttft: row
                    .get::<_, Option<f64>>(10)?
                    .filter(|n| n.is_finite() && *n >= 0.0),
            });
            bounded(usage.len())?;
        }
    }
    let mut files = Vec::new();
    if files_available {
        require(
            &file_cols,
            "session_files",
            &["session_id", "first_seen_at", "file_path", "tool_name"],
        )?;
        let mut stmt = conn.prepare(
            "SELECT session_id, unixepoch(first_seen_at), file_path, tool_name FROM session_files
             WHERE julianday(first_seen_at) >= julianday(?1, 'unixepoch')
             AND julianday(first_seen_at) < julianday(?2, 'unixepoch')
             AND tool_name IN ('create', 'edit')",
        )?;
        let mut rows = stmt.query(params![previous_start, end])?;
        while let Some(row) = rows.next()? {
            let session: String = row.get(0)?;
            if !matches(&session) {
                continue;
            }
            files.push(FileActivity {
                session,
                timestamp: row.get(1)?,
                path: row.get(2)?,
                tool: row.get(3)?,
            });
            bounded(files.len())?;
        }
    }
    let session_sources = session_repos
        .keys()
        .map(|id| (id.clone(), "cli".into()))
        .collect();
    Ok(Data {
        window,
        start,
        dates,
        previous_dates,
        calculated_at,
        repository: repository.map(String::from),
        repositories: repositories.into_iter().collect(),
        session_repos,
        turns,
        usage,
        files,
        usage_available,
        files_available,
        prompts_available,
        warnings,
        first_turns,
        session_sources,
        source: "cli".into(),
    })
}

fn repository_aliases(
    conn: &Connection,
    session_cols: &BTreeSet<String>,
) -> rusqlite::Result<HashMap<String, String>> {
    let mut repo_aliases = HashMap::new();
    if session_cols.contains("cwd") && session_cols.contains("repository") {
        let mut ambiguous = BTreeSet::new();
        let mut stmt = conn.prepare("SELECT DISTINCT cwd, repository FROM sessions WHERE cwd IS NOT NULL AND cwd != '' AND repository IS NOT NULL AND repository != ''")?;
        for row in stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (path, repo) = row?;
            let path = path_key(&path);
            if repo_aliases.get(&path).is_some_and(|other| other != &repo) {
                ambiguous.insert(path.clone());
            }
            repo_aliases.insert(path, repo);
        }
        for key in ambiguous {
            repo_aliases.remove(&key);
        }
    }
    Ok(repo_aliases)
}

pub fn empty_store() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, repository TEXT, cwd TEXT);
         CREATE TABLE turns(session_id TEXT, turn_index INTEGER, timestamp TEXT, user_message TEXT);
         CREATE TABLE assistant_usage_events(session_id TEXT, created_at TEXT, model TEXT,
           input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
           cache_write_tokens INTEGER, total_nano_aiu INTEGER, duration_ms REAL,
           time_to_first_token_ms REAL);
         CREATE TABLE session_files(session_id TEXT, first_seen_at TEXT, file_path TEXT, tool_name TEXT);"
    )?;
    Ok(conn)
}

fn path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}
