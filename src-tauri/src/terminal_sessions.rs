//! Monitoring for Copilot CLI sessions that run in an **external terminal**.
//!
//! When DevTrees launches `copilot` in Windows Terminal the process is detached, so
//! there is no pipe to read. The CLI does, however, append a structured event log to
//! `~/.copilot/session-state/<session-id>/events.jsonl`, and it lets the caller pin the
//! session id up front via `--session-id=<uuid>`. Together that gives us a reliable,
//! read-only side channel: the app generates the id, launches the terminal with it, and
//! tails the resulting event log to mirror the session's state back into the UI.
//!
//! The tail is driven by a single polling task shared by every watched session. Each
//! poll reads only the bytes appended since the last cursor, so watching a long-running
//! session stays cheap even when its log grows to hundreds of megabytes.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

pub const EVENT_UPDATE: &str = "terminal-sessions:update";

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

// ----- Types -----

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSessionStatus {
    /// Launched, but the CLI has not written its first event yet.
    Starting,
    /// A model turn or tool call is in flight.
    Working,
    /// Copilot is blocked on the user: a permission prompt or an `ask_user` question.
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TerminalSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    fn seq(&self) -> u64 {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionsSnapshot {
    pub sessions: Vec<TerminalSession>,
    pub entries_by_id: HashMap<String, Vec<TerminalTimelineEntry>>,
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
}

#[derive(Clone, Default)]
pub struct TerminalSessionMonitor {
    watches: Arc<Mutex<HashMap<String, Watch>>>,
    started: Arc<Mutex<bool>>,
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
           status, last_activity, pending_prompt, cursor, created_at, updated_at, seq
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
           seq = excluded.seq",
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
        ],
    )?;
    Ok(())
}

