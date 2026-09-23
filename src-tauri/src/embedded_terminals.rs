use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::process::ProcessScope;

pub const OUTPUT_EVENT: &str = "embedded-terminals:output";
pub const UPDATE_EVENT: &str = "embedded-terminals:update";
const MAX_REPLAY_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminal {
    pub terminal_id: String,
    pub kind: String,
    pub folder_path: String,
    pub label: String,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub task_id: Option<String>,
    pub copilot_session_id: Option<String>,
    pub phase: String,
    pub status: String,
    pub last_activity: String,
    pub pending_prompt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub exit_code: Option<i32>,
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub folder_path: String,
    pub label: String,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub task_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub ok: bool,
    pub terminal: Option<EmbeddedTerminal>,
    pub error: Option<String>,
}

impl StartResult {
    fn ok(terminal: EmbeddedTerminal) -> Self {
        Self {
            ok: true,
            terminal: Some(terminal),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            terminal: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    terminal_id: String,
    seq: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    terminal: EmbeddedTerminal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub seq: u64,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

struct Runtime {
    terminal: Mutex<EmbeddedTerminal>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    scope: Mutex<Option<ProcessScope>>,
    replay: Mutex<VecDeque<u8>>,
    seq: Mutex<u64>,
    root_pid: u32,
}

#[derive(Default)]
pub struct EmbeddedTerminalManager {
    runtimes: Mutex<HashMap<String, Arc<Runtime>>>,
    configured_roots: Mutex<Option<(Instant, Vec<PathBuf>)>>,
}

fn canonical(path: &Path) -> AppResult<PathBuf> {
    fs::canonicalize(path).map_err(|error| {
        AppError::msg(format!(
            "The terminal folder could not be resolved: {error}"
        ))
    })
}

fn path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw.to_string()
    }
}

fn contains_path(root: &Path, candidate: &Path) -> bool {
    let root = path_key(root);
    let candidate = path_key(candidate);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with(std::path::MAIN_SEPARATOR))
}

fn configured_roots(app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    let manager = app.state::<EmbeddedTerminalManager>();
    if let Some((cached_at, roots)) = manager
        .configured_roots
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .as_ref()
    {
        if cached_at.elapsed() < Duration::from_secs(5) {
            return Ok(roots.clone());
        }
    }
    let repository_paths = {
        let state = app.state::<DbState>();
        let db = state
            .0
            .lock()
            .map_err(|_| AppError::msg("Database mutex poisoned."))?;
        let mut statement = db.prepare("SELECT path FROM repositories")?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        paths
    };
    let mut roots = Vec::new();
    for repository in repository_paths {
        if let Ok(root) = canonical(Path::new(&repository)) {
            roots.push(root.clone());
        }
        let output = crate::git::run_git_blocking(
            &[
                "worktree".to_string(),
                "list".to_string(),
                "--porcelain".to_string(),
            ],
            &repository,
        );
        if let Ok(output) = output {
            for line in output.stdout.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    if let Ok(root) = canonical(Path::new(path.trim())) {
                        roots.push(root);
                    }
                }
            }
        }
    }
    roots.sort_by_key(|root| path_key(root));
    roots.dedup_by(|left, right| path_key(left) == path_key(right));
    *manager
        .configured_roots
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))? =
        Some((Instant::now(), roots.clone()));
    Ok(roots)
}

fn validate_folder(app: &AppHandle, folder: &str) -> AppResult<PathBuf> {
    let candidate = canonical(Path::new(folder))?;
    if is_allowed(&configured_roots(app)?, &candidate) {
        Ok(candidate)
    } else {
        Err(AppError::msg(
            "Terminals can only start inside a configured repository or worktree.",
        ))
    }
}

fn is_allowed(roots: &[PathBuf], candidate: &Path) -> bool {
    roots.iter().any(|root| contains_path(root, candidate))
}

fn resolve_shell() -> AppResult<PathBuf> {
    if let Ok(path) = which("pwsh.exe") {
        return Ok(path);
    }
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let powershell = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if powershell.is_file() {
        Ok(powershell)
    } else {
        Err(AppError::msg(
            "PowerShell 7 or Windows PowerShell is required for embedded terminals.",
        ))
    }
}

