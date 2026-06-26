//! GitHub OAuth **device flow** sign-in and secure token storage.
//!
//! DevTrees ships from a *private* GitHub Enterprise Cloud repository, so the
//! auto-updater must authenticate its downloads. Rather than embedding any
//! shared secret in the distributed app, each user signs in once via the OAuth
//! device flow (which needs only a public `client_id`). The resulting access
//! token is stored in the OS keychain (Windows Credential Manager via the
//! `keyring` crate) and never leaves the Rust backend — the renderer only ever
//! sees sign-in status and the short-lived `user_code`.
//!
//! See `specs/ghe-update.md` for the full design.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Public OAuth App client id. Device flow needs no client secret, so this is
/// safe to embed. Override at runtime with `DEVTREES_GH_CLIENT_ID` for testing
/// against a different OAuth App.
///
/// TODO(enterprise-move): replace with the enterprise OAuth App's client id.
const DEFAULT_CLIENT_ID: &str = "REPLACE_WITH_ENTERPRISE_OAUTH_CLIENT_ID";

/// Owner/repo of the (private) release repository. Override with
/// `DEVTREES_GH_OWNER` / `DEVTREES_GH_REPO`.
///
/// TODO(enterprise-move): replace with the enterprise org and repo.
const DEFAULT_OWNER: &str = "REPLACE_WITH_ENTERPRISE_ORG";
const DEFAULT_REPO: &str = "DevTrees";

/// OAuth scope required to read a *private* repo's releases via an OAuth App.
const OAUTH_SCOPE: &str = "repo";

/// Keychain coordinates for the stored access token.
const KEYRING_SERVICE: &str = "DevTrees";
const KEYRING_ACCOUNT: &str = "github-oauth-token";

/// User-Agent is mandatory for the GitHub REST/OAuth APIs.
pub const USER_AGENT: &str = concat!("DevTrees/", env!("CARGO_PKG_VERSION"));

pub fn client_id() -> String {
    std::env::var("DEVTREES_GH_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID.to_string())
}

pub fn owner() -> String {
    std::env::var("DEVTREES_GH_OWNER").unwrap_or_else(|_| DEFAULT_OWNER.to_string())
}

pub fn repo() -> String {
    std::env::var("DEVTREES_GH_REPO").unwrap_or_else(|_| DEFAULT_REPO.to_string())
}

/// In-flight device-flow state, held in the Rust backend so the `device_code`
/// (which can complete the sign-in) is never exposed to the renderer.
#[derive(Default)]
pub struct GithubAuthState(pub Mutex<Option<PendingDeviceFlow>>);

pub struct PendingDeviceFlow {
    device_code: String,
    interval: Duration,
    expires_at: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
}

/// Result of a single poll tick. The renderer drives polling on `interval_secs`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "status")]
pub enum PollResult {
    /// Still waiting for the user to authorize in the browser.
    Pending,
    /// GitHub asked us to back off; the renderer should slow its polling.
    SlowDown { interval_secs: u64 },
    /// Sign-in completed; token has been stored.
    Authorized,
    /// The `user_code` expired before authorization.
    Expired,
    /// The user denied the request.
    Denied,
    /// An unexpected error occurred.
    Error { message: String },
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    interval: Option<u64>,
}

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| AppError::msg(format!("Failed to build HTTP client: {e}")))
}

fn token_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| AppError::msg(format!("Keychain unavailable: {e}")))
}

/// Read the stored access token, if the user is signed in.
pub fn stored_token() -> AppResult<Option<String>> {
    match token_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::msg(format!("Failed to read token: {e}"))),
    }
}

fn store_token(token: &str) -> AppResult<()> {
    token_entry()?
        .set_password(token)
        .map_err(|e| AppError::msg(format!("Failed to store token: {e}")))
}

fn clear_token() -> AppResult<()> {
    match token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::msg(format!("Failed to clear token: {e}"))),
    }
}

#[tauri::command]
pub fn github_auth_status() -> AppResult<AuthStatus> {
    Ok(AuthStatus {
        signed_in: stored_token()?.is_some(),
    })
}

#[tauri::command]
pub fn github_auth_sign_out() -> AppResult<AuthStatus> {
    clear_token()?;
    Ok(AuthStatus { signed_in: false })
}

/// Begin the device flow: request a device/user code pair from GitHub and stash
/// the `device_code` server-side. Returns the `user_code` + verification URL for
/// the renderer to display.
#[tauri::command]
pub async fn github_auth_start_device_flow(
    state: tauri::State<'_, GithubAuthState>,
) -> AppResult<DeviceFlowStart> {
    let client = http_client()?;
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id()), ("scope", OAUTH_SCOPE.to_string())])
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Failed to start sign-in: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::msg(format!(
            "GitHub rejected the sign-in request ({}).",
            resp.status()
        )));
    }

    let body: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| AppError::msg(format!("Unexpected sign-in response: {e}")))?;

    let interval = Duration::from_secs(body.interval.max(1));
    let expires_at = Instant::now() + Duration::from_secs(body.expires_in);

    *state.0.lock().unwrap() = Some(PendingDeviceFlow {
        device_code: body.device_code,
        interval,
        expires_at,
    });

    Ok(DeviceFlowStart {
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        interval_secs: interval.as_secs(),
        expires_in_secs: body.expires_in,
    })
}

/// Perform a single poll of the access-token endpoint. The renderer calls this
/// repeatedly on `interval_secs` until it gets a terminal result.
#[tauri::command]
pub async fn github_auth_poll(
    state: tauri::State<'_, GithubAuthState>,
) -> AppResult<PollResult> {
    let (device_code, expires_at) = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(p) => (p.device_code.clone(), p.expires_at),
            None => {
                return Ok(PollResult::Error {
                    message: "No sign-in is in progress.".to_string(),
                })
            }
        }
    };

    if Instant::now() >= expires_at {
        *state.0.lock().unwrap() = None;
        return Ok(PollResult::Expired);
    }

    let client = http_client()?;
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id()),
            ("device_code", device_code),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
        ])
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Sign-in poll failed: {e}")))?;

    let body: AccessTokenResponse = resp
        .json()
        .await
        .map_err(|e| AppError::msg(format!("Unexpected poll response: {e}")))?;

    if let Some(token) = body.access_token {
        store_token(&token)?;
        *state.0.lock().unwrap() = None;
        return Ok(PollResult::Authorized);
    }

    match body.error.as_deref() {
        Some("authorization_pending") => Ok(PollResult::Pending),
        Some("slow_down") => {
            let next = body.interval.unwrap_or(5).max(1);
            if let Some(p) = state.0.lock().unwrap().as_mut() {
                p.interval = Duration::from_secs(next);
            }
            Ok(PollResult::SlowDown {
                interval_secs: next,
            })
        }
        Some("expired_token") => {
            *state.0.lock().unwrap() = None;
            Ok(PollResult::Expired)
        }
        Some("access_denied") => {
            *state.0.lock().unwrap() = None;
            Ok(PollResult::Denied)
        }
        other => Ok(PollResult::Error {
            message: other.unwrap_or("Unknown sign-in error").to_string(),
        }),
    }
}
