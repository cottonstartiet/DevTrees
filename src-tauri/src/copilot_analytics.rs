mod coaching;
mod report;
mod source;
#[cfg(test)]
mod tests;

use serde::Serialize;

use crate::copilot_history::open_store_readonly;
use crate::error::AppResult;
use report::AnalyticsSummary;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAnalyticsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<AnalyticsSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CopilotAnalyticsResult {
    fn err(reason: &str, message: &str) -> Self {
        Self {
            ok: false,
            summary: None,
            reason: Some(reason.into()),
            message: Some(message.into()),
        }
    }
}

fn read_analytics(window: i64, repository: Option<String>) -> CopilotAnalyticsResult {
    let result = (|| -> rusqlite::Result<AnalyticsSummary> {
        let (mut conn, missing) = match open_store_readonly() {
            Ok(conn) => (conn, false),
            Err(("missing", _)) => (source::empty_store()?, true),
            Err((_, message)) => return Err(rusqlite::Error::InvalidParameterName(message)),
        };
        let tx = conn.transaction()?;
        let now: String =
            tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')", [], |row| {
                row.get(0)
            })?;
        let mut data = source::load(&tx, window, repository.as_deref(), &now)?;
        if missing {
            data.usage_available = false;
            data.files_available = false;
            data.prompts_available = false;
            data.warnings.push("No local Copilot CLI session store was found. Run a Copilot CLI session, then refresh.".into());
        }
        Ok(report::build(data))
    })();
    match result {
        Ok(summary) => CopilotAnalyticsResult {
            ok: true,
            summary: Some(summary),
            reason: None,
            message: None,
        },
        Err(error) => {
            eprintln!("[copilot-analytics] {error}");
            CopilotAnalyticsResult::err(
                "unreadable",
                &format!("Could not calculate analytics: {error}"),
            )
        }
    }
}

#[tauri::command]
pub async fn copilot_analytics_summary(
    window_days: Option<i64>,
    repository: Option<String>,
) -> AppResult<CopilotAnalyticsResult> {
    let window = window_days.unwrap_or(30).clamp(1, 180);
    Ok(
        tauri::async_runtime::spawn_blocking(move || read_analytics(window, repository))
            .await
            .unwrap_or_else(|error| {
                CopilotAnalyticsResult::err(
                    "unreadable",
                    &format!("Analytics task failed: {error}"),
                )
            }),
    )
}
