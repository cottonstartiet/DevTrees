use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::{AppError, AppResult},
    session_interactions::NativeInteraction,
    terminal_sessions::{TerminalSession, TerminalSessionStatus, TerminalTimelineEntry},
};

pub const MAX_QUEUE: usize = 100;
pub const MAX_PROMPT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_QUEUE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 500;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_LIVE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: String,
    pub prompt: Arc<Vec<Value>>,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session: TerminalSession,
    pub interactions: Vec<NativeInteraction>,
    pub entries: Vec<TerminalTimelineEntry>,
    pub history_truncated: bool,
    pub error: Option<String>,
    pub commands: Vec<Value>,
    pub commands_ready: bool,
    pub capabilities: Value,
    #[serde(serialize_with = "queue_summaries")]
    pub queue: Vec<QueuedPrompt>,
    pub queue_paused: bool,
    pub phase: String,
    pub replaces_id: Option<String>,
    pub usage: Option<Value>,
}

pub struct State {
    pub url_requests: HashSet<String>,
    pub snapshot: Snapshot,
    pub next_seq: u64,
    messages: HashMap<String, u64>,
    pub active_prompt: Option<String>,
    pub dirty: bool,
    echo: String,
}

fn queue_summaries<S: serde::Serializer>(
    queue: &[QueuedPrompt],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    queue.iter().map(|item| json!({
        "id": item.id, "status": item.status, "error": item.error,
        "text": item.prompt.iter().filter_map(|block| (block["type"] == "text").then(|| block["text"].as_str()).flatten()).collect::<Vec<_>>().join("\n"),
        "attachmentCount": item.prompt.iter().filter(|block| block["type"] != "text").count()
    })).collect::<Vec<_>>().serialize(serializer)
}

fn value_size(value: &Value) -> usize {
    32 + match value {
        Value::String(text) => text.len(),
        Value::Array(values) => values.iter().map(value_size).sum(),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| key.len() + value_size(value))
            .sum(),
        _ => 0,
    }
}

fn entry_size(entry: &TerminalTimelineEntry) -> usize {
    128 + match entry {
        TerminalTimelineEntry::UserMessage { text, .. }
        | TerminalTimelineEntry::AssistantMessage { text, .. }
        | TerminalTimelineEntry::Notice { text, .. } => text.len(),
        TerminalTimelineEntry::Acp { data, .. } => value_size(data),
        _ => 0,
    }
}

impl State {
    pub fn new(session: TerminalSession) -> Self {
        Self {
            url_requests: HashSet::new(),
            snapshot: Snapshot {
                session,
                interactions: Vec::new(),
                entries: Vec::new(),
                history_truncated: false,
                error: None,
                commands: Vec::new(),
                commands_ready: false,
                capabilities: json!({}),
                queue: Vec::new(),
                queue_paused: false,
                phase: "starting".into(),
                replaces_id: None,
                usage: None,
            },
            next_seq: 0,
            messages: HashMap::new(),
            active_prompt: None,
            dirty: true,
            echo: String::new(),
        }
    }

    pub fn changed(&mut self) {
        let mut bytes = self.snapshot.entries.iter().map(entry_size).sum::<usize>();
        while bytes > MAX_LIVE_BYTES && !self.snapshot.entries.is_empty() {
            bytes = bytes.saturating_sub(entry_size(&self.snapshot.entries.remove(0)));
            self.snapshot.history_truncated = true;
        }
        if self.snapshot.history_truncated {
            let floor = self
                .snapshot
                .entries
                .first()
                .map_or(self.next_seq, TerminalTimelineEntry::seq);
            self.messages.retain(|_, seq| *seq >= floor);
        }
        self.snapshot.session.revision += 1;
        self.snapshot.session.updated_at = super::now();
        self.snapshot.session.pending_prompt = self
            .snapshot
            .interactions
            .first()
            .map(|r| r.request.message().chars().take(500).collect());
        self.snapshot.session.status = if !self.snapshot.interactions.is_empty() {
            TerminalSessionStatus::WaitingInput
        } else {
            match self.snapshot.phase.as_str() {
                "starting" | "loading" => TerminalSessionStatus::Starting,
                "working" | "cancelling" | "ending" => TerminalSessionStatus::Working,
                "ended" => TerminalSessionStatus::Done,
                "failed" => TerminalSessionStatus::Error,
                _ => TerminalSessionStatus::Idle,
            }
        };
        self.dirty = true;
    }

