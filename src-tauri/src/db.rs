use std::fs;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

const DB_FILE: &str = "devtrees.db";

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS repositories (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        name       TEXT NOT NULL,
        added_at   INTEGER NOT NULL,
        path_key   TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_repositories_added_at ON repositories(added_at);

    CREATE TABLE IF NOT EXISTS tasks (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        status                TEXT NOT NULL
            CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
        repository_id         TEXT NOT NULL,
        repository_name       TEXT NOT NULL,
        repository_path       TEXT NOT NULL,
        worktree_path         TEXT NOT NULL,
        worktree_branch       TEXT,
        pending_worktree_name TEXT,
        copilot_session_id    TEXT,
        queue_status          TEXT NOT NULL DEFAULT 'queued'
            CHECK (queue_status IN ('queued', 'running', 'complete', 'failed')),
        queue_order           INTEGER NOT NULL DEFAULT 0,
        sort_order            INTEGER NOT NULL DEFAULT 0,
        execution_target_key  TEXT NOT NULL DEFAULT '',
        source_provider       TEXT CHECK (source_provider IN ('ado', 'github')),
        source_id             TEXT,
        source_url            TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_sort ON tasks(status, sort_order ASC);

    CREATE TABLE IF NOT EXISTS terminal_sessions (
        id             TEXT PRIMARY KEY,
        task_id        TEXT,
        folder_path    TEXT NOT NULL,
        label          TEXT NOT NULL,
        repository     TEXT,
        branch         TEXT,
        status         TEXT NOT NULL,
        last_activity  TEXT NOT NULL DEFAULT '',
        pending_prompt TEXT,
        cursor         INTEGER NOT NULL DEFAULT 0,
        seq            INTEGER NOT NULL DEFAULT 0,
        managed        INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_task ON terminal_sessions(task_id);

    CREATE TABLE IF NOT EXISTS auto_review_triggers (
        repository_path TEXT COLLATE NOCASE NOT NULL,
        provider        TEXT NOT NULL,
        pull_request_id INTEGER NOT NULL,
        triggered_at    INTEGER NOT NULL,
        PRIMARY KEY (repository_path, provider, pull_request_id)
    );

";

/// The desktop app shares one SQLite connection across its commands.
pub struct DbState(pub Mutex<Connection>);

fn initialize_schema(conn: &Connection) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(SCHEMA)?;
    let columns = {
        let mut statement = tx.prepare("PRAGMA table_info(terminal_sessions)")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        values
    };
    for (name, definition) in [
        ("transport", "TEXT NOT NULL DEFAULT 'external'"),
        ("generation", "TEXT"),
        ("revision", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            tx.execute_batch(&format!(
                "ALTER TABLE terminal_sessions ADD COLUMN {name} {definition};"
            ))?;
        }
    }
    tx.execute("UPDATE terminal_sessions SET transport = 'acp' WHERE managed = 1 AND transport = 'external'", [])?;
    let task_columns = {
        let mut statement = tx.prepare("PRAGMA table_info(tasks)")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        values
    };
    let added_queue_status = !task_columns.iter().any(|column| column == "queue_status");
    let added_queue_order = !task_columns.iter().any(|column| column == "queue_order");
    for (name, definition) in [
        ("queue_status", "TEXT NOT NULL DEFAULT 'queued'"),
        ("queue_order", "INTEGER NOT NULL DEFAULT 0"),
        ("execution_target_key", "TEXT NOT NULL DEFAULT ''"),
        ("source_provider", "TEXT"),
        ("source_id", "TEXT"),
        ("source_url", "TEXT"),
    ] {
        if !task_columns.iter().any(|column| column == name) {
            tx.execute_batch(&format!(
                "ALTER TABLE tasks ADD COLUMN {name} {definition};"
            ))?;
        }
    }
    if added_queue_status {
        tx.execute(
            "UPDATE tasks SET queue_status = CASE
                 WHEN status IN ('todo', 'review') THEN 'queued'
                 ELSE 'complete'
             END",
            [],
        )?;
    }
    if added_queue_order {
        tx.execute("UPDATE tasks SET queue_order = rowid", [])?;
    }
    {
        let mut statement = tx.prepare(
            "SELECT id, repository_id, worktree_path, pending_worktree_name
             FROM tasks WHERE execution_target_key = ''",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (id, repository_id, worktree_path, pending_worktree_name) in rows {
            let key = crate::tasks::execution_target_key(
                &repository_id,
                &worktree_path,
                pending_worktree_name.as_deref(),
            );
            tx.execute(
                "UPDATE tasks SET execution_target_key = ?2 WHERE id = ?1",
                rusqlite::params![id, key],
            )?;
        }
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_running_target
             ON tasks(execution_target_key)
             WHERE queue_status = 'running';",
    )?;
    tx.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source
             ON tasks(source_provider, source_id COLLATE NOCASE)
             WHERE source_provider IS NOT NULL AND source_id IS NOT NULL;",
    )?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );
         INSERT OR IGNORE INTO app_settings (key, value)
             VALUES ('session_launch_mode', 'acp');
         INSERT OR IGNORE INTO app_settings (key, value)
             VALUES ('task_queue_mode', 'manual');
         INSERT OR IGNORE INTO app_settings (key, value)
             VALUES ('task_queue_concurrency', '2');
         UPDATE app_settings SET value = 'acp'
             WHERE key = 'session_launch_mode' AND value = 'sdk';
         UPDATE app_settings SET value = 'external'
             WHERE key = 'session_launch_mode' AND value = 'pty';
         CREATE TABLE IF NOT EXISTS acp_queue_state (
             session_id TEXT PRIMARY KEY,
             payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS acp_transcripts (
             session_id TEXT PRIMARY KEY,
             payload TEXT NOT NULL
         );
         DELETE FROM terminal_sessions WHERE transport IN ('pty', 'external');
         PRAGMA user_version = 7;",
    )?;
    tx.commit()?;
    Ok(())
}

