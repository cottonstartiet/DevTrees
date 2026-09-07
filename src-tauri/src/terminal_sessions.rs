//! Managed Copilot CLI sessions plus compatibility monitoring for legacy external terminals.
//!
//! New sessions use the native Copilot TUI in an app-owned PTY. This module observes
//! CLI event logs for attention and read-only history; pty_sessions owns live I/O.
//! Legacy ACP helpers remain for existing command compatibility.
//!
//! The compatibility tail is driven by a single polling task. Each
//! poll reads only the bytes appended since the last cursor, so watching a long-running
//! session stays cheap even when its log grows to hundreds of megabytes.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::DbState;
use crate::error::{AppError, AppResult};

pub const EVENT_UPDATE: &str = "terminal-sessions:update";
pub const EVENT_INTERACTION: &str = "terminal-sessions:interaction";

/// How often the tail task re-reads every watched log. Fast enough that a prompt in the
/// terminal surfaces as a toast almost immediately, slow enough to stay invisible.
const POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// Guard against a single poll turning into a huge read if the CLI dumps a large burst
/// (e.g. a `messages_snapshot` event). We still advance the cursor, just in slices.
const MAX_READ_PER_POLL: u64 = 4 * 1024 * 1024;

/// Keeps `lastActivity` to a single readable line in the session list.
const MAX_ACTIVITY_LEN: usize = 160;

/// Upper bound on any single timeline string. Tool results in particular can be
/// megabytes; the detail view only needs enough to see what happened.
const MAX_ENTRY_TEXT: usize = 4_000;

/// Most entries kept per session. A long session's log can hold tens of thousands of
/// events, so the history read keeps only the most recent window.
const MAX_ENTRIES: usize = 500;

#[cfg(windows)]
pub(crate) fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

// ----- Types -----

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSessionStatus {
    /// Launched, but the CLI has not written its first event yet.
    Starting,
    /// A model turn or tool call is in flight.
    Working,
    /// Copilot is blocked on the user: permission, elicitation, or another client request.
    WaitingInput,
    /// The turn finished and the CLI is sitting at its prompt.
    Idle,
    /// The terminal process is gone.
    Done,
    /// The session reported a fatal error.
    Error,
}

