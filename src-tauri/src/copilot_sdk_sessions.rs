use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use github_copilot_sdk::{
    handler::{
        AutoModeSwitchHandler, AutoModeSwitchResponse, ElicitationHandler, ExitPlanModeHandler,
        ExitPlanModeResult, PermissionHandler, PermissionResult, UserInputHandler,
        UserInputResponse,
    },
    rpc::PermissionDecision,
    session::Session,
    AskUserVariant, CliProgram, Client, ClientOptions, ElicitationMode, ElicitationRequest,
    ElicitationResult, ExitPlanModeData, PermissionRequestData, RequestId, ResumeSessionConfig,
    SessionConfig, SessionEvent, SessionId, Transport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::{
    error::{AppError, AppResult},
    session_interactions::{
        check_schema, InteractionAnswer, InteractionRequest, NativeInteraction,
    },
    terminal_sessions::{
        self, StartTerminalSessionRequest, TerminalSession, TerminalSessionResult,
        TerminalSessionStatus as Status, TerminalTimelineEntry as Entry,
    },
};

const EVENT: &str = "native-sessions:update";
const MAX_ENTRIES: usize = 500;

#[cfg(test)]
mod tests;

fn error(value: impl std::fmt::Display) -> AppError {
    AppError::msg(value.to_string())
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn short(text: &str) -> String {
    if text.chars().count() > 8_000 {
        format!(
            "{}... [truncated; full text is in the saved Copilot history]",
            text.chars().take(8_000).collect::<String>()
        )
    } else {
        text.into()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub session: TerminalSession,
    pub interactions: Vec<NativeInteraction>,
    pub entries: Vec<Entry>,
    pub history_truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct NativeTarget {
    pub id: String,
    pub generation: String,
}

struct Pending {
    interaction: NativeInteraction,
    response: oneshot::Sender<InteractionAnswer>,
}

struct State {
    session: TerminalSession,
    base_status: Status,
    pending: BTreeMap<u64, Pending>,
    next_request: u64,
    entries: VecDeque<Entry>,
    next_seq: u64,
    message_sequences: HashMap<String, u64>,
    error: Option<String>,
    dirty: bool,
    history_truncated: bool,
}

impl State {
    fn enqueue(
        &mut self,
        request: InteractionRequest,
    ) -> (u64, oneshot::Receiver<InteractionAnswer>) {
        let (tx, rx) = oneshot::channel();
        self.next_request += 1;
        let key = self.next_request;
        self.pending.insert(
            key,
            Pending {
                interaction: NativeInteraction {
                    id: uuid::Uuid::new_v4().to_string(),
                    created_at: now(),
                    request,
                },
                response: tx,
            },
        );
        self.changed();
        (key, rx)
    }

    fn respond(&mut self, id: &str, answer: InteractionAnswer) -> AppResult<()> {
        let key = self
            .pending
            .iter()
            .find(|(_, pending)| pending.interaction.id == id)
            .map(|(key, _)| *key)
            .ok_or_else(|| error("This request was already answered or cancelled."))?;
        self.pending[&key].interaction.request.validate(&answer)?;
        let pending = self
            .pending
            .remove(&key)
            .ok_or_else(|| error("This request is no longer pending."))?;
        self.changed();
        pending.response.send(answer).map_err(|_| error("Copilot stopped waiting before the response was delivered. Do not retry this request."))
    }

    fn snapshot(&self) -> NativeSnapshot {
        NativeSnapshot {
            session: self.session.clone(),
            interactions: self
                .pending
                .values()
                .map(|p| p.interaction.clone())
                .collect(),
            entries: self.entries.iter().cloned().collect(),
            history_truncated: self.history_truncated,
            error: self.error.clone(),
        }
    }

    fn changed(&mut self) {
        self.session.status = if self.pending.is_empty() {
            self.base_status
        } else {
            Status::WaitingInput
        };
        self.session.pending_prompt = self
            .pending
            .values()
            .next()
            .map(|p| short(p.interaction.request.message()));
        self.session.updated_at = now();
        self.session.revision += 1;
        self.dirty = true;
    }

    fn push(&mut self, entry: Entry) {
        self.entries.push_back(entry);
        while self.entries.len() > MAX_ENTRIES {
            self.entries.pop_front();
            self.history_truncated = true;
        }
        let floor = self.entries.front().map_or(0, Entry::seq);
        self.message_sequences.retain(|_, seq| *seq >= floor);
    }

    fn finish_open_tools(&mut self, message: &str) {
        for entry in &mut self.entries {
            if let Entry::ToolCall {
                success, result, ..
            } = entry
            {
                if success.is_none() {
                    *success = Some(false);
                    *result = Some(message.into());
                }
            }
        }
    }

    fn ingest(&mut self, event: SessionEvent) {
        if self.base_status == Status::Done {
            return;
        }
        let data = &event.data;
        let text = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or("");
        let timestamp = Some(event.timestamp.clone());
        let seq = self.next_seq;
        self.next_seq += 1;
        match event.event_type.as_str() {
            "user.message" => self.push(Entry::UserMessage { seq, timestamp, text: text("content").into() }),
            "assistant.message" | "assistant.message_delta" => {
                let delta = event.event_type == "assistant.message_delta";
                let content = text(if delta { "deltaContent" } else { "content" });
                if content.is_empty() { return; }
                let id = data.get("messageId").and_then(Value::as_str).unwrap_or(&event.id);
                let existing = self.message_sequences.get(id).copied();
                if let Some(Entry::AssistantMessage { text, .. }) = existing.and_then(|target| {
                    self.entries.iter_mut().find(|entry| entry.seq() == target)
                }) {
                    if delta { text.push_str(content); } else { *text = content.into(); }
                } else {
                    self.message_sequences.insert(id.into(), seq);
                    self.push(Entry::AssistantMessage { seq, timestamp, text: content.into() });
                }
                self.session.last_activity = "Copilot is responding".into();
            }
            "tool.execution_start" => {
                self.session.last_activity = format!("Running {}", text("toolName"));
                self.push(Entry::ToolCall {
                    seq, timestamp, tool_call_id: text("toolCallId").into(),
                    name: text("toolName").into(),
                    detail: short(&data.get("arguments").map(Value::to_string).unwrap_or_default()),
                    success: None, result: None,
                });
            }
            "tool.execution_complete" => {
                if let Some(Entry::ToolCall { success, result, .. }) = self.entries.iter_mut().find(|entry| {
                    matches!(entry, Entry::ToolCall { tool_call_id, .. } if tool_call_id == text("toolCallId"))
                }) {
                    *success = data.get("success").and_then(Value::as_bool);
                    *result = data.get("result").or_else(|| data.get("error")).map(|value| {
                        short(value.get("content").and_then(Value::as_str).or_else(|| value.as_str())
                            .map(str::to_owned).unwrap_or_else(|| value.to_string()).as_str())
                    });
                }
            }
            "session.idle" => {
                self.finish_open_tools("The turn ended without a tool completion result.");
                self.base_status = Status::Idle;
                self.session.last_activity = "Waiting for your next instruction".into();
            }
            "assistant.turn_start" if data.get("parentToolCallId").is_none_or(Value::is_null) => { self.base_status = Status::Working; }
            "session.error" => {
                self.error = Some(short(text("message")));
                self.finish_open_tools("The turn ended with an error.");
                self.session.last_activity = "Copilot could not complete the turn".into();
                self.base_status = Status::Idle;
            }
            _ => return,
        }
        self.changed();
    }
}

struct Managed {
    app: AppHandle,
    state: Mutex<State>,
    publication: Mutex<()>,
    runtime: tokio::sync::Mutex<Option<(Arc<Client>, Option<Arc<Session>>)>>,
    process_id: Mutex<Option<u32>>,
    lifecycle: tokio::sync::Mutex<()>,
    stopping: AtomicBool,
    cancelling: AtomicBool,
    stop_requested: tokio::sync::Notify,
}

impl Managed {
    fn publish(&self) -> AppResult<NativeSnapshot> {
        // State changes can race; serialize snapshot capture and event publication together.
        let _publication = self.publication.lock().map_err(error)?;
        let snapshot = {
            let mut state = self.state.lock().map_err(error)?;
            state.dirty = false;
            state.snapshot()
        };
        terminal_sessions::publish_native_session(&self.app, &snapshot.session)?;
        self.app.emit(EVENT, &snapshot).map_err(error)?;
        Ok(snapshot)
    }

    fn fail(&self, message: String) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_requested.notify_one();
        if let Ok(mut state) = self.state.lock() {
            state.pending.clear();
            // Keep ownership reserved until End has confirmed runtime shutdown.
            state.base_status = Status::Working;
            state.error = Some(message.clone());
            state.session.last_activity = short(&message);
            state.changed();
        }
        if let Err(e) = self.publish() {
            eprintln!("[native sessions] {e}");
        }
    }

    async fn ask(self: &Arc<Self>, request: InteractionRequest) -> InteractionAnswer {
        let (key, rx) = match self.state.lock() {
            Ok(mut state)
                if !self.stopping.load(Ordering::SeqCst)
                    && !self.cancelling.load(Ordering::SeqCst) =>
            {
                state.enqueue(request)
            }
            _ => return InteractionAnswer::Cancel,
        };
        let _guard = RequestGuard {
            owner: self.clone(),
            key,
        };
        if let Err(e) = self.publish() {
            self.fail(format!("Could not display Copilot's request: {e}"));
            return InteractionAnswer::Cancel;
        }
        match rx.await {
            Ok(answer) => answer,
            Err(_) => InteractionAnswer::Cancel,
        }
    }

    fn clear_requests(&self) -> AppResult<()> {
        let pending = {
            let mut state = self.state.lock().map_err(error)?;
            let pending = std::mem::take(&mut state.pending);
            state.changed();
            pending
        };
        for (_, request) in pending {
            if request.response.send(InteractionAnswer::Cancel).is_err() {
                eprintln!("[native sessions] request ended before cancellation was delivered");
            }
        }
        self.publish()?;
        Ok(())
    }

    async fn end(&self) -> AppResult<()> {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_requested.notify_one();
        if self.state.lock().map_err(error)?.base_status == Status::Done {
            return Ok(());
        }
        let cleared = self.clear_requests();
        let _lifecycle = self.lifecycle.lock().await;
        let runtime = self.runtime.lock().await.take();
        if let Some((client, session)) = runtime {
            if let Some(session) = &session {
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(5), session.disconnect()).await,
                    Ok(Ok(()))
                ) {
                    eprintln!(
                        "[native sessions] disconnect did not complete cleanly; stopping runtime"
                    );
                }
            }
            let stopped = tokio::time::timeout(Duration::from_secs(15), client.stop()).await;
            if stopped.is_err() {
                client.force_stop();
            }
            let stopped = stopped
                .map_err(error)
                .and_then(|result| result.map_err(error));
            if let Err(e) = stopped {
                *self.runtime.lock().await = Some((client, session));
                self.fail(format!(
                    "Could not stop Copilot: {e}. Retry End session before resuming."
                ));
                return Err(error(e));
            }
            let pid = *self.process_id.lock().map_err(error)?;
            if let Err(e) = confirm_process_exit(pid).await {
                *self.runtime.lock().await = Some((client, session));
                self.fail(format!("{e} Retry End session before resuming."));
                return Err(e);
            }
        }
        {
            let mut state = self.state.lock().map_err(error)?;
            state.finish_open_tools("The session ended before this tool completed.");
            state.base_status = Status::Done;
            state.session.last_activity = "Native session ended. Resume to continue.".into();
            state.changed();
        }
        self.publish()?;
        cleared?;
        Ok(())
    }
}

struct RequestGuard {
    owner: Arc<Managed>,
    key: u64,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        let changed = if let Ok(mut state) = self.owner.state.lock() {
            if state.pending.remove(&self.key).is_some() {
                state.changed();
                true
            } else {
                false
            }
        } else {
            false
        };
        if changed {
            if let Err(e) = self.owner.publish() {
                eprintln!("[native sessions] {e}");
            }
        }
    }
}

