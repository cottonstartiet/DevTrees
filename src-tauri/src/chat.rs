use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use github_copilot_sdk::session::Session;
use github_copilot_sdk::types::{
    MessageOptions, ResumeSessionConfig, SessionConfig, SessionId, SystemMessageConfig,
};
use github_copilot_sdk::{Client, ClientOptions};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::db::DbState;
use crate::error::{AppError, AppResult};

const EVENT_DELTA: &str = "chat:delta";
const EVENT_COMPLETE: &str = "chat:complete";
const EVENT_ERROR: &str = "chat:error";
const MAX_PROMPT_BYTES: usize = 200_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub path: String,
}

impl ChatContext {
    fn validate(&self) -> AppResult<()> {
        if self.kind != "repository" && self.kind != "worktree" {
            return Err(AppError::msg("Invalid chat context kind."));
        }
        if self.id.trim().is_empty() || self.name.trim().is_empty() || self.path.trim().is_empty() {
            return Err(AppError::msg("Chat context is incomplete."));
        }
        if !std::path::Path::new(&self.path).is_dir() {
            return Err(AppError::msg(
                "The selected chat context folder no longer exists.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub sdk_session_id: Option<String>,
    pub context: Option<ChatContext>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDeltaEvent {
    conversation_id: String,
    message_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompleteEvent {
    conversation_id: String,
    message: ChatMessage,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatErrorEvent {
    conversation_id: String,
    message_id: String,
    error: String,
}

fn map_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatConversation> {
    let context_kind: Option<String> = row.get(3)?;
    let context = match context_kind {
        Some(kind) => Some(ChatContext {
            kind,
            id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            name: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            path: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        }),
        None => None,
    };
    Ok(ChatConversation {
        id: row.get(0)?,
        title: row.get(1)?,
        sdk_session_id: row.get(2)?,
        context,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn load_conversation(conn: &Connection, id: &str) -> AppResult<ChatConversation> {
    conn.query_row(
        "SELECT id, title, sdk_session_id, context_kind, context_id, context_name,
                context_path, created_at, updated_at
         FROM chat_conversations WHERE id = ?1",
        [id],
        map_conversation,
    )
    .optional()?
    .ok_or_else(|| AppError::msg("Chat conversation not found."))
}

fn message_title(prompt: &str) -> String {
    const MAX_CHARS: usize = 52;
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= MAX_CHARS {
        return normalized;
    }
    let mut title = normalized.chars().take(MAX_CHARS - 1).collect::<String>();
    title.push('…');
    title
}

fn map_sdk_error(error: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("Copilot SDK error: {error}"))
}

fn system_message(context: Option<&ChatContext>) -> SystemMessageConfig {
    let context_note = context
        .map(|value| {
            format!(
                " The user attached the {} context \"{}\" at {}. Use that identity when it is relevant, but do not claim to have inspected files.",
                value.kind, value.name, value.path
            )
        })
        .unwrap_or_default();
    SystemMessageConfig::new().with_content(format!(
        "You are the read-only Q&A assistant inside DevTrees. Answer directly and do not attempt to run tools, edit files, or change the user's environment.{context_note}"
    ))
}

#[derive(Default)]
pub struct ChatManager {
    client: AsyncMutex<Option<Client>>,
    sessions: AsyncMutex<HashMap<String, Arc<Session>>>,
    in_flight: Mutex<HashSet<String>>,
}

impl ChatManager {
    fn reserve_conversation(&self, conversation_id: &str, error: &str) -> AppResult<()> {
        let mut in_flight = self
            .in_flight
            .lock()
            .map_err(|_| AppError::msg("chat state mutex poisoned"))?;
        if !in_flight.insert(conversation_id.to_string()) {
            return Err(AppError::msg(error));
        }
        Ok(())
    }

    fn release_conversation(&self, conversation_id: &str) {
        if let Ok(mut in_flight) = self.in_flight.lock() {
            in_flight.remove(conversation_id);
        }
    }

    async fn client(&self) -> AppResult<Client> {
        let mut client = self.client.lock().await;
        if let Some(existing) = client.as_ref() {
            return Ok(existing.clone());
        }
        let started = Client::start(ClientOptions::default())
            .await
            .map_err(map_sdk_error)?;
        *client = Some(started.clone());
        Ok(started)
    }

    async fn session_for(
        &self,
        conversation: &ChatConversation,
        db: &DbState,
    ) -> AppResult<Arc<Session>> {
        if let Some(session) = self.sessions.lock().await.get(&conversation.id).cloned() {
            return Ok(session);
        }

        let client = self.client().await?;
        let context_path = conversation
            .context
            .as_ref()
            .map(|context| context.path.clone());
        let session = if let Some(sdk_session_id) = conversation.sdk_session_id.as_ref() {
            let mut config = ResumeSessionConfig::new(SessionId::new(sdk_session_id.clone()))
                .with_client_name("DevTrees")
                .with_streaming(true)
                .with_system_message(system_message(conversation.context.as_ref()))
                .with_available_tools(Vec::<String>::new())
                .deny_all_permissions()
                .with_enable_config_discovery(false)
                .with_enable_host_git_operations(false)
                .with_enable_skills(false)
                .with_skip_custom_instructions(true);
            if let Some(path) = context_path {
                config = config.with_working_directory(path);
            }
            client.resume_session(config).await.map_err(map_sdk_error)?
        } else {
            let mut config = SessionConfig::default()
                .with_client_name("DevTrees")
                .with_streaming(true)
                .with_system_message(system_message(conversation.context.as_ref()))
                .with_available_tools(Vec::<String>::new())
                .deny_all_permissions()
                .with_enable_config_discovery(false)
                .with_enable_host_git_operations(false)
                .with_enable_skills(false)
                .with_skip_custom_instructions(true);
            if let Some(path) = context_path {
                config = config.with_working_directory(path);
            }
            client.create_session(config).await.map_err(map_sdk_error)?
        };

        let session = Arc::new(session);
        if conversation.sdk_session_id.is_none() {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            conn.execute(
                "UPDATE chat_conversations SET sdk_session_id = ?1 WHERE id = ?2",
                params![session.id().to_string(), conversation.id],
            )?;
        }
        self.sessions
            .lock()
            .await
            .insert(conversation.id.clone(), session.clone());
        Ok(session)
    }

    async fn reset_session(&self, conversation_id: &str) {
        if let Some(session) = self.sessions.lock().await.remove(conversation_id) {
            let _ = session.disconnect().await;
        }
    }

    async fn send_inner(
        &self,
        app: &AppHandle,
        db: &DbState,
        conversation_id: &str,
        prompt: &str,
    ) -> AppResult<ChatMessage> {
        let conversation = {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            load_conversation(&conn, conversation_id)?
        };
        let assistant_id = uuid::Uuid::new_v4().to_string();
        let created_at = now_ms();
        {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            let tx = conn.unchecked_transaction()?;
            let user_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO chat_messages
                   (id, conversation_id, role, content, status, error, created_at)
                 VALUES (?1, ?2, 'user', ?3, 'completed', NULL, ?4)",
                params![user_id, conversation_id, prompt, created_at],
            )?;
            tx.execute(
                "INSERT INTO chat_messages
                   (id, conversation_id, role, content, status, error, created_at)
                 VALUES (?1, ?2, 'assistant', '', 'streaming', NULL, ?3)",
                params![assistant_id, conversation_id, created_at + 1],
            )?;
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM chat_messages
                 WHERE conversation_id = ?1 AND role = 'user'",
                [conversation_id],
                |row| row.get(0),
            )?;
            if count == 1 {
                tx.execute(
                    "UPDATE chat_conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![message_title(prompt), created_at, conversation_id],
                )?;
            } else {
                tx.execute(
                    "UPDATE chat_conversations SET updated_at = ?1 WHERE id = ?2",
                    params![created_at, conversation_id],
                )?;
            }
            tx.commit()?;
        }
        let session = match self.session_for(&conversation, db).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .finish_error(app, db, conversation_id, &assistant_id, &error.to_string())
                    .await;
            }
        };

        let mut events = session.subscribe();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let event_app = app.clone();
        let event_conversation_id = conversation_id.to_string();
        let event_message_id = assistant_id.clone();
        let event_task = tokio::spawn(async move {
            let mut pending = String::new();
            let mut last_flush = Instant::now();
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    event = events.recv() => {
                        let Ok(event) = event else { break };
                        if event.event_type.as_str() == "assistant.message_delta" {
                            if let Some(delta) = event.data.get("deltaContent").and_then(|value| value.as_str()) {
                                pending.push_str(delta);
                                let _ = event_app.emit(EVENT_DELTA, ChatDeltaEvent {
                                    conversation_id: event_conversation_id.clone(),
                                    message_id: event_message_id.clone(),
                                    delta: delta.to_string(),
                                });
                                if pending.len() >= 4096 || last_flush.elapsed() >= Duration::from_millis(250) {
                                    if let Ok(conn) = event_app.state::<DbState>().0.lock() {
                                        if let Err(error) = conn.execute(
                                            "UPDATE chat_messages SET content = content || ?1 WHERE id = ?2",
                                            params![pending, event_message_id],
                                        ) {
                                            eprintln!("[chat] could not persist streamed response: {error}");
                                        }
                                    } else {
                                        eprintln!("[chat] could not persist streamed response: db mutex poisoned");
                                    }
                                    pending.clear();
                                    last_flush = Instant::now();
                                }
                            }
                        }
                    }
                }
            }
            if !pending.is_empty() {
                if let Ok(conn) = event_app.state::<DbState>().0.lock() {
                    if let Err(error) = conn.execute(
                        "UPDATE chat_messages SET content = content || ?1 WHERE id = ?2",
                        params![pending, event_message_id],
                    ) {
                        eprintln!("[chat] could not persist streamed response: {error}");
                    }
                } else {
                    eprintln!("[chat] could not persist streamed response: db mutex poisoned");
                }
            }
        });

        let result = session
            .send_and_wait(MessageOptions::new(prompt).with_wait_timeout(Duration::from_secs(300)))
            .await;
        let _ = stop_tx.send(());
        let _ = event_task.await;

        match result {
            Ok(Some(event)) => {
                let content = event
                    .data
                    .get("content")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                if content.trim().is_empty() {
                    return self
                        .finish_error(
                            app,
                            db,
                            conversation_id,
                            &assistant_id,
                            "Copilot returned an empty response.",
                        )
                        .await;
                }
                let message = ChatMessage {
                    id: assistant_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    role: "assistant".to_string(),
                    content: content.clone(),
                    status: "completed".to_string(),
                    error: None,
                    created_at: created_at + 1,
                };
                {
                    let conn =
                        db.0.lock()
                            .map_err(|_| AppError::msg("db mutex poisoned"))?;
                    conn.execute(
                        "UPDATE chat_messages
                         SET content = ?1, status = 'completed', error = NULL
                         WHERE id = ?2",
                        params![content, assistant_id],
                    )?;
                }
                let _ = app.emit(
                    EVENT_COMPLETE,
                    ChatCompleteEvent {
                        conversation_id: conversation_id.to_string(),
                        message: message.clone(),
                    },
                );
                Ok(message)
            }
            Ok(None) => {
                self.finish_error(
                    app,
                    db,
                    conversation_id,
                    &assistant_id,
                    "Copilot completed without a response.",
                )
                .await
            }
            Err(error) => {
                let message = format!("Copilot SDK error: {error}");
                self.finish_error(app, db, conversation_id, &assistant_id, &message)
                    .await
            }
        }
    }

    async fn finish_error(
        &self,
        app: &AppHandle,
        db: &DbState,
        conversation_id: &str,
        message_id: &str,
        error: &str,
    ) -> AppResult<ChatMessage> {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        conn.execute(
            "UPDATE chat_messages SET status = 'error', error = ?1 WHERE id = ?2",
            params![error, message_id],
        )?;
        let _ = app.emit(
            EVENT_ERROR,
            ChatErrorEvent {
                conversation_id: conversation_id.to_string(),
                message_id: message_id.to_string(),
                error: error.to_string(),
            },
        );
        Err(AppError::msg(error))
    }

    async fn send(
        &self,
        app: &AppHandle,
        db: &DbState,
        conversation_id: &str,
        prompt: &str,
    ) -> AppResult<ChatMessage> {
        if prompt.trim().is_empty() {
            return Err(AppError::msg("Enter a message before sending."));
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(AppError::msg("Message is too large."));
        }
        self.reserve_conversation(
            conversation_id,
            "This conversation already has an operation in progress.",
        )?;
        let result = self
            .send_inner(app, db, conversation_id, prompt.trim())
            .await;
        self.release_conversation(conversation_id);
        result
    }

    pub async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        for session in sessions.into_values() {
            let _ = session.disconnect().await;
        }
        if let Some(client) = self.client.lock().await.take() {
            let _ = client.stop().await;
        }
    }
}

#[tauri::command]
pub fn chat_list_conversations(state: State<'_, DbState>) -> AppResult<Vec<ChatConversation>> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let mut stmt = conn.prepare(
        "SELECT id, title, sdk_session_id, context_kind, context_id, context_name,
                context_path, created_at, updated_at
         FROM chat_conversations ORDER BY updated_at DESC",
    )?;
    let conversations = stmt
        .query_map([], map_conversation)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(conversations)
}

#[tauri::command]
pub fn chat_create_conversation(
    context: Option<ChatContext>,
    state: State<'_, DbState>,
) -> AppResult<ChatConversation> {
    if let Some(value) = context.as_ref() {
        value.validate()?;
    }
    let now = now_ms();
    let conversation = ChatConversation {
        id: uuid::Uuid::new_v4().to_string(),
        title: "New chat".to_string(),
        sdk_session_id: None,
        context,
        created_at: now,
        updated_at: now,
    };
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    conn.execute(
        "INSERT INTO chat_conversations
           (id, title, sdk_session_id, context_kind, context_id, context_name,
            context_path, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            conversation.id,
            conversation.title,
            conversation.context.as_ref().map(|value| &value.kind),
            conversation.context.as_ref().map(|value| &value.id),
            conversation.context.as_ref().map(|value| &value.name),
            conversation.context.as_ref().map(|value| &value.path),
            conversation.created_at,
            conversation.updated_at
        ],
    )?;
    Ok(conversation)
}

#[tauri::command]
pub async fn chat_update_context(
    conversation_id: String,
    context: Option<ChatContext>,
    state: State<'_, DbState>,
    manager: State<'_, ChatManager>,
) -> AppResult<ChatConversation> {
    if let Some(value) = context.as_ref() {
        value.validate()?;
    }
    manager.reserve_conversation(
        &conversation_id,
        "Wait for the current operation before changing context.",
    )?;
    let result = async {
        manager.reset_session(&conversation_id).await;
        let conn = state
            .0
            .lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
        conn.execute(
            "UPDATE chat_conversations
             SET context_kind = ?1, context_id = ?2, context_name = ?3, context_path = ?4,
                 updated_at = ?5
             WHERE id = ?6",
            params![
                context.as_ref().map(|value| &value.kind),
                context.as_ref().map(|value| &value.id),
                context.as_ref().map(|value| &value.name),
                context.as_ref().map(|value| &value.path),
                now_ms(),
                conversation_id
            ],
        )?;
        load_conversation(&conn, &conversation_id)
    }
    .await;
    manager.release_conversation(&conversation_id);
    result
}

#[tauri::command]
pub async fn chat_delete_conversation(
    conversation_id: String,
    state: State<'_, DbState>,
    manager: State<'_, ChatManager>,
) -> AppResult<()> {
    manager.reserve_conversation(
        &conversation_id,
        "Stop the current operation before deleting this conversation.",
    )?;
    let result = async {
        manager.reset_session(&conversation_id).await;
        let sdk_session_id = {
            let conn = state
                .0
                .lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
            let conversation = load_conversation(&conn, &conversation_id)?;
            conversation.sdk_session_id
        };
        if let Some(id) = sdk_session_id {
            let client = manager.client().await?;
            client
                .delete_session(&SessionId::new(id))
                .await
                .map_err(map_sdk_error)?;
        }
        let conn = state
            .0
            .lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
        conn.execute(
            "DELETE FROM chat_conversations WHERE id = ?1",
            [&conversation_id],
        )?;
        Ok(())
    }
    .await;
    manager.release_conversation(&conversation_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_is_compact_and_preserves_short_prompts() {
        assert_eq!(
            message_title("  explain   this code  "),
            "explain this code"
        );
        let title = message_title(
            "Explain why this repository uses worktrees and how the current branch is selected",
        );
        assert_eq!(title.chars().count(), 52);
        assert!(title.ends_with('…'));
    }
}

#[tauri::command]
pub fn chat_list_messages(
    conversation_id: String,
    state: State<'_, DbState>,
) -> AppResult<Vec<ChatMessage>> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    load_conversation(&conn, &conversation_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, status, error, created_at
         FROM chat_messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
    )?;
    let messages = stmt
        .query_map([conversation_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                status: row.get(4)?,
                error: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(messages)
}

#[tauri::command]
pub async fn chat_send(
    conversation_id: String,
    prompt: String,
    app: AppHandle,
    state: State<'_, DbState>,
    manager: State<'_, ChatManager>,
) -> AppResult<ChatMessage> {
    manager.send(&app, &state, &conversation_id, &prompt).await
}

#[tauri::command]
pub async fn chat_abort(conversation_id: String, manager: State<'_, ChatManager>) -> AppResult<()> {
    let session = manager
        .sessions
        .lock()
        .await
        .get(&conversation_id)
        .cloned()
        .ok_or_else(|| AppError::msg("No active response to stop."))?;
    session.abort().await.map_err(map_sdk_error)
}