/// Create the initial schema without importing data from previous app prototypes.
pub fn init(data_dir: &Path) -> AppResult<Connection> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| {
        AppError::Message(format!(
            "failed to open database at {}: {e}",
            path.display()
        ))
    })?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    initialize_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_schema_contains_only_current_empty_tables() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);

        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            tables,
            [
                "acp_queue_state",
                "acp_transcripts",
                "app_settings",
                "auto_review_triggers",
                "repositories",
                "tasks",
                "terminal_sessions"
            ]
        );
        for table in tables {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, if table == "app_settings" { 3 } else { 0 });
        }
        let concurrency: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'task_queue_concurrency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(concurrency, "2");
    }

    #[test]
    fn legacy_terminal_watches_are_removed_without_changing_the_setting() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO terminal_sessions
             (id, label, folder_path, status, managed, cursor, seq, created_at, updated_at)
             VALUES ('legacy', 'Old session', 'repo', 'idle', 1, 123, 7, 1, 1);",
        )
        .unwrap();
        initialize_schema(&conn).unwrap();
        let transport: String = conn
            .query_row(
                "SELECT transport FROM terminal_sessions WHERE id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(transport, "acp");
        conn.execute("UPDATE terminal_sessions SET transport='pty', generation='new-process', revision=5 WHERE id='legacy'", []).unwrap();
        initialize_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM terminal_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            crate::settings::read_launch_mode(&conn).unwrap(),
            crate::settings::SessionLaunchMode::Acp
        );
        conn.execute("UPDATE app_settings SET value='sdk'", [])
            .unwrap();
        initialize_schema(&conn).unwrap();
        assert_eq!(
            crate::settings::read_launch_mode(&conn).unwrap(),
            crate::settings::SessionLaunchMode::Acp
        );
        conn.execute("UPDATE app_settings SET value='pty'", [])
            .unwrap();
        initialize_schema(&conn).unwrap();
        assert_eq!(
            crate::settings::read_launch_mode(&conn).unwrap(),
            crate::settings::SessionLaunchMode::External
        );
    }

    #[test]
    fn reopening_preserves_repositories_tasks_and_managed_sessions() {
        let data_dir = std::env::temp_dir().join(format!("devtrees-db-{}", uuid::Uuid::new_v4()));
        let conn = init(&data_dir).unwrap();
        conn.execute_batch(
            "INSERT INTO repositories (id, path, name, added_at, path_key)
             VALUES ('repo', 'repo', 'Repo', 1, 'repo');
             INSERT INTO tasks
                (id, title, status, repository_id, repository_name, repository_path,
                 worktree_path, pending_worktree_name, copilot_session_id, created_at, updated_at)
             VALUES ('task', 'Task', 'todo', 'repo', 'Repo', 'repo',
                     'repo', 'planned', 'session', 1, 1);
             INSERT INTO terminal_sessions
                (id, task_id, folder_path, label, status, cursor, seq, managed, created_at, updated_at)
             VALUES ('session', 'task', 'repo', 'Session', 'idle', 123, 7, 1, 1, 1);
             INSERT INTO auto_review_triggers
                (repository_path, provider, pull_request_id, triggered_at)
             VALUES ('repo', 'github', 42, 1);",
        )
        .unwrap();
        conn.execute("UPDATE app_settings SET value='sdk'", [])
            .unwrap();
        conn.close().unwrap();

        let conn = init(&data_dir).unwrap();
        assert_eq!(
            crate::settings::read_launch_mode(&conn).unwrap(),
            crate::settings::SessionLaunchMode::Acp
        );
        let repository: (String, i64) = conn
            .query_row("SELECT name, sort_order FROM repositories", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(repository, ("Repo".into(), 0));

        let task: (String, String, String, i64, String, String) = conn
            .query_row(
                "SELECT copilot_session_id, pending_worktree_name, description, sort_order,
                        queue_status, execution_target_key
                 FROM tasks",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            task,
            (
                "session".into(),
                "planned".into(),
                "".into(),
                0,
                "queued".into(),
                crate::tasks::execution_target_key("repo", "repo", Some("planned"))
            )
        );

        let session: (String, i64, i64, i64) = conn
            .query_row(
                "SELECT task_id, managed, cursor, seq FROM terminal_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(session, ("task".into(), 1, 123, 7));
        let review_trigger: (String, String, i64) = conn
            .query_row(
                "SELECT repository_path, provider, pull_request_id FROM auto_review_triggers",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(review_trigger, ("repo".into(), "github".into(), 42));
        conn.close().unwrap();
        fs::remove_file(data_dir.join(DB_FILE)).unwrap();
        fs::remove_dir(data_dir).unwrap();
    }

    #[test]
    fn task_sources_are_nullable_and_unique() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let insert = |id: &str, source_id: Option<&str>| {
            conn.execute(
                "INSERT INTO tasks
                    (id, title, status, repository_id, repository_name, repository_path,
                     worktree_path, source_provider, source_id, source_url, created_at, updated_at)
                 VALUES (?1, 'Task', 'todo', 'repo', 'Repo', 'repo', 'repo',
                         CASE WHEN ?2 IS NULL THEN NULL ELSE 'github' END,
                         ?2,
                         CASE WHEN ?2 IS NULL THEN NULL ELSE 'https://example.test/item' END,
                         1, 1)",
                rusqlite::params![id, source_id],
            )
        };
        insert("manual-one", None).unwrap();
        insert("manual-two", None).unwrap();
        insert("imported", Some("owner/repo#1")).unwrap();
        assert!(insert("duplicate", Some("owner/repo#1")).is_err());
    }

    #[test]
    fn existing_tasks_receive_execution_target_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO tasks
                (id, title, status, repository_id, repository_name, repository_path,
                 worktree_path, pending_worktree_name, created_at, updated_at)
             VALUES ('task', 'Task', 'todo', 'Repo-ID', 'Repo', 'C:\\Repo',
                     'C:\\Repo', 'Feature-One', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE tasks SET execution_target_key = ''", [])
            .unwrap();

        initialize_schema(&conn).unwrap();

        let key: String = conn
            .query_row(
                "SELECT execution_target_key FROM tasks WHERE id = 'task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            key,
            crate::tasks::execution_target_key("Repo-ID", "C:\\Repo", Some("Feature-One"))
        );
    }
}
