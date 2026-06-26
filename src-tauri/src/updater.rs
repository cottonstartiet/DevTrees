//! Authenticated auto-update against the private release repository.
//!
//! The update flow runs entirely in Rust so the GitHub token (held in the OS
//! keychain) is never exposed to the renderer and the same `Authorization`
//! header is applied to *both* the manifest fetch and the installer download.
//!
//! Releases are resolved through the GitHub REST **asset** endpoints
//! (`api.github.com/repos/<owner>/<repo>/releases/assets/{id}`) rather than the
//! private `releases/latest/download/...` path: we discover the `latest.json`
//! asset id from `releases/latest`, then point the updater at it. The installer
//! URL embedded in `latest.json` is itself an API asset URL (written by CI), so
//! it is fetched with the same auth header. See `specs/ghe-update.md`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};
use crate::github_auth;

const MANIFEST_ASSET_NAME: &str = "latest.json";

/// The most recently checked update, held server-side because a
/// [`Update`] cannot be serialized to the renderer.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub signed_in: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct ReleaseResponse {
    assets: Vec<ReleaseAsset>,
}

/// Discover the API asset URL for the `latest.json` updater manifest on the
/// latest release. Returns the sentinel error message `AUTH_REQUIRED` when the
/// token is missing/expired/unauthorized so the renderer can prompt sign-in.
async fn latest_json_asset_url(token: &str) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .user_agent(github_auth::USER_AGENT)
        .build()
        .map_err(|e| AppError::msg(format!("Failed to build HTTP client: {e}")))?;

    let api = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        github_auth::owner(),
        github_auth::repo()
    );

    let resp = client
        .get(&api)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Failed to query latest release: {e}")))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::msg("AUTH_REQUIRED"));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::msg(
            "No releases found (or no access to the release repository).",
        ));
    }
    if !status.is_success() {
        return Err(AppError::msg(format!(
            "GitHub returned {status} for the latest release."
        )));
    }

    let release: ReleaseResponse = resp
        .json()
        .await
        .map_err(|e| AppError::msg(format!("Unexpected release response: {e}")))?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == MANIFEST_ASSET_NAME)
        .ok_or_else(|| AppError::msg("No latest.json asset found on the latest release."))?;

    Ok(format!(
        "https://api.github.com/repos/{}/{}/releases/assets/{}",
        github_auth::owner(),
        github_auth::repo(),
        asset.id
    ))
}

/// Check for an update. Requires the user to be signed in (private repo). Stores
/// the resulting [`Update`] in managed state and returns its version.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdate>,
) -> AppResult<UpdateCheckResult> {
    let token = match github_auth::stored_token()? {
        Some(t) => t,
        None => {
            return Ok(UpdateCheckResult {
                signed_in: false,
                available: false,
                version: None,
                notes: None,
            })
        }
    };

    let manifest_url = latest_json_asset_url(&token).await?;
    let endpoint = reqwest::Url::parse(&manifest_url)
        .map_err(|e| AppError::msg(format!("Bad manifest URL: {e}")))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| AppError::msg(format!("Updater endpoint error: {e}")))?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| AppError::msg(format!("Header error: {e}")))?
        .header("Accept", "application/octet-stream")
        .map_err(|e| AppError::msg(format!("Header error: {e}")))?
        .build()
        .map_err(|e| AppError::msg(format!("Updater build error: {e}")))?;

    let update = updater
        .check()
        .await
        .map_err(|e| AppError::msg(format!("Update check failed: {e}")))?;

    match update {
        Some(u) => {
            let version = u.version.clone();
            let notes = u.body.clone();
            *state.0.lock().unwrap() = Some(u);
            Ok(UpdateCheckResult {
                signed_in: true,
                available: true,
                version: Some(version),
                notes,
            })
        }
        None => {
            *state.0.lock().unwrap() = None;
            Ok(UpdateCheckResult {
                signed_in: true,
                available: false,
                version: None,
                notes: None,
            })
        }
    }
}

/// Download and install the update previously found by [`update_check`], then
/// relaunch. `expected_version` guards against installing a different release
/// than the one the user confirmed.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdate>,
    expected_version: String,
) -> AppResult<()> {
    let update = {
        let mut guard = state.0.lock().unwrap();
        match guard.take() {
            Some(u) if u.version == expected_version => u,
            Some(u) => {
                *guard = Some(u);
                return Err(AppError::msg(
                    "Update changed since it was checked; please check again.",
                ));
            }
            None => {
                return Err(AppError::msg(
                    "No update is ready to install; run a check first.",
                ))
            }
        }
    };

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AppError::msg(format!("Update install failed: {e}")))?;

    // Diverges (`-> !`); coerces to the command's return type.
    app.restart()
}