impl TerminalSessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Working => "working",
            Self::WaitingInput => "waiting-input",
            Self::Idle => "idle",
            Self::Done => "done",
            Self::Error => "error",
        }
    }

    fn parse(raw: &str) -> Self {
        match raw {
            "working" => Self::Working,
            "waiting-input" => Self::WaitingInput,
            "idle" => Self::Idle,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => Self::Starting,
        }
    }

    /// Terminal states are no longer polled and are not restored on app start.
    fn is_final(self) -> bool {
        matches!(self, Self::Done | Self::Error)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    /// The Copilot CLI session id (also the `session-state` folder name).
    pub id: String,
    /// Kanban task this session was started for, when it came from the Tasks board.
    pub task_id: Option<String>,
    pub folder_path: String,
    pub label: String,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub status: TerminalSessionStatus,
    /// Short human-readable description of what Copilot last did.
    pub last_activity: String,
    /// Set while `status` is `waiting-input`: what Copilot is asking for.
    pub pending_prompt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub transport: String,
    pub generation: Option<String>,
    pub revision: u64,
    pub observed_at: Option<i64>,
    pub observation_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTerminalSessionRequest {
    pub id: String,
    pub folder_path: String,
    pub label: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalSessionRequest {
    pub folder_path: String,
    pub label: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub transport: Option<SessionTransport>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionTransport {
    Sdk,
    Pty,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TerminalSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPermissionOption {
    option_id: String,
    name: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalSessionInteraction {
    Permission {
        request_id: u64,
        message: String,
        options: Vec<TerminalSessionPermissionOption>,
    },
    Elicitation {
        request_id: u64,
        mode: String,
        message: String,
        requested_schema: Option<serde_json::Value>,
        url: Option<String>,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionInteractionUpdate {
    session_id: String,
    interaction: Option<TerminalSessionInteraction>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RespondTerminalSessionRequest {
    Permission {
        id: String,
        request_id: u64,
        option_id: String,
    },
    Elicitation {
        id: String,
        request_id: u64,
        action: String,
        #[serde(default)]
        content: Option<serde_json::Value>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingAcpRequest {
    Permission,
    Elicitation,
}

struct AcpSession {
    stdin: Arc<Mutex<ChildStdin>>,
    next_request_id: u64,
    prompt_requests: Vec<u64>,
    user_message_entries: HashMap<String, (u64, String)>,
    message_entries: HashMap<String, (u64, String)>,
    tool_entries: HashMap<String, (u64, String, String)>,
    plan_entry: Option<u64>,
}

#[derive(Default)]
pub struct AcpSessionManager {
    sessions: Mutex<HashMap<String, AcpSession>>,
    pending: Mutex<HashMap<(String, u64), TerminalSessionInteraction>>,
}

// ----- Timeline -----

/// One entry in a session's read-only history, reconstructed from the CLI's event log.
///
/// `seq` is the source line index, which gives entries a stable total order. The renderer
/// merges the initial history fetch with live updates by `seq`, so an entry delivered by
/// both paths is never duplicated.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalTimelineEntry {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        seq: u64,
        timestamp: Option<String>,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    AssistantMessage {
        seq: u64,
        timestamp: Option<String>,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        seq: u64,
        timestamp: Option<String>,
        /// Correlates `tool.execution_start` with its later `tool.execution_complete`.
        tool_call_id: String,
        name: String,
        /// Compact rendering of the tool's arguments.
        detail: String,
        /// `None` while the call is still running.
        success: Option<bool>,
        result: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Permission {
        seq: u64,
        timestamp: Option<String>,
        description: String,
        /// `None` while the prompt is still unanswered in the terminal.
        resolution: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Notice {
        seq: u64,
        timestamp: Option<String>,
        text: String,
        /// `info` | `error` — drives styling.
        level: String,
    },
}

impl TerminalTimelineEntry {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn seq(&self) -> u64 {
        match self {
            Self::UserMessage { seq, .. }
            | Self::AssistantMessage { seq, .. }
            | Self::ToolCall { seq, .. }
            | Self::Permission { seq, .. }
            | Self::Notice { seq, .. } => *seq,
        }
    }
}

/// Payload of `terminal-sessions:update`: the session's new state plus any timeline
/// entries produced by the same poll, so an open detail view stays live.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionUpdate {
    pub session: TerminalSession,
    pub entries: Vec<TerminalTimelineEntry>,
}

// ----- Monitor state -----

/// Per-session bookkeeping that only matters while tailing; not persisted except for
/// the cursor, which lets a restart resume mid-log instead of re-reading everything.
struct Watch {
    session: TerminalSession,
    cursor: u64,
    /// Source line index of the next event, giving timeline entries a stable order.
    seq: u64,
    /// Timeline entries awaiting their completion event (tool calls, permission prompts).
    open_entries: Vec<TerminalTimelineEntry>,
    /// The CLI drops an `inuse.<pid>.lock` file while the process is attached. Once we
    /// have seen one, its disappearance is a reliable "the terminal was closed" signal.
    saw_lock: bool,
    /// Number of consecutive polls where the session folder did not exist yet. Used to
    /// give up on a launch that never produced a session.
    missing_polls: u32,
    /// Managed ACP sessions stream updates directly and must not be tailed as terminals.
    managed: bool,
    attention: crate::session_attention::Attention,
    log_error: Option<String>,
}

#[derive(Default)]
pub struct TerminalSessionMonitor {
    watches: Mutex<HashMap<String, Watch>>,
    started: Mutex<bool>,
}

/// Location of the Copilot CLI's per-session state folders.
fn session_state_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::msg("could not resolve home directory"))?;
    Ok(home.join(".copilot").join("session-state"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Collapse whitespace and clip, so a multi-line assistant message still renders as one
/// tidy line in the sessions list.
fn summarize(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_ACTIVITY_LEN {
        return flat;
    }
    let clipped: String = flat.chars().take(MAX_ACTIVITY_LEN).collect();
    format!("{clipped}…")
}

/// Clip long text on a character boundary, preserving newlines (unlike `summarize`).
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max).collect();
    format!("{clipped}\n… (truncated)")
}

// ----- Persistence -----

fn upsert(db: &Connection, session: &TerminalSession, cursor: u64, seq: u64) -> AppResult<()> {
    db.execute(
        "INSERT INTO terminal_sessions (
           id, task_id, folder_path, label, repository, branch,
           status, last_activity, pending_prompt, cursor, created_at, updated_at, seq, transport, generation, revision
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           folder_path = excluded.folder_path,
           label = excluded.label,
           repository = excluded.repository,
           branch = excluded.branch,
           status = excluded.status,
           last_activity = excluded.last_activity,
           pending_prompt = excluded.pending_prompt,
           cursor = excluded.cursor,
           updated_at = excluded.updated_at,
           seq = excluded.seq,
           transport = excluded.transport,
           generation = excluded.generation,
           revision = excluded.revision",
        rusqlite::params![
            session.id,
            session.task_id,
            session.folder_path,
            session.label,
            session.repository,
            session.branch,
            session.status.as_str(),
            session.last_activity,
            session.pending_prompt,
            cursor as i64,
            session.created_at,
            session.updated_at,
            seq as i64,
            session.transport,
            session.generation,
            session.revision as i64,
        ],
    )?;
    Ok(())
}

const SELECT_COLUMNS: &str =
    "id, task_id, folder_path, label, repository, branch, status, last_activity, \
     pending_prompt, cursor, created_at, updated_at, seq, managed, transport, generation, revision";

fn row_to_watch(row: &rusqlite::Row<'_>) -> rusqlite::Result<Watch> {
    let status: String = row.get(6)?;
    let cursor: i64 = row.get(9)?;
    let seq: i64 = row.get(12)?;
    Ok(Watch {
        session: TerminalSession {
            id: row.get(0)?,
            task_id: row.get(1)?,
            folder_path: row.get(2)?,
            label: row.get(3)?,
            repository: row.get(4)?,
            branch: row.get(5)?,
            status: TerminalSessionStatus::parse(&status),
            last_activity: row.get(7)?,
            pending_prompt: row.get(8)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            transport: row.get(14)?,
            generation: row.get(15)?,
            revision: row.get::<_, i64>(16)?.max(0) as u64,
            observed_at: None,
            observation_error: None,
        },
        cursor: cursor.max(0) as u64,
        seq: seq.max(0) as u64,
        open_entries: Vec::new(),
        saw_lock: false,
        missing_polls: 0,
        managed: row.get::<_, i64>(13)? != 0,
        attention: crate::session_attention::Attention::default(),
        log_error: None,
    })
}

fn load_one(db: &Connection, id: &str) -> AppResult<Option<Watch>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM terminal_sessions WHERE id = ?1");
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query_map([id], row_to_watch)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn load_all(db: &Connection) -> AppResult<Vec<Watch>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM terminal_sessions ORDER BY created_at DESC");
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_watch)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ----- Event interpretation -----

/// The subset of an `events.jsonl` line we care about.
#[derive(Deserialize)]
struct RawEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    data: serde_json::Value,
    #[serde(default)]
    timestamp: Option<String>,
}

/// Compact single-line rendering of a tool's arguments for the timeline.
fn describe_arguments(args: &serde_json::Value) -> String {
    match args {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Object(map) => {
            let rendered = map
                .iter()
                .map(|(key, value)| {
                    let text = match value {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    format!("{key}: {text}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            summarize(&rendered)
        }
        serde_json::Value::String(s) => summarize(s),
        other => summarize(&other.to_string()),
    }
}

/// Human-readable outcome of a resolved permission prompt.
fn describe_permission_result(data: &serde_json::Value) -> String {
    let result = data.get("result").unwrap_or(&serde_json::Value::Null);
    let kind = result
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("resolved");
    match kind {
        "approved-for-location" | "approved-for-session" | "approved" => "Approved".to_string(),
        "denied" | "rejected" => "Denied".to_string(),
        other => summarize(other),
    }
}

/// Turn one event into a timeline entry, or update the entry it continues.
///
/// `tool.execution_complete` and `permission.completed` finish an entry opened earlier
/// rather than appending a second row, so the timeline reads as one item per action.
fn timeline_entry(
    event: &RawEvent,
    seq: u64,
    open: &mut Vec<TerminalTimelineEntry>,
) -> Option<TerminalTimelineEntry> {
    let timestamp = event.timestamp.clone();
    match event.event_type.as_str() {
        "user.message" => {
            let text = event.data.get("content")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(TerminalTimelineEntry::UserMessage {
                seq,
                timestamp,
                text: truncate(&text, MAX_ENTRY_TEXT),
            })
        }
        // Sub-agent chatter (`agentId` present) would swamp the timeline; only the main
        // agent's messages are shown.
        "assistant.message" if event.data.get("agentId").is_none() => {
            let text = event.data.get("content")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(TerminalTimelineEntry::AssistantMessage {
                seq,
                timestamp,
                text: truncate(&text, MAX_ENTRY_TEXT),
            })
        }
        "tool.execution_start" => {
            let tool_call_id = event
                .data
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let name = event
                .data
                .get("toolName")
                .or_else(|| event.data.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let entry = TerminalTimelineEntry::ToolCall {
                seq,
                timestamp,
                tool_call_id: tool_call_id.clone(),
                name,
                detail: describe_arguments(
                    event
                        .data
                        .get("arguments")
                        .unwrap_or(&serde_json::Value::Null),
                ),
                success: None,
                result: None,
            };
            if !tool_call_id.is_empty() {
                open.push(entry.clone());
            }
            Some(entry)
        }
        "tool.execution_complete" => {
            let id = event.data.get("toolCallId")?.as_str()?;
            let idx = open.iter().position(|entry| {
                matches!(entry, TerminalTimelineEntry::ToolCall { tool_call_id, .. } if tool_call_id == id)
            })?;
            let mut entry = open.remove(idx);
            if let TerminalTimelineEntry::ToolCall {
                success, result, ..
            } = &mut entry
            {
                *success = event.data.get("success").and_then(|v| v.as_bool());
                *result = event
                    .data
                    .get("result")
                    .and_then(|r| r.get("content"))
                    .and_then(|v| v.as_str())
                    .map(|text| truncate(text.trim(), MAX_ENTRY_TEXT));
            }
            Some(entry)
        }
        "permission.requested" => {
            let entry = TerminalTimelineEntry::Permission {
                seq,
                timestamp,
                description: describe_permission(&event.data),
                resolution: None,
            };
            open.push(entry.clone());
            Some(entry)
        }
        "permission.completed" => {
            let idx = open
                .iter()
                .position(|entry| matches!(entry, TerminalTimelineEntry::Permission { .. }))?;
            let mut entry = open.remove(idx);
            if let TerminalTimelineEntry::Permission { resolution, .. } = &mut entry {
                *resolution = Some(describe_permission_result(&event.data));
            }
            Some(entry)
        }
        "session.error" => Some(TerminalTimelineEntry::Notice {
            seq,
            timestamp,
            text: summarize(
                event
                    .data
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("The session reported an error."),
            ),
            level: "error".to_string(),
        }),
        "session.info" | "session.warning" => Some(TerminalTimelineEntry::Notice {
            seq,
            timestamp,
            text: summarize(event.data.get("message").and_then(|v| v.as_str())?),
            level: "info".to_string(),
        }),
        "abort" => Some(TerminalTimelineEntry::Notice {
            seq,
            timestamp,
            text: "Copilot stopped the current turn.".to_string(),
            level: "info".to_string(),
        }),
        _ => None,
    }
}

/// Best-effort description of what a permission request is asking to do.
fn describe_permission(data: &serde_json::Value) -> String {
    let request = data
        .get("permissionRequest")
        .or_else(|| data.get("promptRequest"))
        .unwrap_or(&serde_json::Value::Null);
    let detail = ["command", "url", "path", "toolName", "intention"]
        .iter()
        .find_map(|key| request.get(*key).and_then(|v| v.as_str()))
        .unwrap_or_default();
    let kind = request
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("permission");
    if detail.is_empty() {
        format!("Copilot needs approval ({kind}).")
    } else {
        summarize(&format!("Approve {kind}: {detail}"))
    }
}

/// Apply one event to a session, returning `true` when anything user-visible changed.
fn apply_event(session: &mut TerminalSession, event: &RawEvent) -> bool {
    let before_status = session.status;
    let before_activity = session.last_activity.clone();
    let before_pending = session.pending_prompt.clone();

    match event.event_type.as_str() {
        "session.start" | "session.resume" => {
            session.status = TerminalSessionStatus::Idle;
            session.pending_prompt = None;
            session.last_activity = "Session started".to_string();
        }
        "user.message" => {
            session.status = TerminalSessionStatus::Working;
            session.pending_prompt = None;
            if let Some(content) = event.data.get("content").and_then(|v| v.as_str()) {
                session.last_activity = summarize(&format!("You: {content}"));
            }
        }
        "assistant.turn_start" | "model.turn_started" => {
            session.status = TerminalSessionStatus::Working;
        }
        "assistant.message" => {
            session.status = TerminalSessionStatus::Working;
            if let Some(content) = event.data.get("content").and_then(|v| v.as_str()) {
                if !content.trim().is_empty() {
                    session.last_activity = summarize(content);
                }
            }
        }
        "tool.execution_start" => {
            let name = event
                .data
                .get("toolName")
                .or_else(|| event.data.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            // `ask_user` is the CLI's interactive question tool: it blocks until answered.
            if name == "ask_user" {
                session.status = TerminalSessionStatus::WaitingInput;
                session.pending_prompt = Some("Copilot asked you a question.".to_string());
                session.last_activity = "Waiting for your answer".to_string();
            } else {
                session.status = TerminalSessionStatus::Working;
                session.last_activity = summarize(&format!("Running {name}"));
            }
        }
        "permission.requested" => {
            session.status = TerminalSessionStatus::WaitingInput;
            let prompt = describe_permission(&event.data);
            session.last_activity = prompt.clone();
            session.pending_prompt = Some(prompt);
        }
        "permission.completed" => {
            if session.status == TerminalSessionStatus::WaitingInput {
                session.status = TerminalSessionStatus::Working;
            }
            session.pending_prompt = None;
        }
        "assistant.turn_end" | "model.turn_ended" | "abort" => {
            // A turn ending is the "Copilot is done, your move" moment.
            session.status = TerminalSessionStatus::Idle;
            session.pending_prompt = None;
        }
        "session.error" => {
            // A CLI error may end a turn, not the process. Keep its terminal usable.
            session.status = if session.transport == "pty" {
                TerminalSessionStatus::Idle
            } else {
                TerminalSessionStatus::Error
            };
            let message = event
                .data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("The Copilot session reported an error.");
            session.last_activity = summarize(message);
        }
        _ => {}
    }

    session.status != before_status
        || session.last_activity != before_activity
        || session.pending_prompt != before_pending
}

fn write_rpc(stdin: &Arc<Mutex<ChildStdin>>, value: &serde_json::Value) -> AppResult<()> {
    let mut input = stdin
        .lock()
        .map_err(|_| AppError::msg("Copilot input mutex poisoned"))?;
    serde_json::to_writer(&mut *input, value)?;
    input.write_all(b"\n")?;
    input.flush()?;
    Ok(())
}

fn next_acp_request(
    manager: &AcpSessionManager,
    session_id: &str,
    method: &str,
    params: serde_json::Value,
) -> AppResult<u64> {
    let (stdin, request_id) = {
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| AppError::msg("Copilot session mutex poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| AppError::msg("This Copilot session is no longer connected."))?;
        let request_id = session.next_request_id;
        session.next_request_id += 1;
        (session.stdin.clone(), request_id)
    };
    write_rpc(
        &stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        }),
    )?;
    Ok(request_id)
}

fn send_acp_prompt(app: &AppHandle, session_id: &str, prompt: &str) -> AppResult<()> {
    let seq = allocate_managed_seq(app, session_id)
        .ok_or_else(|| AppError::msg("This Copilot session is no longer available."))?;
    emit_managed_entry(
        app,
        session_id,
        TerminalTimelineEntry::UserMessage {
            seq,
            timestamp: None,
            text: truncate(prompt, MAX_ENTRY_TEXT),
        },
    );
    let request_id = next_acp_request(
        &app.state::<AcpSessionManager>(),
        session_id,
        "session/prompt",
        serde_json::json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }]
        }),
    )?;
    if let Ok(mut sessions) = app.state::<AcpSessionManager>().sessions.lock() {
        if let Some(session) = sessions.get_mut(session_id) {
            session.prompt_requests.push(request_id);
        }
    }
    set_managed_status(
        app,
        session_id,
        TerminalSessionStatus::Working,
        "Working on your message",
        None,
    );
    Ok(())
}

fn emit_interaction(
    app: &AppHandle,
    session_id: &str,
    interaction: Option<TerminalSessionInteraction>,
) {
    let _ = app.emit(
        EVENT_INTERACTION,
        TerminalSessionInteractionUpdate {
            session_id: session_id.to_string(),
            interaction,
        },
    );
}

fn pending_interaction_for_session(
    pending: &HashMap<(String, u64), TerminalSessionInteraction>,
    session_id: &str,
) -> Option<TerminalSessionInteraction> {
    pending
        .iter()
        .filter(|((pending_session_id, _), _)| pending_session_id == session_id)
        .min_by_key(|((_, request_id), _)| *request_id)
        .map(|(_, interaction)| interaction.clone())
}

fn managed_pending_interaction(
    app: &AppHandle,
    session_id: &str,
) -> Option<TerminalSessionInteraction> {
    let manager = app.try_state::<AcpSessionManager>()?;
    let pending = manager.pending.lock().ok()?;
    pending_interaction_for_session(&pending, session_id)
}

fn interaction_prompt(interaction: &TerminalSessionInteraction) -> &str {
    match interaction {
        TerminalSessionInteraction::Permission { message, .. }
        | TerminalSessionInteraction::Elicitation { message, .. } => message,
    }
}

fn interaction_message(params: &serde_json::Value) -> String {
    params
        .get("toolCall")
        .and_then(|tool| tool.get("title"))
        .and_then(|value| value.as_str())
        .or_else(|| params.get("message").and_then(|value| value.as_str()))
        .unwrap_or("Copilot needs your input.")
        .to_string()
}

fn allocate_managed_seq(app: &AppHandle, session_id: &str) -> Option<u64> {
    let monitor = app.try_state::<TerminalSessionMonitor>()?;
    let mut watches = monitor.watches.lock().ok()?;
    let watch = watches.get_mut(session_id)?;
    let seq = watch.seq;
    watch.seq += 1;
    Some(seq)
}

fn emit_managed_entry(app: &AppHandle, session_id: &str, entry: TerminalTimelineEntry) {
    let snapshot = {
        let Some(monitor) = app.try_state::<TerminalSessionMonitor>() else {
            return;
        };
        let Ok(watches) = monitor.watches.lock() else {
            return;
        };
        let Some(watch) = watches.get(session_id) else {
            return;
        };
        (watch.session.clone(), watch.cursor, watch.seq)
    };
    persist(app, &snapshot.0, snapshot.1, snapshot.2);
    emit(app, &snapshot.0, vec![entry]);
}

fn content_text(content: &serde_json::Value) -> Option<&str> {
    content
        .get("text")
        .and_then(|value| value.as_str())
        .or_else(|| {
            content
                .get("content")
                .and_then(|value| value.get("text"))
                .and_then(|value| value.as_str())
        })
}

fn stream_message(app: &AppHandle, session_id: &str, update: &serde_json::Value, user: bool) {
    let Some(text) = update.get("content").and_then(content_text) else {
        return;
    };
    let key = update
        .get("messageId")
        .and_then(|value| value.as_str())
        .unwrap_or(if user { "active-user" } else { "active-agent" })
        .to_string();
    let manager = app.state::<AcpSessionManager>();
    let entry = {
        let Ok(mut sessions) = manager.sessions.lock() else {
            return;
        };
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        let entries = if user {
            &mut session.user_message_entries
        } else {
            &mut session.message_entries
        };
        let seq = entries
            .get(&key)
            .map(|entry| entry.0)
            .or_else(|| allocate_managed_seq(app, session_id));
        let Some(seq) = seq else {
            return;
        };
        let accumulated = entries.entry(key).or_insert_with(|| (seq, String::new()));
        accumulated.1.push_str(text);
        let text = truncate(&accumulated.1, MAX_ENTRY_TEXT);
        if user {
            TerminalTimelineEntry::UserMessage {
                seq,
                timestamp: None,
                text,
            }
        } else {
            TerminalTimelineEntry::AssistantMessage {
                seq,
                timestamp: None,
                text,
            }
        }
    };
    if !user {
        set_managed_status(
            app,
            session_id,
            TerminalSessionStatus::Working,
            summarize(text),
            None,
        );
    }
    emit_managed_entry(app, session_id, entry);
}

fn handle_session_update(app: &AppHandle, session_id: &str, update: &serde_json::Value) {
    match update
        .get("sessionUpdate")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
    {
        "user_message_chunk" => stream_message(app, session_id, update, true),
        "agent_message_chunk" => stream_message(app, session_id, update, false),
        "plan" => {
            let text = update
                .get("entries")
                .and_then(|value| value.as_array())
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            let content = entry.get("content")?.as_str()?;
                            let status = entry
                                .get("status")
                                .and_then(|value| value.as_str())
                                .unwrap_or("pending");
                            Some(format!("[{status}] {content}"))
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.is_empty() {
                return;
            }
            let manager = app.state::<AcpSessionManager>();
            let seq = {
                let Ok(mut sessions) = manager.sessions.lock() else {
                    return;
                };
                let Some(session) = sessions.get_mut(session_id) else {
                    return;
                };
                match session.plan_entry {
                    Some(seq) => seq,
                    None => {
                        let Some(seq) = allocate_managed_seq(app, session_id) else {
                            return;
                        };
                        session.plan_entry = Some(seq);
                        seq
                    }
                }
            };
            emit_managed_entry(
                app,
                session_id,
                TerminalTimelineEntry::Notice {
                    seq,
                    timestamp: None,
                    text,
                    level: "info".to_string(),
                },
            );
        }
        "tool_call" | "tool_call_update" => {
            let Some(tool_call_id) = update.get("toolCallId").and_then(|value| value.as_str())
            else {
                return;
            };
            let manager = app.state::<AcpSessionManager>();
            let (seq, title, detail) = {
                let Ok(mut sessions) = manager.sessions.lock() else {
                    return;
                };
                let Some(session) = sessions.get_mut(session_id) else {
                    return;
                };
                match session.tool_entries.get(tool_call_id) {
                    Some(entry) => entry.clone(),
                    None => {
                        let Some(seq) = allocate_managed_seq(app, session_id) else {
                            return;
                        };
                        let title = update
                            .get("title")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Tool")
                            .to_string();
                        let detail = update
                            .get("rawInput")
                            .map(describe_arguments)
                            .unwrap_or_default();
                        session.tool_entries.insert(
                            tool_call_id.to_string(),
                            (seq, title.clone(), detail.clone()),
                        );
                        (seq, title, detail)
                    }
                }
            };
            let status = update
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("pending");
            let success = match status {
                "completed" => Some(true),
                "failed" => Some(false),
                _ => None,
            };
            let result = update
                .get("content")
                .and_then(|value| value.as_array())
                .and_then(|items| items.iter().find_map(content_text))
                .map(|text| truncate(text, MAX_ENTRY_TEXT));
            emit_managed_entry(
                app,
                session_id,
                TerminalTimelineEntry::ToolCall {
                    seq,
                    timestamp: None,
                    tool_call_id: tool_call_id.to_string(),
                    name: title,
                    detail,
                    success,
                    result,
                },
            );
        }
        _ => {}
    }
}

fn handle_acp_message(app: &AppHandle, session_id_hint: &str, message: &serde_json::Value) {
    if let Some(response_id) = message.get("id").and_then(|value| value.as_u64()) {
        let manager = app.state::<AcpSessionManager>();
        let completed_prompt = manager
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| {
                let session = sessions.get_mut(session_id_hint)?;
                let index = session
                    .prompt_requests
                    .iter()
                    .position(|request_id| *request_id == response_id)?;
                session.prompt_requests.remove(index);
                session.user_message_entries.clear();
                session.message_entries.clear();
                session.plan_entry = None;
                Some(())
            })
            .is_some();
        if completed_prompt {
            if let Some(error) = message.get("error") {
                let text = summarize(&error.to_string());
                if let Some(seq) = allocate_managed_seq(app, session_id_hint) {
                    emit_managed_entry(
                        app,
                        session_id_hint,
                        TerminalTimelineEntry::Notice {
                            seq,
                            timestamp: None,
                            text: text.clone(),
                            level: "error".to_string(),
                        },
                    );
                }
                set_managed_status(
                    app,
                    session_id_hint,
                    TerminalSessionStatus::Error,
                    text,
                    None,
                );
            } else {
                emit_interaction(
                    app,
                    session_id_hint,
                    managed_pending_interaction(app, session_id_hint),
                );
                set_managed_status(
                    app,
                    session_id_hint,
                    TerminalSessionStatus::Idle,
                    "Waiting for your next instruction",
                    None,
                );
            }
            return;
        }
    }

    let Some(method) = message.get("method").and_then(|value| value.as_str()) else {
        return;
    };
    let params = message.get("params").unwrap_or(&serde_json::Value::Null);
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .unwrap_or(session_id_hint);

    if method == "session/update" {
        if let Some(update) = params.get("update") {
            handle_session_update(app, session_id, update);
        }
        return;
    }

    let Some(request_id) = message.get("id").and_then(|value| value.as_u64()) else {
        return;
    };

    let manager = app.state::<AcpSessionManager>();
    match method {
        "session/request_permission" => {
            let prompt = interaction_message(params);
            let options = params
                .get("options")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    Some(TerminalSessionPermissionOption {
                        option_id: option.get("optionId")?.as_str()?.to_string(),
                        name: option.get("name")?.as_str()?.to_string(),
                        kind: option
                            .get("kind")
                            .and_then(|value| value.as_str())
                            .unwrap_or("allow_once")
                            .to_string(),
                    })
                })
                .collect();
            let interaction = TerminalSessionInteraction::Permission {
                request_id,
                message: prompt.clone(),
                options,
            };
            if let Ok(mut pending) = manager.pending.lock() {
                pending.insert((session_id.to_string(), request_id), interaction.clone());
            }
            let active = managed_pending_interaction(app, session_id).unwrap_or(interaction);
            let active_prompt = interaction_prompt(&active).to_string();
            emit_interaction(app, session_id, Some(active));
            set_managed_status(
                app,
                session_id,
                TerminalSessionStatus::WaitingInput,
                active_prompt.clone(),
                Some(active_prompt),
            );
        }
        "elicitation/create" => {
            let prompt = interaction_message(params);
            let interaction = TerminalSessionInteraction::Elicitation {
                request_id,
                mode: params
                    .get("mode")
                    .and_then(|value| value.as_str())
                    .unwrap_or("form")
                    .to_string(),
                message: prompt.clone(),
                requested_schema: params.get("requestedSchema").cloned(),
                url: params
                    .get("url")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            };
            if let Ok(mut pending) = manager.pending.lock() {
                pending.insert((session_id.to_string(), request_id), interaction.clone());
            }
            let active = managed_pending_interaction(app, session_id).unwrap_or(interaction);
            let active_prompt = interaction_prompt(&active).to_string();
            emit_interaction(app, session_id, Some(active));
            set_managed_status(
                app,
                session_id,
                TerminalSessionStatus::WaitingInput,
                active_prompt.clone(),
                Some(active_prompt),
            );
        }
        _ => {}
    }
}

fn read_rpc_response(
    reader: &mut BufReader<std::process::ChildStdout>,
    expected_id: u64,
) -> AppResult<(serde_json::Value, Vec<serde_json::Value>)> {
    let mut notifications = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(AppError::msg(
                "Copilot ACP exited before the session was ready.",
            ));
        }
        let message: serde_json::Value = match serde_json::from_str(line.trim()) {
            Ok(message) => message,
            Err(_) => continue,
        };
        if message.get("id").and_then(|value| value.as_u64()) == Some(expected_id) {
            if let Some(error) = message.get("error") {
                return Err(AppError::msg(format!("Copilot ACP error: {error}")));
            }
            return Ok((
                message
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                notifications,
            ));
        }
        notifications.push(message);
    }
}

/// Read newly appended complete lines from `events.jsonl`, advancing `cursor` only past
/// the final newline so a half-written line is re-read on the next poll.
fn read_new_lines(path: &PathBuf, cursor: &mut u64) -> std::io::Result<Vec<String>> {
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let len = metadata.len();
    // The log was truncated or replaced (e.g. the session folder was recreated).
    if len < *cursor {
        *cursor = len;
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "CLI status log was truncated. Inspect the terminal; earlier waits cannot be reconstructed.",
        ));
    }
    if len == *cursor {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(*cursor))?;
    let take = (len - *cursor).min(MAX_READ_PER_POLL);
    let mut buf = vec![0u8; take as usize];
    let read = file.read(&mut buf)?;
    buf.truncate(read);
    let Some(last_newline) = buf.iter().rposition(|b| *b == b'\n') else {
        if take == MAX_READ_PER_POLL {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Session status record exceeds the observation limit",
            ));
        }
        return Ok(Vec::new());
    };
    let text = std::str::from_utf8(&buf[..last_newline])
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    *cursor += (last_newline + 1) as u64;
    Ok(text.lines().map(|line| line.to_string()).collect())
}

