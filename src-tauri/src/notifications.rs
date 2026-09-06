use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

pub fn show(app: &AppHandle, title: impl Into<String>, body: impl Into<String>, path: &str) {
    let title = title.into();
    let body = body.into();

    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;

        let app_id = if tauri::is_dev() {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        };
        let handle = app.clone();
        let path = path.to_string();
        let _ = Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                let _ = handle.state::<AppState>().open_browser(&path);
                Ok(())
            })
            .show();
    }

    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}
