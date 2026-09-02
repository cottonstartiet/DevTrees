use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

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
        assert_eq!(version, 6);

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
    }
}
