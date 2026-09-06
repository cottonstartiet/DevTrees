mod ado;
mod app_state;
mod az;
mod copilot_history;
mod db;
mod error;
mod gh;
mod git;
mod github;
mod notifications;
mod paths;
mod pr_review;
mod repo;
mod repositories;
mod reviews;
mod server;
mod settings;
mod system;
mod tasks;
mod terminal_sessions;
mod tray;
mod updater;
mod worktrees;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use app_state::AppState;
use db::DbState;
use terminal_sessions::TerminalSessionMonitor;

/// Build and run the DevTrees Tauri application.
///
/// DevTrees is a windowless Windows tray host. The bundled React UI is served by an
/// authenticated loopback server and opened in the user's default browser.
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(state) = app.try_state::<AppState>() {
                let _ = state.open_browser("/");
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let conn = db::init()?;
            let db = DbState(Arc::new(Mutex::new(conn)));
            let terminal_sessions = TerminalSessionMonitor::default();
            app.manage(db.clone());
            app.manage(terminal_sessions.clone());
            app.manage(updater::UpdaterState::default());
            let settings = settings::SettingsStore::load()?;
            app.manage(AppState::new(
                app.handle().clone(),
                db,
                terminal_sessions,
                settings,
            ));

            tauri::async_runtime::block_on(server::start(app.handle().clone()))?;
            tray::init(app.handle())?;
            if let Err(e) = terminal_sessions::init(app.handle()) {
                eprintln!("failed to restore terminal session watches: {e}");
            }
            tray::refresh_session_summary(app.handle());

            let launched_at_sign_in = std::env::args().any(|arg| arg == "--autostart");
            if !launched_at_sign_in {
                let _ = app.state::<AppState>().open_browser("/");
            }

            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    updater::check(handle).await;
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevTrees")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.stop_server();
                }
            }
        });
}