fn history_cursor(path: &PathBuf) -> AppResult<(u64, u64)> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error.into()),
    };
    let mut cursor = 0;
    let mut seq = 0;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let bytes = reader.read_until(b'\n', &mut line)?;
        if bytes == 0 || line.last() != Some(&b'\n') {
            break;
        }
        cursor += bytes as u64;
        seq += 1;
    }
    Ok((cursor, seq))
}

/// True while the CLI holds the session folder open (`inuse.<pid>.lock`).
fn has_lock(dir: &PathBuf) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("inuse."))
}

// ----- Polling loop -----

fn emit(app: &AppHandle, session: &TerminalSession, entries: Vec<TerminalTimelineEntry>) {
    let _ = app.emit(
        EVENT_UPDATE,
        TerminalSessionUpdate {
            session: session.clone(),
            entries,
        },
    );
}

fn persist(app: &AppHandle, session: &TerminalSession, cursor: u64, seq: u64) {
    if let Some(state) = app.try_state::<DbState>() {
        if let Ok(db) = state.0.lock() {
            let _ = upsert(&db, session, cursor, seq);
        }
    }
}

fn persist_managed_transport(app: &AppHandle, session_id: &str) {
    if let Some(state) = app.try_state::<DbState>() {
        if let Ok(db) = state.0.lock() {
            let _ = db.execute(
                "UPDATE terminal_sessions SET managed = 1 WHERE id = ?1",
                [session_id],
            );
        }
    }
}

