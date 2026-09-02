use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use regex::Regex;
use serde_json::Value;

use crate::error::AppResult;
use crate::gh::{is_not_logged_in, run_gh, run_gh_with_body, GhError};
use crate::git::run_git;
use crate::pr_review::{
    clamp_anchor_to_diff, clamp_text, commentable_head_lines, is_markdown_path, looks_binary,
    normalize_path, parse_unified_patch, PrChangedFile, PrChangedFilesResult, PrCommentAnchor,
    PrFileContent, PrFileContentResult, PrFileDiff, PrFileDiffResult, PrMutationResult,
    PrReviewDetail, PrReviewDetailResult,
};
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

    let scp = SCP
        .get_or_init(|| Regex::new(r"(?i)^[^@\s]+@github\.com:([^/]+)/(.+?)(?:\.git)?$").unwrap());
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
pub fn build_github_pr_thread_url(
    remote: &GithubRemote,
    pr_number: i64,
    comment_id: i64,
) -> String {
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
            Some(format!(
                "Origin is not a recognized GitHub remote: {origin}"
            )),
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
          startLine
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
    include_resolved: Option<bool>,
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
        let is_resolved = thread
            .get("isResolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_resolved && !include_resolved.unwrap_or(false) {
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

        let end_line = thread
            .get("line")
            .and_then(Value::as_i64)
            .or_else(|| thread.get("originalLine").and_then(Value::as_i64))
            .filter(|line| *line > 0);
        let start_line = thread
            .get("startLine")
            .and_then(Value::as_i64)
            .filter(|line| *line > 0)
            .or(end_line);

        threads.push(RepoPrThread {
            id: first_comment_id,
            provider_thread_id: thread
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            status: if is_resolved {
                RepoPrThreadStatus::Fixed
            } else {
                RepoPrThreadStatus::Active
            },
            file_path: thread
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string),
            line_number: start_line,
            end_line_number: end_line,
            is_resolved,
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

// ---------------------------------------------------------------------------
// In-app PR review workspace (see `pr_review.rs` and `src/shared/pr-review.ts`)
// ---------------------------------------------------------------------------

/// `(code, message)` failure pair shared by the review helpers below.
type GhFail = (String, Option<String>);

fn map_gh_error(err: GhError) -> GhFail {
    match err {
        GhError::NotInstalled => (
            "gh-not-installed".to_string(),
            Some("GitHub CLI (gh) was not found on PATH.".to_string()),
        ),
        GhError::Failed {
            stdout,
            stderr,
            code,
        } => {
            if is_not_logged_in(&stderr) {
                (
                    "gh-not-logged-in".to_string(),
                    Some("Run: gh auth login".to_string()),
                )
            } else {
                (
                    "gh-failed".to_string(),
                    Some(gh_failed_message(&stdout, &stderr, code)),
                )
            }
        }
    }
}

async fn gh_text(args: Vec<String>, cwd: &str) -> Result<String, GhFail> {
    run_gh(args, cwd.to_string())
        .await
        .map(|out| out.stdout)
        .map_err(map_gh_error)
}

async fn gh_text_with_body(
    args: Vec<String>,
    cwd: &str,
    flag: &'static str,
    body: String,
) -> Result<String, GhFail> {
    run_gh_with_body(args, cwd.to_string(), flag, body)
        .await
        .map(|out| out.stdout)
        .map_err(map_gh_error)
}

async fn gh_json(args: Vec<String>, cwd: &str) -> Result<Value, GhFail> {
    let stdout = gh_text(args, cwd).await?;
    serde_json::from_str(stdout.trim()).map_err(|err| {
        (
            "gh-failed".to_string(),
            Some(format!("Could not parse gh output: {err}")),
        )
    })
}

/// Percent-encode a repository-relative path for use in a `gh api` URL, keeping `/` separators.
fn encode_api_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for &byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn map_review_state_to_vote(state: &str) -> &'static str {
    match state.to_ascii_uppercase().as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "rejected",
        _ => "none",
    }
}

fn map_pr_state(state: &str) -> &'static str {
    match state.to_ascii_uppercase().as_str() {
        "OPEN" => "open",
        "MERGED" => "merged",
        "CLOSED" => "abandoned",
        _ => "unknown",
    }
}

fn map_change_type(status: &str) -> &'static str {
    match status {
        "added" | "copied" => "add",
        "removed" => "delete",
        "renamed" => "rename",
        _ => "edit",
    }
}

/// Fetch the PR's `files` listing once; every changed-file and diff request reads from it.
async fn github_pr_files(
    remote: &GithubRemote,
    folder_path: &str,
    pull_request_id: i64,
) -> Result<Vec<Value>, GhFail> {
    let parsed = gh_json(
        vec![
            "api".into(),
            "--paginate".into(),
            format!(
                "repos/{}/{}/pulls/{pull_request_id}/files?per_page=100",
                remote.owner, remote.repo
            ),
        ],
        folder_path,
    )
    .await?;
    Ok(parsed.as_array().cloned().unwrap_or_default())
}