async fn confirm_process_exit(pid: Option<u32>) -> AppResult<()> {
    #[cfg(windows)]
    if let Some(pid) = pid {
        // Keep the PID after SDK shutdown errors: a second stop may have no child
        // handle left and must not be treated as proof that the old writer exited.
        return tauri::async_runtime::spawn_blocking(move || {
            use winapi::shared::winerror::ERROR_INVALID_PARAMETER;
            use winapi::um::{
                handleapi::CloseHandle, processthreadsapi::OpenProcess,
                synchapi::WaitForSingleObject, winbase::WAIT_OBJECT_0, winnt::SYNCHRONIZE,
            };
            unsafe {
                let handle = OpenProcess(SYNCHRONIZE, 0, pid);
                if handle.is_null() {
                    let e = std::io::Error::last_os_error();
                    return if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                        Ok(())
                    } else {
                        Err(error(format!("Could not confirm Copilot exit: {e}.")))
                    };
                }
                let result = WaitForSingleObject(handle, 5_000);
                CloseHandle(handle);
                if result == WAIT_OBJECT_0 {
                    Ok(())
                } else {
                    Err(error(
                        "The previous Copilot process has not confirmed exit.",
                    ))
                }
            }
        })
        .await
        .map_err(error)?;
    }
    let _ = pid;
    Ok(())
}