fn set_managed_status(
    app: &AppHandle,
    session_id: &str,
    mut status: TerminalSessionStatus,
    activity: impl Into<String>,
    mut pending_prompt: Option<String>,
) {
    let mut activity = activity.into();
    if matches!(
        status,
        TerminalSessionStatus::Working | TerminalSessionStatus::Idle
    ) {
        if let Some(interaction) = managed_pending_interaction(app, session_id) {
            let prompt = interaction_prompt(&interaction).to_string();
            status = TerminalSessionStatus::WaitingInput;
            activity = prompt.clone();
            pending_prompt = Some(prompt);
        }
    }

    let snapshot = {
        let Some(monitor) = app.try_state::<TerminalSessionMonitor>() else {
            return;
        };
        let Ok(mut watches) = monitor.watches.lock() else {
            return;
        };
        let Some(watch) = watches.get_mut(session_id) else {
            return;
        };
        watch.session.status = status;
        watch.session.last_activity = activity;
        watch.session.pending_prompt = pending_prompt;
        watch.session.updated_at = now_ms();
        watch.session.revision += 1;
        (watch.session.clone(), watch.cursor, watch.seq)
    };
    persist(app, &snapshot.0, snapshot.1, snapshot.2);
    emit(app, &snapshot.0, Vec::new());
}

