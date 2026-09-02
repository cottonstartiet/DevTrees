use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::paths::legacy_user_data_dir;

const DB_FILE: &str = "devtrees.db";
const LEGACY_JSON_FILE: &str = "workspaces.json";

/// Tauri-managed application state wrapping the single SQLite connection. The
/// Electron build used a `better-sqlite3` singleton; here we serialize access with
/// a mutex (rusqlite operations are short and synchronous).
pub struct DbState(pub Mutex<Connection>);

fn db_path() -> AppResult<PathBuf> {
    let dir = legacy_user_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(DB_FILE))
}

type Migration = fn(&Connection) -> rusqlite::Result<()>;

/// Schema migrations, ported 1:1 from the Electron `db.ts`. The slot index drives
/// `PRAGMA user_version`, so order and count must never change for existing DBs.
fn migrations() -> Vec<Migration> {
    vec![
        // 0001 -> user_version 1: workspaces table.
        |db| {
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (
                    id        TEXT PRIMARY KEY,
                    path      TEXT NOT NULL,
                    name      TEXT NOT NULL,
                    added_at  INTEGER NOT NULL,
                    path_key  TEXT NOT NULL UNIQUE
                 );
                 CREATE INDEX IF NOT EXISTS idx_workspaces_added_at ON workspaces(added_at);",
            )
        },
        // 0002 -> user_version 2: pinned worktree notes (later removed).
        |db| {
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS worktree_notes (
                    path_key   TEXT PRIMARY KEY,
                    path       TEXT NOT NULL,
                    note       TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );",
            )
        },
        // 0003 -> user_version 3: drop the now-orphaned notes table.
        |db| db.execute_batch("DROP TABLE IF EXISTS worktree_notes;"),
        // 0004 -> user_version 4: per-workspace custom sort order. Backfill from
        // added_at so existing rows keep their current (time-based) ordering.
        |db| {
            db.execute_batch(
                "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                 UPDATE workspaces SET sort_order = added_at;",
            )
        },
        // 0005 -> user_version 5: rename the `workspaces` table to `repositories`.
        // Every prior version (0..=4) reaches this slot with a `workspaces` table and
        // no `repositories` table, so an unconditional rename is safe for all of them.
        |db| {
            db.execute_batch(
                "ALTER TABLE workspaces RENAME TO repositories;
                 DROP INDEX IF EXISTS idx_workspaces_added_at;
                 CREATE INDEX IF NOT EXISTS idx_repositories_added_at ON repositories(added_at);",
            )
        },
        // 0006 -> user_version 6: persistent SDK chat conversations and messages.
        |db| {
            db.execute_batch(
                "CREATE TABLE chat_conversations (
                    id               TEXT PRIMARY KEY,
                    title            TEXT NOT NULL,
                    sdk_session_id   TEXT,
                    context_kind     TEXT CHECK (context_kind IN ('repository', 'worktree')),
                    context_id       TEXT,
                    context_name     TEXT,
                    context_path     TEXT,
                    created_at       INTEGER NOT NULL,
                    updated_at       INTEGER NOT NULL
                 );
                 CREATE INDEX idx_chat_conversations_updated_at
                   ON chat_conversations(updated_at DESC);
                 CREATE TABLE chat_messages (
                    id               TEXT PRIMARY KEY,
                    conversation_id  TEXT NOT NULL
                      REFERENCES chat_conversations(id) ON DELETE CASCADE,
                    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content          TEXT NOT NULL,
                    status           TEXT NOT NULL
                      CHECK (status IN ('streaming', 'completed', 'error')),
                    error            TEXT,
                    created_at       INTEGER NOT NULL
                 );
                 CREATE INDEX idx_chat_messages_conversation
                   ON chat_messages(conversation_id, created_at ASC);",
            )
        },
        // 0007 -> user_version 7: durable Copilot SDK harness sessions and events.
        |db| {
            db.execute_batch(
                "CREATE TABLE agent_sessions (
                   id               TEXT PRIMARY KEY,
                   sdk_session_id   TEXT UNIQUE,
                   purpose          TEXT NOT NULL
                     CHECK (purpose IN ('pr_review', 'interactive')),
                   label            TEXT NOT NULL,
                   folder_path      TEXT NOT NULL,
                   branch           TEXT,
                   repository       TEXT,
                   provider         TEXT,
                   pr_id            TEXT,
                   pr_title         TEXT,
                   lifecycle        TEXT NOT NULL
                     CHECK (lifecycle IN (
                       'initializing', 'active', 'idle', 'waiting_for_user',
                       'waiting_for_permission', 'failed', 'stopped'
                     )),
                   activity         TEXT NOT NULL
                     CHECK (activity IN (
                       'none', 'intent', 'reasoning', 'streaming_message', 'running_tool'
                     )),
                   current_intent   TEXT,
                   last_error       TEXT,
                   created_at       INTEGER NOT NULL,
                   updated_at       INTEGER NOT NULL,
                   completed_at     INTEGER,
                   last_seq         INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX idx_agent_sessions_updated_at
                   ON agent_sessions(updated_at DESC);
                 CREATE INDEX idx_agent_sessions_pr
                   ON agent_sessions(provider, repository, pr_id);

                 CREATE TABLE agent_session_events (
                   event_id         TEXT PRIMARY KEY,
                   session_id       TEXT NOT NULL
                     REFERENCES agent_sessions(id) ON DELETE CASCADE,
                   seq              INTEGER NOT NULL,
                   event_type       TEXT NOT NULL,
                   parent_id        TEXT,
                   agent_id         TEXT,
                   ephemeral        INTEGER NOT NULL DEFAULT 0,
                   data_json        TEXT NOT NULL,
                   timestamp        TEXT NOT NULL,
                   created_at       INTEGER NOT NULL,
                   UNIQUE(session_id, seq)
                 );
                 CREATE INDEX idx_agent_session_events_session
                   ON agent_session_events(session_id, seq ASC);

                 CREATE TABLE agent_pending_interactions (
                   id               TEXT PRIMARY KEY,
                   session_id       TEXT NOT NULL
                     REFERENCES agent_sessions(id) ON DELETE CASCADE,
                   kind             TEXT NOT NULL
                     CHECK (kind IN ('permission', 'user_input')),
                   request_id       TEXT NOT NULL,
                   payload_json     TEXT NOT NULL,
                   created_at       INTEGER NOT NULL,
                   UNIQUE(session_id, request_id)
                 );
                 CREATE INDEX idx_agent_pending_interactions_session
                   ON agent_pending_interactions(session_id, created_at ASC);",
            )
        },
    ]
}