struct Handlers(Arc<Managed>);

#[async_trait]
impl PermissionHandler for Handlers {
    async fn handle(
        &self,
        _: SessionId,
        _: RequestId,
        data: PermissionRequestData,
    ) -> PermissionResult {
        // Only allow-once is enabled until a live session-scope acceptance fixture passes.
        let scoped: Option<(String, PermissionDecision)> = None;
        let detail = serde_json::to_string_pretty(&data).unwrap_or_else(|_| format!("{:?}", data));
        let request = InteractionRequest::Permission {
            message: "Copilot needs permission".into(),
            detail,
            session_approval: scoped.as_ref().map(|(label, _)| label.clone()),
        };
        match self.0.ask(request).await {
            InteractionAnswer::Permission { action } if action == "allow-once" => {
                use github_copilot_sdk::rpc::PermissionDecisionApproveOnce;
                PermissionDecision::ApproveOnce(PermissionDecisionApproveOnce {
                    approved_interactively: Some(true),
                    ..Default::default()
                })
                .into()
            }
            InteractionAnswer::Permission { action } if action == "allow-session" => scoped
                .map(|(_, decision)| decision.into())
                .unwrap_or_else(|| {
                    PermissionResult::reject(Some("Session approval is unavailable.".into()))
                }),
            _ => {
                PermissionResult::reject(Some("The user declined or cancelled the request.".into()))
            }
        }
    }
}

