use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};

use crate::error::AppResult;

// The Copilot CLI persists every session here regardless of how it was launched. We
// only ever read from it. Cap the result so growth in the store can't translate into
// an unbounded IPC payload.
const MAX_ROWS: i64 = 2000;
const BUSY_TIMEOUT_MS: u64 = 2000;
// Only surface recent activity. The CLI stores ISO-8601 UTC timestamps, which compare
// chronologically as plain strings, so we filter with a cutoff string computed the same way.
const HISTORY_WINDOW_DAYS: i64 = 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistorySession {
    pub id: String,
    pub cwd: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub summary: Option<String>,
    pub host_type: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Mirrors the Electron `CopilotHistoryListResult`:
/// `{ ok: true, sessions } | { ok: false, reason: "missing" | "unreadable", message }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistoryListResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<CopilotHistorySession>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CopilotHistoryListResult {
    fn ok(sessions: Vec<CopilotHistorySession>) -> Self {
        Self {
            ok: true,
            sessions: Some(sessions),
            reason: None,
            message: None,
        }
    }
    fn err(reason: &str, message: &str) -> Self {
        Self {
            ok: false,
            sessions: None,
            reason: Some(reason.to_string()),
            message: Some(message.to_string()),
        }
    }
}

fn store_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".copilot").join("session-store.db"))
}

fn cutoff_iso() -> String {
    let cutoff = OffsetDateTime::now_utc() - TimeDuration::days(HISTORY_WINDOW_DAYS);
    cutoff
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn read_history() -> CopilotHistoryListResult {
    let Some(path) = store_path() else {
        return CopilotHistoryListResult::err(
            "missing",
            "No Copilot sessions have been recorded yet.",
        );
    };
    if !path.exists() {
        return CopilotHistoryListResult::err(
            "missing",
            "No Copilot sessions have been recorded yet.",
        );
    }

    // The CLI owns this schema/file; open strictly read-only so we never block its writers
    // (WAL readers don't block writers) and never mutate the store.
    let conn = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("[copilot-store] failed to open session history: {err}");
            return CopilotHistoryListResult::err(
                "unreadable",
                "Could not read the Copilot session store.",
            );
        }
    };
    let _ = conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS));

    let result = (|| -> rusqlite::Result<Vec<CopilotHistorySession>> {
        let cutoff = cutoff_iso();
        let mut stmt = conn.prepare(
            "SELECT id, cwd, repository, branch, summary, host_type, created_at, updated_at
             FROM sessions
             WHERE updated_at >= ?1
             ORDER BY updated_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![cutoff, MAX_ROWS], |row| {
                Ok(CopilotHistorySession {
                    id: row.get(0)?,
                    cwd: row.get(1)?,
                    repository: row.get(2)?,
                    branch: row.get(3)?,
                    summary: row.get(4)?,
                    host_type: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })();

    match result {
        Ok(sessions) => CopilotHistoryListResult::ok(sessions),
        Err(err) => {
            // A renamed/removed column, a corrupt file, or a lock we couldn't acquire all land
            // here. Report an unavailable store instead of pretending it's empty.
            eprintln!("[copilot-store] failed to read session history: {err}");
            CopilotHistoryListResult::err("unreadable", "Could not read the Copilot session store.")
        }
    }
}

#[tauri::command]
pub async fn copilot_history_list() -> AppResult<CopilotHistoryListResult> {
    Ok(tauri::async_runtime::spawn_blocking(read_history)
        .await
        .unwrap_or_else(|e| {
            CopilotHistoryListResult::err("unreadable", &format!("history task panicked: {e}"))
        }))
}
