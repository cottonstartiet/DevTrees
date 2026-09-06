use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::{
    ado, copilot_history, github, repo, repositories, system, tasks, terminal_sessions, updater,
    worktrees,
};

use super::{allowed_origin, auth};

pub async fn health(State(app): State<AppHandle>) -> Json<Value> {
    let state = app.state::<AppState>();
    let database_ready = state.db.0.try_lock().is_ok();
    Json(serde_json::json!({
        "ok": true,
        "databaseReady": database_ready
    }))
}

pub async fn dispatch(
    State(app): State<AppHandle>,
    Path((domain, operation)): Path<(String, String)>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    let host_state = app.state::<AppState>();
    if auth::authenticated(&host_state, &headers).is_none() {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    let origin_valid = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|origin| allowed_origin(&host_state, origin))
        .unwrap_or(false);
    if !origin_valid {
        return error(StatusCode::FORBIDDEN, "Invalid request origin.");
    }
    if !auth::csrf_valid(&host_state, &headers) {
        return error(StatusCode::FORBIDDEN, "Invalid CSRF token.");
    }

    let command = format!("{domain}/{operation}");
    let result: AppResult<Value> = async {
        match command.as_str() {
            "repositories/list" => {
                json(repositories::repositories_list(app.state::<DbState>()).await)
            }
            "repositories/remove" => json(
                repositories::repositories_remove(app.state::<DbState>(), arg(&args, "id")?).await,
            ),
            "repositories/reorder" => json(
                repositories::repositories_reorder(
                    app.state::<DbState>(),
                    arg(&args, "orderedIds")?,
                )
                .await,
            ),
            "repositories/pick-and-add" => json(
                repositories::repositories_pick_and_add(app.clone(), app.state::<DbState>()).await,
            ),
            "worktrees/list-for-repository" => {
                json(worktrees::worktrees_list_for_repository(arg(&args, "repositoryPath")?).await)
            }
            "worktrees/create" => json(
                worktrees::worktrees_create(arg(&args, "repositoryPath")?, arg(&args, "name")?)
                    .await,
            ),
            "worktrees/delete" => json(
                worktrees::worktrees_delete(
                    arg(&args, "repositoryPath")?,
                    arg(&args, "worktreePath")?,
                )
                .await,
            ),
            "worktrees/status" => {
                json(worktrees::worktrees_status(arg(&args, "worktreePath")?).await)
            }
            "repo/default-branch" => {
                json(repo::repo_default_branch(arg(&args, "repositoryPath")?).await)
            }
            "repo/current-branch" => {
                json(repo::repo_current_branch(arg(&args, "folderPath")?).await)
            }
            "repo/status" => {
                json(repo::repo_status(arg(&args, "repositoryPath")?, arg(&args, "branch")?).await)
            }
            "repo/fetch" => json(
                repo::repo_fetch(arg(&args, "repositoryPath")?, optional(&args, "branch")?).await,
            ),
            "repo/pull" => {
                json(repo::repo_pull(arg(&args, "repositoryPath")?, arg(&args, "branch")?).await)
            }
            "repo/pull-current-branch" => {
                json(repo::repo_pull_current_branch(arg(&args, "folderPath")?).await)
            }
            "repo/user-alias" => json(repo::repo_user_alias(arg(&args, "repositoryPath")?).await),
            "repo/create-branch" => {
                json(repo::repo_create_branch(arg(&args, "folderPath")?, arg(&args, "name")?).await)
            }
            "repo/open-pull-request" => {
                json(repo::repo_open_pull_request(app.clone(), arg(&args, "folderPath")?).await)
            }
            "repo/find-active-pull-request" => {
                json(repo::repo_find_active_pull_request(arg(&args, "folderPath")?).await)
            }
            "repo/working-copy-status" => {
                json(repo::repo_working_copy_status(arg(&args, "folderPath")?).await)
            }
            "repo/recent-commits" => json(
                repo::repo_recent_commits(arg(&args, "folderPath")?, optional(&args, "limit")?)
                    .await,
            ),
            "repo/rebase-on-default" => json(
                repo::repo_rebase_on_default(
                    arg(&args, "folderPath")?,
                    optional(&args, "repositoryPath")?,
                )
                .await,
            ),
            "repo/unpushed-commits" => json(
                repo::repo_unpushed_commits(arg(&args, "folderPath")?, arg(&args, "branch")?).await,
            ),
            "repo/push" => json(repo::repo_push(arg(&args, "folderPath")?).await),
            "repo/stage-files" => {
                json(repo::repo_stage_files(arg(&args, "folderPath")?, arg(&args, "files")?).await)
            }
            "repo/unstage-files" => json(
                repo::repo_unstage_files(arg(&args, "folderPath")?, arg(&args, "files")?).await,
            ),
            "repo/revert-files" => json(
                repo::repo_revert_files(
                    arg(&args, "folderPath")?,
                    arg(&args, "files")?,
                    arg(&args, "isUntracked")?,
                )
                .await,
            ),
            "repo/discard-all-changes" => {
                json(repo::repo_discard_all_changes(arg(&args, "folderPath")?).await)
            }
            "repo/commit" => json(
                repo::repo_commit(
                    arg(&args, "folderPath")?,
                    arg(&args, "message")?,
                    optional(&args, "stageAll")?,
                )
                .await,
            ),
            "repo/worktrees-overview" => {
                json(repo::repo_worktrees_overview(arg(&args, "repositoryPath")?).await)
            }
            "repo/list-my-branches" => {
                json(repo::repo_list_my_branches(arg(&args, "repositoryPath")?).await)
            }
            "repo/branch-web-url" => json(
                repo::repo_branch_web_url(arg(&args, "folderPath")?, arg(&args, "branch")?).await,
            ),
            "repo/detect-merge-state" => {
                json(repo::repo_detect_merge_state(arg(&args, "folderPath")?).await)
            }
            "ado/repo-open-prs" => json(ado::ado_repo_open_prs(arg(&args, "folderPath")?).await),
            "ado/pr-threads" => json(
                ado::ado_pr_threads(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    optional(&args, "includeResolved")?,
                )
                .await,
            ),
            "ado/pr-detail" => json(
                ado::ado_pr_detail(arg(&args, "folderPath")?, arg(&args, "pullRequestId")?).await,
            ),
            "ado/pr-changed-files" => json(
                ado::ado_pr_changed_files(arg(&args, "folderPath")?, arg(&args, "pullRequestId")?)
                    .await,
            ),
            "ado/pr-file-diff" => json(
                ado::ado_pr_file_diff(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "path")?,
                )
                .await,
            ),
            "ado/pr-file-content" => json(
                ado::ado_pr_file_content(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "path")?,
                    arg(&args, "side")?,
                )
                .await,
            ),
            "ado/pr-create-thread" => json(
                ado::ado_pr_create_thread(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    optional(&args, "anchor")?,
                    arg(&args, "content")?,
                )
                .await,
            ),
            "ado/pr-reply" => json(
                ado::ado_pr_reply(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "threadId")?,
                    arg(&args, "content")?,
                )
                .await,
            ),
            "ado/pr-set-thread-status" => json(
                ado::ado_pr_set_thread_status(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "threadId")?,
                    arg(&args, "resolved")?,
                )
                .await,
            ),
            "ado/pr-set-vote" => json(
                ado::ado_pr_set_vote(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "vote")?,
                )
                .await,
            ),
            "github/repo-open-prs" => {
                json(github::github_repo_open_prs(arg(&args, "folderPath")?).await)
            }
            "github/pr-threads" => json(
                github::github_pr_threads(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    optional(&args, "includeResolved")?,
                )
                .await,
            ),
            "github/pr-detail" => json(
                github::github_pr_detail(arg(&args, "folderPath")?, arg(&args, "pullRequestId")?)
                    .await,
            ),
            "github/pr-changed-files" => json(
                github::github_pr_changed_files(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                )
                .await,
            ),
            "github/pr-file-diff" => json(
                github::github_pr_file_diff(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "path")?,
                )
                .await,
            ),
            "github/pr-file-content" => json(
                github::github_pr_file_content(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "path")?,
                    arg(&args, "side")?,
                )
                .await,
            ),
            "github/pr-create-thread" => json(
                github::github_pr_create_thread(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    optional(&args, "anchor")?,
                    arg(&args, "content")?,
                )
                .await,
            ),
            "github/pr-reply" => json(
                github::github_pr_reply(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "threadId")?,
                    optional(&args, "rootCommentId")?,
                    arg(&args, "content")?,
                )
                .await,
            ),
            "github/pr-set-thread-status" => json(
                github::github_pr_set_thread_status(
                    arg(&args, "folderPath")?,
                    arg(&args, "threadId")?,
                    arg(&args, "resolved")?,
                )
                .await,
            ),
            "github/pr-set-vote" => json(
                github::github_pr_set_vote(
                    arg(&args, "folderPath")?,
                    arg(&args, "pullRequestId")?,
                    arg(&args, "vote")?,
                    optional(&args, "content")?,
                )
                .await,
            ),
            "system/open-in-vscode" => {
                json(system::system_open_in_vscode(app.clone(), arg(&args, "folderPath")?).await)
            }
            "system/open-in-vscode-scm" => json(
                system::system_open_in_vscode_scm(app.clone(), arg(&args, "folderPath")?).await,
            ),
            "system/open-in-windows-terminal" => {
                json(system::system_open_in_windows_terminal(arg(&args, "folderPath")?).await)
            }
            "system/open-external" => {
                json(system::system_open_external(app.clone(), arg(&args, "url")?).await)
            }
            "system/open-path" => {
                json(system::system_open_path(app.clone(), arg(&args, "folderPath")?).await)
            }
            "system/launch-copilot-cli" => json(
                system::system_launch_copilot_cli(
                    arg(&args, "folderPath")?,
                    arg(&args, "prompt")?,
                    optional(&args, "sessionId")?,
                )
                .await,
            ),
            "system/launch-copilot-resume" => json(
                system::system_launch_copilot_resume(
                    arg(&args, "folderPath")?,
                    arg(&args, "sessionId")?,
                )
                .await,
            ),
            "system/get-app-info" => json(system::system_get_app_info(app.clone()).await),
            "system/host-status" => json(system::system_get_host_status(app.clone()).await),
            "system/open-browser" => {
                host_state
                    .open_browser(optional::<String>(&args, "path")?.as_deref().unwrap_or("/"))
                    .map_err(AppError::msg)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "copilot-history/list" => json(copilot_history::copilot_history_list().await),
            "terminal-sessions/list" => {
                json(terminal_sessions::terminal_sessions_list(app.state::<DbState>()).await)
            }
            "terminal-sessions/watch" => json(
                terminal_sessions::terminal_sessions_watch(
                    app.clone(),
                    serde_json::from_value(args.clone())?,
                )
                .await,
            ),
            "terminal-sessions/history" => {
                json(terminal_sessions::terminal_sessions_history(arg(&args, "id")?).await)
            }
            "terminal-sessions/snapshot" => {
                json(terminal_sessions::terminal_sessions_snapshot(app.clone()).await)
            }
            "terminal-sessions/forget" => json(
                terminal_sessions::terminal_sessions_forget(app.clone(), arg(&args, "id")?).await,
            ),
            "tasks/list" => json(tasks::tasks_list(app.state::<DbState>()).await),
            "tasks/create" => json(
                tasks::tasks_create(
                    app.state::<DbState>(),
                    arg(&args, "title")?,
                    arg(&args, "description")?,
                    arg(&args, "repositoryId")?,
                    arg(&args, "repositoryName")?,
                    arg(&args, "repositoryPath")?,
                    arg(&args, "worktreePath")?,
                    optional(&args, "worktreeBranch")?,
                )
                .await,
            ),
            "tasks/update" => json(
                tasks::tasks_update(
                    app.state::<DbState>(),
                    arg(&args, "id")?,
                    arg(&args, "title")?,
                    arg(&args, "description")?,
                    arg(&args, "repositoryId")?,
                    arg(&args, "repositoryName")?,
                    arg(&args, "repositoryPath")?,
                    arg(&args, "worktreePath")?,
                    optional(&args, "worktreeBranch")?,
                )
                .await,
            ),
            "tasks/move" => json(
                tasks::tasks_move(
                    app.state::<DbState>(),
                    arg(&args, "id")?,
                    arg(&args, "status")?,
                    optional(&args, "beforeId")?,
                )
                .await,
            ),
            "tasks/delete" => {
                json(tasks::tasks_delete(app.state::<DbState>(), arg(&args, "id")?).await)
            }
            "tasks/set-copilot-session" => json(
                tasks::tasks_set_copilot_session(
                    app.state::<DbState>(),
                    arg(&args, "id")?,
                    arg(&args, "copilotSessionId")?,
                )
                .await,
            ),
            "settings/get" => Ok(serde_json::to_value(host_state.settings.get())?),
            "settings/update" => {
                let settings = host_state
                    .settings
                    .update_launch_at_sign_in(arg(&args, "launchAtSignIn")?)?;
                crate::tray::sync_launch_at_sign_in(&app, settings.launch_at_sign_in);
                host_state.broadcast("settings:update", &settings);
                Ok(serde_json::to_value(settings)?)
            }
            "updater/status" => Ok(serde_json::to_value(updater::status(&app))?),
            "updater/check" => Ok(serde_json::to_value(updater::check(app.clone()).await)?),
            "updater/install" => Ok(serde_json::to_value(updater::install(app.clone()).await)?),
            "updater/apply" => Ok(serde_json::to_value(updater::apply(app.clone()).await)?),
            _ => Err(AppError::msg(format!("Unknown API route: {command}"))),
        }
    }
    .await;

    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(error),
    }
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> AppResult<T> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::msg(format!("Missing request field: {key}")))?;
    Ok(serde_json::from_value(value)?)
}

fn optional<T: DeserializeOwned>(args: &Value, key: &str) -> AppResult<Option<T>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(serde_json::from_value(value.clone())?)),
    }
}

fn json<T: Serialize>(result: AppResult<T>) -> AppResult<Value> {
    Ok(serde_json::to_value(result?)?)
}

fn error_response(error: AppError) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": error.to_string() })),
    )
        .into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