fn which(executable: &str) -> std::io::Result<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "PATH is unavailable",
        ));
    };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(executable);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("{executable} was not found"),
    ))
}

fn publish_update(app: &AppHandle, terminal: &EmbeddedTerminal) {
    let _ = app.emit(
        UPDATE_EVENT,
        UpdateEvent {
            terminal: terminal.clone(),
        },
    );
}

fn start_runtime(
    app: &AppHandle,
    request: StartRequest,
    kind: &str,
    copilot_session_id: Option<String>,
    initial_command: Option<String>,
) -> AppResult<EmbeddedTerminal> {
    if request.cols == 0 || request.rows == 0 || request.cols > 1000 || request.rows > 500 {
        return Err(AppError::msg("Invalid terminal dimensions."));
    }
    let folder = validate_folder(app, &request.folder_path)?;
    let shell = resolve_shell()?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: request.rows,
            cols: request.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::msg(format!("Could not create the terminal: {error}")))?;
    let mut command = CommandBuilder::new(shell.clone());
    command.cwd(&folder);
    command.arg("-NoLogo");
    let windows_powershell = shell.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("powershell.exe")
    });
    let encoding_setup =
        "[Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); chcp 65001 > $null";
    if let Some(initial_command) = initial_command {
        command.arg("-NoExit");
        command.arg("-Command");
        command.arg(if windows_powershell {
            format!("{encoding_setup}; {initial_command}")
        } else {
            initial_command
        });
    } else if windows_powershell {
        command.arg("-NoExit");
        command.arg("-Command");
        command.arg(encoding_setup);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| AppError::msg(format!("Could not start PowerShell: {error}")))?;
    let pid = child
        .process_id()
        .ok_or_else(|| AppError::msg("The terminal process id is unavailable."))?;
    let scope = ProcessScope::attach_pid(pid)
        .map_err(|error| AppError::msg(format!("Could not own the terminal process: {error}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::msg(format!("Could not read terminal output: {error}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| AppError::msg(format!("Could not write terminal input: {error}")))?;
    let now = now_ms();
    let terminal = EmbeddedTerminal {
        terminal_id: uuid::Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        folder_path: folder.to_string_lossy().to_string(),
        label: request.label,
        repository: request.repository,
        branch: request.branch,
        task_id: request.task_id,
        copilot_session_id,
        phase: "running".into(),
        status: "idle".into(),
        last_activity: if kind == "copilot" {
            "Starting Copilot in the embedded terminal".into()
        } else {
            "PowerShell is ready".into()
        },
        pending_prompt: None,
        created_at: now,
        updated_at: now,
        exit_code: None,
        revision: 1,
    };
    let runtime = Arc::new(Runtime {
        terminal: Mutex::new(terminal.clone()),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        scope: Mutex::new(Some(scope)),
        replay: Mutex::new(VecDeque::new()),
        seq: Mutex::new(0),
        root_pid: pid,
    });
    app.state::<EmbeddedTerminalManager>()
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .insert(terminal.terminal_id.clone(), runtime.clone());

    let handle = app.clone();
    let terminal_id = terminal.terminal_id.clone();
    std::thread::spawn(move || read_output(handle, terminal_id, runtime, reader));
    if kind == "shell" {
        let handle = app.clone();
        let runtime = app
            .state::<EmbeddedTerminalManager>()
            .runtimes
            .lock()
            .ok()
            .and_then(|runtimes| runtimes.get(&terminal.terminal_id).cloned());
        if let Some(runtime) = runtime {
            std::thread::spawn(move || discover_copilot(handle, runtime));
        }
    }
    publish_update(app, &terminal);
    Ok(terminal)
}

fn discover_copilot(app: AppHandle, runtime: Arc<Runtime>) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let terminal = match runtime.terminal.lock() {
            Ok(terminal) => terminal.clone(),
            Err(_) => return,
        };
        if terminal.phase != "running" {
            return;
        }
        if terminal.copilot_session_id.is_some() {
            return;
        }
        let Some(session_id) = crate::terminal_sessions::discover_embedded_copilot(
            runtime.root_pid,
            terminal.created_at,
        ) else {
            continue;
        };
        let updated = match runtime.terminal.lock() {
            Ok(mut current) => {
                current.kind = "copilot".into();
                current.copilot_session_id = Some(session_id.clone());
                current.status = "starting".into();
                current.last_activity = "Monitoring Copilot in the embedded terminal".into();
                current.updated_at = now_ms();
                current.revision += 1;
                current.clone()
            }
            Err(_) => return,
        };
        publish_update(&app, &updated);
        if let Err(error) =
            crate::terminal_sessions::attach_discovered_embedded(&app, &updated, &session_id)
        {
            eprintln!("Could not attach embedded Copilot monitoring: {error}");
        }
        return;
    }
}

