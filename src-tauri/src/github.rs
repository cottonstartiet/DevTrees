use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::error::AppResult;
use crate::gh::{is_not_logged_in, run_gh, GhError};
use crate::git::run_git;
use crate::reviews::{
    categorize, ident_eq, RepoOpenPrsResult, RepoPr, RepoPrComment, RepoPrCommentAuthor,
    RepoPrThread, RepoPrThreadStatus, RepoPrThreadsResult,
};

/// A parsed `github.com` remote (owner/repo). Mirrors `AdoRemote` in `ado.rs`.
///
/// Note: GitHub Enterprise remotes are not classified as `"github"` by `classify_remote_url` in
/// `repositories.rs` today, so parsing here is intentionally scoped to `github.com` to match.
#[derive(Debug, Clone)]
pub struct GithubRemote {
    pub owner: String,
    pub repo: String,
}

/// Parse a `github.com` origin URL (HTTPS or SSH) into owner/repo. Ported in spirit from
/// `parse_ado_remote`.
pub fn parse_github_remote(raw_url: &str) -> Option<GithubRemote> {
    static HTTPS: OnceLock<Regex> = OnceLock::new();
    static SSH: OnceLock<Regex> = OnceLock::new();
    static SCP: OnceLock<Regex> = OnceLock::new();

    let url = raw_url.trim();
    if url.is_empty() {
        return None;
    }

    let https = HTTPS.get_or_init(|| {
        Regex::new(r"(?i)^https?://(?:[^@/]+@)?github\.com/([^/]+)/(.+?)(?:\.git)?/?$").unwrap()
    });
    if let Some(caps) = https.captures(url) {
        return Some(GithubRemote {
            owner: caps.get(1)?.as_str().to_string(),
            repo: caps.get(2)?.as_str().to_string(),
        });
    }

    let ssh = SSH.get_or_init(|| {
        Regex::new(r"(?i)^ssh://(?:[^@/]+@)?github\.com/([^/]+)/(.+?)(?:\.git)?/?$").unwrap()
    });
    if let Some(caps) = ssh.captures(url) {
        return Some(GithubRemote {
            owner: caps.get(1)?.as_str().to_string(),
            repo: caps.get(2)?.as_str().to_string(),
        });
    }

    let scp = SCP.get_or_init(|| {
        Regex::new(r"(?i)^[^@\s]+@github\.com:([^/]+)/(.+?)(?:\.git)?$").unwrap()
    });
    if let Some(caps) = scp.captures(url) {
        return Some(GithubRemote {
            owner: caps.get(1)?.as_str().to_string(),
            repo: caps.get(2)?.as_str().to_string(),
        });
    }

    None
}

pub fn build_github_pr_web_url(remote: &GithubRemote, pr_number: i64) -> String {
    format!(
        "https://github.com/{}/{}/pull/{}",
        remote.owner, remote.repo, pr_number
    )
}

pub fn build_github_commit_url(remote: &GithubRemote, sha: &str) -> String {
    format!(
        "https://github.com/{}/{}/commit/{}",
        remote.owner, remote.repo, sha
    )
}

pub fn build_github_branch_url(remote: &GithubRemote, branch: &str) -> String {
    format!(
        "https://github.com/{}/{}/tree/{}",
        remote.owner, remote.repo, branch
    )
}

/// URL for a specific PR review comment/thread, anchored to its first comment's database id.
pub fn build_github_pr_thread_url(remote: &GithubRemote, pr_number: i64, comment_id: i64) -> String {
    format!(
        "{}#discussion_r{comment_id}",
        build_github_pr_web_url(remote, pr_number)
    )
}