/// Header detail for the review workspace: PR metadata, head/base commits, and the current
/// user's latest vote.
#[tauri::command]
pub async fn github_pr_detail(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<PrReviewDetailResult> {
    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrReviewDetailResult::err(code, message)),
    };

    let current_login = gh_text(
        vec!["api".into(), "user".into(), "--jq".into(), ".login".into()],
        &folder_path,
    )
    .await
    .map(|out| out.trim().to_string())
    .unwrap_or_default();

    let pr = match gh_json(
        vec![
            "pr".into(),
            "view".into(),
            pull_request_id.to_string(),
            "--json".into(),
            "number,title,body,author,headRefName,baseRefName,headRefOid,baseRefOid,url,isDraft,state,latestReviews".into(),
        ],
        &folder_path,
    )
    .await
    {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrReviewDetailResult::err(code, message)),
    };

    let author = pr
        .pointer("/author/name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| pr.pointer("/author/login").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    let my_vote = pr
        .get("latestReviews")
        .and_then(Value::as_array)
        .and_then(|reviews| {
            reviews.iter().rev().find_map(|review| {
                let login = review.pointer("/author/login").and_then(Value::as_str)?;
                if !ident_eq(login, &current_login) {
                    return None;
                }
                review.get("state").and_then(Value::as_str)
            })
        })
        .map(map_review_state_to_vote)
        .unwrap_or("none");

    Ok(PrReviewDetailResult::ok(PrReviewDetail {
        provider: "github".to_string(),
        id: pr
            .get("number")
            .and_then(Value::as_i64)
            .unwrap_or(pull_request_id),
        title: pr
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: pr
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author,
        source_ref: pr
            .get("headRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        target_ref: pr
            .get("baseRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        head_sha: pr
            .get("headRefOid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        base_sha: pr
            .get("baseRefOid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        web_url: pr
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| build_github_pr_web_url(&remote, pull_request_id)),
        is_draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state: map_pr_state(pr.get("state").and_then(Value::as_str).unwrap_or("")).to_string(),
        my_vote: my_vote.to_string(),
    }))
}

/// The changed-files sidebar contents.
#[tauri::command]
pub async fn github_pr_changed_files(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<PrChangedFilesResult> {
    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrChangedFilesResult::err(code, message)),
    };

    let raw = match github_pr_files(&remote, &folder_path, pull_request_id).await {
        Ok(files) => files,
        Err((code, message)) => return Ok(PrChangedFilesResult::err(code, message)),
    };

    let files = raw
        .iter()
        .filter_map(Value::as_object)
        .map(|file| {
            let path = normalize_path(file.get("filename").and_then(Value::as_str).unwrap_or(""));
            let status = file
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("modified");
            let changes = file.get("changes").and_then(Value::as_i64).unwrap_or(0);
            let has_patch = file.get("patch").and_then(Value::as_str).is_some();
            PrChangedFile {
                is_markdown: is_markdown_path(&path),
                previous_path: file
                    .get("previous_filename")
                    .and_then(Value::as_str)
                    .map(normalize_path),
                change_type: map_change_type(status).to_string(),
                additions: file.get("additions").and_then(Value::as_i64).unwrap_or(0),
                deletions: file.get("deletions").and_then(Value::as_i64).unwrap_or(0),
                // GitHub omits `patch` both for binaries and for oversized text files; treat a
                // zero-change file with no patch as binary.
                is_binary: !has_patch && changes == 0,
                path,
            }
        })
        .collect();

    Ok(PrChangedFilesResult::ok(files))
}

/// Unified diff for one file of the PR, parsed from GitHub's per-file patch.
#[tauri::command]
pub async fn github_pr_file_diff(
    folder_path: String,
    pull_request_id: i64,
    path: String,
) -> AppResult<PrFileDiffResult> {
    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };

    let raw = match github_pr_files(&remote, &folder_path, pull_request_id).await {
        Ok(files) => files,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };

    let wanted = normalize_path(&path);
    let Some(file) = raw.iter().filter_map(Value::as_object).find(|file| {
        normalize_path(file.get("filename").and_then(Value::as_str).unwrap_or("")) == wanted
    }) else {
        return Ok(PrFileDiffResult::err(
            "gh-failed",
            Some(format!("{wanted} is not part of this pull request.")),
        ));
    };

    let changes = file.get("changes").and_then(Value::as_i64).unwrap_or(0);
    match file.get("patch").and_then(Value::as_str) {
        Some(patch) => {
            let (patch, truncated) = clamp_text(patch);
            Ok(PrFileDiffResult::ok(PrFileDiff {
                path: wanted,
                hunks: parse_unified_patch(&patch),
                is_binary: false,
                truncated,
            }))
        }
        // No patch: binary, or a text file GitHub considered too large to inline.
        None => Ok(PrFileDiffResult::ok(PrFileDiff {
            path: wanted,
            hunks: Vec::new(),
            is_binary: changes == 0,
            truncated: changes > 0,
        })),
    }
}

/// Full text of one side of a file, backing the markdown preview and raw views.
#[tauri::command]
pub async fn github_pr_file_content(
    folder_path: String,
    pull_request_id: i64,
    path: String,
    side: String,
) -> AppResult<PrFileContentResult> {
    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };

    let field = if side == "base" {
        "baseRefOid"
    } else {
        "headRefOid"
    };
    let sha = match gh_text(
        vec![
            "pr".into(),
            "view".into(),
            pull_request_id.to_string(),
            "--json".into(),
            field.to_string(),
            "--jq".into(),
            format!(".{field}"),
        ],
        &folder_path,
    )
    .await
    {
        Ok(out) => out.trim().to_string(),
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };

    let wanted = normalize_path(&path);
    let encoded = gh_text(
        vec![
            "api".into(),
            format!(
                "repos/{}/{}/contents/{}?ref={sha}",
                remote.owner,
                remote.repo,
                encode_api_path(&wanted)
            ),
            "--jq".into(),
            ".content".into(),
        ],
        &folder_path,
    )
    .await;

    let encoded = match encoded {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };

    let cleaned: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = match BASE64.decode(cleaned.as_bytes()) {
        Ok(bytes) => bytes,
        Err(err) => {
            return Ok(PrFileContentResult::err(
                "gh-failed",
                Some(format!("Could not decode file contents: {err}")),
            ))
        }
    };

    if looks_binary(&bytes) {
        return Ok(PrFileContentResult::ok(PrFileContent {
            path: wanted,
            side,
            text: String::new(),
            is_binary: true,
            truncated: false,
        }));
    }

    let (text, truncated) = clamp_text(&String::from_utf8_lossy(&bytes));
    Ok(PrFileContentResult::ok(PrFileContent {
        path: wanted,
        side,
        text,
        is_binary: false,
        truncated,
    }))
}