fn run_migrations(db: &Connection) -> AppResult<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let migs = migrations();
    let start = version.max(0) as usize;
    for (i, migrate) in migs.iter().enumerate().skip(start) {
        // Each migration + its version bump runs in one transaction, matching the
        // Electron behavior so a partial failure can't leave a half-applied schema.
        let tx = db.unchecked_transaction()?;
        migrate(db)?;
        db.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }

    Ok(())
}

fn recover_interrupted_chat_messages(db: &Connection) -> AppResult<()> {
    db.execute(
        "UPDATE chat_messages
         SET status = 'error', error = 'Response was interrupted when DevTrees closed.'
         WHERE status = 'streaming'",
        [],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn recover_interrupted_agent_sessions(db: &Connection) -> AppResult<()> {
    let recovered_at = now_ms();
    db.execute(
        "UPDATE agent_sessions
         SET lifecycle = 'idle', activity = 'none', current_intent = NULL,
             updated_at = ?1
         WHERE purpose = 'interactive'
           AND lifecycle IN (
             'initializing', 'active', 'waiting_for_user', 'waiting_for_permission'
           )",
        [recovered_at],
    )?;
    db.execute(
        "UPDATE agent_sessions
         SET lifecycle = 'failed', activity = 'none', current_intent = NULL,
             last_error = 'Review was interrupted when DevTrees closed.',
             updated_at = ?1, completed_at = ?1
         WHERE purpose = 'pr_review'
           AND lifecycle IN (
             'initializing', 'active', 'waiting_for_user', 'waiting_for_permission'
           )",
        [recovered_at],
    )?;
    db.execute("DELETE FROM agent_pending_interactions", [])?;
    Ok(())
}

#[derive(Deserialize)]
struct LegacyWorkspace {
    id: String,
    path: String,
    name: String,
    #[serde(rename = "addedAt")]
    added_at: i64,
}

/// One-time import of the pre-SQLite `workspaces.json`, mirroring `db.ts`. Only runs
/// when the file exists and the workspaces table is empty, then renames the file so
/// it is never imported twice.
fn import_legacy_json(db: &Connection) -> AppResult<()> {
    let dir = legacy_user_data_dir()?;
    let json_file = dir.join(LEGACY_JSON_FILE);
    if !json_file.exists() {
        return Ok(());
    }

    let count: i64 = db.query_row("SELECT COUNT(*) AS n FROM repositories", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }

    let raw = match fs::read_to_string(&json_file) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[db] could not read legacy workspaces.json: {e}");
            return Ok(());
        }
    };
    let parsed: Vec<LegacyWorkspace> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[db] legacy workspaces.json parse failed: {e}");
            return Ok(());
        }
    };

    {
        let tx = db.unchecked_transaction()?;
        let mut stmt = db.prepare(
            "INSERT OR IGNORE INTO repositories (id, path, name, added_at, path_key)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for w in &parsed {
            let path_key = if cfg!(windows) {
                w.path.to_lowercase()
            } else {
                w.path.clone()
            };
            stmt.execute(rusqlite::params![
                w.id, w.path, w.name, w.added_at, path_key
            ])?;
        }
        drop(stmt);
        tx.commit()?;
    }

    if let Err(e) = fs::rename(&json_file, json_file.with_extension("json.migrated")) {
        eprintln!("[db] could not rename legacy workspaces.json: {e}");
    }
    Ok(())
}

