use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct UpdaterState(pub Mutex<UpdateStatus>);

impl Default for UpdaterState {
    fn default() -> Self {
        Self(Mutex::new(UpdateStatus {
            state: "idle".to_string(),
            version: None,
            error: None,
        }))
    }
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<UpdaterState>()
        .0
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| UpdateStatus {
            state: "error".to_string(),
            version: None,
            error: Some("updater state unavailable".to_string()),
        })
}

fn set_status(app: &AppHandle, status: UpdateStatus) {
    if let Ok(mut current) = app.state::<UpdaterState>().0.lock() {
        *current = status.clone();
    }
    app.state::<AppState>().broadcast("updater:update", &status);
}

#[cfg(desktop)]
pub async fn check(app: AppHandle) -> UpdateStatus {
    use tauri_plugin_updater::UpdaterExt;

    set_status(
        &app,
        UpdateStatus {
            state: "checking".to_string(),
            version: None,
            error: None,
        },
    );
    let next = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => UpdateStatus {
                state: "available".to_string(),
                version: Some(update.version),
                error: None,
            },
            Ok(None) => UpdateStatus {
                state: "current".to_string(),
                version: None,
                error: None,
            },
            Err(error) => UpdateStatus {
                state: "error".to_string(),
                version: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => UpdateStatus {
            state: "error".to_string(),
            version: None,
            error: Some(error.to_string()),
        },
    };
    set_status(&app, next.clone());
    if next.state == "available" && !app.state::<AppState>().has_browser_clients() {
        let body = next
            .version
            .as_deref()
            .map(|version| format!("DevTrees {version} is ready. Open DevTrees to install it."))
            .unwrap_or_else(|| "A DevTrees update is ready.".to_string());
        crate::notifications::show(&app, "DevTrees update available", body, "/settings");
    }
    next
}

#[cfg(not(desktop))]
pub async fn check(app: AppHandle) -> UpdateStatus {
    let status = UpdateStatus {
        state: "unsupported".to_string(),
        version: None,
        error: None,
    };
    set_status(&app, status.clone());
    status
}

#[cfg(desktop)]
pub async fn install(app: AppHandle) -> UpdateStatus {
    let current = status(&app);
    let next = if current.state == "available" {
        UpdateStatus {
            state: "installing".to_string(),
            version: current.version,
            error: None,
        }
    } else {
        check(app.clone()).await
    };
    set_status(&app, next.clone());
    next
}

#[cfg(not(desktop))]
pub async fn install(app: AppHandle) -> UpdateStatus {
    check(app).await
}

#[cfg(desktop)]
pub async fn apply(app: AppHandle) -> UpdateStatus {
    use tauri_plugin_updater::UpdaterExt;

    let next = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => match update.install(bytes) {
                        Ok(()) => UpdateStatus {
                            state: "installed".to_string(),
                            version: Some(version),
                            error: None,
                        },
                        Err(error) => UpdateStatus {
                            state: "error".to_string(),
                            version: Some(version),
                            error: Some(error.to_string()),
                        },
                    },
                    Err(error) => UpdateStatus {
                        state: "error".to_string(),
                        version: Some(version),
                        error: Some(error.to_string()),
                    },
                }
            }
            Ok(None) => UpdateStatus {
                state: "current".to_string(),
                version: None,
                error: None,
            },
            Err(error) => UpdateStatus {
                state: "error".to_string(),
                version: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => UpdateStatus {
            state: "error".to_string(),
            version: None,
            error: Some(error.to_string()),
        },
    };
    set_status(&app, next.clone());
    next
}

#[cfg(not(desktop))]
pub async fn apply(app: AppHandle) -> UpdateStatus {
    check(app).await
}