const SELECT_COLUMNS: &str =
    "id, task_id, folder_path, label, repository, branch, status, last_activity, \
     pending_prompt, cursor, created_at, updated_at, seq";

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
        },
        cursor: cursor.max(0) as u64,
        seq: seq.max(0) as u64,
        open_entries: Vec::new(),
        saw_lock: false,
        missing_polls: 0,
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
        "session.start" => {
            session.status = TerminalSessionStatus::Idle;
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
            session.status = TerminalSessionStatus::Error;
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

/// Read newly appended complete lines from `events.jsonl`, advancing `cursor` only past
/// the final newline so a half-written line is re-read on the next poll.
fn read_new_lines(path: &PathBuf, cursor: &mut u64) -> Vec<String> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata() else {
        return Vec::new();
    };
    let len = metadata.len();
    // The log was truncated or replaced (e.g. the session folder was recreated).
    if len < *cursor {
        *cursor = 0;
    }
    if len == *cursor {
        return Vec::new();
    }
    if file.seek(SeekFrom::Start(*cursor)).is_err() {
        return Vec::new();
    }
    let take = (len - *cursor).min(MAX_READ_PER_POLL);
    let mut buf = vec![0u8; take as usize];
    let Ok(read) = file.read(&mut buf) else {
        return Vec::new();
    };
    buf.truncate(read);
    let Some(last_newline) = buf.iter().rposition(|b| *b == b'\n') else {
        return Vec::new();
    };
    *cursor += (last_newline + 1) as u64;
    String::from_utf8_lossy(&buf[..last_newline])
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect()
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

fn emit(
    app: &AppHandle,
    session: &TerminalSession,
    entries: Vec<TerminalTimelineEntry>,
    previous_status: Option<TerminalSessionStatus>,
) {
    let update = TerminalSessionUpdate {
        session: session.clone(),
        entries,
    };
    let state = app.state::<AppState>();
    state.broadcast(EVENT_UPDATE, &update);
    if !state.has_browser_clients() && previous_status != Some(session.status) {
        let message = match session.status {
            TerminalSessionStatus::WaitingInput => Some((
                format!("{} needs you in Windows Terminal", session.label),
                session
                    .pending_prompt
                    .as_deref()
                    .unwrap_or("Copilot is waiting for your response."),
            )),
            TerminalSessionStatus::Idle => Some((
                format!("{} finished a turn", session.label),
                session.last_activity.as_str(),
            )),
            TerminalSessionStatus::Error => Some((
                format!("{} failed", session.label),
                session.last_activity.as_str(),
            )),
            _ => None,
        };
        if let Some((title, body)) = message {
            crate::notifications::show(app, title, body, "/sessions");
        }
    }
    crate::tray::refresh_session_summary(app);
}

fn persist(app: &AppHandle, session: &TerminalSession, cursor: u64, seq: u64) {
    if let Some(state) = app.try_state::<DbState>() {
        if let Ok(db) = state.0.lock() {
            let _ = upsert(&db, session, cursor, seq);
        }
    }
}

fn persist_if_current(app: &AppHandle, session: &TerminalSession, cursor: u64, seq: u64) -> bool {
    let monitor = app.state::<TerminalSessionMonitor>();
    let Ok(watches) = monitor.watches.lock() else {
        return false;
    };
    let is_current = watches
        .get(&session.id)
        .map(|watch| watch.session.updated_at == session.updated_at)
        .unwrap_or(false);
    if !is_current {
        return false;
    }
    let state = app.state::<DbState>();
    let Ok(db) = state.0.lock() else {
        return false;
    };
    upsert(&db, session, cursor, seq).is_ok()
}

/// One tick: advance every watched session, emitting and persisting the ones that moved.
fn poll_once(app: &AppHandle) {
    let Some(monitor) = app.try_state::<TerminalSessionMonitor>() else {
        return;
    };
    let Ok(root) = session_state_root() else {
        return;
    };

    let mut changed: Vec<(
        TerminalSession,
        u64,
        u64,
        Vec<TerminalTimelineEntry>,
        TerminalSessionStatus,
    )> = Vec::new();
    {
        let Ok(mut watches) = monitor.watches.lock() else {
            return;
        };
        for watch in watches.values_mut() {
            if watch.session.status.is_final() {
                continue;
            }
            let previous_status = watch.session.status;
            let dir = root.join(&watch.session.id);
            if !dir.exists() {
                watch.missing_polls += 1;
                // ~2 minutes without the CLI ever creating its folder: the launch failed
                // or the user closed the window before Copilot started.
                if watch.missing_polls > 120 {
                    watch.session.status = TerminalSessionStatus::Done;
                    watch.session.last_activity = "Terminal closed before Copilot started".into();
                    watch.session.updated_at = now_ms();
                    changed.push((
                        watch.session.clone(),
                        watch.cursor,
                        watch.seq,
                        Vec::new(),
                        previous_status,
                    ));
                }
                continue;
            }
            watch.missing_polls = 0;

            let mut dirty = false;
            let mut entries: Vec<TerminalTimelineEntry> = Vec::new();
            for line in read_new_lines(&dir.join("events.jsonl"), &mut watch.cursor) {
                let seq = watch.seq;
                watch.seq += 1;
                // Unknown or malformed lines are skipped: the log format is the CLI's,
                // not ours, so tolerate anything we do not recognize.
                if let Ok(event) = serde_json::from_str::<RawEvent>(&line) {
                    dirty |= apply_event(&mut watch.session, &event);
                    if let Some(entry) = timeline_entry(&event, seq, &mut watch.open_entries) {
                        entries.push(entry);
                    }
                }
            }
            if !entries.is_empty() {
                dirty = true;
            }

            let locked = has_lock(&dir);
            if locked {
                watch.saw_lock = true;
            } else if watch.saw_lock && !watch.session.status.is_final() {
                // The terminal window was closed. Whatever the last state was, the
                // session is over.
                watch.session.status = TerminalSessionStatus::Done;
                watch.session.pending_prompt = None;
                dirty = true;
            }

            if dirty {
                watch.session.updated_at = now_ms();
                changed.push((
                    watch.session.clone(),
                    watch.cursor,
                    watch.seq,
                    entries,
                    previous_status,
                ));
            }
        }
    }

    for (session, cursor, seq, entries, previous_status) in changed {
        if !persist_if_current(app, &session, cursor, seq) {
            continue;
        }
        emit(app, &session, entries, Some(previous_status));
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
            if handle
                .state::<AppState>()
                .shutting_down
                .load(Ordering::Relaxed)
            {
                break;
            }
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
        for watch in restored {
            watches.insert(watch.session.id.clone(), watch);
        }
    }
    ensure_polling(app);
    Ok(())
}

// ----- Commands -----

#[tauri::command]
pub async fn terminal_sessions_list(db: State<'_, DbState>) -> AppResult<Vec<TerminalSession>> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::msg("database mutex poisoned"))?;
    Ok(load_all(&conn)?
        .into_iter()
        .map(|watch| watch.session)
        .collect())
}

/// Begin mirroring an externally launched Copilot CLI session.
#[tauri::command]
pub async fn terminal_sessions_watch(
    app: AppHandle,
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
    };

    persist(&app, &session, cursor, seq);
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
            },
        );
    }
    ensure_polling(&app);
    emit(&app, &session, Vec::new(), None);

    Ok(TerminalSessionResult {
        ok: true,
        session: Some(session),
        error: None,
    })
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
    let Ok(file) = fs::File::open(&path) else {
        return Ok(Vec::new());
    };

    let mut entries: VecDeque<TerminalTimelineEntry> = VecDeque::new();
    let mut open: Vec<TerminalTimelineEntry> = Vec::new();
    for (seq, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { break };
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

pub async fn terminal_sessions_snapshot(app: AppHandle) -> AppResult<TerminalSessionsSnapshot> {
    let sessions = terminal_sessions_list(app.state::<DbState>()).await?;
    Ok(TerminalSessionsSnapshot {
        sessions,
        // Timelines are loaded on demand when a session is selected. Replaying every
        // persisted events.jsonl here would make each browser reconnect scan all
        // historical Copilot logs, which can be hundreds of megabytes apiece.
        entries_by_id: HashMap::new(),
    })
}

/// Stop mirroring a session and drop it from the list.
#[tauri::command]
pub async fn terminal_sessions_forget(app: AppHandle, id: String) -> AppResult<()> {
    let monitor = app.state::<TerminalSessionMonitor>();
    let mut watches = monitor
        .watches
        .lock()
        .map_err(|_| AppError::msg("terminal session monitor mutex poisoned"))?;
    watches.remove(&id);
    let state = app.state::<DbState>();
    let db = state
        .0
        .lock()
        .map_err(|_| AppError::msg("database mutex poisoned"))?;
    db.execute("DELETE FROM terminal_sessions WHERE id = ?1", [&id])?;
    drop(db);
    drop(watches);
    crate::tray::refresh_session_summary(&app);
    Ok(())
}

pub fn active_session_count(app: &AppHandle) -> usize {
    app.try_state::<AppState>()
        .and_then(|state| {
            state.terminal_sessions.watches.lock().ok().map(|watches| {
                watches
                    .values()
                    .filter(|watch| !watch.session.status.is_final())
                    .count()
            })
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }

    fn event(json: &str) -> RawEvent {
        serde_json::from_str(json).unwrap()
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
    fn tail_only_returns_complete_lines_and_resumes_from_the_cursor() {
        let dir = std::env::temp_dir().join(format!("devtrees-tail-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"partial\"").unwrap();

        let mut cursor = 0u64;
        let first = read_new_lines(&path, &mut cursor);
        assert_eq!(first.len(), 2);

        // The partial line is only delivered once its newline arrives.
        let mut existing = fs::read_to_string(&path).unwrap();
        existing.push_str(":3}\n");
        fs::write(&path, existing).unwrap();
        let second = read_new_lines(&path, &mut cursor);
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
        for line in read_new_lines(&path, &mut cursor) {
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