/// Create a review comment thread.
///
/// With an anchor, the comment is posted against head-side lines. GitHub only accepts comments on
/// lines that appear in the diff, so the requested range is clamped to the diff; if it shares no
/// line with the diff (common for markdown preview blocks over unchanged prose), the comment falls
/// back to a PR-level comment that states the file and line range.
#[tauri::command]
pub async fn github_pr_create_thread(
    folder_path: String,
    pull_request_id: i64,
    anchor: Option<PrCommentAnchor>,
    content: String,
) -> AppResult<PrMutationResult> {
    if content.trim().is_empty() {
        return Ok(PrMutationResult::err(
            "gh-failed",
            Some("Comment body is required.".to_string()),
        ));
    }

    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let Some(anchor) = anchor else {
        return Ok(post_result(
            gh_text_with_body(
                vec!["pr".into(), "comment".into(), pull_request_id.to_string()],
                &folder_path,
                "--body-file",
                content,
            )
            .await,
        ));
    };

    let head_sha = match gh_text(
        vec![
            "pr".into(),
            "view".into(),
            pull_request_id.to_string(),
            "--json".into(),
            "headRefOid".into(),
            "--jq".into(),
            ".headRefOid".into(),
        ],
        &folder_path,
    )
    .await
    {
        Ok(out) => out.trim().to_string(),
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let file_path = normalize_path(&anchor.file_path);
    let (start, end) = anchor.range();

    let files = match github_pr_files(&remote, &folder_path, pull_request_id).await {
        Ok(files) => files,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };
    let patch = files
        .iter()
        .filter_map(Value::as_object)
        .find(|file| {
            normalize_path(file.get("filename").and_then(Value::as_str).unwrap_or("")) == file_path
        })
        .and_then(|file| file.get("patch").and_then(Value::as_str))
        .unwrap_or("");
    let commentable = commentable_head_lines(&parse_unified_patch(patch));

    let Some((start, end)) = clamp_anchor_to_diff(&commentable, start, end) else {
        // Not commentable inline — quote the location in a PR-level comment instead.
        let body = format!(
            "**`{file_path}` L{start}\u{2013}L{end}**{}\n\n{content}",
            if anchor.origin == "preview" {
                " _(markdown preview)_"
            } else {
                ""
            }
        );
        return Ok(post_result(
            gh_text_with_body(
                vec!["pr".into(), "comment".into(), pull_request_id.to_string()],
                &folder_path,
                "--body-file",
                body,
            )
            .await,
        ));
    };

    let mut body = serde_json::json!({
        "body": content,
        "commit_id": head_sha,
        "path": file_path,
        "line": end,
        "side": if anchor.is_right() { "RIGHT" } else { "LEFT" },
    });
    if end > start {
        body["start_line"] = serde_json::json!(start);
        body["start_side"] = body["side"].clone();
    }

    Ok(post_result(
        gh_text_with_body(
            vec![
                "api".into(),
                "--method".into(),
                "POST".into(),
                format!(
                    "repos/{}/{}/pulls/{pull_request_id}/comments",
                    remote.owner, remote.repo
                ),
            ],
            &folder_path,
            "--input",
            body.to_string(),
        )
        .await,
    ))
}

/// Reply to an existing review thread. GitHub replies are addressed by the thread's root comment
/// id (`RepoPrThread.id`), not by the GraphQL thread node id.
#[tauri::command]
pub async fn github_pr_reply(
    folder_path: String,
    pull_request_id: i64,
    thread_id: String,
    root_comment_id: Option<i64>,
    content: String,
) -> AppResult<PrMutationResult> {
    if content.trim().is_empty() {
        return Ok(PrMutationResult::err(
            "gh-failed",
            Some("Reply body is required.".to_string()),
        ));
    }

    let remote = match resolve_github_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let comment_id = root_comment_id
        .filter(|id| *id > 0)
        .or_else(|| thread_id.parse::<i64>().ok());
    let Some(comment_id) = comment_id else {
        return Ok(PrMutationResult::err(
            "gh-failed",
            Some("A root comment id is required to reply on GitHub.".to_string()),
        ));
    };

    let body = serde_json::json!({ "body": content });
    Ok(post_result(
        gh_text_with_body(
            vec![
                "api".into(),
                "--method".into(),
                "POST".into(),
                format!(
                    "repos/{}/{}/pulls/{pull_request_id}/comments/{comment_id}/replies",
                    remote.owner, remote.repo
                ),
            ],
            &folder_path,
            "--input",
            body.to_string(),
        )
        .await,
    ))
}

const RESOLVE_THREAD_MUTATION: &str = r#"
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}
"#;

