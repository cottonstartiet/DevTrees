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

    let count: i64 = db.query_row("SELECT COUNT(*) AS n FROM workspaces", [], |r| r.get(0))?;
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
            "INSERT OR IGNORE INTO workspaces (id, path, name, added_at, path_key)
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
    import_legacy_json(&conn)?;
    Ok(conn)
}
