use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};

use crate::copilot_history::open_store_readonly;
use crate::error::AppResult;

const DEFAULT_WINDOW_DAYS: i64 = 30;
const MAX_WINDOW_DAYS: i64 = 180;
const TOP_REPOSITORIES_LIMIT: i64 = 8;
const TOP_FILES_LIMIT: i64 = 15;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotModelUsage {
    pub model: String,
    pub events: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_nano_aiu: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotDailyUsage {
    pub date: String,
    pub sessions: i64,
    pub events: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_nano_aiu: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotRepositoryUsage {
    pub repository: String,
    pub sessions: i64,
    pub events: i64,
    pub cost_nano_aiu: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotFileActivity {
    pub path: String,
    pub creates: i64,
    pub edits: i64,
    pub touches: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAnalyticsTotals {
    pub sessions: i64,
    pub turns: i64,
    pub active_days: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_nano_aiu: i64,
    pub avg_response_ms: Option<f64>,
    pub avg_time_to_first_token_ms: Option<f64>,
    pub files_created: i64,
    pub files_edited: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAnalyticsSummary {
    pub window_days: i64,
    pub totals: CopilotAnalyticsTotals,
    pub daily: Vec<CopilotDailyUsage>,
    pub models: Vec<CopilotModelUsage>,
    pub top_repositories: Vec<CopilotRepositoryUsage>,
    pub top_files: Vec<CopilotFileActivity>,
}

/// Mirrors `CopilotHistoryListResult`: `{ ok: true, summary } | { ok: false, reason, message }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAnalyticsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<CopilotAnalyticsSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CopilotAnalyticsResult {
    fn ok(summary: CopilotAnalyticsSummary) -> Self {
        Self {
            ok: true,
            summary: Some(summary),
            reason: None,
            message: None,
        }
    }
    fn err(reason: &str, message: &str) -> Self {
        Self {
            ok: false,
            summary: None,
            reason: Some(reason.to_string()),
            message: Some(message.to_string()),
        }
    }
}

fn cutoff_iso(window_days: i64) -> String {
    let cutoff = OffsetDateTime::now_utc() - TimeDuration::days(window_days);
    cutoff
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Every UTC calendar date from `window_days` ago through today, inclusive, so the daily chart
/// never has gaps even on days with zero recorded activity.
fn date_range(window_days: i64) -> Vec<String> {
    let today = OffsetDateTime::now_utc().date();
    (0..window_days.max(1))
        .rev()
        .filter_map(|offset| {
            today
                .checked_sub(time::Duration::days(offset))
                .map(|d| d.to_string())
        })
        .collect()
}

fn read_analytics(window_days: i64) -> CopilotAnalyticsResult {
    let conn = match open_store_readonly() {
        Ok(c) => c,
        Err((reason, message)) => return CopilotAnalyticsResult::err(reason, &message),
    };

    match compute_summary(&conn, window_days) {
        Ok(summary) => CopilotAnalyticsResult::ok(summary),
        Err(err) => {
            eprintln!("[copilot-analytics] failed to compute analytics: {err}");
            CopilotAnalyticsResult::err("unreadable", "Could not read the Copilot session store.")
        }
    }
}

fn compute_summary(conn: &Connection, window_days: i64) -> rusqlite::Result<CopilotAnalyticsSummary> {
    let cutoff = cutoff_iso(window_days);

    // --- Turn-derived totals: turn count, distinct active days, and this window's session set. ---
    let (turns, active_days): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT date(timestamp)) FROM turns WHERE timestamp >= ?1",
        rusqlite::params![cutoff],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // --- Model-usage-derived totals: tokens, cost, and latency, summed across every billed call. ---
    let (
        usage_events,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_nano_aiu,
        avg_response_ms,
        avg_ttft_ms,
    ): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<f64>,
        Option<f64>,
    ) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(total_nano_aiu), 0),
                AVG(duration_ms),
                AVG(time_to_first_token_ms)
         FROM assistant_usage_events WHERE created_at >= ?1",
        rusqlite::params![cutoff],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        },
    )?;
    let _ = usage_events;

    // Sessions active in the window: any session with a turn or a billed model call, deduplicated.
    let sessions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
            SELECT session_id FROM turns WHERE timestamp >= ?1
            UNION
            SELECT session_id FROM assistant_usage_events WHERE created_at >= ?1
         )",
        rusqlite::params![cutoff],
        |row| row.get(0),
    )?;

    // --- Files Copilot touched: created vs. edited, from the same window. ---
    let mut files_created = 0i64;
    let mut files_edited = 0i64;
    {
        let mut stmt = conn.prepare(
            "SELECT tool_name, COUNT(*) FROM session_files WHERE first_seen_at >= ?1 GROUP BY tool_name",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (tool_name, count) = row?;
            match tool_name.as_str() {
                "create" => files_created = count,
                "edit" => files_edited = count,
                _ => {}
            }
        }
    }

    let totals = CopilotAnalyticsTotals {
        sessions,
        turns,
        active_days,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_nano_aiu,
        avg_response_ms,
        avg_time_to_first_token_ms: avg_ttft_ms,
        files_created,
        files_edited,
    };

    // --- Daily series: merge per-day turn/session counts with per-day usage/cost, then fill any
    // day in the window that has no rows at all so the chart never shows a gap. ---
    let mut daily_turns: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT date(timestamp) as d, COUNT(*), COUNT(DISTINCT session_id)
             FROM turns WHERE timestamp >= ?1 GROUP BY d",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (d, count, sess) = row?;
            daily_turns.insert(d, (count, sess));
        }
    }
    let mut daily_usage: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT date(created_at) as d, COUNT(*), COALESCE(SUM(input_tokens),0),
                    COALESCE(SUM(output_tokens),0), COALESCE(SUM(total_nano_aiu),0)
             FROM assistant_usage_events WHERE created_at >= ?1 GROUP BY d",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (d, events, input, output, cost) = row?;
            daily_usage.insert(d, (events, input, output, cost));
        }
    }
    let daily = date_range(window_days)
        .into_iter()
        .map(|date| {
            let (turn_count, turn_sessions) = daily_turns.get(&date).copied().unwrap_or((0, 0));
            let (events, input, output, cost) = daily_usage.get(&date).copied().unwrap_or((0, 0, 0, 0));
            CopilotDailyUsage {
                date,
                sessions: turn_sessions,
                events: events.max(turn_count),
                input_tokens: input,
                output_tokens: output,
                cost_nano_aiu: cost,
            }
        })
        .collect();

    // --- Per-model roll-up, most expensive first. ---
    let models = {
        let mut stmt = conn.prepare(
            "SELECT model, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0),
                    COALESCE(SUM(total_nano_aiu),0)
             FROM assistant_usage_events
             WHERE created_at >= ?1
             GROUP BY model
             ORDER BY 7 DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff], |row| {
            Ok(CopilotModelUsage {
                model: row.get(0)?,
                events: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_write_tokens: row.get(5)?,
                cost_nano_aiu: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // --- Top repositories by cost: sessions joined to their billed usage in the window. ---
    let top_repositories = {
        let mut stmt = conn.prepare(
            "SELECT s.repository, COUNT(DISTINCT s.id), COUNT(u.id), COALESCE(SUM(u.total_nano_aiu),0)
             FROM sessions s
             LEFT JOIN assistant_usage_events u ON u.session_id = s.id AND u.created_at >= ?1
             WHERE s.repository IS NOT NULL AND s.updated_at >= ?1
             GROUP BY s.repository
             ORDER BY 4 DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff, TOP_REPOSITORIES_LIMIT], |row| {
            Ok(CopilotRepositoryUsage {
                repository: row.get(0)?,
                sessions: row.get(1)?,
                events: row.get(2)?,
                cost_nano_aiu: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // --- Top files by touch count, across creates and edits. ---
    let top_files = {
        let mut stmt = conn.prepare(
            "SELECT file_path,
                    SUM(CASE WHEN tool_name = 'create' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN tool_name = 'edit' THEN 1 ELSE 0 END),
                    COUNT(*)
             FROM session_files
             WHERE first_seen_at >= ?1
             GROUP BY file_path
             ORDER BY 4 DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![cutoff, TOP_FILES_LIMIT], |row| {
            Ok(CopilotFileActivity {
                path: row.get(0)?,
                creates: row.get(1)?,
                edits: row.get(2)?,
                touches: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(CopilotAnalyticsSummary {
        window_days,
        totals,
        daily,
        models,
        top_repositories,
        top_files,
    })
}

#[tauri::command]
pub async fn copilot_analytics_summary(window_days: Option<i64>) -> AppResult<CopilotAnalyticsResult> {
    let window = window_days
        .unwrap_or(DEFAULT_WINDOW_DAYS)
        .clamp(1, MAX_WINDOW_DAYS);
    Ok(
        tauri::async_runtime::spawn_blocking(move || read_analytics(window))
            .await
            .unwrap_or_else(|e| {
                CopilotAnalyticsResult::err("unreadable", &format!("analytics task panicked: {e}"))
            }),
    )
}