const UNRESOLVE_THREAD_MUTATION: &str = r#"
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}
"#;

/// Resolve or unresolve a review thread. Only the GraphQL API exposes this, so `thread_id` must be
/// the thread's GraphQL node id (`RepoPrThread.providerThreadId`).
#[tauri::command]
pub async fn github_pr_set_thread_status(
    folder_path: String,
    thread_id: String,
    resolved: bool,
) -> AppResult<PrMutationResult> {
    if thread_id.trim().is_empty() {
        return Ok(PrMutationResult::err(
            "gh-failed",
            Some("threadId is required".to_string()),
        ));
    }

    let mutation = if resolved {
        RESOLVE_THREAD_MUTATION
    } else {
        UNRESOLVE_THREAD_MUTATION
    };

    Ok(post_result(
        gh_text(
            vec![
                "api".into(),
                "graphql".into(),
                "-f".into(),
                format!("query={mutation}"),
                "-f".into(),
                format!("threadId={thread_id}"),
            ],
            &folder_path,
        )
        .await,
    ))
}

/// Submit the current user's review vote.
#[tauri::command]
pub async fn github_pr_set_vote(
    folder_path: String,
    pull_request_id: i64,
    vote: String,
    content: Option<String>,
) -> AppResult<PrMutationResult> {
    let (flag, default_body) = match vote.as_str() {
        "approved" | "approvedWithSuggestions" => ("--approve", ""),
        "rejected" | "waitingForAuthor" => ("--request-changes", "Requesting changes."),
        "none" => ("--comment", "Reviewed."),
        other => {
            return Ok(PrMutationResult::err(
                "gh-failed",
                Some(format!("Unsupported vote: {other}")),
            ))
        }
    };

    let body = content.unwrap_or_default();
    let body = if body.trim().is_empty() {
        default_body.to_string()
    } else {
        body
    };

    let args = vec![
        "pr".into(),
        "review".into(),
        pull_request_id.to_string(),
        flag.to_string(),
    ];

    // `--approve` accepts an empty body; the others require one.
    let outcome = if flag == "--approve" && body == default_body {
        gh_text(args, &folder_path).await
    } else {
        gh_text_with_body(args, &folder_path, "--body-file", body).await
    };

    Ok(post_result(outcome))
}

/// Convert a fire-and-forget `gh` call into a mutation result.
fn post_result(outcome: Result<String, GhFail>) -> PrMutationResult {
    match outcome {
        Ok(_) => PrMutationResult::ok(None),
        Err((code, message)) => PrMutationResult::err(code, message),
    }
}
