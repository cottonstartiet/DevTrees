use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};

use base64::Engine as _;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, State};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeResult {
    pub ok: bool,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl KeepAwakeResult {
    fn ok(enabled: bool) -> Self {
        Self {
            ok: true,
            enabled,
            error: None,
        }
    }

    fn err(enabled: bool, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            enabled,
            error: Some(message.into()),
        }
    }
}

struct KeepAwakeWorker {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<Result<(), String>>,
    thread: JoinHandle<()>,
}

impl KeepAwakeWorker {
    fn stop(self) -> Result<(), String> {
        let stop_result = self
            .stop_tx
            .send(())
            .map_err(|_| "The keep-awake worker stopped unexpectedly.".to_string());
        let reset_result = self
            .done_rx
            .recv()
            .map_err(|_| "The keep-awake worker did not confirm shutdown.".to_string())
            .and_then(|result| result);
        let join_result = self
            .thread
            .join()
            .map_err(|_| "The keep-awake worker panicked during shutdown.".to_string());

        stop_result?;
        reset_result?;
        join_result
    }
}

#[derive(Default)]
pub struct KeepAwakeState {
    worker: Mutex<Option<KeepAwakeWorker>>,
}

impl KeepAwakeState {
    fn is_enabled(&self) -> Result<bool, String> {
        self.worker
            .lock()
            .map(|worker| worker.is_some())
            .map_err(|_| "The keep-awake state is unavailable.".to_string())
    }

    fn set_enabled(&self, enabled: bool) -> Result<bool, String> {
        self.set_enabled_with(enabled, start_keep_awake_worker)
    }

    fn set_enabled_with(
        &self,
        enabled: bool,
        start_worker: fn() -> Result<KeepAwakeWorker, String>,
    ) -> Result<bool, String> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "The keep-awake state is unavailable.".to_string())?;

        if enabled {
            if worker.is_none() {
                *worker = Some(start_worker()?);
            }
        } else if let Some(active_worker) = worker.take() {
            active_worker.stop()?;
        }

        Ok(worker.is_some())
    }

    pub(crate) fn shutdown(&self) {
        if let Err(error) = self.set_enabled(false) {
            eprintln!("failed to release keep-awake state: {error}");
        }
    }
}

impl Drop for KeepAwakeState {
    fn drop(&mut self) {
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(active_worker) = worker.take() {
                if let Err(error) = active_worker.stop() {
                    eprintln!("failed to release keep-awake state during drop: {error}");
                }
            }
        }
    }
}

fn start_worker(
    set_execution_state: fn(bool) -> Result<(), String>,
) -> Result<KeepAwakeWorker, String> {
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("devtrees-keep-awake".to_string())
        .spawn(move || {
            let activation = set_execution_state(true);
            let active = activation.is_ok();
            if ready_tx.send(activation).is_err() {
                if active {
                    let _ = set_execution_state(false);
                }
                return;
            }
            if !active {
                return;
            }

            let _ = stop_rx.recv();
            let _ = done_tx.send(set_execution_state(false));
        })
        .map_err(|error| format!("Could not start the keep-awake worker: {error}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(KeepAwakeWorker {
            stop_tx,
            done_rx,
            thread,
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            let _ = thread.join();
            Err("The keep-awake worker did not report its startup state.".to_string())
        }
    }
}

fn start_keep_awake_worker() -> Result<KeepAwakeWorker, String> {
    start_worker(set_system_keep_awake)
}

#[cfg(windows)]
fn set_system_keep_awake(enabled: bool) -> Result<(), String> {
    use winapi::um::winbase::SetThreadExecutionState;

    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_CONTINUOUS: u32 = 0x8000_0000;

    let flags = if enabled {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    let previous = unsafe { SetThreadExecutionState(flags) };
    if previous == 0 {
        Err(format!(
            "Windows could not update the system sleep state: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn set_system_keep_awake(_enabled: bool) -> Result<(), String> {
    Err("Keep awake is currently supported only on Windows.".to_string())
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

#[tauri::command]
pub fn system_get_keep_awake(state: State<'_, KeepAwakeState>) -> KeepAwakeResult {
    match state.is_enabled() {
        Ok(enabled) => KeepAwakeResult::ok(enabled),
        Err(error) => KeepAwakeResult::err(false, error),
    }
}

#[tauri::command]
pub fn system_set_keep_awake(state: State<'_, KeepAwakeState>, enabled: bool) -> KeepAwakeResult {
    match state.set_enabled(enabled) {
        Ok(enabled) => KeepAwakeResult::ok(enabled),
        Err(error) => {
            let current = state.is_enabled().unwrap_or(false);
            KeepAwakeResult::err(current, error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};

    static WORKER_EXECUTION_CALLS: AtomicU8 = AtomicU8::new(0);
    static STATE_EXECUTION_CALLS: AtomicU8 = AtomicU8::new(0);
    static WORKER_STARTS: AtomicUsize = AtomicUsize::new(0);

    fn mock_worker_execution_state(enabled: bool) -> Result<(), String> {
        WORKER_EXECUTION_CALLS.fetch_or(if enabled { 1 } else { 2 }, Ordering::SeqCst);
        Ok(())
    }

    fn mock_state_execution_state(enabled: bool) -> Result<(), String> {
        STATE_EXECUTION_CALLS.fetch_or(if enabled { 1 } else { 2 }, Ordering::SeqCst);
        Ok(())
    }

    fn failing_execution_state(_enabled: bool) -> Result<(), String> {
        Err("native failure".to_string())
    }

    fn mock_worker() -> Result<KeepAwakeWorker, String> {
        WORKER_STARTS.fetch_add(1, Ordering::SeqCst);
        start_worker(mock_state_execution_state)
    }

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

    #[test]
    fn keep_awake_worker_enables_and_resets_on_the_same_lifecycle() {
        WORKER_EXECUTION_CALLS.store(0, Ordering::SeqCst);
        let worker = start_worker(mock_worker_execution_state).unwrap();
        worker.stop().unwrap();
        assert_eq!(WORKER_EXECUTION_CALLS.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn keep_awake_worker_propagates_native_startup_failures() {
        let error = match start_worker(failing_execution_state) {
            Ok(_) => panic!("expected native startup failure"),
            Err(error) => error,
        };
        assert_eq!(error, "native failure");
    }

    #[test]
    fn keep_awake_state_transitions_are_idempotent() {
        STATE_EXECUTION_CALLS.store(0, Ordering::SeqCst);
        WORKER_STARTS.store(0, Ordering::SeqCst);
        let state = KeepAwakeState::default();

        assert!(state.set_enabled_with(true, mock_worker).unwrap());
        assert!(state.set_enabled_with(true, mock_worker).unwrap());
        assert_eq!(WORKER_STARTS.load(Ordering::SeqCst), 1);
        assert!(!state.set_enabled_with(false, mock_worker).unwrap());
        assert!(!state.set_enabled_with(false, mock_worker).unwrap());
        assert_eq!(STATE_EXECUTION_CALLS.load(Ordering::SeqCst), 3);
    }
}
