use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoReviewClaimResult {
    pub claimed: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn claim_auto_review(
    conn: &Connection,
    repository_path: &str,
    provider: &str,
    pull_request_id: i64,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO auto_review_triggers
            (repository_path, provider, pull_request_id, triggered_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![repository_path, provider, pull_request_id, now_ms()],
    )?;
    Ok(changed == 1)
}

#[tauri::command]
pub async fn reviews_claim_auto_trigger(
    state: State<'_, DbState>,
    repository_path: String,
    provider: String,
    pull_request_id: i64,
) -> AppResult<AutoReviewClaimResult> {
    let repository_path = repository_path.trim();
    if repository_path.is_empty() {
        return Err(AppError::msg("repositoryPath is required"));
    }
    if !matches!(provider.as_str(), "github" | "ado") {
        return Err(AppError::msg("provider must be github or ado"));
    }
    if pull_request_id <= 0 {
        return Err(AppError::msg("pullRequestId must be positive"));
    }

    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    Ok(AutoReviewClaimResult {
        claimed: claim_auto_review(&conn, repository_path, &provider, pull_request_id)?,
    })
}

/// Provider-agnostic pull request shape shared by the ADO and GitHub Reviews backends.
///
/// Mirrors the `RepoPr` type in `src/shared/reviews.ts`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoPr {
    /// "github" | "ado"
    pub provider: String,
    pub id: i64,
    pub title: String,
    pub description: String,
    pub author: String,
    pub source_ref: String,
    pub target_ref: String,
    pub web_url: String,
    pub created_at: Option<String>,
    pub is_draft: bool,
    /// "mine" | "assigned" | "other"
    pub category: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenPrsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prs: Option<Vec<RepoPr>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RepoOpenPrsResult {
    pub fn ok(prs: Vec<RepoPr>) -> Self {
        Self {
            ok: true,
            prs: Some(prs),
            code: None,
            message: None,
        }
    }

    pub fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            prs: None,
            code: Some(code.into()),
            message,
        }
    }
}

/// Categorize a PR relative to the current user.
///
/// - author matches the current user -> "mine"
/// - the current user (or one of their teams) is a requested reviewer / assignee -> "assigned"
/// - otherwise -> "other"
pub fn categorize(is_author: bool, is_assigned: bool) -> String {
    if is_author {
        "mine".to_string()
    } else if is_assigned {
        "assigned".to_string()
    } else {
        "other".to_string()
    }
}

/// Short branch name from a full ref like `refs/heads/foo` -> `foo`.
pub fn short_ref(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .unwrap_or(reference)
        .to_string()
}

/// Case-insensitive equality for identity comparisons (logins / unique names).
pub fn ident_eq(a: &str, b: &str) -> bool {
    !a.is_empty() && a.eq_ignore_ascii_case(b)
}

/// Provider-agnostic PR review-thread status. Mirrors `RepoPrThreadStatus` in
/// `src/shared/reviews.ts`. GitHub only distinguishes resolved/unresolved (and outdated), so its
/// threads map onto a subset of ADO's richer status vocabulary (see `github.rs`).
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoPrThreadStatus {
    Unknown,
    Active,
    Pending,
    Fixed,
    WontFix,
    Closed,
    ByDesign,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrCommentAuthor {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrComment {
    pub id: i64,
    pub author: RepoPrCommentAuthor,
    pub content: String,
    pub published_date: Option<String>,
}

/// Provider-agnostic pull-request review-comment thread. Mirrors `RepoPrThread` in
/// `src/shared/reviews.ts`. Produced by both `ado::ado_pr_threads` and `github::github_pr_threads`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrThread {
    pub id: i64,
    /// Provider handle used for writes (replies, resolve/unresolve): the GraphQL node id on
    /// GitHub, the numeric thread id as a string on Azure DevOps.
    pub provider_thread_id: String,
    pub status: RepoPrThreadStatus,
    pub file_path: Option<String>,
    pub line_number: Option<i64>,
    /// Last line of the thread's anchor range; equals `line_number` for single-line threads.
    pub end_line_number: Option<i64>,
    pub is_resolved: bool,
    pub comments: Vec<RepoPrComment>,
    pub last_updated: Option<String>,
    pub web_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrThreadsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threads: Option<Vec<RepoPrThread>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE auto_review_triggers (
                repository_path TEXT COLLATE NOCASE NOT NULL,
                provider TEXT NOT NULL,
                pull_request_id INTEGER NOT NULL,
                triggered_at INTEGER NOT NULL,
                PRIMARY KEY (repository_path, provider, pull_request_id)
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn auto_review_claim_is_persistent_and_case_insensitive_for_paths() {
        let conn = connection();

        assert!(claim_auto_review(&conn, r"C:\Code\Repo", "github", 42).unwrap());
        assert!(!claim_auto_review(&conn, r"c:\code\repo", "github", 42).unwrap());
        assert!(claim_auto_review(&conn, r"C:\Code\Repo", "ado", 42).unwrap());
        assert!(claim_auto_review(&conn, r"C:\Code\Repo", "github", 43).unwrap());
    }
}

impl RepoPrThreadsResult {
    pub fn ok(threads: Vec<RepoPrThread>) -> Self {
        Self {
            ok: true,
            threads: Some(threads),
            code: None,
            message: None,
        }
    }

    pub fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            threads: None,
            code: Some(code.into()),
            message,
        }
    }
}