fn read_output(
    app: AppHandle,
    terminal_id: String,
    runtime: Arc<Runtime>,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let bytes = buffer[..read].to_vec();
                if let Ok(mut replay) = runtime.replay.lock() {
                    replay.extend(bytes.iter().copied());
                    while replay.len() > MAX_REPLAY_BYTES {
                        replay.pop_front();
                    }
                }
                let seq = match runtime.seq.lock() {
                    Ok(mut seq) => {
                        *seq += 1;
                        *seq
                    }
                    Err(_) => break,
                };
                let _ = app.emit(
                    OUTPUT_EVENT,
                    OutputEvent {
                        terminal_id: terminal_id.clone(),
                        seq,
                        bytes,
                    },
                );
            }
            Err(_) => break,
        }
    }
    let exit_code = runtime
        .child
        .lock()
        .ok()
        .and_then(|mut child| child.try_wait().ok().flatten())
        .map(|status| status.exit_code() as i32);
    let terminal = runtime.terminal.lock().ok().map(|mut terminal| {
        terminal.phase = "exited".into();
        terminal.status = "done".into();
        terminal.last_activity = "Terminal exited".into();
        terminal.exit_code = exit_code;
        terminal.updated_at = now_ms();
        terminal.revision += 1;
        terminal.clone()
    });
    if let Some(terminal) = terminal {
        publish_update(&app, &terminal);
        if let Some(state) = app.try_state::<EmbeddedTerminalManager>() {
            if let Ok(mut runtimes) = state.runtimes.lock() {
                runtimes.remove(&terminal_id);
            }
        }
        crate::terminal_sessions::detach_embedded_terminal(&app, &terminal_id);
    }
}

#[tauri::command]
pub fn embedded_terminals_list(
    state: tauri::State<'_, EmbeddedTerminalManager>,
) -> AppResult<Vec<EmbeddedTerminal>> {
    let runtimes = state
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?;
    Ok(runtimes
        .values()
        .filter_map(|runtime| runtime.terminal.lock().ok().map(|value| value.clone()))
        .collect())
}

#[tauri::command]
pub async fn embedded_terminal_start(
    app: AppHandle,
    request: StartRequest,
) -> AppResult<StartResult> {
    match tauri::async_runtime::spawn_blocking(move || {
        start_runtime(&app, request, "shell", None, None)
    })
    .await
    .map_err(|error| AppError::msg(format!("Terminal startup task failed: {error}")))?
    {
        Ok(terminal) => Ok(StartResult::ok(terminal)),
        Err(error) => Ok(StartResult::err(error.to_string())),
    }
}

pub(crate) fn start_copilot(
    app: &AppHandle,
    request: StartRequest,
    copilot_session_id: String,
    command: String,
) -> AppResult<EmbeddedTerminal> {
    start_runtime(
        app,
        request,
        "copilot",
        Some(copilot_session_id),
        Some(command),
    )
}

#[tauri::command]
pub fn embedded_terminal_write(
    state: tauri::State<'_, EmbeddedTerminalManager>,
    terminal_id: String,
    data: String,
) -> AppResult<()> {
    if data.len() > MAX_INPUT_BYTES {
        return Err(AppError::msg("Terminal input is too large."));
    }
    let runtime = state
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| AppError::msg("The terminal is no longer running."))?;
    let mut writer = runtime
        .writer
        .lock()
        .map_err(|_| AppError::msg("Terminal writer mutex poisoned."))?;
    writer.write_all(data.as_bytes())?;
    writer.flush()?;
    Ok(())
}