/// One tick: advance every watched session, emitting and persisting the ones that moved.
fn poll_once(app: &AppHandle) {
    let Some(monitor) = app.try_state::<TerminalSessionMonitor>() else {
        return;
    };
    let Ok(root) = session_state_root() else {
        return;
    };

    let mut changed: Vec<(TerminalSession, u64, u64, Vec<TerminalTimelineEntry>)> = Vec::new();
    {
        let Ok(mut watches) = monitor.watches.lock() else {
            return;
        };
        for watch in watches.values_mut() {
            if watch.session.status.is_final() {
                continue;
            }
            if watch.managed && watch.session.transport != "pty" {
                continue;
            }
            let dir = root.join(&watch.session.id);
            if !dir.exists() {
                watch.missing_polls += 1;
                if watch.session.transport == "pty" {
                    if watch.session.observation_error.is_none() {
                        watch.session.observation_error = Some(
                            "Waiting for the CLI status log. Open the terminal to inspect startup."
                                .into(),
                        );
                        watch.session.revision += 1;
                        changed.push((watch.session.clone(), watch.cursor, watch.seq, Vec::new()));
                    }
                    continue;
                }
                // ~2 minutes without the CLI ever creating its folder: the launch failed
                // or the user closed the window before Copilot started.
                if watch.missing_polls > 120 {
                    watch.session.status = TerminalSessionStatus::Done;
                    watch.session.last_activity = "Terminal closed before Copilot started".into();
                    watch.session.updated_at = now_ms();
                    changed.push((watch.session.clone(), watch.cursor, watch.seq, Vec::new()));
                }
                continue;
            }
            watch.missing_polls = 0;

            let mut dirty = false;
            let mut entries: Vec<TerminalTimelineEntry> = Vec::new();
            let log_path = dir.join("events.jsonl");
            let lines = read_new_lines(&log_path, &mut watch.cursor);
            if let Err(error) = &lines {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    watch.log_error = Some(error.to_string());
                }
            }
            let observation_error = lines
                .as_ref()
                .err()
                .map(|error| format!("Session status unavailable: {error}"))
                .or_else(|| watch.log_error.clone());
            if watch.session.observation_error != observation_error {
                watch.session.observation_error = observation_error;
                dirty = true;
            }
            if watch.session.observation_error.is_none()
                && now_ms() - watch.session.observed_at.unwrap_or(0) >= 5000
            {
                watch.session.observed_at = Some(now_ms());
                dirty = true;
            }
            for line in lines.unwrap_or_default() {
                let seq = watch.seq;
                watch.seq += 1;
                // Unknown event types are forward-compatible; malformed records make
                // observation explicitly unavailable rather than implying no wait.
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(event) = serde_json::from_str::<RawEvent>(&line) {
                    let before_attention =
                        (watch.session.status, watch.session.pending_prompt.clone());
                    dirty |= apply_event(&mut watch.session, &event);
                    watch.attention.update(
                        &event.event_type,
                        &event.data,
                        &describe_permission(&event.data),
                    );
                    if let Some(prompt) = watch.attention.prompt() {
                        watch.session.status = TerminalSessionStatus::WaitingInput;
                        watch.session.pending_prompt = Some(prompt.to_string());
                    } else if watch.session.status == TerminalSessionStatus::WaitingInput {
                        watch.session.status = TerminalSessionStatus::Working;
                        watch.session.pending_prompt = None;
                    }
                    dirty |= before_attention
                        != (watch.session.status, watch.session.pending_prompt.clone());
                    if let Some(entry) = timeline_entry(&event, seq, &mut watch.open_entries) {
                        entries.push(entry);
                    }
                } else {
                    watch.log_error =
                        Some("A CLI status record could not be read. Inspect the terminal.".into());
                    watch.session.observation_error = watch.log_error.clone();
                    dirty = true;
                }
            }
            if !entries.is_empty() {
                dirty = true;
            }

            let locked = has_lock(&dir);
            if locked {
                watch.saw_lock = true;
            } else if watch.session.transport != "pty"
                && watch.saw_lock
                && !watch.session.status.is_final()
            {
                // The terminal window was closed. Whatever the last state was, the
                // session is over.
                watch.session.status = TerminalSessionStatus::Done;
                watch.session.pending_prompt = None;
                dirty = true;
            }

            if dirty {
                watch.session.updated_at = now_ms();
                watch.session.revision += 1;
                changed.push((watch.session.clone(), watch.cursor, watch.seq, entries));
            }
        }
    }

    for (session, cursor, seq, entries) in changed {
        {
            let Ok(watches) = monitor.watches.lock() else {
                continue;
            };
            if !watches
                .get(&session.id)
                .is_some_and(|watch| watch.session.revision == session.revision)
            {
                continue;
            }
            persist(app, &session, cursor, seq);
        }
        emit(app, &session, entries);
    }
}

/// Start the shared polling task once; subsequent calls are no-ops.
fn ensure_polling(app: &AppHandle) {
    let Some(monitor) = app.try_state::<TerminalSessionMonitor>() else {
        return;
    };
    {
        let Ok(mut started) = monitor.started.lock() else {
            return;
        };
        if *started {
            return;
        }
        *started = true;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            poll_once(&handle);
        }
    });
}

/// Restore watches for sessions that were still live when the app last closed, so a
/// restart keeps mirroring a terminal the user never shut down.
pub fn init(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<DbState>();
    let restored = {
        let db = state
            .0
            .lock()
            .map_err(|_| AppError::msg("database mutex poisoned"))?;
        load_all(&db)?
    };
    let monitor = app.state::<TerminalSessionMonitor>();
    {
        let mut watches = monitor
            .watches
            .lock()
            .map_err(|_| AppError::msg("terminal session monitor mutex poisoned"))?;
        for mut watch in restored {
            if (watch.managed || matches!(watch.session.transport.as_str(), "pty" | "sdk"))
                && !watch.session.status.is_final()
            {
                watch.session.status = TerminalSessionStatus::Done;
                watch.session.pending_prompt = None;
                watch.session.last_activity = "DevTrees closed the managed session".to_string();
                watch.session.updated_at = now_ms();
                watch.session.revision += 1;
                persist(app, &watch.session, watch.cursor, watch.seq);
            }
            watches.insert(watch.session.id.clone(), watch);
        }
    }
    ensure_polling(app);
    Ok(())
}

// ----- Commands -----

#[tauri::command]
pub async fn terminal_sessions_list(app: AppHandle) -> AppResult<Vec<TerminalSession>> {
    Ok(app
        .state::<TerminalSessionMonitor>()
        .watches
        .lock()
        .map_err(|_| AppError::msg("session mutex poisoned"))?
        .values()
        .map(|watch| watch.session.clone())
        .collect())
}

/// Begin mirroring an externally launched Copilot CLI session.
fn watch_terminal_session(
    app: &AppHandle,
    req: WatchTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    if req.id.trim().is_empty() {
        return Ok(TerminalSessionResult {
            ok: false,
            session: None,
            error: Some("A session id is required.".into()),
        });
    }

    let id = req.id.trim().to_string();
    let now = now_ms();

    // Re-watching an id (resume) must keep the existing tail position so the log is not
    // replayed — and re-toasted — from the beginning.
    let existing = {
        let state = app.state::<DbState>();
        let conn = state
            .0
            .lock()
            .ok()
            .and_then(|conn| load_one(&conn, &id).unwrap_or_default());
        conn
    };

    let (cursor, seq, created_at) = match &existing {
        Some(watch) => (watch.cursor, watch.seq, watch.session.created_at),
        None => (0, 0, now),
    };

    let session = TerminalSession {
        id,
        task_id: req.task_id,
        folder_path: req.folder_path,
        label: req.label,
        repository: req.repository,
        branch: req.branch,
        status: TerminalSessionStatus::Starting,
        last_activity: "Waiting for Copilot to start…".to_string(),
        pending_prompt: None,
        created_at,
        updated_at: now,
        transport: "external".into(),
        generation: None,
        revision: existing
            .as_ref()
            .map_or(1, |watch| watch.session.revision + 1),
        observed_at: None,
        observation_error: None,
    };

    persist(app, &session, cursor, seq);
    {
        let monitor = app.state::<TerminalSessionMonitor>();
        let mut watches = monitor
            .watches
            .lock()
            .map_err(|_| AppError::msg("terminal session monitor mutex poisoned"))?;
        watches.insert(
            session.id.clone(),
            Watch {
                session: session.clone(),
                cursor,
                seq,
                open_entries: Vec::new(),
                saw_lock: false,
                missing_polls: 0,
                managed: false,
                attention: crate::session_attention::Attention::default(),
                log_error: None,
            },
        );
    }
    ensure_polling(app);
    emit(app, &session, Vec::new());

    Ok(TerminalSessionResult {
        ok: true,
        session: Some(session),
        error: None,
    })
}

#[tauri::command]
pub async fn terminal_sessions_watch(
    app: AppHandle,
    req: WatchTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    watch_terminal_session(&app, req)
}

pub fn watch_pty_session(
    app: &AppHandle,
    req: &StartTerminalSessionRequest,
    id: &str,
    generation: &str,
) -> AppResult<TerminalSessionResult> {
    watch_managed_session(app, req, id, generation, "pty")
}

pub(crate) fn watch_managed_session(
    app: &AppHandle,
    req: &StartTerminalSessionRequest,
    id: &str,
    generation: &str,
    transport: &str,
) -> AppResult<TerminalSessionResult> {
    {
        let monitor = app.state::<TerminalSessionMonitor>();
        let watches = monitor
            .watches
            .lock()
            .map_err(|_| AppError::msg("session mutex poisoned"))?;
        if watches
            .get(id)
            .is_some_and(|watch| !watch.session.status.is_final())
        {
            return Err(AppError::msg(
                "This session is already live. End it before resuming.",
            ));
        }
    }
    let path = session_state_root()?.join(id).join("events.jsonl");
    let (cursor, seq) = history_cursor(&path)?;
    let session = {
        let monitor = app.state::<TerminalSessionMonitor>();
        let mut watches = monitor
            .watches
            .lock()
            .map_err(|_| AppError::msg("session mutex poisoned"))?;
        let previous = watches.get(id);
        if previous.is_some_and(|watch| !watch.session.status.is_final()) {
            return Err(AppError::msg(
                "This session is already live. End it before resuming.",
            ));
        }
        let now = now_ms();
        let session = TerminalSession {
            id: id.to_string(),
            task_id: req
                .task_id
                .clone()
                .or_else(|| previous.and_then(|watch| watch.session.task_id.clone())),
            folder_path: req.folder_path.clone(),
            label: req.label.clone(),
            repository: req
                .repository
                .clone()
                .or_else(|| previous.and_then(|watch| watch.session.repository.clone())),
            branch: req
                .branch
                .clone()
                .or_else(|| previous.and_then(|watch| watch.session.branch.clone())),
            status: TerminalSessionStatus::Starting,
            last_activity: if transport == "sdk" {
                "Starting native Copilot session".into()
            } else {
                "Starting Copilot in the embedded terminal".into()
            },
            pending_prompt: None,
            created_at: previous.map_or(now, |watch| watch.session.created_at),
            updated_at: now,
            transport: transport.into(),
            generation: Some(generation.into()),
            revision: previous.map_or(1, |watch| watch.session.revision + 1),
            observed_at: None,
            observation_error: None,
        };
        // Publish the new generation and end-of-history cursor atomically. An
        // intermediate external watch could replay an old unanswered question.
        {
            let db = app.state::<DbState>();
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("database mutex poisoned"))?;
            upsert(&conn, &session, cursor, seq)?;
        }
        watches.insert(
            id.to_string(),
            Watch {
                session: session.clone(),
                cursor,
                seq,
                open_entries: Vec::new(),
                saw_lock: false,
                missing_polls: 0,
                managed: true,
                attention: crate::session_attention::Attention::default(),
                log_error: None,
            },
        );
        session
    };
    ensure_polling(app);
    emit(app, &session, Vec::new());
    Ok(TerminalSessionResult {
        ok: true,
        session: Some(session),
        error: None,
    })
}

