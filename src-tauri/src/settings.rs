use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    db::DbState,
    error::{AppError, AppResult},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionLaunchMode {
    Sdk,
    External,
}

pub(crate) fn read_launch_mode(db: &Connection) -> AppResult<SessionLaunchMode> {
    let value: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'session_launch_mode'",
        [],
        |row| row.get(0),
    )?;
    match value.as_str() {
        "sdk" => Ok(SessionLaunchMode::Sdk),
        "external" => Ok(SessionLaunchMode::External),
        _ => Err(AppError::msg("The saved Copilot launch mode is invalid.")),
    }
}

fn write_launch_mode(db: &Connection, mode: SessionLaunchMode) -> AppResult<()> {
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES ('session_launch_mode', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [match mode {
            SessionLaunchMode::Sdk => "sdk",
            SessionLaunchMode::External => "external",
        }],
    )?;
    Ok(())
}

#[tauri::command]
pub fn settings_session_launch_mode(app: AppHandle) -> AppResult<SessionLaunchMode> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    read_launch_mode(&db)
}

#[tauri::command]
pub fn settings_set_session_launch_mode(app: AppHandle, mode: SessionLaunchMode) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    write_launch_mode(&db, mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_mode_roundtrips_and_rejects_invalid_values() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        assert!(read_launch_mode(&db).is_err());
        for mode in [SessionLaunchMode::External, SessionLaunchMode::Sdk] {
            write_launch_mode(&db, mode).unwrap();
            assert_eq!(read_launch_mode(&db).unwrap(), mode);
        }
        db.execute("UPDATE app_settings SET value='invalid'", [])
            .unwrap();
        assert!(read_launch_mode(&db).is_err());
        assert!(serde_json::from_str::<SessionLaunchMode>("\"pty\"").is_err());
    }
}
