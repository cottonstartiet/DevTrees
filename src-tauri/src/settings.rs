use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
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
#[serde(rename_all = "kebab-case")]
pub enum CopilotPermissionProfile {
    Default,
    AllowAll,
}

impl CopilotPermissionProfile {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AllowAll => "allow-all",
        }
    }
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    pub id: String,
    pub name: String,
    pub details: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_saved_prompt<'a>(name: &'a str, details: &'a str) -> AppResult<(&'a str, &'a str)> {
    let name = name.trim();
    let details = details.trim();
    if name.is_empty() {
        return Err(AppError::msg("Prompt name is required."));
    }
    if name.chars().count() > 80 {
        return Err(AppError::msg("Prompt name must be 80 characters or fewer."));
    }
    if details.is_empty() {
        return Err(AppError::msg("Prompt details are required."));
    }
    if details.chars().count() > 32_000 {
        return Err(AppError::msg(
            "Prompt details must be 32,000 characters or fewer.",
        ));
    }
    Ok((name, details))
}

fn row_to_saved_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedPrompt> {
    Ok(SavedPrompt {
        id: row.get(0)?,
        name: row.get(1)?,
        details: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn load_saved_prompt(db: &Connection, id: &str) -> AppResult<Option<SavedPrompt>> {
    use rusqlite::OptionalExtension;
    Ok(db
        .query_row(
            "SELECT id, name, details, created_at, updated_at FROM saved_prompts WHERE id = ?1",
            [id],
            row_to_saved_prompt,
        )
        .optional()?)
}

fn saved_prompt_db_error(error: rusqlite::Error) -> AppError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(ref code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    ) {
        AppError::msg("A saved prompt with that name already exists.")
    } else {
        error.into()
    }
}

fn validate_browser_prompt_details(details: &str) -> AppResult<()> {
    static PLACEHOLDER: OnceLock<regex::Regex> = OnceLock::new();
    let placeholder = PLACEHOLDER.get_or_init(|| {
        regex::Regex::new(r"\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}")
            .expect("browser prompt placeholder regex")
    });
    let unknown = placeholder
        .captures_iter(details)
        .filter_map(|captures| captures.get(1).map(|value| value.as_str()))
        .find(|name| !matches!(*name, "url" | "pageTitle" | "host"));
    if let Some(name) = unknown {
        return Err(AppError::msg(format!(
            "Unsupported browser-review placeholder: {name}."
        )));
    }
    Ok(())
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

pub(crate) fn read_permission_profile(db: &Connection) -> AppResult<CopilotPermissionProfile> {
    let value: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'copilot_permission_profile'",
        [],
        |row| row.get(0),
    )?;
    match value.as_str() {
        "default" => Ok(CopilotPermissionProfile::Default),
        "allow-all" => Ok(CopilotPermissionProfile::AllowAll),
        _ => Err(AppError::msg(
            "The saved Copilot permission profile is invalid.",
        )),
    }
}

fn write_permission_profile(db: &Connection, profile: CopilotPermissionProfile) -> AppResult<()> {
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES ('copilot_permission_profile', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [profile.as_str()],
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
pub fn settings_copilot_permission_profile(app: AppHandle) -> AppResult<CopilotPermissionProfile> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    read_permission_profile(&db)
}

#[tauri::command]
pub fn settings_set_copilot_permission_profile(
    app: AppHandle,
    profile: CopilotPermissionProfile,
) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    write_permission_profile(&db, profile)
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

#[tauri::command]
pub fn settings_saved_prompts(app: AppHandle) -> AppResult<Vec<SavedPrompt>> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let mut statement = db.prepare(
        "SELECT id, name, details, created_at, updated_at
         FROM saved_prompts ORDER BY name COLLATE NOCASE, created_at",
    )?;
    let rows = statement.query_map([], row_to_saved_prompt)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn settings_create_saved_prompt(
    app: AppHandle,
    name: String,
    details: String,
) -> AppResult<SavedPrompt> {
    let (name, details) = validate_saved_prompt(&name, &details)?;
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    db.execute(
        "INSERT INTO saved_prompts (id, name, details, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, name, details, now],
    )
    .map_err(saved_prompt_db_error)?;
    load_saved_prompt(&db, &id)?
        .ok_or_else(|| AppError::msg("Prompt was saved but could not be loaded."))
}

#[tauri::command]
pub fn settings_update_saved_prompt(
    app: AppHandle,
    id: String,
    name: String,
    details: String,
) -> AppResult<SavedPrompt> {
    let (name, details) = validate_saved_prompt(&name, &details)?;
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let assigned: Option<String> = db
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'browser_code_review_prompt_id'",
            [],
            |row| row.get(0),
        )
        .ok();
    if assigned.as_deref() == Some(id.as_str()) {
        validate_browser_prompt_details(details)?;
    }
    let changed = db
        .execute(
            "UPDATE saved_prompts SET name = ?2, details = ?3, updated_at = ?4 WHERE id = ?1",
            rusqlite::params![id, name, details, now_ms()],
        )
        .map_err(saved_prompt_db_error)?;
    if changed == 0 {
        return Err(AppError::msg("Saved prompt not found."));
    }
    load_saved_prompt(&db, &id)?
        .ok_or_else(|| AppError::msg("Prompt was updated but could not be loaded."))
}

#[tauri::command]
pub fn settings_delete_saved_prompt(app: AppHandle, id: String) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let assigned: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'browser_code_review_prompt_id'",
        [],
        |row| row.get(0),
    )?;
    if assigned == id {
        return Err(AppError::msg(
            "Assign another prompt to browser code reviews before deleting this one.",
        ));
    }
    if db.execute("DELETE FROM saved_prompts WHERE id = ?1", [id])? == 0 {
        return Err(AppError::msg("Saved prompt not found."));
    }
    Ok(())
}