pub(crate) fn publish_native_session(app: &AppHandle, session: &TerminalSession) -> AppResult<()> {
    let monitor = app.state::<TerminalSessionMonitor>();
    let mut watches = monitor
        .watches
        .lock()
        .map_err(|_| AppError::msg("Session mutex poisoned."))?;
    let watch = watches
        .get_mut(&session.id)
        .ok_or_else(|| AppError::msg("This session was removed."))?;
    if watch.session.generation != session.generation {
        return Err(AppError::msg(
            "This update belongs to a previous session process.",
        ));
    }

    if session.revision < watch.session.revision {
        return Err(AppError::msg("This session update is stale."));
    }
    if watch.session.status != session.status
        || watch.session.pending_prompt != session.pending_prompt
        || watch.session.last_activity != session.last_activity
    {
        let state = app.state::<DbState>();
        let db = state
            .0
            .lock()
            .map_err(|_| AppError::msg("Database mutex poisoned."))?;
        upsert(&db, session, watch.cursor, watch.seq)?;
    }
    watch.session = session.clone();
    drop(watches);
    app.emit(
        EVENT_UPDATE,
        TerminalSessionUpdate {
            session: session.clone(),
            entries: Vec::new(),
        },
    )
    .map_err(|error| AppError::msg(error.to_string()))
}

#[tauri::command]
pub async fn terminal_sessions_switch(
    app: AppHandle,
    id: String,
    generation: String,
    transport: SessionTransport,
) -> AppResult<TerminalSessionResult> {
    let session = {
        let monitor = app.state::<TerminalSessionMonitor>();
        let watches = monitor
            .watches
            .lock()
            .map_err(|_| AppError::msg("Session mutex poisoned."))?;
        let session = &watches
            .get(&id)
            .ok_or_else(|| AppError::msg("This session was removed."))?
            .session;
        if session.generation.as_deref() != Some(&generation) {
            return Err(AppError::msg(
                "The session owner changed. Refresh before switching modes.",
            ));
        }
        session.clone()
    };
    if !session.status.is_final() {
        match session.transport.as_str() {
            "sdk" => {
                crate::copilot_sdk_sessions::native_session_end(
                    app.clone(),
                    crate::copilot_sdk_sessions::NativeTarget {
                        id: id.clone(),
                        generation: generation.clone(),
                    },
                )
                .await?
            }
            "pty" => crate::pty_sessions::stop_and_wait(&app, &id, &generation).await?,
            _ => return Err(AppError::msg(
                "An external session must be ended in its owning terminal before resuming here.",
            )),
        }
    }
    terminal_sessions_start(
        app,
        StartTerminalSessionRequest {
            folder_path: session.folder_path,
            prompt: None,
            resume_session_id: Some(id),
            label: session.label,
            task_id: session.task_id,
            repository: session.repository,
            branch: session.branch,
            transport: Some(transport),
        },
    )
    .await
}

pub fn pty_exited(app: &AppHandle, id: &str, generation: &str, exit: Result<u32, String>) {
    let snapshot = {
        let monitor = app.state::<TerminalSessionMonitor>();
        let Ok(mut watches) = monitor.watches.lock() else {
            return;
        };
        let Some(watch) = watches.get_mut(id) else {
            return;
        };
        if watch.session.generation.as_deref() != Some(generation) {
            return;
        }
        watch.session.status = TerminalSessionStatus::Done;
        watch.session.pending_prompt = None;
        watch.session.updated_at = now_ms();
        watch.session.revision += 1;
        watch.session.last_activity = match exit {
            Ok(code) => format!("Copilot terminal exited ({code})"),
            Err(error) => {
                watch.session.status = TerminalSessionStatus::Error;
                format!("Could not observe Copilot exit: {error}")
            }
        };
        (watch.session.clone(), watch.cursor, watch.seq)
    };
    persist(app, &snapshot.0, snapshot.1, snapshot.2);
    emit(app, &snapshot.0, Vec::new());
}

#[allow(dead_code)]
fn start_acp_session(
    app: AppHandle,
    req: StartTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    if req.folder_path.trim().is_empty() {
        return Ok(TerminalSessionResult {
            ok: false,
            session: None,
            error: Some("A session folder is required.".into()),
        });
    }

    let mut command = Command::new("copilot");
    command
        .arg("--acp")
        .current_dir(&req.folder_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Redirecting ACP streams does not prevent Windows from allocating a console.
    configure_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| AppError::msg(format!("Could not start Copilot ACP: {error}")))?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            AppError::msg("Copilot ACP did not expose stdin.")
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("Copilot ACP did not expose stdout."))?;
    let mut reader = BufReader::new(stdout);

    write_rpc(
        &stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "elicitation": { "form": {}, "url": {} },
                    "session": { "configOptions": { "boolean": {} } }
                },
                "clientInfo": {
                    "name": "DevTrees",
                    "title": "DevTrees",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    let _ = read_rpc_response(&mut reader, 1)?;

    let resume_id = req
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let (method, params) = match resume_id {
        Some(id) => (
            "session/load",
            serde_json::json!({
                "sessionId": id,
                "cwd": req.folder_path,
                "mcpServers": []
            }),
        ),
        None => (
            "session/new",
            serde_json::json!({
                "cwd": req.folder_path,
                "mcpServers": []
            }),
        ),
    };
    write_rpc(
        &stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params
        }),
    )?;
    let (setup, setup_notifications) = read_rpc_response(&mut reader, 2)?;
    let session_id = resume_id
        .map(str::to_string)
        .or_else(|| {
            setup
                .get("sessionId")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .ok_or_else(|| AppError::msg("Copilot ACP did not return a session id."))?;

    let watch_result = watch_terminal_session(
        &app,
        WatchTerminalSessionRequest {
            id: session_id.clone(),
            folder_path: req.folder_path.clone(),
            label: req.label,
            task_id: req.task_id,
            repository: req.repository,
            branch: req.branch,
        },
    )?;
    if !watch_result.ok {
        return Ok(watch_result);
    }
    if let Ok(mut watches) = app.state::<TerminalSessionMonitor>().watches.lock() {
        if let Some(watch) = watches.get_mut(&session_id) {
            watch.managed = true;
            watch.session.status = TerminalSessionStatus::Idle;
            watch.session.last_activity = "Waiting for your first instruction".to_string();
        }
    }
    persist_managed_transport(&app, &session_id);

    {
        let manager = app.state::<AcpSessionManager>();
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| AppError::msg("Copilot session mutex poisoned"))?;
        sessions.insert(
            session_id.clone(),
            AcpSession {
                stdin: stdin.clone(),
                next_request_id: 3,
                prompt_requests: Vec::new(),
                user_message_entries: HashMap::new(),
                message_entries: HashMap::new(),
                tool_entries: HashMap::new(),
                plan_entry: None,
            },
        );
    }
    for notification in setup_notifications {
        handle_acp_message(&app, &session_id, &notification);
    }

    let reader_app = app.clone();
    let reader_session_id = session_id.clone();
    std::thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            handle_acp_message(&reader_app, &reader_session_id, &message);
        }
        let manager = reader_app.state::<AcpSessionManager>();
        if let Ok(mut sessions) = manager.sessions.lock() {
            sessions.remove(&reader_session_id);
        }
        if let Ok(mut pending) = manager.pending.lock() {
            pending.retain(|(session_id, _), _| session_id != &reader_session_id);
        }
        emit_interaction(&reader_app, &reader_session_id, None);
        set_managed_status(
            &reader_app,
            &reader_session_id,
            TerminalSessionStatus::Done,
            "Copilot session ended",
            None,
        );
        let _ = child.wait();
    });

    set_managed_status(
        &app,
        &session_id,
        TerminalSessionStatus::Idle,
        "Waiting for your first instruction",
        None,
    );
    if let Some(prompt) = req.prompt.map(|value| value.trim().to_string()) {
        if !prompt.is_empty() {
            send_acp_prompt(&app, &session_id, &prompt)?;
        }
    }

    let session = app
        .state::<TerminalSessionMonitor>()
        .watches
        .lock()
        .ok()
        .and_then(|watches| watches.get(&session_id).map(|watch| watch.session.clone()))
        .ok_or_else(|| AppError::msg("Copilot session disappeared during startup."))?;
    Ok(TerminalSessionResult {
        ok: true,
        session: Some(session),
        error: None,
    })
}

#[tauri::command]
pub async fn terminal_sessions_start(
    app: AppHandle,
    req: StartTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    if matches!(req.transport, Some(SessionTransport::Sdk)) {
        return crate::copilot_sdk_sessions::start(app, req).await;
    }
    tauri::async_runtime::spawn_blocking(move || crate::pty_sessions::start(app, req))
        .await
        .map_err(|error| AppError::msg(format!("Copilot session task failed: {error}")))?
}

