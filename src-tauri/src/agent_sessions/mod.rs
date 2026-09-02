mod handlers;
mod policy;
mod reducer;
mod store;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use github_copilot_sdk::session::Session;
use github_copilot_sdk::types::{
    MessageOptions, ResumeSessionConfig, SessionConfig, SessionEvent, SessionId,
    SystemMessageConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::copilot_runtime::CopilotRuntime;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

use handlers::{
    HarnessPermissionHandler, HarnessUserInputHandler, PendingRegistry, PermissionResolution,
    UserInputResolution,
};

pub const EVENT_UPDATE: &str = "agent-sessions:update";
pub const EVENT_INTERACTION: &str = "agent-sessions:interaction";
const MAX_PROMPT_BYTES: usize = 200_000;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn system_message(purpose: AgentSessionPurpose) -> SystemMessageConfig {
    if purpose.is_pr_review() {
        SystemMessageConfig::new().with_content(
            "You are reviewing a pull request inside DevTrees. Inspect the repository and \
             return a concise, evidence-based review. Do not modify files, branches, remotes, \
             pull requests, or external systems. Use only local read and shell tools; do not use \
             URL, web, MCP, or custom tools. If a tool is unavailable or denied, continue with \
             the evidence already collected and clearly report the limitation.",
        )
    } else {
        SystemMessageConfig::new().with_content(
            "You are the coding agent inside DevTrees. Work in the selected repository, \
             communicate progress clearly, and request permission before risky or mutating \
             operations.",
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionPurpose {
    PrReview,
    Interactive,
}

impl AgentSessionPurpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::PrReview => "pr_review",
            Self::Interactive => "interactive",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "pr_review" => Self::PrReview,
            _ => Self::Interactive,
        }
    }

    pub fn is_pr_review(self) -> bool {
        self == Self::PrReview
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionLifecycle {
    Initializing,
    Active,
    Idle,
    WaitingForUser,
    WaitingForPermission,
    Failed,
    Stopped,
}

impl AgentSessionLifecycle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::Active => "active",
            Self::Idle => "idle",
            Self::WaitingForUser => "waiting_for_user",
            Self::WaitingForPermission => "waiting_for_permission",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "initializing" => Self::Initializing,
            "active" => Self::Active,
            "waiting_for_user" => Self::WaitingForUser,
            "waiting_for_permission" => Self::WaitingForPermission,
            "failed" => Self::Failed,
            "stopped" => Self::Stopped,
            _ => Self::Idle,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionActivity {
    None,
    Intent,
    Reasoning,
    StreamingMessage,
    RunningTool,
}

impl AgentSessionActivity {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Intent => "intent",
            Self::Reasoning => "reasoning",
            Self::StreamingMessage => "streaming_message",
            Self::RunningTool => "running_tool",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "intent" => Self::Intent,
            "reasoning" => Self::Reasoning,
            "streaming_message" => Self::StreamingMessage,
            "running_tool" => Self::RunningTool,
            _ => Self::None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdk_session_id: Option<String>,
    pub purpose: AgentSessionPurpose,
    pub label: String,
    pub folder_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_title: Option<String>,
    pub lifecycle: AgentSessionLifecycle,
    pub activity: AgentSessionActivity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub last_seq: i64,
}

impl AgentSession {
    fn new(request: CreateAgentSessionRequest) -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            sdk_session_id: request.resume_sdk_session_id,
            purpose: request.purpose,
            label: request.label,
            folder_path: request.folder_path,
            branch: request.branch,
            repository: request.repository,
            provider: request.provider,
            pr_id: request.pr_id,
            pr_title: request.pr_title,
            lifecycle: AgentSessionLifecycle::Initializing,
            activity: AgentSessionActivity::None,
            current_intent: None,
            last_error: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
            last_seq: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionEvent {
    pub session_id: String,
    pub seq: i64,
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub ephemeral: bool,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequest {
    pub id: String,
    pub session_id: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub description: String,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputRequest {
    pub id: String,
    pub session_id: String,
    pub request_id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    pub allow_freeform: bool,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentPendingInteraction {
    Permission(AgentPermissionRequest),
    UserInput(AgentUserInputRequest),
}

impl AgentPendingInteraction {
    fn id(&self) -> &str {
        match self {
            Self::Permission(value) => &value.id,
            Self::UserInput(value) => &value.id,
        }
    }

    fn session_id(&self) -> &str {
        match self {
            Self::Permission(value) => &value.session_id,
            Self::UserInput(value) => &value.session_id,
        }
    }

    fn request_id(&self) -> &str {
        match self {
            Self::Permission(value) => &value.request_id,
            Self::UserInput(value) => &value.request_id,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Permission(_) => "permission",
            Self::UserInput(_) => "user_input",
        }
    }

    fn created_at(&self) -> i64 {
        match self {
            Self::Permission(value) => value.created_at,
            Self::UserInput(value) => value.created_at,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSessionRequest {
    pub purpose: AgentSessionPurpose,
    pub folder_path: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub resume_sdk_session_id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub pr_id: Option<String>,
    #[serde(default)]
    pub pr_title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSessionResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<AgentSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSnapshot {
    pub session: AgentSession,
    pub events: Vec<AgentSessionEvent>,
    pub pending_interactions: Vec<AgentPendingInteraction>,
    pub last_seq: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUpdate {
    pub session: AgentSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<AgentSessionEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePermissionRequest {
    pub session_id: String,
    pub interaction_id: String,
    pub decision: String,
    #[serde(default)]
    pub feedback: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerUserInputRequest {
    pub session_id: String,
    pub interaction_id: String,
    pub answer: String,
    pub was_freeform: bool,
}

struct LiveSession {
    sdk: Arc<Session>,
}

#[derive(Default)]
pub struct AgentSessionManager {
    live: AsyncMutex<HashMap<String, LiveSession>>,
    pending: Arc<PendingRegistry>,
    sending: Mutex<HashSet<String>>,
}

impl AgentSessionManager {
    fn reserve_send(&self, id: &str) -> AppResult<()> {
        let mut sending = self
            .sending
            .lock()
            .map_err(|_| AppError::msg("agent session state mutex poisoned"))?;
        if !sending.insert(id.to_string()) {
            return Err(AppError::msg(
                "Wait for the current Copilot turn before sending another message.",
            ));
        }
        Ok(())
    }

    fn release_send(&self, id: &str) {
        if let Ok(mut sending) = self.sending.lock() {
            sending.remove(id);
        }
    }

    async fn create(
        &self,
        app: &AppHandle,
        db: &DbState,
        runtime: &CopilotRuntime,
        mut request: CreateAgentSessionRequest,
    ) -> AppResult<AgentSession> {
        request.folder_path = request.folder_path.trim().to_string();
        request.label = request.label.trim().to_string();
        request.prompt = request
            .prompt
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if request.folder_path.is_empty() || !std::path::Path::new(&request.folder_path).is_dir() {
            return Err(AppError::msg(
                "The agent session working directory does not exist.",
            ));
        }
        if request.label.is_empty() {
            request.label = "Copilot".to_string();
        }
        if request
            .prompt
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PROMPT_BYTES)
        {
            return Err(AppError::msg("prompt is too large."));
        }

        {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            if request.purpose.is_pr_review() {
                if let (Some(provider), Some(pr_id)) =
                    (request.provider.as_deref(), request.pr_id.as_deref())
                {
                    if let Some(existing) =
                        store::find_review_session(&conn, &request.folder_path, provider, pr_id)?
                    {
                        return Ok(existing);
                    }
                }
            }
            if let Some(sdk_id) = request.resume_sdk_session_id.as_deref() {
                if let Some(existing) = store::find_session_by_sdk_id(&conn, sdk_id)? {
                    return Ok(existing);
                }
            }
        }

        let prompt = request.prompt.clone();
        let mut session = AgentSession::new(request);
        {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            store::insert_session(&conn, &session)?;
        }

        let client = runtime.client().await?;
        let permission_handler = Arc::new(HarnessPermissionHandler::new(
            app.clone(),
            session.id.clone(),
            session.purpose,
            PathBuf::from(&session.folder_path),
            self.pending.clone(),
        ));
        let user_input_handler = Arc::new(HarnessUserInputHandler::new(
            app.clone(),
            session.id.clone(),
            session.purpose,
            self.pending.clone(),
        ));
        let created = if let Some(sdk_id) = session.sdk_session_id.clone() {
            client
                .resume_session(
                    ResumeSessionConfig::new(SessionId::new(sdk_id))
                        .with_client_name("DevTrees")
                        .with_streaming(true)
                        .with_working_directory(&session.folder_path)
                        .with_system_message(system_message(session.purpose))
                        .with_permission_handler(permission_handler)
                        .with_user_input_handler(user_input_handler),
                )
                .await
        } else {
            client
                .create_session(
                    SessionConfig::default()
                        .with_client_name("DevTrees")
                        .with_streaming(true)
                        .with_working_directory(&session.folder_path)
                        .with_system_message(system_message(session.purpose))
                        .with_permission_handler(permission_handler)
                        .with_user_input_handler(user_input_handler),
                )
                .await
        };

        let sdk = match created {
            Ok(value) => Arc::new(value),
            Err(error) => {
                mark_failed(app, &session.id, &format!("Copilot SDK error: {error}"))?;
                return Err(AppError::msg(format!("Copilot SDK error: {error}")));
            }
        };
        session.sdk_session_id = Some(sdk.id().to_string());
        session.updated_at = now_ms();
        {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            store::update_session(&conn, &session)?;
        }

        let events = start_event_stream(app, &session.id, &sdk).await?;
        self.live
            .lock()
            .await
            .insert(session.id.clone(), LiveSession { sdk: sdk.clone() });
        spawn_event_loop(app.clone(), session.id.clone(), sdk.clone(), events);
        emit_update(app, session.clone(), None);

        if let Some(prompt) = prompt {
            if let Err(error) = sdk.send(MessageOptions::new(prompt)).await {
                mark_failed(app, &session.id, &format!("Copilot SDK error: {error}"))?;
                return Err(AppError::msg(format!("Copilot SDK error: {error}")));
            }
        } else {
            session.lifecycle = AgentSessionLifecycle::Idle;
            session.updated_at = now_ms();
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            store::update_session(&conn, &session)?;
            emit_update(app, session.clone(), None);
        }

        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        store::load_session(&conn, &session.id)
    }

    async fn ensure_live(
        &self,
        app: &AppHandle,
        runtime: &CopilotRuntime,
        session: &AgentSession,
    ) -> AppResult<Arc<Session>> {
        if let Some(sdk) = self
            .live
            .lock()
            .await
            .get(&session.id)
            .map(|value| value.sdk.clone())
        {
            return Ok(sdk);
        }
        let sdk_id = session
            .sdk_session_id
            .as_ref()
            .ok_or_else(|| AppError::msg("This agent session has no SDK session id."))?;
        let permission_handler = Arc::new(HarnessPermissionHandler::new(
            app.clone(),
            session.id.clone(),
            session.purpose,
            PathBuf::from(&session.folder_path),
            self.pending.clone(),
        ));
        let user_input_handler = Arc::new(HarnessUserInputHandler::new(
            app.clone(),
            session.id.clone(),
            session.purpose,
            self.pending.clone(),
        ));
        let sdk = Arc::new(
            runtime
                .client()
                .await?
                .resume_session(
                    ResumeSessionConfig::new(SessionId::new(sdk_id.clone()))
                        .with_client_name("DevTrees")
                        .with_streaming(true)
                        .with_working_directory(&session.folder_path)
                        .with_system_message(system_message(session.purpose))
                        .with_permission_handler(permission_handler)
                        .with_user_input_handler(user_input_handler),
                )
                .await
                .map_err(|error| AppError::msg(format!("Copilot SDK error: {error}")))?,
        );
        let events = start_event_stream(app, &session.id, &sdk).await?;
        self.live
            .lock()
            .await
            .insert(session.id.clone(), LiveSession { sdk: sdk.clone() });
        spawn_event_loop(app.clone(), session.id.clone(), sdk.clone(), events);
        Ok(sdk)
    }

    async fn send(
        &self,
        app: &AppHandle,
        db: &DbState,
        runtime: &CopilotRuntime,
        id: &str,
        prompt: &str,
    ) -> AppResult<()> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(AppError::msg("Enter a message before sending."));
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(AppError::msg("Message is too large."));
        }
        self.reserve_send(id)?;
        let result = self.send_inner(app, db, runtime, id, prompt).await;
        self.release_send(id);
        result
    }

    async fn send_inner(
        &self,
        app: &AppHandle,
        db: &DbState,
        runtime: &CopilotRuntime,
        id: &str,
        prompt: &str,
    ) -> AppResult<()> {
        let current = {
            let conn =
                db.0.lock()
                    .map_err(|_| AppError::msg("db mutex poisoned"))?;
            store::load_session(&conn, id)?
        };
        if current.lifecycle != AgentSessionLifecycle::Idle {
            return Err(AppError::msg(
                "Wait for the current Copilot turn before sending another message.",
            ));
        }
        let sdk = self.ensure_live(app, runtime, &current).await?;
        set_lifecycle(app, id, AgentSessionLifecycle::Active)?;
        if let Err(error) = sdk.send(MessageOptions::new(prompt)).await {
            mark_failed(app, id, &format!("Copilot SDK error: {error}"))?;
            return Err(AppError::msg(format!("Copilot SDK error: {error}")));
        }
        Ok(())
    }

    async fn abort(&self, id: &str) -> AppResult<()> {
        let sdk = self
            .live
            .lock()
            .await
            .get(id)
            .map(|value| value.sdk.clone())
            .ok_or_else(|| AppError::msg("Agent session is not connected."))?;
        sdk.abort()
            .await
            .map_err(|error| AppError::msg(format!("Copilot SDK error: {error}")))
    }

    async fn close(&self, app: &AppHandle, id: &str) -> AppResult<()> {
        cancel_session_interactions(app, id, &self.pending)?;
        self.release_send(id);
        let mut disconnect_error = None;
        if let Some(live) = self.live.lock().await.remove(id) {
            let _ = live.sdk.abort().await;
            if let Err(error) = live.sdk.disconnect().await {
                disconnect_error = Some(AppError::msg(format!("Copilot SDK error: {error}")));
            }
        }
        set_lifecycle(app, id, AgentSessionLifecycle::Stopped)?;
        disconnect_error.map_or(Ok(()), Err)
    }

    pub async fn shutdown(&self) {
        self.pending.cancel_all();
        let sessions = std::mem::take(&mut *self.live.lock().await);
        for session in sessions.into_values() {
            let _ = session.sdk.abort().await;
            let _ = session.sdk.disconnect().await;
        }
    }
}

fn cancel_session_interactions(
    app: &AppHandle,
    session_id: &str,
    pending: &PendingRegistry,
) -> AppResult<()> {
    let db = app.state::<DbState>();
    let conn =
        db.0.lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let mut stmt =
        conn.prepare("SELECT id FROM agent_pending_interactions WHERE session_id = ?1")?;
    let ids = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    conn.execute(
        "DELETE FROM agent_pending_interactions WHERE session_id = ?1",
        [session_id],
    )?;
    pending.cancel(&ids);
    Ok(())
}

fn spawn_event_loop(
    app: AppHandle,
    session_id: String,
    sdk: Arc<Session>,
    mut events: github_copilot_sdk::subscription::EventSubscription,
) {
    tauri::async_runtime::spawn(async move {
        let mut recovery_attempted = false;
        loop {
            match events.recv().await {
                Ok(event) => {
                    recovery_attempted = false;
                    if let Err(error) = apply_sdk_event(&app, &session_id, event) {
                        eprintln!("[agent-session] could not apply SDK event: {error}");
                    }
                }
                Err(error) if !recovery_attempted => {
                    recovery_attempted = true;
                    eprintln!("[agent-session] SDK event stream interrupted: {error}");
                    match sdk.get_events().await {
                        Ok(history) => {
                            for event in history {
                                if let Err(error) = apply_history_event(&app, &session_id, event) {
                                    eprintln!(
                                        "[agent-session] could not recover SDK event: {error}"
                                    );
                                }
                            }
                            events = sdk.subscribe();
                        }
                        Err(error) => {
                            let _ = mark_failed(
                                &app,
                                &session_id,
                                &format!("Copilot SDK event stream failed: {error}"),
                            );
                            break;
                        }
                    }
                }
                Err(error) => {
                    let _ = mark_failed(
                        &app,
                        &session_id,
                        &format!("Copilot SDK event stream failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

async fn start_event_stream(
    app: &AppHandle,
    session_id: &str,
    sdk: &Session,
) -> AppResult<github_copilot_sdk::subscription::EventSubscription> {
    let events = sdk.subscribe();
    let history = sdk
        .get_events()
        .await
        .map_err(|error| AppError::msg(format!("Copilot SDK error: {error}")))?;
    for event in history {
        apply_history_event(app, session_id, event)?;
    }
    Ok(events)
}

fn apply_history_event(app: &AppHandle, session_id: &str, event: SessionEvent) -> AppResult<()> {
    if event.ephemeral.unwrap_or(false) {
        return Ok(());
    }
    apply_sdk_event(app, session_id, event)
}

fn apply_sdk_event(app: &AppHandle, session_id: &str, event: SessionEvent) -> AppResult<()> {
    let db = app.state::<DbState>();
    let mut session;
    let projected;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        if !event.ephemeral.unwrap_or(false) {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_session_events WHERE event_id = ?1)",
                [&event.id],
                |row| row.get(0),
            )?;
            if exists {
                return Ok(());
            }
        }
        let tx = conn.unchecked_transaction()?;
        session = store::load_session(&tx, session_id)?;
        session.last_seq += 1;
        reducer::reduce(&mut session, &event);
        projected = AgentSessionEvent {
            session_id: session_id.to_string(),
            seq: session.last_seq,
            id: event.id,
            event_type: event.event_type,
            timestamp: event.timestamp,
            parent_id: event.parent_id,
            agent_id: event.agent_id,
            ephemeral: event.ephemeral.unwrap_or(false),
            data: event.data,
        };
        store::update_session(&tx, &session)?;
        if !projected.ephemeral {
            store::insert_event(&tx, &projected)?;
        }
        tx.commit()?;
    }
    emit_update(app, session, Some(projected));
    Ok(())
}

fn emit_update(app: &AppHandle, session: AgentSession, event: Option<AgentSessionEvent>) {
    let _ = app.emit(EVENT_UPDATE, AgentSessionUpdate { session, event });
}

fn set_lifecycle(
    app: &AppHandle,
    session_id: &str,
    lifecycle: AgentSessionLifecycle,
) -> AppResult<AgentSession> {
    let db = app.state::<DbState>();
    let mut session;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        session = store::load_session(&conn, session_id)?;
        session.lifecycle = lifecycle;
        session.updated_at = now_ms();
        if lifecycle != AgentSessionLifecycle::Active {
            session.activity = AgentSessionActivity::None;
            session.current_intent = None;
        }
        store::update_session(&conn, &session)?;
    }
    emit_update(app, session.clone(), None);
    Ok(session)
}

fn mark_failed(app: &AppHandle, session_id: &str, error: &str) -> AppResult<AgentSession> {
    let db = app.state::<DbState>();
    let mut session;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        session = store::load_session(&conn, session_id)?;
        if session.lifecycle == AgentSessionLifecycle::Stopped {
            return Ok(session);
        }
        session.lifecycle = AgentSessionLifecycle::Failed;
        session.activity = AgentSessionActivity::None;
        session.current_intent = None;
        session.last_error = Some(error.to_string());
        session.completed_at = Some(now_ms());
        session.updated_at = session.completed_at.unwrap_or(session.updated_at);
        store::update_session(&conn, &session)?;
    }
    emit_update(app, session.clone(), None);
    Ok(session)
}

fn start_interaction(
    app: &AppHandle,
    interaction: &AgentPendingInteraction,
    lifecycle: AgentSessionLifecycle,
) -> AppResult<()> {
    let db = app.state::<DbState>();
    let mut session;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        store::insert_interaction(&conn, interaction)?;
        session = store::load_session(&conn, interaction.session_id())?;
        session.lifecycle = lifecycle;
        session.activity = AgentSessionActivity::None;
        session.updated_at = now_ms();
        store::update_session(&conn, &session)?;
    }
    emit_update(app, session, None);
    Ok(())
}

fn finish_interaction(app: &AppHandle, session_id: &str, interaction_id: &str) -> AppResult<()> {
    let db = app.state::<DbState>();
    let mut session;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::msg("db mutex poisoned"))?;
        store::remove_interaction(&conn, interaction_id)?;
        session = store::load_session(&conn, session_id)?;
        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_pending_interactions WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        if pending == 0
            && matches!(
                session.lifecycle,
                AgentSessionLifecycle::WaitingForUser | AgentSessionLifecycle::WaitingForPermission
            )
        {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.updated_at = now_ms();
            store::update_session(&conn, &session)?;
        }
    }
    emit_update(app, session, None);
    Ok(())
}

#[tauri::command]
pub async fn agent_sessions_create(
    req: CreateAgentSessionRequest,
    app: AppHandle,
    db: State<'_, DbState>,
    runtime: State<'_, CopilotRuntime>,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<CreateAgentSessionResponse> {
    Ok(match manager.create(&app, &db, &runtime, req).await {
        Ok(session) => CreateAgentSessionResponse {
            ok: true,
            session: Some(session),
            error: None,
        },
        Err(error) => CreateAgentSessionResponse {
            ok: false,
            session: None,
            error: Some(error.to_string()),
        },
    })
}

#[tauri::command]
pub fn agent_sessions_list(db: State<'_, DbState>) -> AppResult<Vec<AgentSession>> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
    store::list_sessions(&conn)
}

#[tauri::command]
pub fn agent_sessions_snapshot(
    id: String,
    db: State<'_, DbState>,
) -> AppResult<AgentSessionSnapshot> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let session = store::load_session(&conn, &id)?;
    let events = store::load_events(&conn, &id)?;
    let pending_interactions = store::load_interactions(&conn, &id)?;
    Ok(AgentSessionSnapshot {
        last_seq: session.last_seq,
        session,
        events,
        pending_interactions,
    })
}

#[tauri::command]
pub async fn agent_sessions_send(
    id: String,
    prompt: String,
    app: AppHandle,
    db: State<'_, DbState>,
    runtime: State<'_, CopilotRuntime>,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<()> {
    manager.send(&app, &db, &runtime, &id, &prompt).await
}

#[tauri::command]
pub async fn agent_sessions_abort(
    id: String,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<()> {
    manager.abort(&id).await
}

#[tauri::command]
pub async fn agent_sessions_close(
    id: String,
    app: AppHandle,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<()> {
    manager.close(&app, &id).await
}

#[tauri::command]
pub fn agent_sessions_resolve_permission(
    req: ResolvePermissionRequest,
    app: AppHandle,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<()> {
    if !handlers::interaction_belongs_to_session(&app, &req.interaction_id, &req.session_id) {
        return Err(AppError::msg("Permission request is no longer pending."));
    }
    let approve = match req.decision.as_str() {
        "approve_once" => true,
        "reject" => false,
        _ => return Err(AppError::msg("Invalid permission decision.")),
    };
    manager
        .pending
        .resolve_permission(
            &req.interaction_id,
            PermissionResolution {
                approve,
                feedback: req.feedback,
            },
        )
        .map_err(|_| AppError::msg("Permission request is no longer pending."))
}

#[tauri::command]
pub fn agent_sessions_answer_user_input(
    req: AnswerUserInputRequest,
    app: AppHandle,
    manager: State<'_, AgentSessionManager>,
) -> AppResult<()> {
    if req.answer.trim().is_empty() {
        return Err(AppError::msg("Enter an answer before continuing."));
    }
    if !handlers::interaction_belongs_to_session(&app, &req.interaction_id, &req.session_id) {
        return Err(AppError::msg("User input request is no longer pending."));
    }
    manager
        .pending
        .resolve_user_input(
            &req.interaction_id,
            UserInputResolution {
                answer: req.answer,
                was_freeform: req.was_freeform,
            },
        )
        .map_err(|_| AppError::msg("User input request is no longer pending."))
}