#[tauri::command]
pub fn settings_browser_code_review_prompt(app: AppHandle) -> AppResult<SavedPrompt> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let id: String = db.query_row(
        "SELECT value FROM app_settings WHERE key = 'browser_code_review_prompt_id'",
        [],
        |row| row.get(0),
    )?;
    load_saved_prompt(&db, &id)?.ok_or_else(|| {
        AppError::msg("The prompt assigned to browser code reviews could not be found.")
    })
}

#[tauri::command]
pub fn settings_set_browser_code_review_prompt(app: AppHandle, id: String) -> AppResult<()> {
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("Database mutex poisoned."))?;
    let prompt =
        load_saved_prompt(&db, &id)?.ok_or_else(|| AppError::msg("Saved prompt not found."))?;
    validate_browser_prompt_details(&prompt.details)?;
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES ('browser_code_review_prompt_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [id],
    )?;
    Ok(())
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
    fn permission_profile_roundtrips_and_rejects_invalid_values() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        assert!(read_permission_profile(&db).is_err());
        for profile in [
            CopilotPermissionProfile::Default,
            CopilotPermissionProfile::AllowAll,
        ] {
            write_permission_profile(&db, profile).unwrap();
            assert_eq!(read_permission_profile(&db).unwrap(), profile);
        }
        db.execute(
            "UPDATE app_settings SET value='invalid' WHERE key='copilot_permission_profile'",
            [],
        )
        .unwrap();
        assert!(read_permission_profile(&db).is_err());
        assert!(serde_json::from_str::<CopilotPermissionProfile>("\"custom\"").is_err());
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
        write_task_queue_settings(
            &db,
            TaskQueueSettings {
                mode: TaskQueueMode::Manual,
                concurrency: 4,
            },
        )
        .unwrap();
        assert_eq!(
            read_task_queue_settings(&db).unwrap(),
            TaskQueueSettings {
                mode: TaskQueueMode::Manual,
                concurrency: 4,
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

    #[test]
    fn saved_prompt_validation_requires_bounded_name_and_details() {
        assert!(validate_saved_prompt("Review", "Inspect {{url}}").is_ok());
        assert!(validate_saved_prompt("", "Details").is_err());
        assert!(validate_saved_prompt("Review", " ").is_err());
        assert!(validate_saved_prompt(&"n".repeat(81), "Details").is_err());
        assert!(validate_saved_prompt("Review", &"d".repeat(32_001)).is_err());
        assert!(validate_browser_prompt_details("Review {{url}} on {{host}}").is_ok());
        assert!(validate_browser_prompt_details("Review {{repository}}").is_err());
    }
}