#[tauri::command]
pub async fn terminal_sessions_prompt(app: AppHandle, id: String, prompt: String) -> AppResult<()> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::msg("A message is required."));
    }
    send_acp_prompt(&app, &id, prompt)
}

#[tauri::command]
pub async fn terminal_sessions_cancel(app: AppHandle, id: String) -> AppResult<()> {
    let stdin = {
        let manager = app.state::<AcpSessionManager>();
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| AppError::msg("Copilot session mutex poisoned"))?;
        sessions
            .get(&id)
            .map(|session| session.stdin.clone())
            .ok_or_else(|| AppError::msg("This Copilot session is no longer connected."))?
    };
    write_rpc(
        &stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": id }
        }),
    )
}

#[tauri::command]
pub async fn terminal_sessions_interaction(
    app: AppHandle,
    id: String,
) -> AppResult<Option<TerminalSessionInteraction>> {
    let manager = app.state::<AcpSessionManager>();
    let pending = manager
        .pending
        .lock()
        .map_err(|_| AppError::msg("Copilot request mutex poisoned"))?;
    Ok(pending_interaction_for_session(&pending, &id))
}

#[tauri::command]
pub async fn terminal_sessions_respond(
    app: AppHandle,
    req: RespondTerminalSessionRequest,
) -> AppResult<()> {
    let (id, request_id, expected, result) = match req {
        RespondTerminalSessionRequest::Permission {
            id,
            request_id,
            option_id,
        } => (
            id,
            request_id,
            PendingAcpRequest::Permission,
            serde_json::json!({
                "outcome": { "outcome": "selected", "optionId": option_id }
            }),
        ),
        RespondTerminalSessionRequest::Elicitation {
            id,
            request_id,
            action,
            content,
        } => {
            if !matches!(action.as_str(), "accept" | "decline" | "cancel") {
                return Err(AppError::msg("Invalid elicitation response."));
            }
            let mut result = serde_json::json!({ "action": action });
            if action == "accept" {
                if let Some(content) = content {
                    result["content"] = content;
                }
            }
            (id, request_id, PendingAcpRequest::Elicitation, result)
        }
    };

    {
        let manager = app.state::<AcpSessionManager>();
        let pending = manager
            .pending
            .lock()
            .map_err(|_| AppError::msg("Copilot request mutex poisoned"))?;
        match pending.get(&(id.clone(), request_id)) {
            Some(TerminalSessionInteraction::Permission { .. })
                if expected == PendingAcpRequest::Permission => {}
            Some(TerminalSessionInteraction::Elicitation { .. })
                if expected == PendingAcpRequest::Elicitation => {}
            _ => return Err(AppError::msg("This Copilot request is no longer pending.")),
        }
    }

    let stdin = {
        let manager = app.state::<AcpSessionManager>();
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| AppError::msg("Copilot session mutex poisoned"))?;
        sessions
            .get(&id)
            .map(|session| session.stdin.clone())
            .ok_or_else(|| AppError::msg("This Copilot session is no longer connected."))?
    };
    write_rpc(
        &stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result
        }),
    )?;
    if let Ok(mut pending) = app.state::<AcpSessionManager>().pending.lock() {
        pending.remove(&(id.clone(), request_id));
    }
    emit_interaction(&app, &id, managed_pending_interaction(&app, &id));
    set_managed_status(
        &app,
        &id,
        TerminalSessionStatus::Working,
        "Continuing after your response",
        None,
    );
    Ok(())
}

/// Replay a session's event log into timeline entries, capped at the most recent
/// `MAX_ENTRIES`. Streams line-by-line: these logs reach hundreds of megabytes.
#[tauri::command]
pub async fn terminal_sessions_history(id: String) -> AppResult<Vec<TerminalTimelineEntry>> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Ok(Vec::new());
    }
    let path = session_state_root()?.join(&id).join("events.jsonl");
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut entries: VecDeque<TerminalTimelineEntry> = VecDeque::new();
    let mut open: Vec<TerminalTimelineEntry> = Vec::new();
    for (seq, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<RawEvent>(&line) else {
            continue;
        };
        if let Some(entry) = timeline_entry(&event, seq as u64, &mut open) {
            entries.push_back(entry);
            while entries.len() > MAX_ENTRIES {
                entries.pop_front();
            }
        }
    }

    Ok(entries.into())
}

