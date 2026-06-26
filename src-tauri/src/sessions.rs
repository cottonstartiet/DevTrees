//! Embedded Copilot CLI terminal sessions.
//!
//! Hosts real PTY-backed `copilot` processes inside DevTrees (the in-app alternative to launching
//! the external Windows Terminal). Each session owns a ConPTY via `portable-pty`; a dedicated
//! reader thread streams output to the renderer as `sessions:data` events (base64 of the raw PTY
//! bytes so multibyte/escape sequences are never corrupted by a chunk boundary). The renderer
//! renders it with xterm.js and replays the rolling buffer on (re)mount using sequence numbers.
//!
//! Clean teardown is the critical contract: Copilot spawns children (language servers, MCP
//! servers, git, …) that inherit the session's working directory and would otherwise keep the
//! worktree folder locked. `kill()` walks the whole process tree with `taskkill /PID <pid> /T /F`
//! before dropping the PTY handles, so the folder is fully released and can be deleted.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};

// Per-session rolling output cap (raw bytes). Output beyond this drops the oldest bytes so a
// long-running session can't grow memory unbounded; the live xterm keeps its own scrollback.
const MAX_BUFFER_BYTES: usize = 1_500_000;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 30;
const MAX_DIMENSION: u16 = 1000;
const MAX_INPUT_BYTES: usize = 100_000;
const MAX_PROMPT_BYTES: usize = 200_000;
const READ_CHUNK: usize = 8192;

const EVENT_DATA: &str = "sessions:data";
const EVENT_EXIT: &str = "sessions:exit";

// ----- Serializable shapes shared with the renderer (camelCase) -----

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSession {
    pub id: String,
    pub label: String,
    pub folder_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// "running" | "exited"
    pub status: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub folder_path: String,
    #[serde(default)]
    pub prompt: Option<String>,
    pub label: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<CopilotSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: CopilotSession,
    /// base64 of the rolling raw output buffer.
    pub buffer_b64: String,
    pub last_seq: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDataEvent {
    id: String,
    seq: u64,
    /// base64 of the raw output chunk.
    data_b64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExitEvent {
    id: String,
    exit_code: i64,
}

// ----- Internal session state -----

struct SessionState {
    meta: CopilotSession,
    buffer: Vec<u8>,
    seq: u64,
}

struct SessionInner {
    id: String,
    folder_path: String,
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    state: Mutex<SessionState>,
    closing: AtomicBool,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<SessionInner>>>,
}

// ----- Helpers -----

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clamp_dim(value: Option<u16>, fallback: u16) -> u16 {
    match value {
        Some(v) if v >= 1 => v.min(MAX_DIMENSION),
        _ => fallback,
    }
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

fn is_valid_session_id(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[0-9a-fA-F-]{8,64}$").unwrap());
    re.is_match(id)
}

/// Resolve the Copilot CLI executable. The GUI process may not share the PATH of an interactive
/// shell, so we resolve an absolute path up front (cached) and surface an actionable error when it
/// can't be found.
fn detect_copilot_cli() -> Result<String, AppError> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some(p) = cache.lock().unwrap().clone() {
        return Ok(p);
    }

    let mut cmd = Command::new("where.exe");
    cmd.arg("copilot");
    configure_no_window(&mut cmd);
    let out = cmd.output().map_err(|e| {
        AppError::msg(format!(
            "Could not run `where.exe` to locate the Copilot CLI: {e}"
        ))
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let candidates: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if candidates.is_empty() {
        return Err(AppError::msg(
            "Copilot CLI not found. Install it and ensure `copilot` is on your PATH, then try again.",
        ));
    }
    // Prefer a real executable over an .exe-less shim when both exist.
    let resolved = candidates
        .iter()
        .find(|p| p.to_lowercase().ends_with(".exe"))
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    *cache.lock().unwrap() = Some(resolved.clone());
    Ok(resolved)
}

/// Map a resolved CLI path + Copilot args to the actual file/args to spawn. `portable-pty` can
/// launch an `.exe` directly, but shim scripts (`.cmd`/`.bat`/`.ps1`) must run through their host
/// interpreter.
fn resolve_spawn_target(cli_path: &str, args: Vec<String>) -> (String, Vec<String>) {
    let lower = cli_path.to_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut full = vec!["/c".to_string(), cli_path.to_string()];
        full.extend(args);
        return (comspec, full);
    }
    if lower.ends_with(".ps1") {
        let mut full = vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            cli_path.to_string(),
        ];
        full.extend(args);
        return ("powershell.exe".to_string(), full);
    }
    (cli_path.to_string(), args)
}

/// Forcibly terminate a process and its entire descendant tree on Windows so every handle on the
/// worktree folder is released.
fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    configure_no_window(&mut cmd);
    let _ = cmd.output();
}

fn path_is_within(candidate: &str, ancestor: &str) -> bool {
    let norm = |p: &str| {
        std::path::absolute(p)
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string())
            .trim_end_matches(['\\', '/'])
            .to_string()
    };
    let (c, a) = (norm(candidate), norm(ancestor));
    let (c, a) = if cfg!(windows) {
        (c.to_lowercase(), a.to_lowercase())
    } else {
        (c, a)
    };
    if c == a {
        return true;
    }
    let prefix = format!("{a}\\");
    let prefix_unix = format!("{a}/");
    c.starts_with(&prefix) || c.starts_with(&prefix_unix)
}