#[async_trait]
impl ElicitationHandler for Handlers {
    async fn handle(
        &self,
        _: SessionId,
        _: RequestId,
        req: ElicitationRequest,
    ) -> ElicitationResult {
        let unsupported = match req.mode {
            None | Some(ElicitationMode::Form) => req
                .requested_schema
                .as_ref()
                .map_or(Some("No form schema was provided.".into()), |schema| {
                    check_schema(schema).err().map(|e| e.to_string())
                }),
            Some(ElicitationMode::Url) => Some(
                "URL authorization requires Terminal mode until completion tracking is supported."
                    .into(),
            ),
            _ => Some("Copilot requested an unsupported interaction mode.".into()),
        };
        let url = if req.mode == Some(ElicitationMode::Url) {
            req.url
        } else {
            None
        };
        match self
            .0
            .ask(InteractionRequest::Elicitation {
                message: req.message,
                schema: req.requested_schema,
                url,
                unsupported,
            })
            .await
        {
            InteractionAnswer::Elicitation { action, content } => {
                ElicitationResult { action, content }
            }
            _ => ElicitationResult {
                action: "cancel".into(),
                content: None,
            },
        }
    }
}

#[async_trait]
impl UserInputHandler for Handlers {
    async fn handle(
        &self,
        _: SessionId,
        message: String,
        choices: Option<Vec<String>>,
        freeform: Option<bool>,
    ) -> Option<UserInputResponse> {
        match self
            .0
            .ask(InteractionRequest::Question {
                message,
                choices: choices.unwrap_or_default(),
                allow_freeform: freeform.unwrap_or(true),
            })
            .await
        {
            InteractionAnswer::Question {
                answer,
                was_freeform,
            } => Some(UserInputResponse {
                answer,
                was_freeform,
            }),
            _ => None,
        }
    }
}

