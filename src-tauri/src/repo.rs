use std::fs;
use std::collections::HashMap;
use std::path::{absolute, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::ado::{
    build_ado_branch_url, build_ado_commit_url, build_ado_pr_web_url, resolve_ado_remote,
};
use crate::az::{classify_az_generic_failure, run_az, AzError};
use crate::error::AppResult;
use crate::git::{run_git, GitError};

const COMMIT_FIELD_SEPARATOR: char = '\x1f';
const MAX_FULL_REF_LENGTH: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub ahead: i64,
    pub behind: i64,
    pub has_remote: bool,
    pub fetched_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatusResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RepoStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RepoStatusResult {
    fn ok(status: RepoStatus) -> Self {
        Self {
            ok: true,
            status: Some(status),
            error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_forwarded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_up_to_date: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PullResult {
    fn ok(fast_forwarded: bool, already_up_to_date: bool, message: Option<String>) -> Self {
        Self {
            ok: true,
            fast_forwarded: Some(fast_forwarded),
            already_up_to_date: Some(already_up_to_date),
            message,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            fast_forwarded: None,
            already_up_to_date: None,
            message: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleOkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SimpleOkResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CreateBranchResult {
    fn ok(branch: String) -> Self {
        Self {
            ok: true,
            branch: Some(branch),
            error: None,
            message: None,
        }
    }

    fn err(error: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            branch: None,
            error: Some(error.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingPullRequest {
    pub id: i64,
    pub title: String,
    pub web_url: String,
    pub status: String,
    /// Azure DevOps merge status: conflicts | succeeded | queued | rejectedByPolicy | notSet | failure.
    pub merge_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindPullRequestResult {
    pub ok: bool,
    pub pull_request: Option<ExistingPullRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl FindPullRequestResult {
    fn ok(pull_request: Option<ExistingPullRequest>) -> Self {
        Self {
            ok: true,
            pull_request,
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            pull_request: None,
            code: Some(code.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPullRequestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl OpenPullRequestResult {
    fn ok(pull_request_id: i64, web_url: String) -> Self {
        Self {
            ok: true,
            pull_request_id: Some(pull_request_id),
            web_url: Some(web_url),
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            pull_request_id: None,
            web_url: None,
            code: Some(code.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub is_staged: bool,
    pub is_unstaged: bool,
    pub is_untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyStatusResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub untracked: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<WorkingCopyEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl WorkingCopyStatusResult {
    fn ok(modified: i64, staged: i64, untracked: i64, entries: Vec<WorkingCopyEntry>) -> Self {
        Self {
            ok: true,
            modified: Some(modified),
            staged: Some(staged),
            untracked: Some(untracked),
            entries: Some(entries),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            modified: None,
            staged: None,
            untracked: None,
            entries: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub iso_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommitsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commits: Option<Vec<RecentCommit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ado_commit_url_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RecentCommitsResult {
    fn ok(commits: Vec<RecentCommit>, ado_commit_url_prefix: Option<String>) -> Self {
        Self {
            ok: true,
            commits: Some(commits),
            ado_commit_url_prefix,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            commits: None,
            ado_commit_url_prefix: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCommitsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commits: Option<Vec<RecentCommit>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UnpushedCommitsResult {
    fn ok(commits: Vec<RecentCommit>) -> Self {
        Self {
            ok: true,
            commits: Some(commits),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            commits: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl CommitResult {
    fn ok(commit_sha: String) -> Self {
        Self {
            ok: true,
            commit_sha: Some(commit_sha),
            error: None,
            code: None,
        }
    }

    fn err(error: impl Into<String>, code: Option<String>) -> Self {
        Self {
            ok: false,
            commit_sha: None,
            error: Some(error.into()),
            code,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOnDefaultResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RebaseOnDefaultResult {
    fn ok() -> Self {
        Self {
            ok: true,
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            code: Some(code.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectMergeStateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_head_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_onto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_heads: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DetectMergeStateResult {
    fn ok(
        state: &str,
        rebase_head_name: Option<String>,
        rebase_onto: Option<String>,
        merge_heads: Option<Vec<String>>,
    ) -> Self {
        Self {
            ok: true,
            state: Some(state.to_string()),
            rebase_head_name,
            rebase_onto,
            merge_heads,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: None,
            rebase_head_name: None,
            rebase_onto: None,
            merge_heads: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOverviewRow {
    pub path: String,
    pub branch: Option<String>,
    pub is_detached: bool,
    pub is_main: bool,
    pub is_locked: bool,
    pub is_dirty: bool,
    pub ahead: i64,
    pub behind: i64,
    pub has_remote: bool,
    pub last_commit_iso: Option<String>,
    pub last_commit_subject: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreesOverviewResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<WorktreeOverviewRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl WorktreesOverviewResult {
    fn ok(rows: Vec<WorktreeOverviewRow>) -> Self {
        Self {
            ok: true,
            rows: Some(rows),
            error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyBranchRow {
    pub name: String,
    pub last_commit_iso: Option<String>,
    pub last_commit_subject: Option<String>,
    pub has_local: bool,
    pub has_remote: bool,
    pub has_worktree: bool,
    pub worktree_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyBranchesResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<MyBranchRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl MyBranchesResult {
    fn ok(rows: Vec<MyBranchRow>) -> Self {
        Self {
            ok: true,
            rows: Some(rows),
            error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchWebUrlResult {
    pub web_url: Option<String>,
}

struct LocalWorktree {
    path: String,
    branch: Option<String>,
    is_detached: bool,
    is_main: bool,
    is_locked: bool,
}

async fn try_git(args: Vec<String>, cwd: String) -> Option<String> {
    run_git(args, cwd)
        .await
        .ok()
        .map(|out| out.stdout.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn has_remote_branch(repository_path: &str, branch: &str) -> bool {
    run_git(
        vec![
            "show-ref".into(),
            "--verify".into(),
            "--quiet".into(),
            format!("refs/remotes/origin/{branch}"),
        ],
        repository_path.to_string(),
    )
    .await
    .is_ok()
}

async fn get_repo_status(repository_path: &str, branch: &str) -> RepoStatus {
    let fetched_at = now_ms();
    let has_remote = has_remote_branch(repository_path, branch).await;
    if !has_remote {
        return RepoStatus {
            branch: branch.to_string(),
            ahead: 0,
            behind: 0,
            has_remote: false,
            fetched_at,
        };
    }

    let local_exists = run_git(
        vec![
            "show-ref".into(),
            "--verify".into(),
            "--quiet".into(),
            format!("refs/heads/{branch}"),
        ],
        repository_path.to_string(),
    )
    .await
    .is_ok();
    if !local_exists {
        return RepoStatus {
            branch: branch.to_string(),
            ahead: 0,
            behind: 0,
            has_remote: true,
            fetched_at,
        };
    }

    let counts = try_git(
        vec![
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("refs/remotes/origin/{branch}...refs/heads/{branch}"),
        ],
        repository_path.to_string(),
    )
    .await;
    let (behind, ahead) = counts
        .as_deref()
        .map(|out| {
            let mut parts = out.split_whitespace();
            let behind = parts
                .next()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            let ahead = parts
                .next()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            (behind, ahead)
        })
        .unwrap_or((0, 0));

    RepoStatus {
        branch: branch.to_string(),
        ahead,
        behind,
        has_remote: true,
        fetched_at,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sanitize_alias_fragment(raw: &str) -> String {
    static NON_ALLOWED: OnceLock<Regex> = OnceLock::new();
    static MULTI_DASH: OnceLock<Regex> = OnceLock::new();
    static EDGE: OnceLock<Regex> = OnceLock::new();

    let non_allowed = NON_ALLOWED.get_or_init(|| Regex::new(r"[^A-Za-z0-9._-]").unwrap());
    let multi_dash = MULTI_DASH.get_or_init(|| Regex::new(r"-{2,}").unwrap());
    let edge = EDGE.get_or_init(|| Regex::new(r"^[._-]+|[._-]+$").unwrap());

    let replaced = non_allowed.replace_all(raw, "-");
    let collapsed = multi_dash.replace_all(&replaced, "-");
    edge.replace_all(&collapsed, "").to_string()
}

fn is_valid_branch_name(name: &str) -> bool {
    static VALID: OnceLock<Regex> = OnceLock::new();
    VALID
        .get_or_init(|| Regex::new(r"^[A-Za-z0-9._/\-]+$").unwrap())
        .is_match(name)
}

fn sanitize_pr_title(raw: &str) -> String {
    static CONTROL: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();

    let control = CONTROL.get_or_init(|| Regex::new(r"[\x00-\x1f\x7f]").unwrap());
    let space = SPACE.get_or_init(|| Regex::new(r"\s+").unwrap());
    let cleaned = control.replace_all(raw, " ");
    let collapsed = space.replace_all(&cleaned, " ");
    let trimmed = collapsed.trim();
    if trimmed.chars().count() > 400 {
        trimmed.chars().take(400).collect()
    } else {
        trimmed.to_string()
    }
}

fn parse_commit_log(stdout: &str) -> Vec<RecentCommit> {
    stdout
        .split_terminator(&['\r', '\n'][..])
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut parts = line.split(COMMIT_FIELD_SEPARATOR);
            Some(RecentCommit {
                sha: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                iso_time: parts.next()?.to_string(),
            })
        })
        .collect()
}

fn normalize_path(path: &str) -> String {
    absolute(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn paths_equal(a: &str, b: &str) -> bool {
    let a = normalize_path(a);
    let b = normalize_path(b);
    if cfg!(windows) {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

fn parse_worktree_porcelain_local(stdout: &str, repository_path: &str) -> Vec<LocalWorktree> {
    let normalized = stdout.replace("\r\n", "\n");
    let mut worktrees = Vec::new();
    for block in normalized.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        let mut path = None;
        let mut branch = None;
        let mut is_detached = false;
        let mut is_locked = false;

        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let rest = rest.trim();
                branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
            } else if line == "detached" {
                is_detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                is_locked = true;
            }
        }

        let Some(path) = path else {
            continue;
        };
        let path = normalize_path(&path);
        worktrees.push(LocalWorktree {
            is_main: paths_equal(&path, repository_path),
            path,
            branch,
            is_detached,
            is_locked,
        });
    }
    worktrees
}

async fn list_worktrees_local(repository_path: &str) -> Vec<LocalWorktree> {
    match run_git(
        vec!["worktree".into(), "list".into(), "--porcelain".into()],
        repository_path.to_string(),
    )
    .await
    {
        Ok(out) => parse_worktree_porcelain_local(&out.stdout, repository_path),
        Err(_) => Vec::new(),
    }
}

fn az_failed_message(stdout: &str, stderr: &str, code: Option<i32>) -> String {
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        format!(
            "az exited with code {}",
            code.map_or("?".to_string(), |c| c.to_string())
        )
    }
}

fn parse_az_json(stdout: &str) -> Result<Value, serde_json::Error> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    let first_bracket = trimmed.find('[');
    let first_brace = trimmed.find('{');
    let start = match (first_bracket, first_brace) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    serde_json::from_str(start.map(|idx| &trimmed[idx..]).unwrap_or(trimmed))
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|v| v as i64))
        .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
}

async fn is_working_tree_clean(folder_path: &str) -> Result<bool, GitError> {
    let out = run_git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--untracked-files=all".into(),
        ],
        folder_path.to_string(),
    )
    .await?;
    Ok(out.stdout.trim().is_empty())
}

fn git_error_message(err: GitError) -> String {
    err.message
}

#[tauri::command]
pub async fn repo_default_branch(repository_path: String) -> AppResult<Option<String>> {
    if let Some(symbolic) = try_git(
        vec![
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "refs/remotes/origin/HEAD".into(),
        ],
        repository_path.clone(),
    )
    .await
    {
        return Ok(Some(
            symbolic
                .strip_prefix("origin/")
                .unwrap_or(&symbolic)
                .to_string(),
        ));
    }

    if let Some(ls_remote) = try_git(
        vec![
            "ls-remote".into(),
            "--symref".into(),
            "origin".into(),
            "HEAD".into(),
        ],
        repository_path.clone(),
    )
    .await
    {
        if let Some(line) = ls_remote.lines().find(|line| line.starts_with("ref:")) {
            static HEAD_RE: OnceLock<Regex> = OnceLock::new();
            let head_re =
                HEAD_RE.get_or_init(|| Regex::new(r"^ref:\s+refs/heads/(\S+)\s+HEAD$").unwrap());
            if let Some(caps) = head_re.captures(line) {
                return Ok(caps.get(1).map(|m| m.as_str().to_string()));
            }
        }
    }

    for candidate in ["main", "master"] {
        if run_git(
            vec![
                "show-ref".into(),
                "--verify".into(),
                "--quiet".into(),
                format!("refs/heads/{candidate}"),
            ],
            repository_path.clone(),
        )
        .await
        .is_ok()
        {
            return Ok(Some(candidate.to_string()));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn repo_current_branch(folder_path: String) -> AppResult<Option<String>> {
    let branch = try_git(
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        folder_path,
    )
    .await;
    Ok(branch.filter(|value| value != "HEAD"))
}

#[tauri::command]
pub async fn repo_status(repository_path: String, branch: String) -> AppResult<RepoStatusResult> {
    Ok(RepoStatusResult::ok(
        get_repo_status(&repository_path, &branch).await,
    ))
}

#[tauri::command]
pub async fn repo_fetch(
    repository_path: String,
    branch: Option<String>,
) -> AppResult<SimpleOkResult> {
    let mut args = vec!["fetch".to_string(), "origin".to_string()];
    if let Some(branch) = branch.filter(|b| !b.is_empty()) {
        args.push(branch);
    }
    Ok(match run_git(args, repository_path).await {
        Ok(_) => SimpleOkResult::ok(),
        Err(err) => SimpleOkResult::err(git_error_message(err)),
    })
}

#[tauri::command]
pub async fn repo_pull(repository_path: String, branch: String) -> AppResult<PullResult> {
    let current = repo_current_branch(repository_path.clone()).await?;
    if current.as_deref() == Some(branch.as_str()) {
        return Ok(
            match run_git(
                vec!["pull".into(), "--ff-only".into(), "origin".into(), branch],
                repository_path,
            )
            .await
            {
                Ok(out) => {
                    static UP_TO_DATE: OnceLock<Regex> = OnceLock::new();
                    let re = UP_TO_DATE
                        .get_or_init(|| Regex::new(r"(?i)already up[\s-]?to[\s-]?date").unwrap());
                    let already_up_to_date = re.is_match(&out.stdout);
                    PullResult::ok(
                        !already_up_to_date,
                        already_up_to_date,
                        Some(out.stdout.trim().to_string()),
                    )
                }
                Err(err) => PullResult::err(git_error_message(err)),
            },
        );
    }

    Ok(
        match run_git(
            vec![
                "fetch".into(),
                "origin".into(),
                format!("{branch}:{branch}"),
            ],
            repository_path,
        )
        .await
        {
            Ok(_) => PullResult::ok(true, false, None),
            Err(err) => {
                let message = err.message;
                static OTHER_WORKTREE: OnceLock<Regex> = OnceLock::new();
                let re = OTHER_WORKTREE.get_or_init(|| {
                    Regex::new(r"(?i)already checked out|refusing to fetch").unwrap()
                });
                if re.is_match(&message) {
                    PullResult::err(format!(
                    "Cannot update {branch}: it is checked out in another worktree. Switch to it and pull manually."
                ))
                } else {
                    PullResult::err(message)
                }
            }
        },
    )
}

#[tauri::command]
pub async fn repo_pull_current_branch(folder_path: String) -> AppResult<PullResult> {
    Ok(
        match run_git(vec!["pull".into(), "--ff-only".into()], folder_path).await {
            Ok(out) => {
                static UP_TO_DATE: OnceLock<Regex> = OnceLock::new();
                let re = UP_TO_DATE
                    .get_or_init(|| Regex::new(r"(?i)already up[\s-]?to[\s-]?date").unwrap());
                let already_up_to_date = re.is_match(&out.stdout);
                PullResult::ok(
                    !already_up_to_date,
                    already_up_to_date,
                    Some(out.stdout.trim().to_string()),
                )
            }
            Err(err) => {
                static NO_UPSTREAM: OnceLock<Regex> = OnceLock::new();
                let re = NO_UPSTREAM.get_or_init(|| {
                    Regex::new(
                        r"(?i)no tracking information|no upstream|There is no tracking information",
                    )
                    .unwrap()
                });
                if re.is_match(&err.message) {
                    PullResult::err(
                        "No upstream configured for this branch. Push it first to set an upstream.",
                    )
                } else {
                    PullResult::err(err.message)
                }
            }
        },
    )
}

#[tauri::command]
pub async fn repo_user_alias(repository_path: String) -> AppResult<String> {
    Ok(resolve_user_alias(&repository_path).await)
}

async fn resolve_user_alias(repository_path: &str) -> String {
    if let Some(email) = try_git(
        vec!["config".into(), "--get".into(), "user.email".into()],
        repository_path.to_string(),
    )
    .await
    {
        let local = email.split('@').next().unwrap_or("");
        let cleaned = sanitize_alias_fragment(local);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    let fallback = sanitize_alias_fragment(
        &std::env::var("USERNAME")
            .ok()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_default(),
    );
    if fallback.is_empty() {
        "user".to_string()
    } else {
        fallback
    }
}

#[tauri::command]
pub async fn repo_create_branch(
    folder_path: String,
    name: String,
) -> AppResult<CreateBranchResult> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_FULL_REF_LENGTH
        || !is_valid_branch_name(trimmed)
        || trimmed.contains("..")
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
    {
        return Ok(CreateBranchResult::err(
            "invalid-name",
            Some("Invalid branch name.".to_string()),
        ));
    }

    Ok(
        match run_git(
            vec!["switch".into(), "-c".into(), trimmed.to_string()],
            folder_path,
        )
        .await
        {
            Ok(_) => CreateBranchResult::ok(trimmed.to_string()),
            Err(err) => {
                if err.message.to_ascii_lowercase().contains("already exists") {
                    CreateBranchResult::err("already-exists", Some(err.message))
                } else {
                    CreateBranchResult::err("git-failed", Some(err.message))
                }
            }
        },
    )
}

#[tauri::command]
pub async fn repo_open_pull_request(
    app: AppHandle,
    folder_path: String,
) -> AppResult<OpenPullRequestResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(OpenPullRequestResult::err(code, message)),
    };

    let current_branch = match repo_current_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => return Ok(OpenPullRequestResult::err("detached", None)),
    };
    let default_branch = match repo_default_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => return Ok(OpenPullRequestResult::err("no-default-branch", None)),
    };
    if current_branch == default_branch {
        return Ok(OpenPullRequestResult::err("same-as-default", None));
    }

    let dirty = match run_git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--untracked-files=all".into(),
        ],
        folder_path.clone(),
    )
    .await
    {
        Ok(out) => out.stdout,
        Err(err) => return Ok(OpenPullRequestResult::err("git-failed", Some(err.message))),
    };
    if !dirty.trim().is_empty() {
        return Ok(OpenPullRequestResult::err("uncommitted", None));
    }

    match run_git(
        vec![
            "fetch".into(),
            "origin".into(),
            format!("refs/heads/{current_branch}:refs/remotes/origin/{current_branch}"),
        ],
        folder_path.clone(),
    )
    .await
    {
        Ok(_) => {}
        Err(err) => {
            static NO_REMOTE_REF: OnceLock<Regex> = OnceLock::new();
            let re = NO_REMOTE_REF.get_or_init(|| {
                Regex::new(r"(?i)couldn't find remote ref|does not exist|not our ref").unwrap()
            });
            if re.is_match(&err.message) {
                return Ok(OpenPullRequestResult::err(
                    "no-remote-branch",
                    Some(err.message),
                ));
            }
            return Ok(OpenPullRequestResult::err(
                "fetch-failed",
                Some(err.message),
            ));
        }
    }

    let status = get_repo_status(&folder_path, &current_branch).await;
    if !status.has_remote {
        return Ok(OpenPullRequestResult::err("no-remote-branch", None));
    }
    if status.ahead > 0 {
        return Ok(OpenPullRequestResult::err("unpushed", None));
    }

    let mut title = current_branch.clone();
    if let Ok(out) = run_git(
        vec![
            "log".into(),
            "-1".into(),
            "--pretty=%s".into(),
            "HEAD".into(),
        ],
        folder_path.clone(),
    )
    .await
    {
        let subject = sanitize_pr_title(&out.stdout);
        if !subject.is_empty() {
            title = subject;
        }
    }

    let output = match run_az(vec![
        "repos".into(),
        "pr".into(),
        "create".into(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--project".into(),
        remote.project.clone(),
        "--repository".into(),
        remote.repo.clone(),
        "--source-branch".into(),
        current_branch.clone(),
        "--target-branch".into(),
        default_branch.clone(),
        "--title".into(),
        title,
        "--draft".into(),
        "true".into(),
        "--output".into(),
        "json".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(AzError::NotInstalled) => {
            return Ok(OpenPullRequestResult::err(
                "az-not-installed",
                Some("Azure CLI (az) was not found on PATH.".to_string()),
            ))
        }
        Err(AzError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                return Ok(OpenPullRequestResult::err(code, Some(message)));
            }
            static ALREADY_EXISTS: OnceLock<Regex> = OnceLock::new();
            let re = ALREADY_EXISTS.get_or_init(|| {
                Regex::new(r"(?i)TF401179|active pull request[^.]*already exists").unwrap()
            });
            if re.is_match(&stderr) {
                return Ok(OpenPullRequestResult::err(
                    "az-pr-exists",
                    Some("A PR already exists for this source/target.".to_string()),
                ));
            }
            return Ok(OpenPullRequestResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_az_json(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(OpenPullRequestResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };
    let pull_request_id = parsed
        .get("pullRequestId")
        .and_then(json_i64)
        .or_else(|| parsed.get("codeReviewId").and_then(json_i64))
        .unwrap_or(0);
    if pull_request_id <= 0 {
        return Ok(OpenPullRequestResult::err(
            "az-failed",
            Some("az output missing pullRequestId.".to_string()),
        ));
    }

    let web_url = build_ado_pr_web_url(&remote, pull_request_id);
    let _ = app.opener().open_url(web_url.as_str(), None::<&str>);
    Ok(OpenPullRequestResult::ok(pull_request_id, web_url))
}

#[tauri::command]
pub async fn repo_find_active_pull_request(
    folder_path: String,
) -> AppResult<FindPullRequestResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(FindPullRequestResult::err(code, message)),
    };

    let current_branch = match repo_current_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => return Ok(FindPullRequestResult::err("detached", None)),
    };
    let default_branch = match repo_default_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => return Ok(FindPullRequestResult::err("no-default-branch", None)),
    };
    if current_branch == default_branch {
        return Ok(FindPullRequestResult::err("same-as-default", None));
    }

    let output = match run_az(vec![
        "repos".into(),
        "pr".into(),
        "list".into(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--project".into(),
        remote.project.clone(),
        "--repository".into(),
        remote.repo.clone(),
        "--source-branch".into(),
        format!("refs/heads/{current_branch}"),
        "--target-branch".into(),
        format!("refs/heads/{default_branch}"),
        "--status".into(),
        "active".into(),
        "--output".into(),
        "json".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(AzError::NotInstalled) => {
            return Ok(FindPullRequestResult::err(
                "az-not-installed",
                Some("Azure CLI (az) was not found on PATH.".to_string()),
            ))
        }
        Err(AzError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                return Ok(FindPullRequestResult::err(code, Some(message)));
            }
            return Ok(FindPullRequestResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_az_json(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(FindPullRequestResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };
    let Some(items) = parsed.as_array() else {
        return Ok(FindPullRequestResult::ok(None));
    };
    let Some(first) = items.first().and_then(Value::as_object) else {
        return Ok(FindPullRequestResult::ok(None));
    };

    let id = first
        .get("pullRequestId")
        .and_then(json_i64)
        .or_else(|| first.get("codeReviewId").and_then(json_i64))
        .unwrap_or(0);
    if id <= 0 {
        return Ok(FindPullRequestResult::ok(None));
    }

    Ok(FindPullRequestResult::ok(Some(ExistingPullRequest {
        id,
        title: first
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        web_url: build_ado_pr_web_url(&remote, id),
        status: first
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            .to_string(),
        merge_status: first
            .get("mergeStatus")
            .and_then(Value::as_str)
            .unwrap_or("notSet")
            .to_string(),
    })))
}

#[tauri::command]
pub async fn repo_working_copy_status(folder_path: String) -> AppResult<WorkingCopyStatusResult> {
    let output = match run_git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--untracked-files=all".into(),
        ],
        folder_path,
    )
    .await
    {
        Ok(output) => output.stdout,
        Err(err) => return Ok(WorkingCopyStatusResult::err(err.message)),
    };

    let tokens: Vec<&str> = output.split('\0').collect();
    let mut modified = 0;
    let mut staged = 0;
    let mut untracked = 0;
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < tokens.len() {
        let token = tokens[i];
        if token.len() < 3 {
            i += 1;
            continue;
        }
        let bytes = token.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = token[3..].to_string();
        let is_untracked = x == '?' && y == '?';
        let is_staged = !is_untracked && x != ' ' && x != '?';
        let is_unstaged = !is_untracked && y != ' ' && y != '?';

        if is_untracked {
            untracked += 1;
        }
        if is_staged {
            staged += 1;
        }
        if is_unstaged {
            modified += 1;
        }

        let mut original_path = None;
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            if i + 1 < tokens.len() {
                original_path = Some(tokens[i + 1].to_string());
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }

        entries.push(WorkingCopyEntry {
            path,
            original_path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            is_staged,
            is_unstaged,
            is_untracked,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_untracked != b.is_untracked {
            if a.is_untracked {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        } else {
            a.path.cmp(&b.path)
        }
    });

    Ok(WorkingCopyStatusResult::ok(
        modified, staged, untracked, entries,
    ))
}

#[tauri::command]
pub async fn repo_recent_commits(
    folder_path: String,
    limit: Option<u32>,
) -> AppResult<RecentCommitsResult> {
    let limit = limit.filter(|v| *v > 0).map(|v| v.min(100)).unwrap_or(10);
    let output = match run_git(
        vec![
            "log".into(),
            "-n".into(),
            limit.to_string(),
            "--pretty=format:%H%x1f%s%x1f%an%x1f%aI".into(),
        ],
        folder_path.clone(),
    )
    .await
    {
        Ok(output) => output.stdout,
        Err(err) => {
            static EMPTY_HISTORY: OnceLock<Regex> = OnceLock::new();
            let re = EMPTY_HISTORY.get_or_init(|| {
                Regex::new(r"(?i)does not have any commits yet|bad default revision").unwrap()
            });
            if re.is_match(&err.message) {
                return Ok(RecentCommitsResult::ok(Vec::new(), None));
            }
            return Ok(RecentCommitsResult::err(err.message));
        }
    };

    let commits = parse_commit_log(&output);
    let ado_commit_url_prefix = resolve_ado_remote(&folder_path)
        .await
        .ok()
        .map(|remote| build_ado_commit_url(&remote, ""));
    Ok(RecentCommitsResult::ok(commits, ado_commit_url_prefix))
}

#[tauri::command]
pub async fn repo_rebase_on_default(
    folder_path: String,
    repository_path: Option<String>,
) -> AppResult<RebaseOnDefaultResult> {
    match is_working_tree_clean(&folder_path).await {
        Ok(true) => {}
        Ok(false) => return Ok(RebaseOnDefaultResult::err("dirty", None)),
        Err(err) => return Ok(RebaseOnDefaultResult::err("git-failed", Some(err.message))),
    }

    let current_branch = match repo_current_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => {
            return Ok(RebaseOnDefaultResult::err(
                "git-failed",
                Some("Cannot rebase: HEAD is detached. Create a branch first.".to_string()),
            ))
        }
    };
    let default_branch = match repo_default_branch(folder_path.clone()).await? {
        Some(branch) => branch,
        None => return Ok(RebaseOnDefaultResult::err("no-default-branch", None)),
    };

    if let Some(repository_path) = repository_path.filter(|path| path != &folder_path) {
        let pulled = repo_pull(repository_path, default_branch.clone()).await?;
        if !pulled.ok {
            return Ok(RebaseOnDefaultResult::err("pull-failed", pulled.error));
        }
    }

    if let Err(err) = run_git(
        vec!["fetch".into(), "origin".into(), default_branch.clone()],
        folder_path.clone(),
    )
    .await
    {
        return Ok(RebaseOnDefaultResult::err(
            "fetch-failed",
            Some(err.message),
        ));
    }

    if current_branch == default_branch {
        return Ok(
            match run_git(
                vec![
                    "merge".into(),
                    "--ff-only".into(),
                    format!("origin/{default_branch}"),
                ],
                folder_path,
            )
            .await
            {
                Ok(_) => RebaseOnDefaultResult::ok(),
                Err(err) => RebaseOnDefaultResult::err("pull-failed", Some(err.message)),
            },
        );
    }

    Ok(
        match run_git(
            vec!["rebase".into(), format!("origin/{default_branch}")],
            folder_path,
        )
        .await
        {
            Ok(_) => RebaseOnDefaultResult::ok(),
            Err(err) => {
                static CONFLICTS: OnceLock<Regex> = OnceLock::new();
                let re = CONFLICTS.get_or_init(|| {
                    Regex::new(r"(?i)conflict|could not apply|resolve all conflicts").unwrap()
                });
                if re.is_match(&err.message) {
                    RebaseOnDefaultResult::err("conflicts", Some(err.message))
                } else {
                    RebaseOnDefaultResult::err("rebase-failed", Some(err.message))
                }
            }
        },
    )
}

#[tauri::command]
pub async fn repo_unpushed_commits(
    folder_path: String,
    branch: String,
) -> AppResult<UnpushedCommitsResult> {
    let args = if has_remote_branch(&folder_path, &branch).await {
        vec![
            "log".into(),
            "-n".into(),
            "50".into(),
            "--pretty=format:%H%x1f%s%x1f%an%x1f%aI".into(),
            format!("refs/remotes/origin/{branch}..HEAD"),
        ]
    } else {
        vec![
            "log".into(),
            "-n".into(),
            "50".into(),
            "--pretty=format:%H%x1f%s%x1f%an%x1f%aI".into(),
            "HEAD".into(),
        ]
    };

    Ok(match run_git(args, folder_path).await {
        Ok(out) => UnpushedCommitsResult::ok(parse_commit_log(&out.stdout)),
        Err(err) => UnpushedCommitsResult::err(err.message),
    })
}

#[tauri::command]
pub async fn repo_push(folder_path: String) -> AppResult<SimpleOkResult> {
    Ok(
        match run_git(
            vec!["push".into(), "-u".into(), "origin".into(), "HEAD".into()],
            folder_path,
        )
        .await
        {
            Ok(_) => SimpleOkResult::ok(),
            Err(err) => SimpleOkResult::err(err.message),
        },
    )
}

#[tauri::command]
pub async fn repo_stage_files(
    folder_path: String,
    files: Vec<String>,
) -> AppResult<SimpleOkResult> {
    if files.is_empty() {
        return Ok(SimpleOkResult::err("No files specified."));
    }
    let mut args = vec!["add".into(), "-A".into(), "--".into()];
    args.extend(files);
    Ok(match run_git(args, folder_path).await {
        Ok(_) => SimpleOkResult::ok(),
        Err(err) => SimpleOkResult::err(err.message),
    })
}

#[tauri::command]
pub async fn repo_unstage_files(
    folder_path: String,
    files: Vec<String>,
) -> AppResult<SimpleOkResult> {
    if files.is_empty() {
        return Ok(SimpleOkResult::err("No files specified."));
    }

    let has_head = run_git(
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        folder_path.clone(),
    )
    .await
    .is_ok();

    let mut args = if has_head {
        vec!["reset".into(), "HEAD".into(), "--".into()]
    } else {
        vec!["rm".into(), "--cached".into(), "--".into()]
    };
    args.extend(files);

    Ok(match run_git(args, folder_path).await {
        Ok(_) => SimpleOkResult::ok(),
        Err(err) => SimpleOkResult::err(err.message),
    })
}

#[tauri::command]
pub async fn repo_revert_files(
    folder_path: String,
    files: Vec<String>,
    is_untracked: bool,
) -> AppResult<SimpleOkResult> {
    if files.is_empty() {
        return Ok(SimpleOkResult::err("No files specified."));
    }

    if is_untracked {
        let mut args = vec!["clean".into(), "-fd".into(), "--".into()];
        args.extend(files);
        return Ok(match run_git(args, folder_path).await {
            Ok(_) => SimpleOkResult::ok(),
            Err(err) => SimpleOkResult::err(err.message),
        });
    }

    let has_head = run_git(
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        folder_path.clone(),
    )
    .await
    .is_ok();

    if has_head {
        let mut args = vec![
            "restore".into(),
            "--source=HEAD".into(),
            "--staged".into(),
            "--worktree".into(),
            "--".into(),
        ];
        args.extend(files);
        return Ok(match run_git(args, folder_path).await {
            Ok(_) => SimpleOkResult::ok(),
            Err(err) => SimpleOkResult::err(err.message),
        });
    }

    let mut rm_args = vec![
        "rm".into(),
        "-f".into(),
        "--cached".into(),
        "--ignore-unmatch".into(),
        "--".into(),
    ];
    rm_args.extend(files.clone());
    if let Err(err) = run_git(rm_args, folder_path.clone()).await {
        return Ok(SimpleOkResult::err(err.message));
    }
    let mut clean_args = vec!["clean".into(), "-fd".into(), "--".into()];
    clean_args.extend(files);
    Ok(match run_git(clean_args, folder_path).await {
        Ok(_) => SimpleOkResult::ok(),
        Err(err) => SimpleOkResult::err(err.message),
    })
}

#[tauri::command]
pub async fn repo_discard_all_changes(folder_path: String) -> AppResult<SimpleOkResult> {
    let has_head = run_git(
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        folder_path.clone(),
    )
    .await
    .is_ok();

    if has_head {
        if let Err(err) = run_git(
            vec!["reset".into(), "--hard".into(), "HEAD".into()],
            folder_path.clone(),
        )
        .await
        {
            return Ok(SimpleOkResult::err(err.message));
        }
    } else if let Err(err) = run_git(
        vec![
            "rm".into(),
            "-rf".into(),
            "--cached".into(),
            "--ignore-unmatch".into(),
            ".".into(),
        ],
        folder_path.clone(),
    )
    .await
    {
        return Ok(SimpleOkResult::err(err.message));
    }

    Ok(
        match run_git(vec!["clean".into(), "-fd".into()], folder_path).await {
            Ok(_) => SimpleOkResult::ok(),
            Err(err) => SimpleOkResult::err(err.message),
        },
    )
}

#[tauri::command]
pub async fn repo_commit(
    folder_path: String,
    message: String,
    stage_all: Option<bool>,
) -> AppResult<CommitResult> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Ok(CommitResult::err(
            "Commit message is required.",
            Some("empty-message".to_string()),
        ));
    }

    if stage_all.unwrap_or(false) {
        if let Err(err) = run_git(vec!["add".into(), "-A".into()], folder_path.clone()).await {
            return Ok(CommitResult::err(
                err.message,
                Some("git-failed".to_string()),
            ));
        }
    }

    if let Err(err) = run_git(
        vec!["commit".into(), "-m".into(), trimmed.to_string()],
        folder_path.clone(),
    )
    .await
    {
        static NOTHING: OnceLock<Regex> = OnceLock::new();
        let re = NOTHING.get_or_init(|| {
            Regex::new(r"(?i)nothing to commit|no changes added to commit|nothing added to commit")
                .unwrap()
        });
        let combined = format!("{}\n{}", err.stderr, err.message);
        if re.is_match(&combined) {
            return Ok(CommitResult::err(
                "Nothing to commit.",
                Some("nothing-to-commit".to_string()),
            ));
        }
        return Ok(CommitResult::err(
            err.message,
            Some("git-failed".to_string()),
        ));
    }

    Ok(
        match run_git(vec!["rev-parse".into(), "HEAD".into()], folder_path).await {
            Ok(out) => CommitResult::ok(out.stdout.trim().to_string()),
            Err(err) => CommitResult::err(err.message, Some("git-failed".to_string())),
        },
    )
}

#[tauri::command]
pub async fn repo_worktrees_overview(repository_path: String) -> AppResult<WorktreesOverviewResult> {
    let worktrees = list_worktrees_local(&repository_path).await;
    let mut rows = Vec::new();
    for worktree in worktrees {
        let is_dirty = try_git(
            vec![
                "status".into(),
                "--porcelain=v1".into(),
                "--untracked-files=all".into(),
            ],
            worktree.path.clone(),
        )
        .await
        .map(|output| !output.trim().is_empty())
        .unwrap_or(false);

        let (has_remote, ahead, behind) = if let Some(branch) = &worktree.branch {
            let has_remote = has_remote_branch(&worktree.path, branch).await;
            if has_remote {
                let status = get_repo_status(&worktree.path, branch).await;
                (true, status.ahead, status.behind)
            } else {
                (false, 0, 0)
            }
        } else {
            (false, 0, 0)
        };

        let (last_commit_iso, last_commit_subject) = try_git(
            vec![
                "log".into(),
                "-1".into(),
                format!("--pretty=format:%aI{COMMIT_FIELD_SEPARATOR}%s"),
            ],
            worktree.path.clone(),
        )
        .await
        .map(|log| {
            let mut parts = log.split(COMMIT_FIELD_SEPARATOR);
            (
                parts.next().filter(|s| !s.is_empty()).map(str::to_string),
                {
                    let rest: Vec<&str> = parts.collect();
                    if rest.is_empty() {
                        None
                    } else {
                        Some(rest.join(&COMMIT_FIELD_SEPARATOR.to_string()))
                    }
                },
            )
        })
        .unwrap_or((None, None));

        rows.push(WorktreeOverviewRow {
            path: worktree.path,
            branch: worktree.branch,
            is_detached: worktree.is_detached,
            is_main: worktree.is_main,
            is_locked: worktree.is_locked,
            is_dirty,
            ahead,
            behind,
            has_remote,
            last_commit_iso,
            last_commit_subject,
        });
    }

    Ok(WorktreesOverviewResult::ok(rows))
}

#[tauri::command]
pub async fn repo_list_my_branches(repository_path: String) -> AppResult<MyBranchesResult> {
    let alias = resolve_user_alias(&repository_path).await;
    let prefix = format!("users/{alias}/");

    let format_arg = format!(
        "--format=%(refname:short){COMMIT_FIELD_SEPARATOR}%(committerdate:iso-strict){COMMIT_FIELD_SEPARATOR}%(contents:subject)"
    );

    // Ordered map keyed by logical branch name (origin/ stripped) to keep stable de-dup.
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, MyBranchRow> = HashMap::new();

    let local_ref = format!("refs/heads/{prefix}");
    if let Some(output) = try_git(
        vec![
            "for-each-ref".into(),
            format_arg.clone(),
            local_ref,
        ],
        repository_path.clone(),
    )
    .await
    {
        for line in output.lines() {
            let (name, iso, subject) = parse_branch_ref_line(line);
            if name.is_empty() {
                continue;
            }
            let entry = map.entry(name.clone()).or_insert_with(|| {
                order.push(name.clone());
                MyBranchRow {
                    name: name.clone(),
                    last_commit_iso: None,
                    last_commit_subject: None,
                    has_local: false,
                    has_remote: false,
                    has_worktree: false,
                    worktree_path: None,
                }
            });
            entry.has_local = true;
            entry.last_commit_iso = iso;
            entry.last_commit_subject = subject;
        }
    }

    let remote_ref = format!("refs/remotes/origin/{prefix}");
    if let Some(output) = try_git(
        vec!["for-each-ref".into(), format_arg, remote_ref],
        repository_path.clone(),
    )
    .await
    {
        for line in output.lines() {
            let (raw_name, iso, subject) = parse_branch_ref_line(line);
            // raw_name looks like "origin/users/<alias>/<suffix>"; strip the remote prefix.
            let name = raw_name
                .strip_prefix("origin/")
                .unwrap_or(&raw_name)
                .to_string();
            if name.is_empty() {
                continue;
            }
            let entry = map.entry(name.clone()).or_insert_with(|| {
                order.push(name.clone());
                MyBranchRow {
                    name: name.clone(),
                    last_commit_iso: None,
                    last_commit_subject: None,
                    has_local: false,
                    has_remote: false,
                    has_worktree: false,
                    worktree_path: None,
                }
            });
            entry.has_remote = true;
            if entry.last_commit_iso.is_none() {
                entry.last_commit_iso = iso;
                entry.last_commit_subject = subject;
            }
        }
    }

    // Mark branches that are checked out in a worktree.
    for worktree in list_worktrees_local(&repository_path).await {
        if let Some(branch) = worktree.branch {
            if let Some(entry) = map.get_mut(&branch) {
                entry.has_worktree = true;
                entry.worktree_path = Some(worktree.path);
            }
        }
    }

    let mut rows: Vec<MyBranchRow> = order
        .into_iter()
        .filter_map(|name| map.remove(&name))
        .collect();
    // Newest commit first; rows without a date sink to the bottom.
    rows.sort_by(|a, b| {
        b.last_commit_iso
            .as_deref()
            .unwrap_or("")
            .cmp(a.last_commit_iso.as_deref().unwrap_or(""))
    });

    Ok(MyBranchesResult::ok(rows))
}

fn parse_branch_ref_line(line: &str) -> (String, Option<String>, Option<String>) {
    let mut parts = line.split(COMMIT_FIELD_SEPARATOR);
    let name = parts.next().unwrap_or("").trim().to_string();
    let iso = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let subject = {
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() {
            None
        } else {
            let joined = rest.join(&COMMIT_FIELD_SEPARATOR.to_string());
            if joined.is_empty() {
                None
            } else {
                Some(joined)
            }
        }
    };
    (name, iso, subject)
}

#[tauri::command]
pub async fn repo_branch_web_url(
    folder_path: String,
    branch: String,
) -> AppResult<BranchWebUrlResult> {
    let web_url = resolve_ado_remote(&folder_path)
        .await
        .ok()
        .map(|remote| build_ado_branch_url(&remote, &branch));
    Ok(BranchWebUrlResult { web_url })
}

#[tauri::command]
pub async fn repo_detect_merge_state(folder_path: String) -> AppResult<DetectMergeStateResult> {
    let git_dir_raw = match try_git(
        vec!["rev-parse".into(), "--git-dir".into()],
        folder_path.clone(),
    )
    .await
    {
        Some(dir) => dir,
        None => return Ok(DetectMergeStateResult::err("Not a git repository.")),
    };

    let git_dir = if Path::new(&git_dir_raw).is_absolute() {
        PathBuf::from(git_dir_raw)
    } else {
        Path::new(&folder_path).join(git_dir_raw)
    };

    let rebase_merge_dir = git_dir.join("rebase-merge");
    let rebase_apply_dir = git_dir.join("rebase-apply");
    let merge_head_file = git_dir.join("MERGE_HEAD");

    if rebase_merge_dir.exists() || rebase_apply_dir.exists() {
        let dir = if rebase_merge_dir.exists() {
            rebase_merge_dir
        } else {
            rebase_apply_dir
        };
        let rebase_head_name = read_file_trimmed(dir.join("head-name"));
        let rebase_onto = read_file_trimmed(dir.join("onto"));
        return Ok(DetectMergeStateResult::ok(
            "rebase",
            rebase_head_name,
            rebase_onto,
            None,
        ));
    }

    if merge_head_file.exists() {
        let merge_heads = read_file_trimmed(&merge_head_file)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        return Ok(DetectMergeStateResult::ok(
            "merge",
            None,
            None,
            Some(merge_heads),
        ));
    }

    Ok(DetectMergeStateResult::ok("none", None, None, None))
}

fn read_file_trimmed(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|contents| contents.trim().to_string())
        .filter(|contents| !contents.is_empty())
}