/// Resolve the `github.com` remote for `folder_path`'s `origin`. Mirrors `resolve_ado_remote`.
pub async fn resolve_github_remote(
    folder_path: &str,
) -> Result<GithubRemote, (String, Option<String>)> {
    if folder_path.trim().is_empty() {
        return Err((
            "git-failed".to_string(),
            Some("folderPath is required".to_string()),
        ));
    }

    let origin = match run_git(
        vec!["remote".into(), "get-url".into(), "origin".into()],
        folder_path.to_string(),
    )
    .await
    {
        Ok(out) => out.stdout.trim().to_string(),
        Err(err) => return Err(("no-origin".to_string(), Some(err.message))),
    };

    if origin.is_empty() {
        return Err(("no-origin".to_string(), None));
    }

    match parse_github_remote(&origin) {
        Some(remote) => Ok(remote),
        None => Err((
            "unsupported-remote".to_string(),
            Some(format!("Origin is not a recognized GitHub remote: {origin}")),
        )),
    }
}

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

const PR_REVIEW_THREADS_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 100) {
            nodes {
              databaseId
              body
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}
"#;

/// List unresolved GitHub PR review-comment threads, mirroring `ado::ado_pr_threads`'s shape and
/// filtering (only threads that still need attention are returned; resolved threads are dropped).
///
/// Unlike REST, only the GraphQL API exposes `isResolved`/`isOutdated`, so this uses
/// `gh api graphql` rather than `gh pr view --comments`.
#[tauri::command]
pub async fn github_pr_threads(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<RepoPrThreadsResult> {
    if folder_path.trim().is_empty() {
        return Ok(RepoPrThreadsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }
    if pull_request_id <= 0 {
        return Ok(RepoPrThreadsResult::err(
            "git-failed",
            Some("pullRequestId is required".to_string()),
        ));
    }

    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(RepoPrThreadsResult::err(code, message)),
    };

    let output = match run_gh(
        vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            format!("query={PR_REVIEW_THREADS_QUERY}"),
            "-f".into(),
            format!("owner={}", remote.owner),
            "-f".into(),
            format!("repo={}", remote.repo),
            "-F".into(),
            format!("number={pull_request_id}"),
        ],
        folder_path.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(GhError::NotInstalled) => {
            return Ok(RepoPrThreadsResult::err(
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
                return Ok(RepoPrThreadsResult::err(
                    "gh-not-logged-in",
                    Some("Run: gh auth login".to_string()),
                ));
            }
            return Ok(RepoPrThreadsResult::err(
                "gh-failed",
                Some(gh_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed: Value = match serde_json::from_str(output.stdout.trim()) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(RepoPrThreadsResult::err(
                "gh-failed",
                Some(format!("Could not parse gh output: {err}")),
            ))
        }
    };

    let raw_threads = parsed
        .pointer("/data/repository/pullRequest/reviewThreads/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut threads = Vec::new();
    for thread in raw_threads.iter().filter_map(Value::as_object) {
        if thread
            .get("isResolved")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }

        let raw_comments = thread
            .get("comments")
            .and_then(Value::as_object)
            .and_then(|c| c.get("nodes"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut comments = Vec::new();
        for comment in raw_comments.iter().filter_map(Value::as_object) {
            let login = comment
                .get("author")
                .and_then(Value::as_object)
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("Unknown")
                .to_string();
            comments.push(RepoPrComment {
                id: comment
                    .get("databaseId")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                author: RepoPrCommentAuthor {
                    display_name: login,
                    unique_name: None,
                },
                content: comment
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                published_date: comment
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        if comments.is_empty() {
            continue;
        }

        let first_comment_id = comments.first().map(|c| c.id).unwrap_or(0);
        let last_updated = comments.last().and_then(|c| c.published_date.clone());

        threads.push(RepoPrThread {
            id: first_comment_id,
            status: RepoPrThreadStatus::Active,
            file_path: thread
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string),
            line_number: thread
                .get("line")
                .and_then(Value::as_i64)
                .or_else(|| thread.get("originalLine").and_then(Value::as_i64))
                .filter(|line| *line > 0),
            comments,
            last_updated,
            web_url: if first_comment_id > 0 {
                build_github_pr_thread_url(&remote, pull_request_id, first_comment_id)
            } else {
                build_github_pr_web_url(&remote, pull_request_id)
            },
        });
    }

    Ok(RepoPrThreadsResult::ok(threads))
}