impl SessionManager {
    pub fn create(
        &self,
        app: &AppHandle,
        req: CreateSessionRequest,
    ) -> Result<CopilotSession, AppError> {
        if !cfg!(windows) {
            return Err(AppError::msg("Copilot sessions are currently Windows-only."));
        }

        let folder_path = req.folder_path.trim().to_string();
        if folder_path.is_empty() {
            return Err(AppError::msg("folderPath is required."));
        }
        if !std::path::Path::new(&folder_path).exists() {
            return Err(AppError::msg(format!(
                "This session's folder no longer exists:\n{folder_path}"
            )));
        }

        let label = {
            let l = req.label.trim();
            if l.is_empty() {
                "Copilot".to_string()
            } else {
                l.to_string()
            }
        };
        let prompt = req.prompt.unwrap_or_default();
        let branch = req
            .branch
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
        let repository = req
            .repository
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty());
        let resume_id = req.resume_session_id.unwrap_or_default();
        let has_prompt = !prompt.trim().is_empty();
        let has_resume = !resume_id.trim().is_empty();

        if has_prompt && has_resume {
            return Err(AppError::msg(
                "A session cannot have both an initial prompt and a resume id.",
            ));
        }
        if has_prompt && prompt.len() > MAX_PROMPT_BYTES {
            return Err(AppError::msg("prompt is too large."));
        }
        if has_resume && !is_valid_session_id(resume_id.trim()) {
            return Err(AppError::msg("Invalid Copilot session id."));
        }

        // With no prompt/resume, start a plain interactive session. A prompt runs immediately via
        // `-i`. For resume we use `--session-id=<id>` rather than `--resume=<id>`: it resumes when
        // the id has a recorded session and otherwise starts a fresh session reusing that UUID, so
        // selecting an empty/ephemeral history entry no longer hard-errors with "No session matched".
        let copilot_args: Vec<String> = if has_resume {
            vec![
                "--allow-all-tools".into(),
                format!("--session-id={}", resume_id.trim()),
            ]
        } else if has_prompt {
            vec!["--allow-all-tools".into(), "-i".into(), prompt]
        } else {
            vec!["--allow-all-tools".into(), "--banner".into()]
        };

        let cli_path = detect_copilot_cli()?;
        let (file, args) = resolve_spawn_target(&cli_path, copilot_args);

