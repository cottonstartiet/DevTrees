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
    #[serde(alias = "sdk")]
    Acp,
    External,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskQueueMode {
    Automatic,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueSettings {
    pub mode: TaskQueueMode,
    pub concurrency: u8,
}

pub(crate) fn read_launch_mode(db: &Connection) -> AppResult<SessionLaunchMode> {
    let value: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'session_launch_mode'",
        [],
        |row| row.get(0),
    )?;
    match value.as_str() {
        "acp" => Ok(SessionLaunchMode::Acp),
        "sdk" => Ok(SessionLaunchMode::Acp),
        "external" => Ok(SessionLaunchMode::External),
        _ => Err(AppError::msg("The saved Copilot launch mode is invalid.")),
    }
}

fn write_launch_mode(db: &Connection, mode: SessionLaunchMode) -> AppResult<()> {
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES ('session_launch_mode', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [match mode {
            SessionLaunchMode::Acp => "acp",
            SessionLaunchMode::External => "external",
        }],
    )?;
    Ok(())
}

pub(crate) fn read_task_queue_settings(db: &Connection) -> AppResult<TaskQueueSettings> {
    let mode: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'task_queue_mode'",
        [],
        |row| row.get(0),
    )?;
    let concurrency: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'task_queue_concurrency'",
        [],
        |row| row.get(0),
    )?;
    let mode = match mode.as_str() {
        "automatic" => TaskQueueMode::Automatic,
        "manual" => TaskQueueMode::Manual,
        _ => return Err(AppError::msg("The saved task queue mode is invalid.")),
    };
    let concurrency = concurrency
        .parse::<u8>()
        .ok()
        .filter(|value| (1..=10).contains(value))
        .ok_or_else(|| AppError::msg("The saved task queue concurrency is invalid."))?;
    Ok(TaskQueueSettings { mode, concurrency })
}

fn write_task_queue_settings(db: &Connection, settings: TaskQueueSettings) -> AppResult<()> {
    if !(1..=10).contains(&settings.concurrency) {
        return Err(AppError::msg(
            "Task queue concurrency must be between 1 and 10.",
        ));
    }
    let tx = db.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES ('task_queue_mode', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [match settings.mode {
            TaskQueueMode::Automatic => "automatic",
            TaskQueueMode::Manual => "manual",
        }],
    )?;
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES ('task_queue_concurrency', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [settings.concurrency.to_string()],
    )?;
    tx.commit()?;
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

#[tauri::command]
pub fn settings_task_queue(app: AppHandle) -> AppResult<TaskQueueSettings> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    read_task_queue_settings(&db)
}

#[tauri::command]
pub fn settings_set_task_queue(app: AppHandle, settings: TaskQueueSettings) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    write_task_queue_settings(&db, settings)
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
        for mode in [SessionLaunchMode::External, SessionLaunchMode::Acp] {
            write_launch_mode(&db, mode).unwrap();
            assert_eq!(read_launch_mode(&db).unwrap(), mode);
        }
        db.execute("UPDATE app_settings SET value='invalid'", [])
            .unwrap();
        assert!(read_launch_mode(&db).is_err());
        assert!(serde_json::from_str::<SessionLaunchMode>("\"pty\"").is_err());
    }

    #[test]
    fn task_queue_settings_roundtrip_and_validate_concurrency() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        write_task_queue_settings(
            &db,
            TaskQueueSettings {
                mode: TaskQueueMode::Automatic,
                concurrency: 2,
            },
        )
        .unwrap();
        assert_eq!(
            read_task_queue_settings(&db).unwrap(),
            TaskQueueSettings {
                mode: TaskQueueMode::Automatic,
                concurrency: 2,
            }
        );
        assert!(write_task_queue_settings(
            &db,
            TaskQueueSettings {
                mode: TaskQueueMode::Manual,
                concurrency: 0,
            },
        )
        .is_err());
    }
}
