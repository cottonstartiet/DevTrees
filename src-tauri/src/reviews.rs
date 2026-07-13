use serde::Serialize;

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
