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
        sort_order            INTEGER NOT NULL DEFAULT 0,
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

    PRAGMA user_version = 1;
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
    tx.execute_batch("PRAGMA user_version = 2;")?;
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
        assert_eq!(version, 2);

        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(tables, ["repositories", "tasks", "terminal_sessions"]);
        for table in tables {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn version_one_sessions_migrate_without_converting_pty_records_on_reopen() {
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
        let record: (String, String, i64, i64, i64) = conn.query_row(
            "SELECT transport, generation, revision, cursor, seq FROM terminal_sessions WHERE id='legacy'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        ).unwrap();
        assert_eq!(record, ("pty".into(), "new-process".into(), 5, 123, 7));
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
             VALUES ('session', 'task', 'repo', 'Session', 'idle', 123, 7, 1, 1, 1);",
        )
        .unwrap();
        conn.close().unwrap();

        let conn = init(&data_dir).unwrap();
        let repository: (String, i64) = conn
            .query_row("SELECT name, sort_order FROM repositories", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(repository, ("Repo".into(), 0));

        let task: (String, String, String, i64) = conn
            .query_row(
                "SELECT copilot_session_id, pending_worktree_name, description, sort_order FROM tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(task, ("session".into(), "planned".into(), "".into(), 0));

        let session: (String, i64, i64, i64) = conn
            .query_row(
                "SELECT task_id, managed, cursor, seq FROM terminal_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(session, ("task".into(), 1, 123, 7));
        conn.close().unwrap();
        fs::remove_file(data_dir.join(DB_FILE)).unwrap();
        fs::remove_dir(data_dir).unwrap();
    }
}