/// Stop mirroring a session and drop it from the list.
#[tauri::command]
pub async fn terminal_sessions_forget(app: AppHandle, id: String) -> AppResult<()> {
    crate::copilot_sdk_sessions::forget(&app, &id).await?;
    app.state::<crate::pty_sessions::PtySessionManager>()
        .stop_session(&id)?;
    if app
        .state::<AcpSessionManager>()
        .sessions
        .lock()
        .map(|sessions| sessions.contains_key(&id))
        .unwrap_or(false)
    {
        let _ = next_acp_request(
            &app.state::<AcpSessionManager>(),
            &id,
            "session/close",
            serde_json::json!({ "sessionId": id }),
        );
    }
    {
        let manager = app.state::<AcpSessionManager>();
        if let Ok(mut sessions) = manager.sessions.lock() {
            sessions.remove(&id);
        }
        if let Ok(mut pending) = manager.pending.lock() {
            pending.retain(|(session_id, _), _| session_id != &id);
        };
    }
    {
        let monitor = app.state::<TerminalSessionMonitor>();
        let removed = monitor.watches.lock().map(|mut w| w.remove(&id));
        drop(removed);
    }
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("database mutex poisoned"))?;
    db.execute("DELETE FROM terminal_sessions WHERE id = ?1", [&id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn no_window_child_has_no_console_window_and_preserves_piped_output() {
        const PROBE_ENV: &str = "DEVTREES_TEST_NO_WINDOW_CHILD";
        if std::env::var_os(PROBE_ENV).is_some() {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn GetConsoleWindow() -> *mut std::ffi::c_void;
            }
            // A headless console may still have a code page, but must not have a window.
            assert!(unsafe { GetConsoleWindow() }.is_null());
            println!("pipe-ready");
            return;
        }

        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "terminal_sessions::tests::no_window_child_has_no_console_window_and_preserves_piped_output",
                "--nocapture",
            ])
            .env(PROBE_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_no_window(&mut command);

        let output = command.output().expect("Could not start console probe");
        assert!(
            output.status.success(),
            "Console probe failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("pipe-ready"));
    }

    fn session() -> TerminalSession {
        TerminalSession {
            id: "s1".into(),
            task_id: None,
            folder_path: "C:/repo".into(),
            label: "demo".into(),
            repository: None,
            branch: None,
            status: TerminalSessionStatus::Starting,
            last_activity: String::new(),
            pending_prompt: None,
            created_at: 0,
            updated_at: 0,
            transport: "external".into(),
            generation: None,
            revision: 0,
            observed_at: None,
            observation_error: None,
        }
    }

    fn event(json: &str) -> RawEvent {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn interaction_payloads_use_the_renderer_camel_case_contract() {
        let permission = serde_json::to_value(TerminalSessionInteraction::Permission {
            request_id: 0,
            message: "Approve command".into(),
            options: vec![TerminalSessionPermissionOption {
                option_id: "allow_once".into(),
                name: "Allow once".into(),
                kind: "allow_once".into(),
            }],
        })
        .unwrap();
        assert_eq!(
            permission,
            serde_json::json!({
                "kind": "permission",
                "requestId": 0,
                "message": "Approve command",
                "options": [{
                    "optionId": "allow_once",
                    "name": "Allow once",
                    "kind": "allow_once"
                }]
            })
        );

        let elicitation = serde_json::to_value(TerminalSessionInteraction::Elicitation {
            request_id: 7,
            mode: "form".into(),
            message: "Choose one".into(),
            requested_schema: Some(serde_json::json!({
                "type": "object",
                "properties": { "choice": { "type": "string" } }
            })),
            url: None,
        })
        .unwrap();
        assert_eq!(elicitation["requestId"], 7);
        assert!(elicitation.get("requestedSchema").is_some());
        assert!(elicitation.get("request_id").is_none());
        assert!(elicitation.get("requested_schema").is_none());
    }

    #[test]
    fn renderer_responses_deserialize_with_camel_case_fields_and_zero_request_id() {
        let permission: RespondTerminalSessionRequest = serde_json::from_value(serde_json::json!({
            "kind": "permission",
            "id": "session-1",
            "requestId": 0,
            "optionId": "allow_once"
        }))
        .unwrap();
        match permission {
            RespondTerminalSessionRequest::Permission {
                id,
                request_id,
                option_id,
            } => {
                assert_eq!(id, "session-1");
                assert_eq!(request_id, 0);
                assert_eq!(option_id, "allow_once");
            }
            _ => panic!("expected permission response"),
        }

        let elicitation: RespondTerminalSessionRequest =
            serde_json::from_value(serde_json::json!({
                "kind": "elicitation",
                "id": "session-2",
                "requestId": 12,
                "action": "accept",
                "content": { "choice": "alpha" }
            }))
            .unwrap();
        match elicitation {
            RespondTerminalSessionRequest::Elicitation {
                id,
                request_id,
                action,
                content,
            } => {
                assert_eq!(id, "session-2");
                assert_eq!(request_id, 12);
                assert_eq!(action, "accept");
                assert_eq!(content, Some(serde_json::json!({ "choice": "alpha" })));
            }
            _ => panic!("expected elicitation response"),
        }
    }

    #[test]
    fn pending_interactions_can_be_recovered_after_a_renderer_remount() {
        let mut pending = HashMap::new();
        pending.insert(
            ("session-1".into(), 0),
            TerminalSessionInteraction::Permission {
                request_id: 0,
                message: "Approve command".into(),
                options: vec![TerminalSessionPermissionOption {
                    option_id: "allow_once".into(),
                    name: "Allow once".into(),
                    kind: "allow_once".into(),
                }],
            },
        );
        pending.insert(
            ("session-2".into(), 1),
            TerminalSessionInteraction::Elicitation {
                request_id: 1,
                mode: "form".into(),
                message: "Choose one".into(),
                requested_schema: None,
                url: None,
            },
        );
        pending.insert(
            ("session-1".into(), 2),
            TerminalSessionInteraction::Permission {
                request_id: 2,
                message: "Approve later command".into(),
                options: Vec::new(),
            },
        );

        match pending_interaction_for_session(&pending, "session-1") {
            Some(TerminalSessionInteraction::Permission {
                request_id,
                options,
                ..
            }) => {
                assert_eq!(request_id, 0);
                assert_eq!(options[0].option_id, "allow_once");
            }
            _ => panic!("expected the pending permission"),
        }
        assert!(pending_interaction_for_session(&pending, "missing").is_none());
    }

    #[test]
    fn permission_request_marks_the_session_as_waiting_for_input() {
        let mut s = session();
        let changed = apply_event(
            &mut s,
            &event(
                r#"{"type":"permission.requested","data":{"permissionRequest":{"kind":"url","url":"https://example.com"}}}"#,
            ),
        );
        assert!(changed);
        assert_eq!(s.status, TerminalSessionStatus::WaitingInput);
        assert!(s.pending_prompt.unwrap().contains("https://example.com"));
    }

    #[test]
    fn turn_end_clears_the_pending_prompt_and_goes_idle() {
        let mut s = session();
        s.status = TerminalSessionStatus::WaitingInput;
        s.pending_prompt = Some("approve".into());
        apply_event(&mut s, &event(r#"{"type":"assistant.turn_end","data":{}}"#));
        assert_eq!(s.status, TerminalSessionStatus::Idle);
        assert!(s.pending_prompt.is_none());
    }

    #[test]
    fn ask_user_tool_blocks_on_the_user() {
        let mut s = session();
        apply_event(
            &mut s,
            &event(r#"{"type":"tool.execution_start","data":{"toolName":"ask_user"}}"#),
        );
        assert_eq!(s.status, TerminalSessionStatus::WaitingInput);
    }

    #[test]
    fn unknown_events_do_not_change_the_session() {
        let mut s = session();
        s.status = TerminalSessionStatus::Working;
        let changed = apply_event(&mut s, &event(r#"{"type":"model.usage","data":{}}"#));
        assert!(!changed);
        assert_eq!(s.status, TerminalSessionStatus::Working);
    }

    #[test]
    fn resumed_and_recoverable_pty_errors_leave_the_terminal_usable() {
        let mut s = session();
        s.transport = "pty".into();
        s.status = TerminalSessionStatus::WaitingInput;
        s.pending_prompt = Some("old question".into());
        apply_event(&mut s, &event(r#"{"type":"session.resume","data":{}}"#));
        assert_eq!(s.status, TerminalSessionStatus::Idle);
        assert!(s.pending_prompt.is_none());
        apply_event(
            &mut s,
            &event(r#"{"type":"session.error","data":{"message":"turn failed"}}"#),
        );
        assert!(!s.status.is_final());
        assert_eq!(s.last_activity, "turn failed");
    }

    #[test]
    fn resume_cursor_excludes_old_questions_and_preserves_line_identity() {
        let dir = std::env::temp_dir().join(format!("devtrees-resume-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        fs::write(&path, "\n{\"type\":\"tool.execution_start\",\"data\":{\"toolName\":\"ask_user\",\"toolCallId\":\"old\"}}\n").unwrap();
        let (mut cursor, seq) = history_cursor(&path).unwrap();
        assert_eq!(seq, 2);
        assert!(read_new_lines(&path, &mut cursor).unwrap().is_empty());
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"type\":\"session.resume\",\"data\":{}}\n")
            .unwrap();
        let lines = read_new_lines(&path, &mut cursor).unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("session.resume"));
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn status_read_errors_and_truncation_are_not_successful_empty_observations() {
        let dir =
            std::env::temp_dir().join(format!("devtrees-log-errors-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        let mut cursor = 0;
        assert!(read_new_lines(&path, &mut cursor).is_err());
        fs::write(&path, b"\xff\n").unwrap();
        assert!(read_new_lines(&path, &mut cursor).is_err());
        assert_eq!(cursor, 0);
        fs::write(&path, b"old event\n").unwrap();
        read_new_lines(&path, &mut cursor).unwrap();
        fs::write(&path, b"new\n").unwrap();
        assert!(read_new_lines(&path, &mut cursor).is_err());
        assert!(read_new_lines(&path, &mut cursor).unwrap().is_empty());
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn tail_only_returns_complete_lines_and_resumes_from_the_cursor() {
        let dir = std::env::temp_dir().join(format!("devtrees-tail-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"partial\"").unwrap();

        let mut cursor = 0u64;
        let first = read_new_lines(&path, &mut cursor).unwrap();
        assert_eq!(first.len(), 2);

        // The partial line is only delivered once its newline arrives.
        let mut existing = fs::read_to_string(&path).unwrap();
        existing.push_str(":3}\n");
        fs::write(&path, existing).unwrap();
        let second = read_new_lines(&path, &mut cursor).unwrap();
        assert_eq!(second, vec!["{\"partial\":3}".to_string()]);

        fs::remove_dir_all(&dir).ok();
    }

    /// Replays the exact event sequence a real `copilot --session-id=<uuid> -p ...` run
    /// writes, through the same tail + interpret path the poller uses.
    #[test]
    fn replaying_a_real_cli_log_ends_idle_after_the_turn() {
        let dir = std::env::temp_dir().join(format!("devtrees-replay-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        let log = concat!(
            r#"{"type":"session.start","data":{"sessionId":"a37a97a9","version":1}}"#,
            "\n",
            r#"{"type":"user.message","data":{"content":"Reply with the single word: pong"}}"#,
            "\n",
            r#"{"type":"assistant.turn_start","data":{"turnId":"0"}}"#,
            "\n",
            r#"{"type":"assistant.message","data":{"content":"pong"}}"#,
            "\n",
            r#"{"type":"assistant.turn_end","data":{"turnId":"0"}}"#,
            "\n",
        );
        fs::write(&path, log).unwrap();

        let mut s = session();
        let mut cursor = 0u64;
        for line in read_new_lines(&path, &mut cursor).unwrap() {
            let event: RawEvent = serde_json::from_str(&line).unwrap();
            apply_event(&mut s, &event);
        }

        assert_eq!(s.status, TerminalSessionStatus::Idle);
        assert_eq!(s.last_activity, "pong");
        assert!(s.pending_prompt.is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_tool_call_is_completed_in_place_rather_than_appended_twice() {
        let mut open = Vec::new();
        let start = timeline_entry(
            &event(
                r#"{"type":"tool.execution_start","data":{"toolCallId":"c1","toolName":"bash","arguments":{"command":"ls"}}}"#,
            ),
            0,
            &mut open,
        )
        .unwrap();
        assert_eq!(start.seq(), 0);
        assert_eq!(open.len(), 1);

        let done = timeline_entry(
            &event(
                r#"{"type":"tool.execution_complete","data":{"toolCallId":"c1","success":true,"result":{"content":"a.txt"}}}"#,
            ),
            1,
            &mut open,
        )
        .unwrap();
        assert!(open.is_empty());
        // The completion reuses the start's seq, so the renderer replaces the existing
        // row instead of rendering the same call twice.
        assert_eq!(done.seq(), 0);
        match done {
            TerminalTimelineEntry::ToolCall {
                name,
                success,
                result,
                detail,
                ..
            } => {
                assert_eq!(name, "bash");
                assert_eq!(success, Some(true));
                assert_eq!(result.unwrap(), "a.txt");
                assert!(detail.contains("ls"));
            }
            _ => panic!("expected a tool call"),
        }
    }

    #[test]
    fn a_permission_prompt_is_resolved_by_its_completion() {
        let mut open = Vec::new();
        timeline_entry(
            &event(
                r#"{"type":"permission.requested","data":{"permissionRequest":{"kind":"command","command":"git push"}}}"#,
            ),
            4,
            &mut open,
        )
        .unwrap();
        let resolved = timeline_entry(
            &event(r#"{"type":"permission.completed","data":{"result":{"kind":"approved"}}}"#),
            5,
            &mut open,
        )
        .unwrap();
        match resolved {
            TerminalTimelineEntry::Permission { resolution, .. } => {
                assert!(resolution.is_some());
            }
            _ => panic!("expected a permission entry"),
        }
    }

    #[test]
    fn sub_agent_chatter_is_kept_out_of_the_timeline() {
        let mut open = Vec::new();
        assert!(timeline_entry(
            &event(r#"{"type":"assistant.message","data":{"content":"hi","agentId":"sub"}}"#),
            0,
            &mut open,
        )
        .is_none());
        assert!(timeline_entry(
            &event(r#"{"type":"assistant.message","data":{"content":"hi"}}"#),
            1,
            &mut open,
        )
        .is_some());
    }

    #[test]
    fn long_entry_text_is_truncated() {
        let long = "x".repeat(MAX_ENTRY_TEXT + 500);
        let out = truncate(&long, MAX_ENTRY_TEXT);
        assert!(out.ends_with("(truncated)"));
        assert!(out.chars().count() < long.chars().count());
    }
}