#[tauri::command]
pub fn embedded_terminal_resize(
    state: tauri::State<'_, EmbeddedTerminalManager>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 500 {
        return Err(AppError::msg("Invalid terminal dimensions."));
    }
    let runtime = state
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| AppError::msg("The terminal is no longer running."))?;
    let result = runtime
        .master
        .lock()
        .map_err(|_| AppError::msg("Terminal resize mutex poisoned."))?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::msg(format!("Could not resize the terminal: {error}")));
    result
}

#[tauri::command]
pub fn embedded_terminal_replay(
    state: tauri::State<'_, EmbeddedTerminalManager>,
    terminal_id: String,
) -> AppResult<Replay> {
    let runtime = state
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| AppError::msg("The terminal is no longer running."))?;
    let seq = *runtime
        .seq
        .lock()
        .map_err(|_| AppError::msg("Terminal sequence mutex poisoned."))?;
    let bytes = runtime
        .replay
        .lock()
        .map_err(|_| AppError::msg("Terminal replay mutex poisoned."))?
        .iter()
        .copied()
        .collect();
    Ok(Replay {
        seq,
        bytes,
        truncated: false,
    })
}

#[tauri::command]
pub fn embedded_terminal_close(app: AppHandle, terminal_id: String) -> AppResult<()> {
    close_terminal(&app, &terminal_id)
}

pub(crate) fn close_terminal(app: &AppHandle, terminal_id: &str) -> AppResult<()> {
    let runtime = app
        .state::<EmbeddedTerminalManager>()
        .runtimes
        .lock()
        .map_err(|_| AppError::msg("Terminal manager mutex poisoned."))?
        .remove(terminal_id)
        .ok_or_else(|| AppError::msg("The terminal is no longer running."))?;
    if let Ok(mut child) = runtime.child.lock() {
        let _ = child.kill();
    }
    if let Ok(mut scope) = runtime.scope.lock() {
        scope.take();
    }
    crate::terminal_sessions::detach_embedded_terminal(app, terminal_id);
    Ok(())
}

#[tauri::command]
pub async fn embedded_terminal_list_directories(
    app: AppHandle,
    folder_path: String,
) -> AppResult<Vec<DirectoryEntry>> {
    tauri::async_runtime::spawn_blocking(move || list_directories(&app, &folder_path))
        .await
        .map_err(|error| AppError::msg(format!("Directory listing task failed: {error}")))?
}

fn list_directories(app: &AppHandle, folder_path: &str) -> AppResult<Vec<DirectoryEntry>> {
    let roots = configured_roots(app)?;
    let folder = canonical(Path::new(folder_path))?;
    if !is_allowed(&roots, &folder) {
        return Err(AppError::msg(
            "This folder is outside the configured repositories and worktrees.",
        ));
    }
    let mut entries = fs::read_dir(folder)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let path = canonical(&entry.path()).ok()?;
            is_allowed(&roots, &path).then_some(())?;
            Some(DirectoryEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<EmbeddedTerminalManager>() else {
        return;
    };
    let runtimes = match state.runtimes.lock() {
        Ok(mut runtimes) => runtimes
            .drain()
            .map(|(_, runtime)| runtime)
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    for runtime in runtimes {
        let terminal_id = runtime
            .terminal
            .lock()
            .ok()
            .map(|terminal| terminal.terminal_id.clone());
        if let Ok(mut child) = runtime.child.lock() {
            let _ = child.kill();
        }
        if let Ok(mut scope) = runtime.scope.lock() {
            scope.take();
        }
        if let Some(terminal_id) = terminal_id {
            crate::terminal_sessions::detach_embedded_terminal(app, &terminal_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::contains_path;
    use std::path::Path;

    #[test]
    fn containment_requires_a_path_boundary() {
        assert!(contains_path(
            Path::new(r"C:\repo"),
            Path::new(r"C:\repo\src")
        ));
        assert!(!contains_path(
            Path::new(r"C:\repo"),
            Path::new(r"C:\repo-evil")
        ));
    }
}