    pub fn notice(&mut self, text: impl Into<String>, error: bool) {
        let entry = TerminalTimelineEntry::Notice {
            seq: self.next_seq,
            timestamp: None,
            text: text.into(),
            level: if error { "error" } else { "info" }.into(),
        };
        self.next_seq += 1;
        self.push(entry);
    }

    fn push(&mut self, entry: TerminalTimelineEntry) {
        self.snapshot.entries.push(entry);
        if self.snapshot.entries.len() > MAX_ENTRIES {
            self.snapshot.entries.remove(0);
            self.snapshot.history_truncated = true;
            let floor = self
                .snapshot
                .entries
                .first()
                .map_or(0, TerminalTimelineEntry::seq);
            self.messages.retain(|_, seq| *seq >= floor);
        }
        self.changed();
    }

    pub fn validate_prompt(&self, prompt: &[Value], literal: bool) -> AppResult<()> {
        if prompt.is_empty() || serde_json::to_vec(prompt)?.len() > MAX_PROMPT_BYTES {
            return Err(AppError::msg(
                "Provide a message or attachment smaller than 16 MiB.",
            ));
        }
        let _: Vec<agent_client_protocol::schema::v1::ContentBlock> =
            serde_json::from_value(json!(prompt))
                .map_err(|e| AppError::msg(format!("Invalid ACP content: {e}")))?;
        if prompt
            .iter()
            .filter_map(|b| b["text"].as_str())
            .map(str::len)
            .sum::<usize>()
            > MAX_TEXT_BYTES
        {
            return Err(AppError::msg(
                "Message text exceeds 64 KiB. Attach large text as a context file instead.",
            ));
        }
        for block in prompt {
            match block["type"].as_str() {
                Some("text") if block["text"].as_str().is_some() => {}
                Some("image")
                    if self.snapshot.capabilities["promptCapabilities"]["image"] == true => {}
                Some("resource")
                    if self.snapshot.capabilities["promptCapabilities"]["embeddedContext"]
                        == true => {}
                Some("resource_link") => {}
                _ => {
                    return Err(AppError::msg(
                        "Copilot does not support this attachment type.",
                    ))
                }
            }
        }
        if prompt.iter().all(|block| {
            block["type"] == "text" && block["text"].as_str().is_none_or(|s| s.trim().is_empty())
        }) {
            return Err(AppError::msg("A message is required."));
        }
        if let Some(text) = prompt.first().and_then(|b| b["text"].as_str()) {
            if text.trim_start().starts_with('/') && !literal {
                let name = text.trim_start()[1..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("");
                if !self.snapshot.commands_ready {
                    return Err(AppError::msg("Copilot is still loading its command list."));
                }
                if !self.snapshot.commands.iter().any(|c| c["name"] == name) {
                    return Err(AppError::msg(format!("/{name} is not advertised by Copilot ACP. Choose a supported command or explicitly send it as a literal message.")));
                }
                if prompt.len() != 1 {
                    return Err(AppError::msg(
                        "Slash commands must be sent without attachments.",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn stage_prompt(
        &mut self,
        id: String,
        mut prompt: Vec<Value>,
        literal: bool,
    ) -> AppResult<bool> {
        if id.is_empty() || id.len() > 128 {
            return Err(AppError::msg("Invalid submission ID."));
        }
        if literal {
            if let Some(text) = prompt.first_mut().and_then(|b| b.get_mut("text")) {
                if text
                    .as_str()
                    .is_some_and(|s| s.trim_start().starts_with('/'))
                {
                    *text = Value::String(format!(
                        "Treat the following as literal user text, not a slash command:\n{}",
                        text.as_str().unwrap_or("")
                    ));
                }
            }
        }
        if let Some(existing) = self.snapshot.queue.iter().find(|item| item.id == id) {
            if existing.prompt.as_ref() == &prompt {
                return Ok(false);
            }
            return Err(AppError::msg(
                "This submission ID already belongs to a different message.",
            ));
        }
        self.validate_prompt(&prompt, false)?;
        if self.snapshot.queue.len() >= MAX_QUEUE {
            return Err(AppError::msg("The queue holds at most 100 items. Remove completed or unsent items before adding another."));
        }
        self.snapshot.queue.push(QueuedPrompt {
            id,
            prompt: Arc::new(prompt),
            status: "queued".into(),
            error: None,
        });
        if serde_json::to_vec(&self.snapshot.queue)?.len() > MAX_QUEUE_BYTES {
            self.snapshot.queue.pop();
            return Err(AppError::msg(
                "The queue exceeds 32 MiB. Remove an item before adding more attachments.",
            ));
        }
        Ok(true)
    }

    pub fn begin_prompt(&mut self, item: &QueuedPrompt) {
        self.messages.clear();
        self.echo.clear();
        for block in item.prompt.iter() {
            if let Some(text) = block["text"].as_str().filter(|_| block["type"] == "text") {
                self.echo.push_str(text);
                let seq = self.next_seq;
                self.next_seq += 1;
                self.push(TerminalTimelineEntry::UserMessage {
                    seq,
                    timestamp: None,
                    text: text.into(),
                });
            } else {
                self.rich("user_message_chunk", block.clone());
            }
        }
    }

    pub fn recover_queue(&mut self, mut queue: Vec<QueuedPrompt>) {
        for item in &mut queue {
            if matches!(item.status.as_str(), "dispatching" | "active") {
                item.status = "delivery-unknown".into();
                item.error = Some("The app stopped before completion could be confirmed. Review saved history before resending.".into());
            }
        }
        self.snapshot.queue = queue;
        self.snapshot.queue_paused = true;
        self.changed();
    }

    pub fn ingest(&mut self, update: Value) {
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        match kind {
            "available_commands_update" => {
                self.snapshot.commands = update["availableCommands"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                self.snapshot.commands_ready = true;
            }
            "config_option_update" | "current_mode_update" => {}
            "usage_update" => self.snapshot.usage = Some(update.clone()),
            "session_info_update" => {
                if let Some(title) = update["title"].as_str() {
                    self.snapshot.session.label = title.into();
                }
            }
            "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk" => {
                let user = kind == "user_message_chunk";
                if user {
                    self.messages.remove("agent_message_chunk:current");
                    if !self.messages.contains_key("user_message_chunk:current") {
                        self.messages.remove("plan");
                    }
                } else if kind == "agent_message_chunk" {
                    self.messages.remove("user_message_chunk:current");
                }
                let content = &update["content"];
                if content["type"] != "text" {
                    self.messages.remove(&format!("{kind}:current"));
                    self.rich(kind, content.clone());
                    return;
                }
                let text = content["text"].as_str().unwrap_or("");
                if user && !self.echo.is_empty() {
                    if self.echo.starts_with(text) {
                        self.echo.drain(..text.len());
                        return;
                    }
                    self.echo.clear();
                }
                if text.len() > MAX_MESSAGE_BYTES {
                    self.notice("Copilot output exceeds the 1 MiB live-message limit. Read the full output in Copilot's saved history.", true);
                    self.snapshot.history_truncated = true;
                    return;
                }
                if kind == "agent_thought_chunk" {
                    if let Some(TerminalTimelineEntry::Acp { data, .. }) = self.snapshot.entries.last_mut()
                        .filter(|entry| matches!(entry, TerminalTimelineEntry::Acp { category, .. } if category == kind)) {
                        let previous = data["text"].as_str().unwrap_or("");
                        let combined = if previous.len() + text.len() <= MAX_MESSAGE_BYTES {
                            format!("{previous}{text}")
                        } else {
                            self.snapshot.history_truncated = true;
                            format!("Earlier output omitted at the 1 MiB live-message limit.\n{text}")
                        };
                        data["text"] = Value::String(combined);
                        self.changed();
                    } else { self.rich(kind, content.clone()); }
                    return;
                }
                let key = format!(
                    "{kind}:{}",
                    update["messageId"].as_str().unwrap_or("current")
                );
                let existing = self.messages.get(&key).copied();
                if let Some(entry) = existing
                    .and_then(|seq| self.snapshot.entries.iter_mut().find(|e| e.seq() == seq))
                {
                    match entry {
                        TerminalTimelineEntry::UserMessage { text: current, .. }
                        | TerminalTimelineEntry::AssistantMessage { text: current, .. } => {
                            if current.len() + text.len() > MAX_MESSAGE_BYTES {
                                *current =
                                    "Earlier output omitted at the 1 MiB live-message limit.\n"
                                        .into();
                                self.snapshot.history_truncated = true;
                            }
                            current.push_str(text);
                        }
                        _ => {}
                    }
                } else {
                    let seq = self.next_seq;
                    self.next_seq += 1;
                    self.messages.insert(key, seq);
                    self.push(if user {
                        TerminalTimelineEntry::UserMessage {
                            seq,
                            timestamp: None,
                            text: text.into(),
                        }
                    } else {
                        TerminalTimelineEntry::AssistantMessage {
                            seq,
                            timestamp: None,
                            text: text.into(),
                        }
                    });
                }
                self.snapshot.session.last_activity = if user {
                    "Instruction received"
                } else {
                    "Copilot is responding"
                }
                .into();
            }
            "tool_call" | "tool_call_update" => {
                self.messages.remove("agent_message_chunk:current");
                self.messages.remove("user_message_chunk:current");
                let id = update["toolCallId"].as_str().unwrap_or("");
                if id.is_empty() {
                    self.notice("Copilot sent a tool update without an ID.", true);
                    return;
                }
                let existing = self.snapshot.entries.iter_mut().find(|entry| {
                    matches!(entry, TerminalTimelineEntry::Acp { data, .. } if data["toolCallId"] == id)
                });
                if let Some(TerminalTimelineEntry::Acp { data, .. }) = existing {
                    if let (Some(current), Some(patch)) = (data.as_object_mut(), update.as_object())
                    {
                        for (key, value) in patch {
                            current.insert(key.clone(), value.clone());
                        }
                    }
                } else {
                    self.rich("tool", update.clone());
                }
                self.snapshot.session.last_activity = update["title"]
                    .as_str()
                    .unwrap_or("Copilot tool activity")
                    .into();
            }
            "plan" => {
                let existing = self.messages.get("plan").copied();
                if let Some(TerminalTimelineEntry::Acp { data, .. }) = existing.and_then(|seq| {
                    self.snapshot
                        .entries
                        .iter_mut()
                        .find(|entry| entry.seq() == seq)
                }) {
                    *data = update.clone();
                } else {
                    self.messages.insert("plan".into(), self.next_seq);
                    self.rich("plan", update.clone());
                }
            }
            _ => self.rich("update", update.clone()),
        }
        self.changed();
    }

    fn rich(&mut self, category: &str, data: Value) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.push(TerminalTimelineEntry::Acp {
            seq,
            timestamp: None,
            category: category.into(),
            data,
        });
    }

    pub fn finish_tools(&mut self, stop: &str) {
        for entry in &mut self.snapshot.entries {
            if let TerminalTimelineEntry::Acp { category, data, .. } = entry {
                if category == "tool"
                    && matches!(
                        data["status"].as_str(),
                        None | Some("pending" | "in_progress")
                    )
                {
                    data["status"] = Value::String(
                        if stop == "cancelled" {
                            "cancelled"
                        } else {
                            "incomplete"
                        }
                        .into(),
                    );
                }
            }
        }
    }

    pub fn turn_finished(&mut self, stop: &str) {
        self.finish_tools(stop);
        if let Some(id) = self.active_prompt.take() {
            if let Some(item) = self.snapshot.queue.iter_mut().find(|item| item.id == id) {
                item.status = if stop == "end_turn" {
                    "completed"
                } else {
                    "cancelled"
                }
                .into();
                item.error = (stop != "end_turn").then(|| format!("Turn stopped: {stop}"));
            }
        }
        self.messages.clear();
        self.echo.clear();
        self.snapshot.queue_paused |= stop != "end_turn";
        if self.snapshot.phase != "ending" {
            self.snapshot.phase = "idle".into();
        }
        self.snapshot.session.last_activity = format!("Turn finished: {stop}");
        self.changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State::new(TerminalSession {
            id: "test".into(),
            task_id: None,
            folder_path: ".".into(),
            label: "test".into(),
            repository: None,
            branch: None,
            status: TerminalSessionStatus::Starting,
            last_activity: String::new(),
            pending_prompt: None,
            created_at: 0,
            updated_at: 0,
            transport: "acp".into(),
            generation: Some("one".into()),
            revision: 0,
            observed_at: None,
            observation_error: None,
        })
    }

    #[test]
    fn acp_commands_replace_and_validate() {
        let mut state = state();
        assert!(state
            .validate_prompt(&[json!({"type":"text","text":"/usage"})], false)
            .is_err());
        state.ingest(json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"usage"}]}));
        assert!(state
            .validate_prompt(&[json!({"type":"text","text":"/usage"})], false)
            .is_ok());
        assert!(state
            .validate_prompt(&[json!({"type":"text","text":"/typo"})], false)
            .is_err());
        state.ingest(json!({"sessionUpdate":"available_commands_update","availableCommands":[]}));
        assert!(state
            .validate_prompt(&[json!({"type":"text","text":"/usage"})], false)
            .is_err());
    }

    #[test]
    fn acp_partial_tool_updates_preserve_prior_fields() {
        let mut state = state();
        state.ingest(json!({"sessionUpdate":"tool_call","toolCallId":"one","title":"Read file","status":"in_progress","rawInput":{"path":"a"}}));
        state.ingest(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"one","status":"completed"}),
        );
        let TerminalTimelineEntry::Acp { data, .. } = &state.snapshot.entries[0] else {
            panic!()
        };
        assert_eq!(data["title"], "Read file");
        assert_eq!(data["status"], "completed");
        assert_eq!(state.snapshot.entries.len(), 1);
    }

    #[test]
    fn acp_cancel_pauses_queue() {
        let mut state = state();
        state.turn_finished("cancelled");
        assert!(state.snapshot.queue_paused);
        state.turn_finished("end_turn");
        assert!(state.snapshot.queue_paused);
    }

    #[test]
    fn acp_submissions_are_idempotent_and_literal_commands_are_not_executed() {
        let mut state = state();
        let prompt = vec![json!({"type":"text","text":"hello"})];
        assert!(state
            .stage_prompt("one".into(), prompt.clone(), false)
            .unwrap());
        assert!(!state.stage_prompt("one".into(), prompt, false).unwrap());
        assert!(state
            .stage_prompt(
                "one".into(),
                vec![json!({"type":"text","text":"different"})],
                false
            )
            .is_err());
        assert_eq!(state.snapshot.queue.len(), 1);
        assert!(state
            .stage_prompt(
                "literal".into(),
                vec![json!({"type":"text","text":"/usage"})],
                true
            )
            .unwrap());
        assert!(!state.snapshot.queue[1].prompt[0]["text"]
            .as_str()
            .unwrap()
            .starts_with('/'));
        assert!(state
            .validate_prompt(&state.snapshot.queue[1].prompt, false)
            .is_ok());
    }

    #[test]
    fn acp_recovery_never_replays_uncertain_delivery() {
        let mut state = state();
        state
            .stage_prompt(
                "one".into(),
                vec![json!({"type":"text","text":"first"})],
                false,
            )
            .unwrap();
        state
            .stage_prompt(
                "two".into(),
                vec![json!({"type":"text","text":"second"})],
                false,
            )
            .unwrap();
        state.snapshot.queue[0].status = "dispatching".into();
        state.recover_queue(state.snapshot.queue.clone());
        assert!(state.snapshot.queue_paused);
        assert_eq!(state.snapshot.queue[0].status, "delivery-unknown");
        assert_eq!(state.snapshot.queue[1].status, "queued");
        state.turn_finished("end_turn");
        assert!(state.snapshot.queue_paused);
    }

    #[test]
    fn acp_snapshots_exclude_attachment_payloads_but_storage_retains_them() {
        let mut state = state();
        state.snapshot.capabilities = json!({"promptCapabilities":{"embeddedContext":true}});
        state
            .stage_prompt(
                "one".into(),
                vec![json!({"type":"resource","resource":{
                    "uri":"devtrees-attachment:file.txt","text":"x".repeat(100_000)
                }})],
                false,
            )
            .unwrap();
        let snapshot = serde_json::to_string(&state.snapshot).unwrap();
        assert!(snapshot.len() < 2048);
        assert!(snapshot.contains("\"attachmentCount\":1"));
        assert!(serde_json::to_string(&state.snapshot.queue).unwrap().len() > 100_000);
    }

    #[test]
    fn acp_replay_keeps_turns_separate_and_local_echo_is_not_duplicated() {
        let mut state = state();
        for (role, text) in [
            ("user", "first"),
            ("agent", "answer"),
            ("user", "second"),
            ("agent", "reply"),
        ] {
            state.ingest(json!({"sessionUpdate":format!("{role}_message_chunk"),"content":{"type":"text","text":text}}));
        }
        assert_eq!(state.snapshot.entries.len(), 4);
        state
            .stage_prompt(
                "one".into(),
                vec![json!({"type":"text","text":"new prompt"})],
                false,
            )
            .unwrap();
        state.begin_prompt(&state.snapshot.queue[0].clone());
        for text in ["new ", "prompt"] {
            state.ingest(
                json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}}),
            );
        }
        assert_eq!(state.snapshot.entries.len(), 5);
    }

    #[test]
    fn acp_limits_and_invalid_content_fail_before_delivery() {
        let mut state = state();
        assert!(state
            .stage_prompt(
                "too-big".into(),
                vec![json!({"type":"text","text":"x".repeat(MAX_TEXT_BYTES + 1)})],
                false
            )
            .is_err());
        state.snapshot.capabilities = json!({"promptCapabilities":{"image":true}});
        assert!(state
            .stage_prompt("malformed".into(), vec![json!({"type":"image"})], false)
            .is_err());
        assert!(state.snapshot.queue.is_empty());
        for index in 0..MAX_QUEUE {
            state
                .stage_prompt(
                    index.to_string(),
                    vec![json!({"type":"text","text":"hello"})],
                    false,
                )
                .unwrap();
        }
        assert!(state
            .stage_prompt(
                "overflow".into(),
                vec![json!({"type":"text","text":"hello"})],
                false
            )
            .is_err());
        state.ingest(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x".repeat(MAX_MESSAGE_BYTES + 1)}}));
        assert!(state.snapshot.history_truncated);
    }
}
