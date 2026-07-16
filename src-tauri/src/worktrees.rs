use std::path::{absolute, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::error::AppResult;
use crate::git::{run_git, GitError};
use crate::sessions::SessionManager;

const MAX_NAME_LENGTH: usize = 64;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_detached: bool,
    pub is_main: bool,
    pub is_locked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CreateWorktreeResult {
    fn ok(w: Worktree) -> Self {
        Self {
            ok: true,
            worktree: Some(w),
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            worktree: None,
            error: Some(code.to_string()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorktreeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl DeleteWorktreeResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            error: Some(code.to_string()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatusResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_unreachable_commits: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl WorktreeStatusResult {
    fn ok(has_changes: bool, has_unreachable_commits: bool, folder_missing: Option<bool>) -> Self {
        Self {
            ok: true,
            has_changes: Some(has_changes),
            has_unreachable_commits: Some(has_unreachable_commits),
            folder_missing,
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            has_changes: None,
            has_unreachable_commits: None,
            folder_missing: None,
            error: Some(code.to_string()),
            message,
        }
    }
}

fn valid_name(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._-]+$").unwrap());
    re.is_match(name)
}

fn normalize(p: &str) -> String {
    absolute(p)
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

fn paths_equal(a: &str, b: &str) -> bool {
    let na = normalize(a);
    let nb = normalize(b);
    if cfg!(windows) {
        na.to_lowercase() == nb.to_lowercase()
    } else {
        na == nb
    }
}

fn parse_worktree_porcelain(stdout: &str, repository_path: &str) -> Vec<Worktree> {
    let normalized = stdout.replace("\r\n", "\n");
    let mut out = Vec::new();
    for raw in normalized.split("\n\n") {
        let block = raw.trim();
        if block.is_empty() {
            continue;
        }
        let mut path: Option<String> = None;
        let mut head = String::new();
        let mut branch: Option<String> = None;
        let mut is_detached = false;
        let mut is_locked = false;
        for line in block.split('\n') {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let r = rest.trim();
                branch = Some(
                    r.strip_prefix("refs/heads/")
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| r.to_string()),
                );
            } else if line == "detached" {
                is_detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                is_locked = true;
            }
        }
        let Some(p) = path else { continue };
        let canonical = normalize(&p);
        let is_main = paths_equal(&canonical, repository_path);
        out.push(Worktree {
            path: canonical,
            branch,
            head,
            is_detached,
            is_main,
            is_locked,
        });
    }
    out
}

async fn list_worktrees(repository_path: &str) -> Result<Vec<Worktree>, GitError> {
    let out = run_git(
        vec!["worktree".into(), "list".into(), "--porcelain".into()],
        repository_path.to_string(),
    )
    .await?;
    Ok(parse_worktree_porcelain(&out.stdout, repository_path))
}

fn compute_worktree_destination(repository_path: &str, name: &str) -> PathBuf {
    let ws = normalize(repository_path);
    let ws_path = Path::new(&ws);
    let parent = ws_path.parent().unwrap_or(Path::new("."));
    let ws_name = ws_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repository");
    parent.join(format!("{ws_name}.worktrees")).join(name)
}

async fn create_worktree(repository_path: &str, name: &str) -> CreateWorktreeResult {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_NAME_LENGTH || !valid_name(trimmed) {
        return CreateWorktreeResult::err("invalid-name", None);
    }

    let dest = compute_worktree_destination(repository_path, trimmed);
    let dest_str = dest.to_string_lossy().to_string();
    if dest.exists() {
        return CreateWorktreeResult::err(
            "already-exists",
            Some(format!("Destination already exists: {dest_str}")),
        );
    }

    if let Some(parent) = dest.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return CreateWorktreeResult::err("unknown", Some(err.to_string()));
        }
    }

    if let Err(err) = run_git(
        vec![
            "worktree".into(),
            "add".into(),
            "--detach".into(),
            dest_str.clone(),
        ],
        repository_path.to_string(),
    )
    .await
    {
        return CreateWorktreeResult::err("git-failed", Some(err.message));
    }

    let all = list_worktrees(repository_path).await.unwrap_or_default();
    match all.into_iter().find(|w| paths_equal(&w.path, &dest_str)) {
        Some(created) => CreateWorktreeResult::ok(created),
        None => CreateWorktreeResult::err(
            "unknown",
            Some("Worktree created but could not be located afterwards.".into()),
        ),
    }
}

async fn get_worktree_change_status(worktree_path: &str) -> WorktreeStatusResult {
    if !Path::new(worktree_path).exists() {
        return WorktreeStatusResult::ok(false, false, Some(true));
    }

    let porcelain = match run_git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--untracked-files=all".into(),
        ],
        worktree_path.to_string(),
    )
    .await
    {
        Ok(out) => out.stdout,
        Err(err) => return WorktreeStatusResult::err("git-failed", Some(err.message)),
    };
    let has_changes = porcelain.split('\n').any(|l| !l.trim().is_empty());

    let head = match run_git(
        vec!["rev-parse".into(), "HEAD".into()],
        worktree_path.to_string(),
    )
    .await
    {
        Ok(out) => out.stdout.trim().to_string(),
        Err(err) => return WorktreeStatusResult::err("git-failed", Some(err.message)),
    };

    let symbolic = run_git(
        vec!["symbolic-ref".into(), "--quiet".into(), "HEAD".into()],
        worktree_path.to_string(),
    )
    .await
    .ok()
    .map(|out| out.stdout.trim().to_string())
    .filter(|s| !s.is_empty());
    let is_detached = symbolic.is_none();

    let mut has_unreachable_commits = false;
    if is_detached && !head.is_empty() {
        if let Ok(out) = run_git(
            vec![
                "for-each-ref".into(),
                "--contains".into(),
                head,
                "--count=1".into(),
                "--format=%(refname)".into(),
            ],
            worktree_path.to_string(),
        )
        .await
        {
            has_unreachable_commits = out.stdout.trim().is_empty();
        }
    }

    WorktreeStatusResult::ok(has_changes, has_unreachable_commits, None)
}