        let cols = clamp_dim(req.cols, DEFAULT_COLS);
        let rows = clamp_dim(req.rows, DEFAULT_ROWS);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::msg(format!("Failed to open a terminal: {e}")))?;

        let mut cmd = CommandBuilder::new(&file);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(&folder_path);
        // Inherit the GUI process environment explicitly so the child sees the same PATH that let
        // `where.exe copilot` resolve.
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::msg(format!("Failed to start Copilot: {e}")))?;
        // Drop the slave so the master read sees EOF once the child (and its descendants holding the
        // slave) exit.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::msg(format!("Failed to read from the terminal: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::msg(format!("Failed to write to the terminal: {e}")))?;
        let pid = child.process_id();

        let id = uuid::Uuid::new_v4().to_string();
        let meta = CopilotSession {
            id: id.clone(),
            label,
            folder_path: folder_path.clone(),
            branch,
            repository,
            status: "running".to_string(),
            created_at: now_ms(),
            exited_at: None,
            exit_code: None,
        };

        let inner = Arc::new(SessionInner {
            id: id.clone(),
            folder_path,
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            state: Mutex::new(SessionState {
                meta: meta.clone(),
                buffer: Vec::new(),
                seq: 0,
            }),
            closing: AtomicBool::new(false),
        });

        self.sessions.lock().unwrap().insert(id.clone(), inner.clone());

        spawn_reader(app.clone(), inner, reader);

        Ok(meta)
    }

    pub fn list(&self) -> Vec<CopilotSession> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|e| e.state.lock().unwrap().meta.clone())
            .collect()
    }

    pub fn snapshot(&self, id: &str) -> Option<SessionSnapshot> {
        let inner = self.sessions.lock().unwrap().get(id).cloned()?;
        let st = inner.state.lock().unwrap();
        Some(SessionSnapshot {
            session: st.meta.clone(),
            buffer_b64: base64::engine::general_purpose::STANDARD.encode(&st.buffer),
            last_seq: st.seq,
        })
    }

    pub fn input(&self, id: &str, data: &str) {
        if data.len() > MAX_INPUT_BYTES {
            return;
        }
        let inner = match self.sessions.lock().unwrap().get(id).cloned() {
            Some(i) => i,
            None => return,
        };
        if inner.closing.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut w) = inner.writer.lock() {
            let _ = w.write_all(data.as_bytes());
            let _ = w.flush();
        };
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let inner = match self.sessions.lock().unwrap().get(id).cloned() {
            Some(i) => i,
            None => return,
        };
        if let Ok(master) = inner.master.lock() {
            let _ = master.resize(PtySize {
                rows: clamp_dim(Some(rows), DEFAULT_ROWS),
                cols: clamp_dim(Some(cols), DEFAULT_COLS),
                pixel_width: 0,
                pixel_height: 0,
            });
        };
    }

    /// Kill a single session and release its worktree folder. Removes it from the registry first so
    /// the UI stops tracking it, then tears down the OS process tree before the PTY handles drop.
    pub fn kill(&self, id: &str) {
        let inner = self.sessions.lock().unwrap().remove(id);
        let Some(inner) = inner else { return };
        teardown(&inner);
    }

    /// Kill every session whose working directory is the given path or a descendant of it. Used by
    /// the worktree delete flow so no embedded session keeps the folder locked.
    pub fn kill_sessions_for_path(&self, path: &str) {
        let targets: Vec<Arc<SessionInner>> = {
            let mut map = self.sessions.lock().unwrap();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, inner)| path_is_within(&inner.folder_path, path))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        };
        for inner in targets {
            teardown(&inner);
        }
    }

    /// Synchronous teardown of all sessions, for app shutdown.
    pub fn kill_all(&self) {
        let all: Vec<Arc<SessionInner>> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().map(|(_, v)| v).collect()
        };
        for inner in all {
            teardown(&inner);
        }
    }
}

/// Tear down a single session's OS resources. Kills the whole process tree first (while parent
/// links are intact) so the folder is released, then kills/reaps the child.
fn teardown(inner: &Arc<SessionInner>) {
    inner.closing.store(true, Ordering::SeqCst);
    if let Some(pid) = inner.pid {
        kill_process_tree(pid);
    }
    if let Ok(mut child) = inner.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // The master/writer handles drop when the last Arc<SessionInner> drops (the reader thread
    // releases its clone once the killed child closes the slave and read() returns EOF).
}

fn spawn_reader(app: AppHandle, inner: Arc<SessionInner>, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let seq = {
                        let mut st = inner.state.lock().unwrap();
                        st.buffer.extend_from_slice(chunk);
                        if st.buffer.len() > MAX_BUFFER_BYTES {
                            let overflow = st.buffer.len() - MAX_BUFFER_BYTES;
                            st.buffer.drain(0..overflow);
                        }
                        st.seq += 1;
                        st.seq
                    };
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
                    let _ = app.emit(
                        EVENT_DATA,
                        SessionDataEvent {
                            id: inner.id.clone(),
                            seq,
                            data_b64,
                        },
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        let exit_code = inner
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|s| s.exit_code() as i64);

        {
            let mut st = inner.state.lock().unwrap();
            st.meta.status = "exited".to_string();
            st.meta.exited_at = Some(now_ms());
            st.meta.exit_code = exit_code;
        }

        let _ = app.emit(
            EVENT_EXIT,
            SessionExitEvent {
                id: inner.id.clone(),
                exit_code: exit_code.unwrap_or(0),
            },
        );
    });
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn sessions_create(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    req: CreateSessionRequest,
) -> AppResult<CreateSessionResponse> {
    match manager.create(&app, req) {
        Ok(session) => Ok(CreateSessionResponse {
            ok: true,
            session: Some(session),
            error: None,
        }),
        Err(e) => Ok(CreateSessionResponse {
            ok: false,
            session: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sessions_list(manager: State<'_, SessionManager>) -> AppResult<Vec<CopilotSession>> {
    Ok(manager.list())
}

#[tauri::command]
pub async fn sessions_snapshot(
    manager: State<'_, SessionManager>,
    id: String,
) -> AppResult<Option<SessionSnapshot>> {
    Ok(manager.snapshot(&id))
}

#[tauri::command]
pub async fn sessions_kill(manager: State<'_, SessionManager>, id: String) -> AppResult<()> {
    manager.kill(&id);
    Ok(())
}

#[tauri::command]
pub async fn sessions_input(
    manager: State<'_, SessionManager>,
    id: String,
    data: String,
) -> AppResult<()> {
    manager.input(&id, &data);
    Ok(())
}

#[tauri::command]
pub async fn sessions_resize(
    manager: State<'_, SessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    manager.resize(&id, cols, rows);
    Ok(())
}