#[async_trait]
impl ExitPlanModeHandler for Handlers {
    async fn handle(&self, _: SessionId, data: ExitPlanModeData) -> ExitPlanModeResult {
        match self
            .0
            .ask(InteractionRequest::Plan {
                message: data.summary,
                plan: data.plan_content,
                actions: data.actions,
            })
            .await
        {
            InteractionAnswer::Plan {
                approved,
                selected_action,
                feedback,
            } => ExitPlanModeResult {
                approved,
                selected_action,
                feedback,
            },
            _ => ExitPlanModeResult {
                approved: false,
                selected_action: None,
                feedback: Some("The user cancelled.".into()),
            },
        }
    }
}

#[async_trait]
impl AutoModeSwitchHandler for Handlers {
    async fn handle(
        &self,
        _: SessionId,
        code: Option<String>,
        _: Option<f64>,
    ) -> AutoModeSwitchResponse {
        match self
            .0
            .ask(InteractionRequest::AutoMode {
                message: format!(
                    "Copilot proposes switching to Auto after {}. Allow this switch once?",
                    code.as_deref().unwrap_or("a rate limit")
                ),
            })
            .await
        {
            InteractionAnswer::AutoMode { approved: true } => AutoModeSwitchResponse::Yes,
            _ => AutoModeSwitchResponse::No,
        }
    }
}

#[derive(Default)]
pub struct NativeSessionManager {
    sessions: Mutex<HashMap<String, Arc<Managed>>>,
}

fn get(app: &AppHandle, target: &NativeTarget) -> AppResult<Arc<Managed>> {
    let owner = app
        .state::<NativeSessionManager>()
        .sessions
        .lock()
        .map_err(error)?
        .get(&target.id)
        .cloned()
        .ok_or_else(|| error("This native session is no longer connected."))?;
    if owner
        .state
        .lock()
        .map_err(error)?
        .session
        .generation
        .as_deref()
        != Some(&target.generation)
    {
        return Err(error("This request belongs to a previous session process."));
    }
    Ok(owner)
}

fn installed_cli() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("COPILOT_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path.canonicalize().map_err(error);
        }
        return Err(error(
            "COPILOT_CLI_PATH does not point to an installed executable.",
        ));
    }
    let name = if cfg!(windows) {
        "copilot.exe"
    } else {
        "copilot"
    };
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        })
        .ok_or_else(|| {
            error("Copilot CLI was not found. Install it and sign in, or use terminal mode.")
        })?
        .canonicalize()
        .map_err(error)
}

