use serde_json::Value;

use crate::error::AppResult;
use crate::gh::{is_not_logged_in, run_gh, GhError};
use crate::reviews::{categorize, ident_eq, RepoOpenPrsResult, RepoPr};

/// List all open pull requests for the GitHub repository at `folder_path`, categorized relative to
/// the authenticated user (mine / assigned / other).
///
/// `gh` is run with `folder_path` as the working directory so the host (github.com or Enterprise)
/// and repository are inferred from the repository's git remote.
#[tauri::command]
pub async fn github_repo_open_prs(folder_path: String) -> AppResult<RepoOpenPrsResult> {
    if folder_path.trim().is_empty() {
        return Ok(RepoOpenPrsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }

    // Resolve the authenticated login for the repo's host. Best-effort: if it fails for a reason
    // other than auth/install, fall through so PRs still list (all bucketed as "other").
    let current_login = match run_gh(
        vec!["api".into(), "user".into(), "--jq".into(), ".login".into()],
        folder_path.clone(),
    )
    .await
    {
        Ok(output) => output.stdout.trim().to_string(),
        Err(GhError::NotInstalled) => {
            return Ok(RepoOpenPrsResult::err(
                "gh-not-installed",
                Some("GitHub CLI (gh) was not found on PATH.".to_string()),
            ))
        }
        Err(GhError::Failed { stderr, .. }) if is_not_logged_in(&stderr) => {
            return Ok(RepoOpenPrsResult::err(
                "gh-not-logged-in",
                Some("Run: gh auth login".to_string()),
            ))
        }
        Err(GhError::Failed { .. }) => String::new(),
    };

    let output = match run_gh(
        vec![
            "pr".into(),
            "list".into(),
            "--state".into(),
            "open".into(),
            "--limit".into(),
            "200".into(),
            "--json".into(),
            "number,title,author,headRefName,baseRefName,url,isDraft,createdAt,reviewRequests,assignees"
                .into(),
        ],
        folder_path.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(GhError::NotInstalled) => {
            return Ok(RepoOpenPrsResult::err(
                "gh-not-installed",
                Some("GitHub CLI (gh) was not found on PATH.".to_string()),
            ))
        }
        Err(GhError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            if is_not_logged_in(&stderr) {
                return Ok(RepoOpenPrsResult::err(
                    "gh-not-logged-in",
                    Some("Run: gh auth login".to_string()),
                ));
            }
            return Ok(RepoOpenPrsResult::err(
                "gh-failed",
                Some(gh_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed: Value = match serde_json::from_str(output.stdout.trim()) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(RepoOpenPrsResult::err(
                "gh-failed",
                Some(format!("Could not parse gh output: {err}")),
            ))
        }
    };

    let Some(items) = parsed.as_array() else {
        return Ok(RepoOpenPrsResult::ok(Vec::new()));
    };

    let prs = items
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            let author = item
                .get("author")
                .and_then(Value::as_object)
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let is_author = !current_login.is_empty() && ident_eq(&author, &current_login);
            let is_assigned = !current_login.is_empty()
                && (login_list_contains(item.get("reviewRequests"), &current_login)
                    || login_list_contains(item.get("assignees"), &current_login));

            let author_display = item
                .get("author")
                .and_then(Value::as_object)
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| author.clone());

            RepoPr {
                provider: "github".to_string(),
                id: item
                    .get("number")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                author: author_display,
                source_ref: item
                    .get("headRefName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                target_ref: item
                    .get("baseRefName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                web_url: item
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                created_at: item
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                is_draft: item
                    .get("isDraft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                category: categorize(is_author, is_assigned),
            }
        })
        .collect();

    Ok(RepoOpenPrsResult::ok(prs))
}

/// True if any element of a `gh` JSON array of accounts has a `login` matching `needle`.
fn login_list_contains(value: Option<&Value>, needle: &str) -> bool {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|entry| {
                entry
                    .as_object()
                    .and_then(|obj| obj.get("login"))
                    .and_then(Value::as_str)
                    .map(|login| ident_eq(login, needle))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn gh_failed_message(stdout: &str, stderr: &str, code: Option<i32>) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match code {
        Some(code) => format!("gh exited with code {code}"),
        None => "gh failed".to_string(),
    }
}