async fn delete_worktree(
    repository_path: &str,
    worktree_path: &str,
    sessions: &SessionManager,
) -> DeleteWorktreeResult {
    if paths_equal(worktree_path, repository_path) {
        return DeleteWorktreeResult::err(
            "is-main",
            Some("Cannot delete the main worktree of a repository.".into()),
        );
    }

    let all = list_worktrees(repository_path).await.unwrap_or_default();
    let found = all.iter().find(|w| paths_equal(&w.path, worktree_path));
    let Some(found) = found else {
        return DeleteWorktreeResult::err(
            "not-found",
            Some(format!(
                "Worktree not registered with this repository: {worktree_path}"
            )),
        );
    };
    if found.is_locked {
        return DeleteWorktreeResult::err(
            "is-locked",
            Some(
                "Worktree is locked. Unlock it with `git worktree unlock` before deleting.".into(),
            ),
        );
    }

    if Path::new(worktree_path).exists() {
        let status = get_worktree_change_status(worktree_path).await;
        if !status.ok {
            return DeleteWorktreeResult::err("git-failed", status.message);
        }
        if status.has_changes == Some(true) {
            return DeleteWorktreeResult::err(
                "has-changes",
                Some("Worktree has uncommitted changes. Commit them before deleting.".into()),
            );
        }
        if status.has_unreachable_commits == Some(true) {
            return DeleteWorktreeResult::err(
                "unreachable-commits",
                Some(
                    "Worktree's detached HEAD has commits not reachable from any branch. \
                     Create a branch for them before deleting."
                        .into(),
                ),
            );
        }
    } else {
        if let Err(err) = run_git(
            vec!["worktree".into(), "prune".into()],
            repository_path.to_string(),
        )
        .await
        {
            return DeleteWorktreeResult::err("git-failed", Some(err.message));
        }
        let remaining = list_worktrees(repository_path).await.unwrap_or_default();
        if remaining
            .iter()
            .any(|w| paths_equal(&w.path, worktree_path))
        {
            return DeleteWorktreeResult::err(
                "git-failed",
                Some(format!(
                    "git worktree prune did not remove the stale entry for {worktree_path}."
                )),
            );
        }
        return DeleteWorktreeResult::ok();
    }

    // Release any embedded Copilot sessions rooted in this worktree before removing it, so no
    // child process keeps the folder locked. Returns only after each process tree is torn down.
    sessions.kill_sessions_for_path(worktree_path);

    match run_git(
        vec![
            "worktree".into(),
            "remove".into(),
            worktree_path.to_string(),
        ],
        repository_path.to_string(),
    )
    .await
    {
        Ok(_) => DeleteWorktreeResult::ok(),
        Err(err) => {
            let m = err.message;
            if Regex::new(r"(?i)contains modified or untracked files")
                .unwrap()
                .is_match(&m)
            {
                return DeleteWorktreeResult::err("has-changes", Some(m));
            }
            if Regex::new(r"(?i)is locked").unwrap().is_match(&m) {
                return DeleteWorktreeResult::err("is-locked", Some(m));
            }
            DeleteWorktreeResult::err("git-failed", Some(m))
        }
    }
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn worktrees_list_for_repository(repository_path: String) -> AppResult<Vec<Worktree>> {
    Ok(list_worktrees(&repository_path).await.unwrap_or_default())
}

#[tauri::command]
pub async fn worktrees_create(
    repository_path: String,
    name: String,
) -> AppResult<CreateWorktreeResult> {
    Ok(create_worktree(&repository_path, &name).await)
}

#[tauri::command]
pub async fn worktrees_delete(
    sessions: tauri::State<'_, SessionManager>,
    repository_path: String,
    worktree_path: String,
) -> AppResult<DeleteWorktreeResult> {
    Ok(delete_worktree(&repository_path, &worktree_path, &sessions).await)
}

#[tauri::command]
pub async fn worktrees_status(worktree_path: String) -> AppResult<WorktreeStatusResult> {
    Ok(get_worktree_change_status(&worktree_path).await)
}