async fn launch(owner: Arc<Managed>, req: StartTerminalSessionRequest) -> AppResult<()> {
    let _lifecycle = owner.lifecycle.lock().await;
    if owner.stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    let id = owner.state.lock().map_err(error)?.session.id.clone();
    let history_id = id.clone();
    let history = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(terminal_sessions::terminal_sessions_history(history_id))
    })
    .await
    .map_err(error)??;
    {
        let mut state = owner.state.lock().map_err(error)?;
        state.entries = history
            .into_iter()
            .map(|entry| (entry.seq(), entry))
            .collect::<BTreeMap<_, _>>()
            .into_values()
            .collect();
        state.next_seq = state.entries.back().map_or(0, |entry| entry.seq() + 1);
        while state.entries.len() > MAX_ENTRIES {
            state.entries.pop_front();
            state.history_truncated = true;
        }
        state.finish_open_tools("The previous runtime ended without a tool completion result.");
    }
    let mut options = ClientOptions::default();
    options.program = CliProgram::Path(installed_cli()?);
    options.transport = Transport::Stdio;
    options.working_directory = PathBuf::from(&req.folder_path);
    options.extra_args = vec!["--no-auto-update".into(), "--no-remote".into()];
    options.env_remove = [
        "COPILOT_AGENT_SESSION_ID",
        "COPILOT_LOADER_PID",
        "COPILOT_CLI",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let client = Arc::new(
        tokio::time::timeout(Duration::from_secs(45), Client::start(options))
            .await
            .map_err(error)?
            .map_err(error)?,
    );
    // Retain ownership even when preparation fails; End is the only shutdown path.
    *owner.runtime.lock().await = Some((client.clone(), None));
    *owner.process_id.lock().map_err(error)? = client.pid();
    let result = async {
        let handlers = Arc::new(Handlers(owner.clone()));
        let prepared = if req.resume_session_id.is_some() {
            client.prepare_resume_session(ResumeSessionConfig::new(SessionId::new(&id))
                .with_working_directory(&req.folder_path).with_streaming(true)
                .with_ask_user_variant(AskUserVariant::Elicitation)
                .with_permission_handler(handlers.clone()).with_elicitation_handler(handlers.clone())
                .with_user_input_handler(handlers.clone()).with_exit_plan_mode_handler(handlers.clone())
                .with_auto_mode_switch_handler(handlers))?
        } else {
            client.prepare_session(SessionConfig::default().with_session_id(id.clone())
                .with_working_directory(&req.folder_path).with_streaming(true)
                .with_ask_user_variant(AskUserVariant::Elicitation)
                .with_permission_handler(handlers.clone()).with_elicitation_handler(handlers.clone())
                .with_user_input_handler(handlers.clone()).with_exit_plan_mode_handler(handlers.clone())
                .with_auto_mode_switch_handler(handlers))?
        };
        let mut events = prepared.subscribe();
        let observer_owner = owner.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(100));
            loop {
                if observer_owner.stopping.load(Ordering::SeqCst) { break; }
                tokio::select! {
                    event = events.recv() => match event {
                        Ok(event) => {
                            match observer_owner.state.lock() {
                                Ok(mut state) => state.ingest(event),
                                Err(e) => { eprintln!("[native sessions] {e}"); break; }
                            }
                        }
                        Err(e) => {
                            if let github_copilot_sdk::subscription::RecvErrorKind::Lagged(skipped) = e.kind() {
                                if let Ok(mut state) = observer_owner.state.lock() {
                                    state.error = Some(format!("Transcript missed {} events. Pending controls remain available; end and resume to reload saved history.", skipped.skipped()));
                                    state.changed();
                                }
                                continue;
                            }
                            if !observer_owner.stopping.load(Ordering::SeqCst) {
                                observer_owner.fail(format!("Copilot event stream ended: {e}. End and resume the session."));
                                if let Err(stop) = observer_owner.end().await { eprintln!("[native sessions] {stop}"); }
                            }
                            break;
                        }
                    },
                    _ = ticker.tick() => {
                        let dirty = observer_owner.state.lock().map(|state| state.dirty).unwrap_or(true);
                        if dirty {
                            if let Err(e) = observer_owner.publish() {
                                observer_owner.fail(format!("Could not publish session state: {e}"));
                                if let Err(stop) = observer_owner.end().await { eprintln!("[native sessions] {stop}"); }
                                break;
                            }
                        }
                    }
                }
            }
        });
        // Human callbacks during setup have no arbitrary timeout; End cancels setup explicitly.
        let session = Arc::new(tokio::select! {
            result = prepared.start() => result?,
            _ = owner.stop_requested.notified() => {
                return Err::<(), Box<dyn std::error::Error + Send + Sync>>("Session startup was cancelled.".into());
            }
        });
        if owner.stopping.load(Ordering::SeqCst) {
            return Err::<(), Box<dyn std::error::Error + Send + Sync>>("Session startup was cancelled.".into());
        }
        *owner.runtime.lock().await = Some((client.clone(), Some(session.clone())));
        {
            let mut state = owner.state.lock().map_err(error)?;
            state.base_status = Status::Idle;
            state.session.last_activity = "Waiting for your first instruction".into();
            state.changed();
        }
        owner.publish()?;
        if req.resume_session_id.is_none() {
            if let Some(prompt) = req.prompt.filter(|prompt| !prompt.trim().is_empty()) {
                {
                    let mut state = owner.state.lock().map_err(error)?;
                    state.base_status = Status::Working;
                    state.changed();
                }
                owner.publish()?;
                tokio::time::timeout(Duration::from_secs(30), session.send(prompt)).await
                    .map_err(|_| error("Prompt delivery timed out. It may have been received; do not automatically resend it."))??;
            }
        }
        Ok(())
    }.await;
    result.map_err(error)
}