/// Open (creating if needed) the workspaces database, apply migrations, and run the
/// one-time legacy JSON import. Returns a ready-to-use connection.
pub fn init() -> AppResult<Connection> {
    let path = db_path()?;
    let conn = Connection::open(&path).map_err(|e| {
        AppError::Message(format!(
            "failed to open database at {}: {e}",
            path.display()
        ))
    })?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    run_migrations(&conn)?;
    recover_interrupted_chat_messages(&conn)?;
    recover_interrupted_agent_sessions(&conn)?;
    import_legacy_json(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_create_chat_schema_and_recover_streams() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        run_migrations(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);

        conn.execute(
            "INSERT INTO chat_conversations
               (id, title, created_at, updated_at)
             VALUES ('conversation', 'Test', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages
               (id, conversation_id, role, content, status, created_at)
             VALUES ('message', 'conversation', 'assistant', '', 'streaming', 1)",
            [],
        )
        .unwrap();

        recover_interrupted_chat_messages(&conn).unwrap();
        let (status, error): (String, String) = conn
            .query_row(
                "SELECT status, error FROM chat_messages WHERE id = 'message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "error");
        assert_eq!(error, "Response was interrupted when DevTrees closed.");

        conn.execute(
            "INSERT INTO agent_sessions
               (id, purpose, label, folder_path, lifecycle, activity, created_at, updated_at)
             VALUES ('agent', 'interactive', 'Agent', 'C:\\repo', 'active', 'running_tool', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_sessions
               (id, purpose, label, folder_path, lifecycle, activity, created_at, updated_at)
             VALUES ('review', 'pr_review', 'Review', 'C:\\repo', 'active', 'running_tool', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_pending_interactions
               (id, session_id, kind, request_id, payload_json, created_at)
             VALUES ('interaction', 'agent', 'permission', 'request', '{}', 1)",
            [],
        )
        .unwrap();

        recover_interrupted_agent_sessions(&conn).unwrap();
        let (lifecycle, activity): (String, String) = conn
            .query_row(
                "SELECT lifecycle, activity FROM agent_sessions WHERE id = 'agent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(lifecycle, "idle");
        assert_eq!(activity, "none");
        let (lifecycle, error, completed_at): (String, String, i64) = conn
            .query_row(
                "SELECT lifecycle, last_error, completed_at
                 FROM agent_sessions WHERE id = 'review'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(lifecycle, "failed");
        assert_eq!(error, "Review was interrupted when DevTrees closed.");
        assert!(completed_at > 1);
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_pending_interactions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0);
    }
}
