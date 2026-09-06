mod ado;
mod az;
mod copilot_history;
mod db;
mod error;
mod gh;
mod git;
mod github;
mod paths;
mod pr_review;
mod repo;
mod repositories;
mod reviews;
mod system;
mod tasks;
mod terminal_sessions;
mod worktrees;

use std::sync::Mutex;

use tauri::Manager;

use db::DbState;
use terminal_sessions::TerminalSessionMonitor;

/// Build and run the DevTrees Tauri application.
///
/// Plugins mirror the Electron capabilities that survive the migration:
/// dialog (folder picker), opener (open external URLs / paths / apps), process
/// (relaunch after update), log (diagnostics), single-instance (focus the
/// existing window on a second launch so update-on-relaunch never races), and
/// updater (auto-update against GitHub Releases, replacing electron-updater).
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Open the SQLite database (shared with any existing Electron install)
            // and stash the connection in managed state for commands to use.
            let conn = db::init()?;
            app.manage(DbState(Mutex::new(conn)));
            app.manage(TerminalSessionMonitor::default());
            app.manage(terminal_sessions::AcpSessionManager::default());
            // Resume mirroring any external Copilot terminal that outlived the last run.
            if let Err(e) = terminal_sessions::init(app.handle()) {
                eprintln!("failed to restore terminal session watches: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repositories::repositories_list,
            repositories::repositories_remove,
            repositories::repositories_reorder,
            repositories::repositories_pick_and_add,
            worktrees::worktrees_list_for_repository,
            worktrees::worktrees_create,
            worktrees::worktrees_delete,
            worktrees::worktrees_status,
            copilot_history::copilot_history_list,
            system::system_open_in_vscode,
            system::system_open_in_vscode_scm,
            system::system_open_in_windows_terminal,
            system::system_open_external,
            system::system_open_path,
            system::system_launch_copilot_cli,
            system::system_launch_copilot_resume,
            system::system_get_app_info,
            ado::ado_pr_threads,
            ado::ado_repo_open_prs,
            ado::ado_pr_detail,
            ado::ado_pr_changed_files,
            ado::ado_pr_file_diff,
            ado::ado_pr_file_content,
            ado::ado_pr_create_thread,
            ado::ado_pr_reply,
            ado::ado_pr_set_thread_status,
            ado::ado_pr_set_vote,
            github::github_repo_open_prs,
            github::github_pr_threads,
            github::github_pr_detail,
            github::github_pr_changed_files,
            github::github_pr_file_diff,
            github::github_pr_file_content,
            github::github_pr_create_thread,
            github::github_pr_reply,
            github::github_pr_set_thread_status,
            github::github_pr_set_vote,
            repo::repo_default_branch,
            repo::repo_current_branch,
            repo::repo_status,
            repo::repo_fetch,
            repo::repo_pull,
            repo::repo_pull_current_branch,
            repo::repo_user_alias,
            repo::repo_create_branch,
            repo::repo_open_pull_request,
            repo::repo_find_active_pull_request,
            repo::repo_working_copy_status,
            repo::repo_recent_commits,
            repo::repo_rebase_on_default,
            repo::repo_unpushed_commits,
            repo::repo_push,
            repo::repo_stage_files,
            repo::repo_unstage_files,
            repo::repo_revert_files,
            repo::repo_discard_all_changes,
            repo::repo_commit,
            repo::repo_worktrees_overview,
            repo::repo_list_my_branches,
            repo::repo_branch_web_url,
            repo::repo_detect_merge_state,
            tasks::tasks_list,
            tasks::tasks_create,
            tasks::tasks_update,
            tasks::tasks_move,
            tasks::tasks_delete,
            tasks::tasks_set_copilot_session,
            terminal_sessions::terminal_sessions_list,
            terminal_sessions::terminal_sessions_start,
            terminal_sessions::terminal_sessions_prompt,
            terminal_sessions::terminal_sessions_interaction,
            terminal_sessions::terminal_sessions_respond,
            terminal_sessions::terminal_sessions_cancel,
            terminal_sessions::terminal_sessions_history,
            terminal_sessions::terminal_sessions_watch,
            terminal_sessions::terminal_sessions_forget,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevTrees")
        .run(|_, _| {});
}