pub async fn start(
    app: AppHandle,
    req: StartTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    if !PathBuf::from(&req.folder_path).is_dir() {
        return Err(error("The working directory does not exist."));
    }
    if github_copilot_sdk::HAS_BUNDLED_CLI {
        return Err(error("This build must not bundle a Copilot runtime."));
    }
    installed_cli()?;
    let id = req
        .resume_session_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(error)?
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string();
    let generation = uuid::Uuid::new_v4().to_string();
    let result = terminal_sessions::watch_managed_session(&app, &req, &id, &generation, "sdk")?;
    let session = result
        .session
        .as_ref()
        .ok_or_else(|| error("Session registration failed."))?
        .clone();
    let owner = Arc::new(Managed {
        app: app.clone(),
        state: Mutex::new(State {
            session,
            base_status: Status::Starting,
            pending: BTreeMap::new(),
            next_request: 0,
            entries: VecDeque::new(),
            next_seq: 0,
            message_sequences: HashMap::new(),
            error: None,
            dirty: true,
            history_truncated: false,
        }),
        publication: Mutex::new(()),
        runtime: tokio::sync::Mutex::new(None),
        process_id: Mutex::new(None),
        lifecycle: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
        cancelling: AtomicBool::new(false),
        stop_requested: tokio::sync::Notify::new(),
    });
    app.state::<NativeSessionManager>()
        .sessions
        .lock()
        .map_err(error)?
        .insert(id, owner.clone());
    owner.publish()?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = launch(owner.clone(), req).await {
            if !owner.stopping.load(Ordering::SeqCst) {
                owner.fail(e.to_string());
            }
            if let Err(stop) = owner.end().await {
                eprintln!("[native sessions] startup cleanup: {stop}");
            }
        }
    });
    Ok(result)
}

