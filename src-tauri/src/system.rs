use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use base64::Engine as _;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::app_state::AppState;
use crate::error::AppResult;

// Friendly product name shown in the UI. Kept separate from the package name so the
// displayed name can be capitalized independently of the data directory.
const APP_DISPLAY_NAME: &str = "DevTrees";

/// `{ ok: true } | { ok: false, error }` — mirrors the Electron `LaunchResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LaunchResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }
    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAvailability {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub local_url: Option<String>,
    pub browser_clients: usize,
    pub windows_terminal: ToolAvailability,
    pub copilot_cli: ToolAvailability,
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// Spawn a detached child process and return success as soon as it starts (we never
/// wait for it to exit). Mirrors the Electron `launchDetached` helper.
fn launch_detached(program: &str, args: &[String]) -> LaunchResult {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_no_window(&mut cmd);
    match cmd.spawn() {
        Ok(_) => LaunchResult::ok(),
        Err(e) => LaunchResult::err(e.to_string()),
    }
}

fn tool_availability(program: &str, version_args: &[&str]) -> ToolAvailability {
    #[cfg(windows)]
    let mut command = if program == "copilot" {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(program).args(version_args);
        command
    } else {
        let mut command = Command::new("where.exe");
        command.arg(program);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(program);
        command.args(version_args);
        command
    };
    command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    configure_no_window(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            ToolAvailability {
                available: true,
                version: Some(if stdout.is_empty() { stderr } else { stdout }),
                error: None,
            }
        }
        Ok(output) => ToolAvailability {
            available: false,
            version: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(error) => ToolAvailability {
            available: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

/// Launch the VS Code CLI. On Windows `code` is a `.cmd` shim, so it must run through
/// `cmd /C` for PATH/PATHEXT resolution (the Electron version used `shell: true`).
fn launch_code(args: &[String]) -> LaunchResult {
    #[cfg(windows)]
    {
        let mut full = vec!["/C".to_string(), "code".to_string()];
        full.extend_from_slice(args);
        launch_detached("cmd", &full)
    }
    #[cfg(not(windows))]
    {
        launch_detached("code", args)
    }
}

fn open_external_url(app: &AppHandle, url: &str) -> LaunchResult {
    static HTTP: OnceLock<Regex> = OnceLock::new();
    let http = HTTP.get_or_init(|| Regex::new(r"(?i)^https?://").unwrap());
    if !http.is_match(url) {
        return LaunchResult::err("Only http(s) URLs are allowed.");
    }
    match app.opener().open_url(url, None::<&str>) {
        Ok(_) => LaunchResult::ok(),
        Err(e) => LaunchResult::err(e.to_string()),
    }
}

fn open_local_path(app: &AppHandle, folder_path: &str) -> LaunchResult {
    if folder_path.trim().is_empty() {
        return LaunchResult::err("Path is required.");
    }
    match app.opener().open_path(folder_path, None::<&str>) {
        Ok(_) => LaunchResult::ok(),
        Err(e) => LaunchResult::err(e.to_string()),
    }
}

fn open_in_vscode(app: &AppHandle, folder_path: &str) -> LaunchResult {
    let primary = launch_code(&[folder_path.to_string()]);
    if primary.ok {
        return primary;
    }
    // Fall back to the vscode://file/ deep link via the OS handler.
    let normalized = folder_path.replace('\\', "/");
    let path_part = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    let url = format!("vscode://file{path_part}");
    match app.opener().open_url(&url, None::<&str>) {
        Ok(_) => LaunchResult::ok(),
        Err(e) => LaunchResult::err(format!("{}; {}", primary.error.unwrap_or_default(), e)),
    }
}

/// Open the folder in VS Code and focus the Source Control view. Requires VS Code
/// 1.82+ for `--command`; on failure falls back to opening the folder normally.
fn open_in_vscode_scm(app: &AppHandle, folder_path: &str) -> LaunchResult {
    let primary = launch_code(&[
        folder_path.to_string(),
        "--command".to_string(),
        "workbench.view.scm".to_string(),
    ]);
    if primary.ok {
        return primary;
    }
    open_in_vscode(app, folder_path)
}

// ----- PowerShell EncodedCommand helpers (Windows Copilot CLI launchers) -----

/// PowerShell 5.1 `-EncodedCommand` expects base64 of the UTF-16LE command bytes.
fn encode_ps_command(command: &str) -> String {
    let utf16le: Vec<u8> = command
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16le)
}

fn is_valid_copilot_session_id(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[0-9a-fA-F-]{8,64}$").unwrap());
    re.is_match(id)
}

fn launch_copilot_cli(folder_path: &str, prompt: &str, session_id: Option<&str>) -> LaunchResult {
    if !cfg!(windows) {
        return LaunchResult::err("Copilot CLI launch is currently Windows-only.");
    }
    if folder_path.trim().is_empty() {
        return LaunchResult::err("folderPath is required.");
    }
    if !tool_availability("wt", &[]).available {
        return LaunchResult::err(
            "Windows Terminal was not found. Install it and restart DevTrees.",
        );
    }
    if !tool_availability("copilot", &["--version"]).available {
        return LaunchResult::err(
            "GitHub Copilot CLI was not found on PATH. Install and authenticate it, then restart DevTrees.",
        );
    }
    // Pinning the session id up front (`--session-id` also *sets* the UUID for a new
    // session) is what lets the app find and tail this session's event log afterwards.
    let id_arg = match session_id {
        Some(id) if !id.trim().is_empty() => {
            if !is_valid_copilot_session_id(id) {
                return LaunchResult::err("Invalid Copilot session id.");
            }
            format!(" --session-id={id}")
        }
        _ => String::new(),
    };
    // An empty prompt launches a plain interactive Copilot session (`copilot --allow-all-tools`).
    // A non-empty prompt is passed via `-i <prompt>` so Copilot executes it immediately. This is the
    // external-terminal replacement for the former embedded "start Copilot session" feature.
    let ps_command = if prompt.trim().is_empty() {
        format!("copilot --allow-all-tools{id_arg}")
    } else {
        // PowerShell 5.1 does not escape embedded double quotes when serializing an argument
        // to a native exe; pre-escape for the Windows CRT argv (double the backslash run
        // preceding a quote, then escape the quote) so the whole prompt reaches copilot as one arg.
        static QUOTE_RE: OnceLock<Regex> = OnceLock::new();
        let quote_re = QUOTE_RE.get_or_init(|| Regex::new(r#"(\\*)""#).unwrap());
        let native_escaped = quote_re.replace_all(prompt, |caps: &regex::Captures| {
            let slashes = &caps[1];
            format!("{slashes}{slashes}\\\"")
        });
        let ps_escaped = native_escaped.replace('\'', "''");
        format!("copilot --allow-all-tools{id_arg} -i '{ps_escaped}'")
    };
    let encoded = encode_ps_command(&ps_command);
    launch_detached(
        "wt",
        &[
            "-d".into(),
            folder_path.into(),
            "powershell".into(),
            "-NoExit".into(),
            "-EncodedCommand".into(),
            encoded,
        ],
    )
}

fn launch_copilot_resume(folder_path: &str, session_id: &str) -> LaunchResult {
    if !cfg!(windows) {
        return LaunchResult::err("Copilot CLI launch is currently Windows-only.");
    }
    if folder_path.trim().is_empty() {
        return LaunchResult::err("folderPath is required.");
    }
    if !is_valid_copilot_session_id(session_id) {
        return LaunchResult::err("Invalid Copilot session id.");
    }
    if !Path::new(folder_path).exists() {
        return LaunchResult::err(format!(
            "This session's folder no longer exists:\n{folder_path}"
        ));
    }
    if !tool_availability("wt", &[]).available {
        return LaunchResult::err(
            "Windows Terminal was not found. Install it and restart DevTrees.",
        );
    }
    if !tool_availability("copilot", &["--version"]).available {
        return LaunchResult::err(
            "GitHub Copilot CLI was not found on PATH. Install and authenticate it, then restart DevTrees.",
        );
    }
    let ps_command = format!("copilot --allow-all-tools --session-id={session_id}");
    let encoded = encode_ps_command(&ps_command);
    launch_detached(
        "wt",
        &[
            "-d".into(),
            folder_path.into(),
            "powershell".into(),
            "-NoExit".into(),
            "-EncodedCommand".into(),
            encoded,
        ],
    )
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn system_open_in_vscode(app: AppHandle, folder_path: String) -> AppResult<LaunchResult> {
    Ok(open_in_vscode(&app, &folder_path))
}

#[tauri::command]
pub async fn system_open_in_vscode_scm(
    app: AppHandle,
    folder_path: String,
) -> AppResult<LaunchResult> {
    Ok(open_in_vscode_scm(&app, &folder_path))
}

#[tauri::command]
pub async fn system_open_in_windows_terminal(folder_path: String) -> AppResult<LaunchResult> {
    if !cfg!(windows) {
        return Ok(LaunchResult::err(
            "Windows Terminal is only available on Windows.",
        ));
    }
    Ok(launch_detached("wt", &["-d".into(), folder_path]))
}

#[tauri::command]
pub async fn system_open_external(app: AppHandle, url: String) -> AppResult<LaunchResult> {
    Ok(open_external_url(&app, &url))
}

#[tauri::command]
pub async fn system_open_path(app: AppHandle, folder_path: String) -> AppResult<LaunchResult> {
    Ok(open_local_path(&app, &folder_path))
}

#[tauri::command]
pub async fn system_launch_copilot_cli(
    folder_path: String,
    prompt: String,
    session_id: Option<String>,
) -> AppResult<LaunchResult> {
    Ok(launch_copilot_cli(
        &folder_path,
        &prompt,
        session_id.as_deref(),
    ))
}

#[tauri::command]
pub async fn system_launch_copilot_resume(
    folder_path: String,
    session_id: String,
) -> AppResult<LaunchResult> {
    Ok(launch_copilot_resume(&folder_path, &session_id))
}

#[tauri::command]
pub async fn system_get_app_info(app: AppHandle) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: APP_DISPLAY_NAME.to_string(),
        version: app.package_info().version.to_string(),
    })
}

pub async fn system_get_host_status(app: AppHandle) -> AppResult<HostStatus> {
    let state = app.state::<AppState>();
    Ok(HostStatus {
        local_url: state.base_url(),
        browser_clients: state
            .browser_clients
            .load(std::sync::atomic::Ordering::Relaxed),
        windows_terminal: tool_availability("wt", &[]),
        copilot_cli: tool_availability("copilot", &["--version"]),
    })
}
