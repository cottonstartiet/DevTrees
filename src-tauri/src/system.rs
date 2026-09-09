use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use base64::Engine as _;
use regex::Regex;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

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

pub(crate) fn launch_copilot_cli(
    folder_path: &str,
    prompt: &str,
    session_id: Option<&str>,
    initial_mode: Option<&str>,
) -> LaunchResult {
    if !cfg!(windows) {
        return LaunchResult::err("Copilot CLI launch is currently Windows-only.");
    }
    if folder_path.trim().is_empty() {
        return LaunchResult::err("folderPath is required.");
    }
    if !Path::new(folder_path).is_dir() {
        return LaunchResult::err("The session's working directory does not exist.");
    }
    let cli = match crate::copilot_acp_sessions::installed_cli() {
        Ok(path) => path,
        Err(error) => return LaunchResult::err(error.to_string()),
    };
    let ps_command = match copilot_command(&cli, prompt, session_id, initial_mode) {
        Ok(command) => command,
        Err(error) => return LaunchResult::err(error),
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

fn copilot_command(
    cli: &Path,
    prompt: &str,
    session_id: Option<&str>,
    initial_mode: Option<&str>,
) -> Result<String, &'static str> {
    // Pinning the session id up front (`--session-id` also *sets* the UUID for a new
    // session) is what lets the app find and tail this session's event log afterwards.
    let id_arg = match session_id {
        Some(id) if !id.trim().is_empty() => {
            if !is_valid_copilot_session_id(id) {
                return Err("Invalid Copilot session id.");
            }
            format!(" --session-id={id}")
        }
        _ => String::new(),
    };
    let executable = cli.to_string_lossy().replace('\'', "''");
    let mode_arg = match initial_mode {
        Some(mode @ ("interactive" | "plan" | "autopilot")) => format!(" --mode={mode}"),
        Some(_) => return Err("Invalid Copilot session mode."),
        None => String::new(),
    };
    // Do not add automatic approval flags; the CLI retains the user's permission settings.
    let ps_command = if prompt.trim().is_empty() {
        format!("& '{executable}'{id_arg}{mode_arg}")
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
        format!("& '{executable}'{id_arg}{mode_arg} -i '{ps_escaped}'")
    };
    Ok(ps_command)
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
pub async fn system_get_app_info(app: AppHandle) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: APP_DISPLAY_NAME.to_string(),
        version: app.package_info().version.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_commands_preserve_session_ids_without_granting_permissions() {
        let cli = Path::new(r"C:\Copilot tools\copilot.exe");
        let id = "00112233-4455-6677-8899-aabbccddeeff";
        let resumed = copilot_command(cli, "", Some(id), None).unwrap();
        assert_eq!(
            resumed,
            format!("& 'C:\\Copilot tools\\copilot.exe' --session-id={id}")
        );
        assert!(!resumed.contains(" -i "));
        let fresh = copilot_command(cli, "Review this worktree", Some(id), Some("plan")).unwrap();
        assert!(fresh.ends_with(" --mode=plan -i 'Review this worktree'"));
        for command in [resumed, fresh] {
            assert!(!command.contains("--allow"));
        }
        assert!(copilot_command(cli, "", Some("bad;command"), None).is_err());
        assert!(copilot_command(cli, "", None, Some("invalid")).is_err());
    }

    #[test]
    fn powershell_encoding_preserves_unicode_newlines_and_quoted_prompts() {
        let command = copilot_command(
            Path::new(r"C:\User's tools\copilot.exe"),
            "Don't run \"$env:INJECT\";\nReview \u{03bb}",
            None,
            None,
        )
        .unwrap();
        assert!(command.starts_with("& 'C:\\User''s tools\\copilot.exe'"));
        assert!(command.contains("Don''t run \\\"$env:INJECT\\\";"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encode_ps_command(&command))
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), command);
    }
}