#[tauri::command]
pub async fn native_session_snapshot(
    app: AppHandle,
    target: NativeTarget,
) -> AppResult<NativeSnapshot> {
    let owner = get(&app, &target)?;
    let state = owner.state.lock().map_err(error)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn native_session_respond(
    app: AppHandle,
    target: NativeTarget,
    interaction_id: String,
    answer: InteractionAnswer,
) -> AppResult<NativeSnapshot> {
    let owner = get(&app, &target)?;
    let response = {
        let mut state = owner.state.lock().map_err(error)?;
        if owner.stopping.load(Ordering::SeqCst) || owner.cancelling.load(Ordering::SeqCst) {
            return Err(error(
                "The session is stopping. This request cannot be answered.",
            ));
        }
        state.respond(&interaction_id, answer)
    };
    let snapshot = owner.publish()?;
    response?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn native_session_prompt(
    app: AppHandle,
    target: NativeTarget,
    prompt: String,
) -> AppResult<()> {
    let owner = get(&app, &target)?;
    if prompt.trim().is_empty() {
        return Err(error("A message is required."));
    }
    if prompt.trim_start().starts_with('/') && !matches!(prompt.trim(), "/plan" | "/interactive") {
        return Err(error("This slash command requires Terminal mode. Native controls support /plan and /interactive."));
    }
    let _lifecycle = owner.lifecycle.lock().await;
    let runtime = owner
        .runtime
        .lock()
        .await
        .as_ref()
        .and_then(|(_, session)| session.clone())
        .ok_or_else(|| error("This session is no longer connected."))?;
    {
        let mut state = owner.state.lock().map_err(error)?;
        if state.session.status != Status::Idle
            || owner.stopping.load(Ordering::SeqCst)
            || owner.cancelling.load(Ordering::SeqCst)
        {
            return Err(error(
                "Wait until Copilot is idle before sending another message.",
            ));
        }
        state.base_status = Status::Working;
        state.session.last_activity = "Sending your instruction to Copilot".into();
        state.error = None;
        state.changed();
    }
    owner.publish()?;
    let sent = if matches!(prompt.trim(), "/plan" | "/interactive") {
        use github_copilot_sdk::{rpc::ModeSetRequest, session_events::SessionMode};
        let mode = if prompt.trim() == "/plan" {
            SessionMode::Plan
        } else {
            SessionMode::Interactive
        };
        async {
            let result = runtime
                .rpc()
                .mode()
                .set(ModeSetRequest {
                    mode: mode.clone(),
                    ..Default::default()
                })
                .await?;
            let actual = runtime.rpc().mode().get().await?;
            let mut state = owner.state.lock().map_err(error)?;
            let seq = state.next_seq;
            state.next_seq += 1;
            let message = if actual == mode {
                format!(
                    "Copilot mode: {}. {}",
                    prompt.trim().trim_start_matches('/'),
                    result.warning.or(result.message).unwrap_or_default()
                )
            } else {
                "The mode change needs an additional decision. Use Terminal to complete it.".into()
            };
            state.push(Entry::Notice {
                seq,
                timestamp: None,
                text: message,
                level: "info".into(),
            });
            state.base_status = Status::Idle;
            state.changed();
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        }
        .await
        .map_err(error)
    } else {
        match tokio::time::timeout(Duration::from_secs(30), runtime.send(prompt)).await {
            Ok(result) => result.map(|_| ()).map_err(error),
            Err(_) => {
                let message = "Prompt delivery timed out. It may have been received. End and resume before deciding whether to resend.";
                owner.fail(message.into());
                drop(_lifecycle);
                owner.end().await?;
                return Err(error(message));
            }
        }
    };
    if let Err(e) = sent {
        let mut state = owner.state.lock().map_err(error)?;
        state.base_status = Status::Idle;
        state.error = Some(e.to_string());
        state.changed();
        drop(state);
        owner.publish()?;
        return Err(error(e));
    }
    owner.publish()?;
    Ok(())
}

#[tauri::command]
pub async fn native_session_cancel(app: AppHandle, target: NativeTarget) -> AppResult<()> {
    let owner = get(&app, &target)?;
    let starting = owner.state.lock().map_err(error)?.base_status == Status::Starting;
    if starting {
        return owner.end().await;
    }
    if owner.cancelling.swap(true, Ordering::SeqCst) {
        return Err(error("This turn is already stopping."));
    }
    // Resolve human callbacks before waiting for an in-flight mode RPC.
    let cleared = owner.clear_requests();
    let _lifecycle = owner.lifecycle.lock().await;
    let runtime = owner
        .runtime
        .lock()
        .await
        .as_ref()
        .and_then(|(_, session)| session.clone());
    if let Some(session) = runtime {
        let aborted = tokio::time::timeout(Duration::from_secs(15), session.abort())
            .await
            .map_err(|_| error("Stopping the turn timed out. End the session before continuing."))
            .and_then(|result| result.map_err(error));
        owner.cancelling.store(false, Ordering::SeqCst);
        if let Err(e) = aborted {
            let mut state = owner.state.lock().map_err(error)?;
            state.error = Some(e.to_string());
            state.changed();
            drop(state);
            owner.publish()?;
            return Err(e);
        }
        {
            let mut state = owner.state.lock().map_err(error)?;
            state.finish_open_tools("The turn was stopped by the user.");
            state.base_status = Status::Idle;
            state.session.last_activity =
                "Turn stopped. Send another instruction when ready.".into();
            state.changed();
        }
        owner.publish()?;
        cleared?;
        Ok(())
    } else {
        owner.cancelling.store(false, Ordering::SeqCst);
        Err(error(
            "This session is no longer connected. Resume it to continue.",
        ))
    }
}

#[tauri::command]
pub async fn native_session_end(app: AppHandle, target: NativeTarget) -> AppResult<()> {
    get(&app, &target)?.end().await
}

pub async fn forget(app: &AppHandle, id: &str) -> AppResult<()> {
    let owner = app
        .state::<NativeSessionManager>()
        .sessions
        .lock()
        .map_err(error)?
        .get(id)
        .cloned();
    if let Some(owner) = owner {
        owner.end().await?;
        app.state::<NativeSessionManager>()
            .sessions
            .lock()
            .map_err(error)?
            .remove(id);
    }
    Ok(())
}

pub async fn shutdown(app: &AppHandle) {
    let owners = match app.state::<NativeSessionManager>().sessions.lock() {
        Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
        Err(e) => {
            eprintln!("[native sessions] shutdown: {e}");
            return;
        }
    };
    let mut tasks = tokio::task::JoinSet::new();
    for owner in owners {
        tasks.spawn(async move { owner.end().await });
    }
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("[native sessions] shutdown: {e}"),
            Err(e) => eprintln!("[native sessions] shutdown task: {e}"),
        }
    }
}
