use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::app_state::AppState;
use crate::terminal_sessions;

pub struct TrayState {
    summary: MenuItem<Wry>,
    launch_at_sign_in: CheckMenuItem<Wry>,
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open DevTrees", true, None::<&str>)?;
    let sessions = MenuItem::with_id(app, "sessions", "Open Sessions", true, None::<&str>)?;
    let summary = MenuItem::with_id(
        app,
        "session-summary",
        "No active Copilot sessions",
        false,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let launch_at_sign_in = CheckMenuItem::with_id(
        app,
        "launch-at-sign-in",
        "Start at sign-in",
        true,
        app.state::<AppState>().settings.get().launch_at_sign_in,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "Exit DevTrees", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &sessions,
            &summary,
            &separator,
            &updates,
            &launch_at_sign_in,
            &exit,
        ],
    )?;

    app.manage(TrayState {
        summary,
        launch_at_sign_in,
    });

    let mut builder = TrayIconBuilder::with_id("devtrees")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DevTrees")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = app.state::<AppState>().open_browser("/");
            }
            "sessions" => {
                let _ = app.state::<AppState>().open_browser("/sessions");
            }
            "check-updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::updater::check(app).await;
                });
            }
            "launch-at-sign-in" => {
                let state = app.state::<AppState>();
                let enabled = !state.settings.get().launch_at_sign_in;
                match state.settings.update_launch_at_sign_in(enabled) {
                    Ok(settings) => {
                        let _ = app
                            .state::<TrayState>()
                            .launch_at_sign_in
                            .set_checked(settings.launch_at_sign_in);
                        state.broadcast("settings:update", &settings);
                    }
                    Err(error) => eprintln!("[settings] could not update autostart: {error}"),
                }
            }
            "exit" => {
                app.state::<AppState>().stop_server();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().state::<AppState>().open_browser("/");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn refresh_session_summary(app: &AppHandle) {
    let count = terminal_sessions::active_session_count(app);
    let text = match count {
        0 => "No active Copilot sessions".to_string(),
        1 => "1 active Copilot session".to_string(),
        count => format!("{count} active Copilot sessions"),
    };
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.summary.set_text(text);
    }
}

pub fn sync_launch_at_sign_in(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.launch_at_sign_in.set_checked(enabled);
    }
}
