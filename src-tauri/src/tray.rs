use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Runtime, Window, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

use crate::{db::DbState, settings};

const MAIN_WINDOW_LABEL: &str = "main";
const OPEN_MENU_ID: &str = "open-devtrees";
const QUIT_MENU_ID: &str = "quit-devtrees";

pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };

    window.set_skip_taskbar(false)?;
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub(crate) fn setup(app: &mut App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_MENU_ID, "Open DevTrees", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("DevTrees")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_MENU_ID => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("failed to restore DevTrees from the tray menu: {error}");
                }
            }
            QUIT_MENU_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("failed to restore DevTrees from a tray double-click: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub(crate) fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    api.prevent_close();
    if let Err(error) = window.hide() {
        eprintln!("failed to hide DevTrees in the system tray: {error}");
        return;
    }

    let app = window.app_handle();
    let should_notify = {
        let state = app.state::<DbState>();
        let result = match state.0.lock() {
            Ok(db) => match settings::claim_tray_close_notice(&db) {
                Ok(claimed) => claimed,
                Err(error) => {
                    eprintln!("failed to persist the close-to-tray notice state: {error}");
                    false
                }
            },
            Err(error) => {
                eprintln!("failed to lock the database for the close-to-tray notice: {error}");
                false
            }
        };
        result
    };

    if should_notify {
        if let Err(error) = app
            .notification()
            .builder()
            .title("DevTrees is still running")
            .body(
                "Double-click the DevTrees tray icon to reopen the app, or use Quit from its menu.",
            )
            .show()
        {
            eprintln!("failed to show the close-to-tray notification: {error}");
        }
    }
}
