mod ado;
mod az;
mod copilot_history;
mod db;
mod error;
mod git;
mod paths;
mod repo;
mod system;
mod workspaces;
mod worktrees;

use std::sync::Mutex;

use tauri::Manager;

use db::DbState;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspaces::workspaces_list,
            workspaces::workspaces_remove,
            workspaces::workspaces_pick_and_add,
            worktrees::worktrees_list_for_workspace,
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
            ado::ado_pr_details,
            ado::ado_pr_threads,
            ado::ado_my_open_prs,
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
            repo::repo_branch_web_url,
            repo::repo_detect_merge_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevTrees");
}
