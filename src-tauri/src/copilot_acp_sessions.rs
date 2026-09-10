mod process;
mod state;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_client_protocol::{schema::v1 as acp, Agent, ByteStreams, Client, ConnectionTo};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::AsyncReadExt,
    sync::{oneshot, Notify},
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::{
    db::DbState,
    error::{AppError, AppResult},
    session_interactions::{
        check_schema, InteractionAnswer, InteractionRequest, NativeInteraction,
    },
    terminal_sessions::{self, StartTerminalSessionRequest, TerminalSessionResult},
};
use state::{QueuedPrompt, SessionMode, Snapshot, State};

fn error(value: impl std::fmt::Display) -> AppError {
    AppError::msg(value.to_string())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn copilot_server_args(profile: crate::settings::CopilotPermissionProfile) -> Vec<&'static str> {
    let mut args = vec!["--acp", "--stdio", "--no-auto-update", "--no-remote"];
    if profile == crate::settings::CopilotPermissionProfile::AllowAll {
        args.push("--allow-all");
    }
    args
}

pub(crate) fn installed_cli() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("COPILOT_CLI_PATH") {
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(error(
                "COPILOT_CLI_PATH does not point to an installed executable.",
            ));
        }
        return path.canonicalize().map_err(error);
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
            error(
                "Copilot CLI was not found. Install Copilot and run copilot login before retrying.",
            )
        })?
        .canonicalize()
        .map_err(error)
}

#[derive(Clone, Deserialize)]
pub struct Target {
    pub id: String,
    pub generation: String,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Managed>>>,
    pub exiting: AtomicBool,
    pub shutdown_complete: AtomicBool,
}

struct PendingGuard {
    owner: Arc<Managed>,
    id: String,
}

struct UrlGuard {
    owner: Arc<Managed>,
    id: Option<String>,
    accepted: bool,
}

impl Drop for UrlGuard {
    fn drop(&mut self) {
        if !self.accepted {
            if let Some(id) = &self.id {
                match self.owner.state.lock() {
                    Ok(mut state) => {
                        state.url_requests.remove(id);
                    }
                    Err(e) => eprintln!("[ACP] clearing URL request: {e}"),
                }
            }
        }
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.owner.pending.lock() {
            pending.remove(&self.id);
        }
        if let Ok(mut state) = self.owner.state.lock() {
            state.snapshot.interactions.retain(|r| r.id != self.id);
            state.changed();
        }
        if let Err(e) = self.owner.publish() {
            eprintln!("[ACP] clearing request: {e}");
        }
        self.owner.wake.notify_one();
    }
}

struct Managed {
    app: AppHandle,
    state: Mutex<State>,
    publication: Mutex<()>,
    connection: Mutex<Option<ConnectionTo<Agent>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<InteractionAnswer>>>,
    queue_write: Mutex<()>,
    wake: Notify,
    shutdown: Notify,
    turn_done: Notify,
    exited: Notify,
    stopping: AtomicBool,
    finished: AtomicBool,
    process_exited: AtomicBool,
}

impl Managed {
    fn publish(&self) -> AppResult<Snapshot> {
        let _guard = self.publication.lock().map_err(error)?;
        let snapshot = {
            let mut state = self.state.lock().map_err(error)?;
            state.dirty = false;
            state.snapshot.clone()
        };
        terminal_sessions::publish_native_session(&self.app, &snapshot.session)?;
        self.app
            .emit("native-sessions:update", &snapshot)
            .map_err(error)?;
        Ok(snapshot)
    }

    fn persist_queue(&self, state: &State) -> AppResult<()> {
        let data = json!({ "queue": state.snapshot.queue, "paused": state.snapshot.queue_paused });
        self.app
            .state::<DbState>()
            .0
            .lock()
            .map_err(error)?
            .execute(
                "INSERT INTO acp_queue_state(session_id,payload) VALUES(?1,?2)
             ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
                rusqlite::params![state.snapshot.session.id, data.to_string()],
            )?;
        Ok(())
    }

    fn persist_transcript(&self) -> AppResult<()> {
        let state = self.state.lock().map_err(error)?;
        if state.snapshot.entries.is_empty() {
            return Ok(());
        }
        self.app.state::<DbState>().0.lock().map_err(error)?.execute(
            "INSERT INTO acp_transcripts(session_id,payload) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
            rusqlite::params![state.snapshot.session.id, serde_json::to_string(&state.snapshot.entries)?],
        )?;
        Ok(())
    }

    fn restore_queue(&self) -> AppResult<()> {
        let id = self.id()?;
        let data: Option<String> = self
            .app
            .state::<DbState>()
            .0
            .lock()
            .map_err(error)?
            .query_row(
                "SELECT payload FROM acp_queue_state WHERE session_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(data) = data {
            let value: Value = serde_json::from_str(&data)?;
            let queue: Vec<QueuedPrompt> = serde_json::from_value(value["queue"].clone())?;
            let mut state = self.state.lock().map_err(error)?;
            state.recover_queue(queue);
            self.persist_queue(&state)?;
        }
        Ok(())
    }

    fn id(&self) -> AppResult<String> {
        Ok(self
            .state
            .lock()
            .map_err(error)?
            .snapshot
            .session
            .id
            .clone())
    }

    fn connection(&self) -> AppResult<ConnectionTo<Agent>> {
        self.connection
            .lock()
            .map_err(error)?
            .clone()
            .ok_or_else(|| error("Copilot is not connected."))
    }

    fn fail(&self, message: String) {
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown.notify_one();
        match self.state.lock() {
            Ok(mut state) => {
                state.snapshot.error = Some(message.clone());
                state.snapshot.queue_paused = true;
                state.snapshot.phase = "failed".into();
                state.finish_tools("incomplete");
                if let Some(id) = state.active_prompt.take() {
                    if let Some(item) = state.snapshot.queue.iter_mut().find(|item| item.id == id) {
                        item.status = "delivery-unknown".into();
                        item.error = Some(message.clone());
                    }
                }
                state.notice(message, true);
                if let Err(e) = self.persist_queue(&state) {
                    eprintln!("[ACP] could not preserve failed queue: {e}");
                }
            }
            Err(e) => eprintln!("[ACP] state failure: {e}"),
        }
        if let Err(e) = self.publish() {
            eprintln!("[ACP] could not publish failure: {e}");
        }
    }

    fn clear_requests(&self) -> AppResult<()> {
        let pending = std::mem::take(&mut *self.pending.lock().map_err(error)?);
        for (_, response) in pending {
            if response.send(InteractionAnswer::Cancel).is_err() {
                eprintln!("[ACP] request already ended during cancellation");
            }
        }
        let mut state = self.state.lock().map_err(error)?;
        state.snapshot.interactions.clear();
        state.url_requests.clear();
        state.changed();
        Ok(())
    }

    async fn ask(self: Arc<Self>, request: InteractionRequest) -> InteractionAnswer {
        if self.stopping.load(Ordering::SeqCst) {
            return InteractionAnswer::Cancel;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let registered = (|| -> AppResult<bool> {
            let mut state = self.state.lock().map_err(error)?;
            if matches!(
                state.snapshot.phase.as_str(),
                "cancelling" | "ending" | "ended" | "failed"
            ) {
                return Ok(false);
            }
            if state.snapshot.interactions.len() >= 32 {
                return Err(error("Copilot exceeded the limit of 32 pending decisions."));
            }
            self.pending.lock().map_err(error)?.insert(id.clone(), tx);
            state.snapshot.interactions.push(NativeInteraction {
                id: id.clone(),
                created_at: now(),
                request,
            });
            state.changed();
            Ok(true)
        })();
        if matches!(registered, Ok(false)) {
            return InteractionAnswer::Cancel;
        }
        if let Err(e) = registered.and_then(|_| self.publish().map(|_| ())) {
            self.fail(format!("Could not display Copilot's request: {e}"));
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return InteractionAnswer::Cancel;
        }
        let _guard = PendingGuard {
            owner: self.clone(),
            id: id.clone(),
        };
        rx.await.unwrap_or(InteractionAnswer::Cancel)
    }

    async fn request_stop(&self) -> AppResult<()> {
        {
            let _write = self.queue_write.lock().map_err(error)?;
            let mut state = self.state.lock().map_err(error)?;
            state.snapshot.queue_paused = true;
            if state.snapshot.phase == "starting" || state.snapshot.phase == "loading" {
                drop(state);
                self.stopping.store(true, Ordering::SeqCst);
                self.shutdown.notify_one();
                return Ok(());
            }
            if state.active_prompt.is_none() {
                self.persist_queue(&state)?;
                drop(state);
                self.publish()?;
                return Ok(());
            }
            state.snapshot.phase = "cancelling".into();
            state.changed();
            self.persist_queue(&state)?;
        }
        self.clear_requests()?;
        self.publish()?;
        let request: acp::CancelNotification =
            serde_json::from_value(json!({"sessionId": self.id()?}))?;
        self.connection()?
            .send_notification(request)
            .map_err(error)?;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let notified = self.turn_done.notified();
                if self.state.lock().map_err(error)?.active_prompt.is_none() { return Ok::<_, AppError>(()); }
                notified.await;
            }
        }).await.map_err(|_| error("Copilot has not confirmed cancellation. Use End session; queued messages remain paused."))??;
        Ok(())
    }

    async fn end(&self) -> AppResult<()> {
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown.notify_one();
        {
            let mut state = self.state.lock().map_err(error)?;
            state.snapshot.queue_paused = true;
            if !self.finished.load(Ordering::SeqCst) {
                state.snapshot.phase = "ending".into();
            }
            state.changed();
            self.persist_queue(&state)?;
        }
        self.clear_requests()?;
        self.publish()?;
        self.shutdown.notify_one();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let exited = self.exited.notified();
                if self.finished.load(Ordering::SeqCst) {
                    break;
                }
                exited.await;
            }
        })
        .await
        .map_err(|_| {
            error("Copilot process shutdown has not been confirmed. Retry End before resuming.")
        })?;
        Ok(())
    }
}

fn get(app: &AppHandle, target: &Target) -> AppResult<Arc<Managed>> {
    let manager = app.state::<SessionManager>();
    let owner = manager
        .sessions
        .lock()
        .map_err(error)?
        .get(&target.id)
        .cloned()
        .ok_or_else(|| error("This in-app session is no longer connected."))?;
    if owner
        .state
        .lock()
        .map_err(error)?
        .snapshot
        .session
        .generation
        .as_deref()
        != Some(&target.generation)
    {
        return Err(error("This action belongs to a previous session process."));
    }
    Ok(owner)
}

fn protocol_error(e: impl std::fmt::Display) -> acp::Error {
    acp::Error::internal_error().data(e.to_string())
}

fn permission_outcome(answer: InteractionAnswer) -> acp::RequestPermissionOutcome {
    match answer {
        InteractionAnswer::Permission { action } => {
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(action))
        }
        _ => acp::RequestPermissionOutcome::Cancelled,
    }
}

fn permission_resolution(
    options: &[crate::terminal_sessions::TerminalSessionPermissionOption],
    answer: &InteractionAnswer,
) -> (String, Option<String>) {
    let InteractionAnswer::Permission { action } = answer else {
        return ("Cancelled".into(), None);
    };
    let Some(option) = options.iter().find(|option| option.option_id == *action) else {
        return ("Cancelled".into(), None);
    };
    let detail = match option.kind.as_str() {
        "allow_once" => "Allowed once",
        "allow_always" => "Saved as a project-scoped approval when supported",
        "reject_once" => "Rejected once",
        "reject_always" => "Saved as a project-scoped rejection when supported",
        _ => option.name.as_str(),
    };
    (detail.into(), Some(option.kind.clone()))
}

async fn permission(
    owner: Arc<Managed>,
    request: acp::RequestPermissionRequest,
) -> acp::RequestPermissionResponse {
    if let Err(e) = check_request_session(&owner, Some(&request.session_id.to_string())) {
        owner.fail(e.to_string());
        return acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled);
    }
    let value = match serde_json::to_value(&request) {
        Ok(value) => value,
        Err(e) => {
            owner.fail(e.to_string());
            return acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled);
        }
    };
    let options: Vec<crate::terminal_sessions::TerminalSessionPermissionOption> =
        match serde_json::from_value(value["options"].clone()) {
            Ok(options) => options,
            Err(e) => {
                owner.fail(format!("Invalid permission options: {e}"));
                return acp::RequestPermissionResponse::new(
                    acp::RequestPermissionOutcome::Cancelled,
                );
            }
        };
    let message = value["toolCall"]["title"]
        .as_str()
        .unwrap_or("Copilot requests permission")
        .to_string();
    let timeline_seq = match owner.state.lock() {
        Ok(mut state) => state.permission_requested(message.clone()),
        Err(e) => {
            owner.fail(e.to_string());
            return acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled);
        }
    };
    let answer = owner
        .clone()
        .ask(InteractionRequest::AcpPermission {
            message,
            options: options.clone(),
            detail: serde_json::to_string_pretty(&value["toolCall"]).unwrap_or_default(),
        })
        .await;
    let (resolution, selection_kind) = permission_resolution(&options, &answer);
    match owner.state.lock() {
        Ok(mut state) => state.resolve_permission(timeline_seq, resolution, selection_kind),
        Err(e) => owner.fail(e.to_string()),
    }
    if let Err(e) = owner.publish() {
        owner.fail(format!("Could not publish the permission result: {e}"));
    }
    acp::RequestPermissionResponse::new(permission_outcome(answer))
}

async fn elicitation(
    owner: Arc<Managed>,
    request: acp::CreateElicitationRequest,
) -> Result<acp::CreateElicitationResponse, acp::Error> {
    let value = serde_json::to_value(request).map_err(protocol_error)?;
    check_request_session(&owner, value["sessionId"].as_str()).map_err(protocol_error)?;
    let schema = value.get("requestedSchema").cloned();
    let url = value["url"].as_str().map(str::to_owned);
    let url_id = if url.is_some() {
        value["elicitationId"].as_str().map(str::to_owned)
    } else {
        None
    };
    if let Some(id) = &url_id {
        let mut state = owner.state.lock().map_err(protocol_error)?;
        if state.url_requests.len() >= 128 {
            return Err(protocol_error(
                "Too many outstanding external interactions.",
            ));
        }
        state.url_requests.insert(id.clone());
    }
    let mut url_guard = UrlGuard {
        owner: owner.clone(),
        id: url_id.clone(),
        accepted: false,
    };
    let unsupported = if value["mode"] == "form" {
        schema
            .as_ref()
            .map(check_schema)
            .transpose()
            .err()
            .map(|e| e.to_string())
    } else if value["mode"] == "url" {
        None
    } else {
        Some("This elicitation mode is not supported.".into())
    };
    let answer = owner
        .clone()
        .ask(InteractionRequest::Elicitation {
            message: value["message"]
                .as_str()
                .unwrap_or("Copilot needs your input")
                .into(),
            schema,
            url,
            unsupported,
        })
        .await;
    let response = match answer {
        InteractionAnswer::Elicitation { action, content } => {
            json!({ "action": action, "content": content })
        }
        _ => json!({"action":"cancel"}),
    };
    if let Some(id) = &url_id {
        let mut state = owner.state.lock().map_err(protocol_error)?;
        if response["action"] != "accept" {
            state.url_requests.remove(id);
        } else if state.url_requests.contains(id) {
            state.notice(
                "URL opened with your consent. External completion has not yet been confirmed.",
                false,
            );
        }
    }
    url_guard.accepted = response["action"] == "accept";
    serde_json::from_value(response).map_err(protocol_error)
}

fn check_request_session(owner: &Managed, id: Option<&str>) -> AppResult<()> {
    let state = owner.state.lock().map_err(error)?;
    if !matches!(state.snapshot.phase.as_str(), "starting" | "loading")
        && id.is_some_and(|id| id != state.snapshot.session.id)
    {
        return Err(error("Copilot sent a decision for another conversation."));
    }
    Ok(())
}

async fn dispatch_queue(owner: Arc<Managed>) -> AppResult<()> {
    loop {
        let wake = owner.wake.notified();
        let next = {
            let _write = owner.queue_write.lock().map_err(error)?;
            let mut state = owner.state.lock().map_err(error)?;
            if owner.stopping.load(Ordering::SeqCst) {
                return Ok(());
            }
            if state.snapshot.phase != "idle"
                || state.snapshot.queue_paused
                || !state.snapshot.interactions.is_empty()
            {
                None
            } else if let Some(index) = state
                .snapshot
                .queue
                .iter()
                .position(|item| item.status == "queued")
            {
                let item = state.snapshot.queue[index].clone();
                if let Err(e) = state.validate_prompt(&item.prompt, false) {
                    state.snapshot.queue[index].error = Some(e.to_string());
                    state.snapshot.queue_paused = true;
                    state.changed();
                    owner.persist_queue(&state)?;
                    None
                } else {
                    state.snapshot.queue[index].status = "dispatching".into();
                    state.active_prompt = Some(item.id.clone());
                    state.snapshot.phase = "working".into();
                    state.snapshot.plan_transition_available = false;
                    state.changed();
                    owner.persist_queue(&state)?;
                    state.begin_prompt(&item);
                    Some(item)
                }
            } else {
                None
            }
        };
        owner.publish()?;
        let Some(item) = next else {
            wake.await;
            continue;
        };
        let request: acp::PromptRequest = serde_json::from_value(json!({
            "sessionId": owner.id()?, "prompt": item.prompt
        }))?;
        let connection = owner.connection()?;
        let result = connection.send_request(request).block_task().await;
        {
            let mut state = owner.state.lock().map_err(error)?;
            match result {
                Ok(response) => {
                    let result = serde_json::to_value(response)?;
                    state.turn_finished(result["stopReason"].as_str().unwrap_or("unknown"));
                }
                Err(e) => {
                    if let Some(queued) = state.snapshot.queue.iter_mut().find(|q| q.id == item.id)
                    {
                        queued.status = "delivery-unknown".into();
                        queued.error = Some(format!("{e}. Review history before resending."));
                    }
                    state.active_prompt = None;
                    state.snapshot.queue_paused = true;
                    if state.snapshot.phase != "ending" {
                        state.snapshot.phase = "idle".into();
                    }
                    state.snapshot.error = Some(e.to_string());
                    state.finish_tools("incomplete");
                    state.changed();
                }
            }
            owner.persist_queue(&state)?;
        }
        owner.turn_done.notify_waiters();
        owner.persist_transcript()?;
        owner.publish()?;
    }
}

async fn run(
    owner: Arc<Managed>,
    req: StartTerminalSessionRequest,
    ready: oneshot::Sender<AppResult<TerminalSessionResult>>,
) {
    let result = run_inner(owner.clone(), req, ready).await;
    if let Err(e) = result {
        owner.fail(e.to_string());
    }
    if let Err(e) = owner.clear_requests() {
        owner.fail(e.to_string());
    }
    if let Ok(mut connection) = owner.connection.lock() {
        *connection = None;
    }
    if let Ok(mut state) = owner.state.lock() {
        if let Some(id) = state.active_prompt.take() {
            if let Some(item) = state.snapshot.queue.iter_mut().find(|q| q.id == id) {
                item.status = "delivery-unknown".into();
                item.error = Some("The runtime ended without a confirmed turn result. Review history before resending.".into());
            }
        }
        state.snapshot.phase = if state.snapshot.error.is_some() {
            "failed"
        } else {
            "ended"
        }
        .into();
        state.finish_tools("incomplete");
        state.snapshot.queue_paused = true;
        state.changed();
        if let Err(e) = owner.persist_queue(&state) {
            eprintln!("[ACP] shutdown persistence: {e}");
        }
    }
    if let Err(e) = owner.persist_transcript() {
        owner.fail(format!("Could not save transcript: {e}"));
    }
    owner.finished.store(
        owner.process_exited.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    owner.exited.notify_waiters();
    if let Err(e) = owner.publish() {
        eprintln!("[ACP] shutdown publication: {e}");
    }
}

async fn run_inner(
    owner: Arc<Managed>,
    req: StartTerminalSessionRequest,
    ready: oneshot::Sender<AppResult<TerminalSessionResult>>,
) -> AppResult<()> {
    if owner.stopping.load(Ordering::SeqCst) {
        return Err(error("Session startup was cancelled."));
    }
    let mut command = tokio::process::Command::new(installed_cli()?);
    let permission_profile = req
        .permission_profile
        .unwrap_or(crate::settings::CopilotPermissionProfile::Default);
    command
        .args(copilot_server_args(permission_profile))
        .current_dir(&req.folder_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "COPILOT_AGENT_SESSION_ID",
        "COPILOT_LOADER_PID",
        "COPILOT_CLI",
    ] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(error)?;
    owner.process_exited.store(false, Ordering::SeqCst);
    let process_scope = match process::ProcessScope::attach(&child) {
        Ok(scope) => scope,
        Err(e) => {
            child.kill().await.map_err(error)?;
            child.wait().await.map_err(error)?;
            owner.process_exited.store(true, Ordering::SeqCst);
            return Err(error(format!(
                "Could not establish managed process ownership: {e}"
            )));
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| error("Copilot stdin is unavailable."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| error("Copilot stdout is unavailable."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| error("Copilot stderr is unavailable."))?;
    let stderr_tail = Arc::new(Mutex::new(std::collections::VecDeque::<u8>::new()));
    let stderr_buffer = stderr_tail.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buffer = [0; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) => return Ok::<_, std::io::Error>(()),
                Ok(read) => {
                    let mut tail = stderr_buffer
                        .lock()
                        .map_err(|_| std::io::Error::other("Diagnostic buffer lock failed."))?;
                    tail.extend(&buffer[..read]);
                    while tail.len() > 8192 {
                        tail.pop_front();
                    }
                }
                Err(e) => return Err(e),
            }
        }
    });
    let updates_owner = owner.clone();
    let permissions_owner = owner.clone();
    let elicitations_owner = owner.clone();
    let completion_owner = owner.clone();
    let connected_owner = owner.clone();
    let connection = Client.builder()
        .on_receive_notification(
            async move |notification: acp::SessionNotification, _| {
                {
                    let state = updates_owner.state.lock().map_err(protocol_error)?;
                    if !matches!(state.snapshot.phase.as_str(), "starting" | "loading")
                        && notification.session_id.to_string() != state.snapshot.session.id {
                        return Err(protocol_error("Copilot sent an update for another conversation."));
                    }
                }
                let update = serde_json::to_value(notification.update).map_err(protocol_error)?;
                updates_owner.state.lock().map_err(protocol_error)?.ingest(update);
                updates_owner.wake.notify_one();
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: acp::RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                let owner = permissions_owner.clone();
                let cancellation = responder.cancellation();
                cx.spawn(async move {
                    let response = tokio::select! {
                        response = permission(owner, request) => response,
                        _ = cancellation.cancelled() => acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled),
                    };
                    responder.respond(response)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::CreateElicitationRequest, responder, cx: ConnectionTo<Agent>| {
                let owner = elicitations_owner.clone();
                let cancellation = responder.cancellation();
                cx.spawn(async move {
                    let response = tokio::select! {
                        response = elicitation(owner, request) => response?,
                        _ = cancellation.cancelled() => serde_json::from_value(json!({"action":"cancel"})).map_err(protocol_error)?,
                    };
                    responder.respond(response)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: acp::CompleteElicitationNotification, _| {
                let value = serde_json::to_value(notification).map_err(protocol_error)?;
                let mut state = completion_owner.state.lock().map_err(protocol_error)?;
                if let Some(id) = value["elicitationId"].as_str() {
                    if state.url_requests.remove(id) {
                        state.notice("The external Copilot interaction completed.", false);
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(ByteStreams::new(stdin.compat_write(), process::BoundedRead::new(stdout).compat()), async move |cx: ConnectionTo<Agent>| {
            *connected_owner.connection.lock().map_err(protocol_error)? = Some(cx.clone());
            let initialize: acp::InitializeRequest = serde_json::from_value(json!({
                "protocolVersion": 1,
                "clientInfo": {"name":"DevTrees","version": env!("CARGO_PKG_VERSION")},
                "clientCapabilities": {
                    "fs":{"readTextFile":false,"writeTextFile":false},
                    "terminal":false, "elicitation":{"form":{},"url":{}}
                }
            })).map_err(protocol_error)?;
            let initialized = tokio::time::timeout(Duration::from_secs(45), cx.send_request(initialize).block_task())
                .await.map_err(protocol_error)??;
            let init = serde_json::to_value(initialized).map_err(protocol_error)?;
            if init["protocolVersion"] != 1 { return Err(protocol_error("Copilot requires an unsupported ACP protocol version.")); }
            connected_owner.state.lock().map_err(protocol_error)?.snapshot.capabilities = init["agentCapabilities"].clone();
            let params = json!({"cwd": req.folder_path, "mcpServers":[],"sessionId":req.resume_session_id});
            let setup = if req.resume_session_id.is_some() {
                if init["agentCapabilities"]["loadSession"] != true {
                    return Err(protocol_error("This Copilot version cannot load saved sessions."));
                }
                let request: acp::LoadSessionRequest = serde_json::from_value(params).map_err(protocol_error)?;
                serde_json::to_value(cx.send_request(request).block_task().await?).map_err(protocol_error)?
            } else {
                let request: acp::NewSessionRequest = serde_json::from_value(params).map_err(protocol_error)?;
                serde_json::to_value(cx.send_request(request).block_task().await?).map_err(protocol_error)?
            };
            let actual_id = req.resume_session_id.clone()
                .or_else(|| setup["sessionId"].as_str().map(str::to_owned))
                .ok_or_else(|| protocol_error("Copilot did not return a session ID."))?;
            let available_modes: Vec<SessionMode> = setup["modes"]["availableModes"]
                .as_array()
                .map(|modes| serde_json::from_value(Value::Array(modes.clone())))
                .transpose()
                .map_err(|e| protocol_error(format!("Copilot returned invalid session modes: {e}")))?
                .unwrap_or_default();
            let mut current_mode_id = setup["modes"]["currentModeId"].as_str().map(str::to_owned);
            if req.resume_session_id.is_none() {
                if let Some(initial_mode) = req.initial_mode.as_ref() {
                    let requested = initial_mode.as_str();
                    let mode_id = available_modes
                        .iter()
                        .find(|mode| {
                            mode.id.eq_ignore_ascii_case(requested)
                                || mode.name.eq_ignore_ascii_case(requested)
                        })
                        .map(|mode| mode.id.as_str())
                        .ok_or_else(|| {
                            protocol_error(format!(
                                "Copilot does not support the requested {requested} mode."
                            ))
                        })?;
                    if setup["modes"]["currentModeId"].as_str() != Some(mode_id) {
                        let request: acp::SetSessionModeRequest = serde_json::from_value(json!({
                            "sessionId": &actual_id,
                            "modeId": mode_id
                        }))
                        .map_err(protocol_error)?;
                        tokio::time::timeout(
                            Duration::from_secs(15),
                            cx.send_request(request).block_task(),
                        )
                        .await
                        .map_err(protocol_error)??;
                    }
                    current_mode_id = Some(mode_id.into());
                }
            }
            let previous_id = connected_owner.id().map_err(protocol_error)?;
            if actual_id != previous_id {
                let _publication = connected_owner.publication.lock().map_err(protocol_error)?;
                terminal_sessions::rekey_managed_session(&connected_owner.app, &previous_id, &actual_id)
                    .map_err(protocol_error)?;
                {
                    let mut state = connected_owner.state.lock().map_err(protocol_error)?;
                    state.snapshot.session.id = actual_id.clone();
                    state.snapshot.replaces_id = Some(previous_id.clone());
                    state.snapshot.available_modes = available_modes.clone();
                    state.snapshot.current_mode_id = current_mode_id.clone();
                }
                let manager = connected_owner.app.state::<SessionManager>();
                let mut sessions = manager.sessions.lock().map_err(protocol_error)?;
                sessions.remove(&previous_id);
                sessions.insert(actual_id.clone(), connected_owner.clone());
            }
            connected_owner.restore_queue().map_err(protocol_error)?;
            {
                let mut state = connected_owner.state.lock().map_err(protocol_error)?;
                state.snapshot.available_modes = available_modes;
                state.snapshot.current_mode_id = current_mode_id;
                state.snapshot.phase = if req.resume_session_id.is_some() { "idle" } else { "starting" }.into();
                state.snapshot.session.last_activity = "Ready for your instruction".into();
                state.changed();
            }
            if req.resume_session_id.is_none() {
                if let Some(prompt) = req.prompt.filter(|p| !p.trim().is_empty()) {
                    if prompt.trim_start().starts_with('/') {
                        let discovery = tokio::time::timeout(Duration::from_secs(15), async {
                            loop {
                                let wake = connected_owner.wake.notified();
                                if connected_owner.state.lock().map_err(protocol_error)?.snapshot.commands_ready { return Ok::<_, acp::Error>(()); }
                                if connected_owner.stopping.load(Ordering::SeqCst) { return Err(protocol_error("Session startup was cancelled.")); }
                                wake.await;
                            }
                        }).await;
                        if let Ok(result) = discovery { result?; }
                    }
                    if let Err(e) = enqueue(&connected_owner, uuid::Uuid::new_v4().to_string(), vec![json!({"type":"text","text":prompt})], false) {
                        let mut state = connected_owner.state.lock().map_err(protocol_error)?;
                        state.snapshot.error = Some(e.to_string());
                        state.notice(format!("Initial instruction was not submitted: {e}\n\n{prompt}"), true);
                    }
                }
            }
            {
                let mut state = connected_owner.state.lock().map_err(protocol_error)?;
                if connected_owner.stopping.load(Ordering::SeqCst) { return Err(protocol_error("Session startup was cancelled.")); }
                state.snapshot.phase = "idle".into();
                state.changed();
            }
            let snapshot = connected_owner.publish().map_err(protocol_error)?;
            let _ = ready.send(Ok(TerminalSessionResult { ok: true, session: Some(snapshot.session), error: None }));
            let queue_owner = connected_owner.clone();
            cx.spawn(async move { dispatch_queue(queue_owner).await.map_err(protocol_error) })?;
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        if connected_owner.stopping.load(Ordering::SeqCst) { break; }
                        if connected_owner.state.lock().map_err(protocol_error)?.dirty {
                            connected_owner.publish().map_err(protocol_error)?;
                        }
                    }
                }
            }
            if init["agentCapabilities"]["sessionCapabilities"].get("close").is_some() {
                let request: acp::CloseSessionRequest = serde_json::from_value(json!({"sessionId": actual_id})).map_err(protocol_error)?;
                match tokio::time::timeout(Duration::from_secs(5), cx.send_request(request).block_task()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => eprintln!("[ACP] graceful close failed: {e}"),
                    Err(e) => eprintln!("[ACP] graceful close deadline: {e}"),
                }
            }
            Ok(())
        });
    let result = {
        tokio::pin!(connection);
        tokio::select! {
            result = &mut connection => result.map_err(error),
            _ = owner.shutdown.notified() => {
                owner.wake.notify_one();
                tokio::time::timeout(Duration::from_secs(6), &mut connection).await
                    .map_err(error).and_then(|r| r.map_err(error))
            }
        }
    };
    // Closing the owned job also releases descendants that outlived their parent.
    drop(process_scope);
    match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
        Ok(status) => {
            let status = status.map_err(error)?;
            owner.process_exited.store(true, Ordering::SeqCst);
            if !status.success() && !owner.stopping.load(Ordering::SeqCst) {
                return Err(error(format!(
                    "Copilot exited with {status}. Check Copilot CLI sign-in."
                )));
            }
        }
        Err(_) => {
            child.kill().await.map_err(error)?;
            child.wait().await.map_err(error)?;
            owner.process_exited.store(true, Ordering::SeqCst);
        }
    }
    stderr_task.abort();
    result.map_err(|e| {
        let stderr_bytes = stderr_tail.lock().map(|tail| tail.len()).unwrap_or(0);
        error(format!("{e}. Copilot stderr retained {stderr_bytes} diagnostic bytes; check `copilot login`. No input was automatically resent."))
    })
}

fn enqueue(owner: &Managed, id: String, prompt: Vec<Value>, literal: bool) -> AppResult<()> {
    let _write = owner.queue_write.lock().map_err(error)?;
    let mut state = owner.state.lock().map_err(error)?;
    if owner.stopping.load(Ordering::SeqCst)
        || matches!(state.snapshot.phase.as_str(), "ended" | "ending" | "failed")
    {
        return Err(error(
            "This session has ended. Resume it before submitting messages.",
        ));
    }
    let previous = state.snapshot.queue.clone();
    if !state.stage_prompt(id, prompt, literal)? {
        return Ok(());
    }
    if let Err(e) = owner.persist_queue(&state) {
        state.snapshot.queue = previous;
        return Err(e);
    }
    state.changed();
    drop(state);
    owner.publish()?;
    owner.wake.notify_one();
    Ok(())
}

fn restore_plan_transition(owner: &Managed) {
    if let Ok(mut state) = owner.state.lock() {
        if state.current_mode_matches("plan")
            && state.snapshot.phase == "idle"
            && state.snapshot.interactions.is_empty()
        {
            state.snapshot.plan_transition_available = true;
            state.changed();
        }
    }
    if let Err(e) = owner.publish() {
        eprintln!("[ACP] restoring plan transition: {e}");
    }
}

async fn set_session_mode(owner: &Managed, requested: &str) -> AppResult<()> {
    let mode_id = {
        let state = owner.state.lock().map_err(error)?;
        state.mode_id(requested).map(str::to_owned).ok_or_else(|| {
            error(format!(
                "Copilot does not support the requested {requested} mode."
            ))
        })?
    };
    let request: acp::SetSessionModeRequest = serde_json::from_value(json!({
        "sessionId": owner.id()?,
        "modeId": &mode_id
    }))?;
    tokio::time::timeout(
        Duration::from_secs(15),
        owner.connection()?.send_request(request).block_task(),
    )
    .await
    .map_err(|_| error("Copilot did not confirm the mode change."))?
    .map_err(error)?;
    owner.state.lock().map_err(error)?.set_current_mode(mode_id);
    Ok(())
}

fn stage_plan_continuation(owner: &Managed, fleet: bool) -> AppResult<()> {
    let _write = owner.queue_write.lock().map_err(error)?;
    let mut state = owner.state.lock().map_err(error)?;
    let previous = state.snapshot.queue.clone();
    let prompts = if fleet {
        vec!["/fleet", "Implement the approved plan."]
    } else {
        vec!["Implement the approved plan."]
    };
    for prompt in prompts {
        if let Err(e) = state.stage_prompt(
            uuid::Uuid::new_v4().to_string(),
            vec![json!({"type":"text","text":prompt})],
            false,
        ) {
            state.snapshot.queue = previous;
            return Err(e);
        }
    }
    if let Err(e) = owner.persist_queue(&state) {
        state.snapshot.queue = previous;
        return Err(e);
    }
    state.changed();
    drop(state);
    owner.publish()?;
    owner.wake.notify_one();
    Ok(())
}

pub async fn start(
    app: AppHandle,
    req: StartTerminalSessionRequest,
) -> AppResult<TerminalSessionResult> {
    if app.state::<SessionManager>().exiting.load(Ordering::SeqCst) {
        return Err(error("DevTrees is shutting down."));
    }
    installed_cli()?;
    let id = req
        .resume_session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let generation = uuid::Uuid::new_v4().to_string();
    let registered = terminal_sessions::watch_managed_session(&app, &req, &id, &generation, "acp")?;
    let session = registered
        .session
        .ok_or_else(|| error("Could not register the session."))?;
    let owner = Arc::new(Managed {
        app: app.clone(),
        state: Mutex::new(State::new(session)),
        publication: Mutex::new(()),
        connection: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        queue_write: Mutex::new(()),
        wake: Notify::new(),
        shutdown: Notify::new(),
        turn_done: Notify::new(),
        exited: Notify::new(),
        stopping: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        process_exited: AtomicBool::new(true),
    });
    {
        let manager = app.state::<SessionManager>();
        let mut sessions = manager.sessions.lock().map_err(error)?;
        if manager.exiting.load(Ordering::SeqCst) {
            drop(sessions);
            owner.finished.store(true, Ordering::SeqCst);
            owner.fail("Session startup was cancelled because DevTrees is shutting down.".into());
            return Err(error("DevTrees is shutting down."));
        }
        sessions.insert(id, owner.clone());
    }
    if let Err(e) = owner.publish() {
        owner.finished.store(true, Ordering::SeqCst);
        owner.fail(e.to_string());
        return Err(e);
    }
    let (tx, rx) = oneshot::channel();
    tauri::async_runtime::spawn(run(owner, req, tx));
    rx.await
        .map_err(|_| error("Copilot setup failed or was cancelled. See the session for details."))?
}

#[tauri::command]
pub fn native_session_snapshot(app: AppHandle, target: Target) -> AppResult<Snapshot> {
    get(&app, &target)?.publish()
}

#[tauri::command]
pub fn acp_session_reopen_plan_transition(app: AppHandle, target: Target) -> AppResult<Snapshot> {
    let owner = get(&app, &target)?;
    if owner.stopping.load(Ordering::SeqCst) {
        return Err(error("The session is stopping."));
    }
    {
        let mut state = owner.state.lock().map_err(error)?;
        if !state.can_reopen_plan_transition() {
            return Err(error(
                "Implementation choices are available only for an idle Plan session with no pending work.",
            ));
        }
        state.snapshot.plan_transition_available = true;
        state.changed();
    }
    owner.publish()
}

#[tauri::command]
pub async fn acp_session_plan_transition(
    app: AppHandle,
    target: Target,
    action: String,
) -> AppResult<Snapshot> {
    let owner = get(&app, &target)?;
    if owner.stopping.load(Ordering::SeqCst) {
        return Err(error("The session is stopping."));
    }
    {
        let mut state = owner.state.lock().map_err(error)?;
        if !state.snapshot.plan_transition_available
            || !state.current_mode_matches("plan")
            || !state.snapshot.interactions.is_empty()
        {
            return Err(error("This plan transition is no longer available."));
        }
        if !matches!(
            action.as_str(),
            "interactive" | "autopilot" | "autopilot_fleet" | "exit_only"
        ) {
            return Err(error("Unsupported plan transition."));
        }
        if action == "autopilot_fleet"
            && !state.snapshot.commands.iter().any(|command| {
                command["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("fleet"))
            })
        {
            return Err(error(
                "This Copilot session does not advertise the /fleet command.",
            ));
        }
        state.snapshot.plan_transition_available = false;
        state.changed();
    }
    owner.publish()?;

    let requested_mode = if matches!(action.as_str(), "autopilot" | "autopilot_fleet") {
        "autopilot"
    } else {
        "interactive"
    };
    if let Err(e) = set_session_mode(&owner, requested_mode).await {
        restore_plan_transition(&owner);
        return Err(e);
    }
    if action != "exit_only" {
        {
            let mut state = owner.state.lock().map_err(error)?;
            state.snapshot.queue_paused = false;
            state.changed();
        }
        if let Err(e) = stage_plan_continuation(&owner, action == "autopilot_fleet") {
            if let Err(mode_error) = set_session_mode(&owner, "plan").await {
                owner.fail(format!(
                    "Could not queue implementation after changing mode: {e}. Restoring plan mode also failed: {mode_error}"
                ));
                return Err(e);
            }
            restore_plan_transition(&owner);
            return Err(e);
        }
    } else {
        owner.publish()?;
    }
    owner.publish()
}

#[tauri::command]
pub fn native_session_respond(
    app: AppHandle,
    target: Target,
    interaction_id: String,
    answer: InteractionAnswer,
) -> AppResult<Snapshot> {
    let owner = get(&app, &target)?;
    if owner.stopping.load(Ordering::SeqCst) {
        return Err(error("The session is stopping."));
    }
    {
        let mut state = owner.state.lock().map_err(error)?;
        let request = state
            .snapshot
            .interactions
            .iter()
            .find(|r| r.id == interaction_id)
            .ok_or_else(|| error("This request has already ended."))?;
        request.request.validate(&answer)?;
        let response = owner
            .pending
            .lock()
            .map_err(error)?
            .remove(&interaction_id)
            .ok_or_else(|| error("This request is no longer active."))?;
        response.send(answer).map_err(|_| {
            error("Copilot stopped waiting before the answer was delivered. Do not retry.")
        })?;
        state
            .snapshot
            .interactions
            .retain(|r| r.id != interaction_id);
        state.changed();
    }
    owner.publish()
}

#[tauri::command]
pub fn acp_session_enqueue(
    app: AppHandle,
    target: Target,
    id: String,
    prompt: Vec<Value>,
    literal: bool,
) -> AppResult<Snapshot> {
    let owner = get(&app, &target)?;
    enqueue(&owner, id, prompt, literal)?;
    owner.publish()
}

#[tauri::command]
pub fn acp_session_queue(
    app: AppHandle,
    target: Target,
    action: String,
    item_id: Option<String>,
    text: Option<String>,
) -> AppResult<Snapshot> {
    let owner = get(&app, &target)?;
    {
        let _write = owner.queue_write.lock().map_err(error)?;
        let mut state = owner.state.lock().map_err(error)?;
        let previous_queue = state.snapshot.queue.clone();
        let previous_paused = state.snapshot.queue_paused;
        match action.as_str() {
            "pause" => state.snapshot.queue_paused = true,
            "resume" => {
                if owner.stopping.load(Ordering::SeqCst) {
                    return Err(error("Resume the conversation before resuming its queue."));
                }
                if state
                    .snapshot
                    .queue
                    .iter()
                    .any(|q| q.status == "delivery-unknown")
                {
                    return Err(error(
                        "Review and remove delivery-unknown messages before resuming the queue.",
                    ));
                }
                state.snapshot.queue_paused = false;
            }
            "clear" => state
                .snapshot
                .queue
                .retain(|q| matches!(q.status.as_str(), "active" | "dispatching")),
            "remove" | "edit" | "up" => {
                let index = state
                    .snapshot
                    .queue
                    .iter()
                    .position(|q| Some(&q.id) == item_id.as_ref())
                    .ok_or_else(|| error("This queue item no longer exists."))?;
                if matches!(
                    state.snapshot.queue[index].status.as_str(),
                    "active" | "dispatching"
                ) {
                    return Err(error("An in-flight message cannot be changed."));
                }
                match action.as_str() {
                    "remove" => {
                        state.snapshot.queue.remove(index);
                    }
                    "edit" => {
                        if state.snapshot.queue[index].status != "queued" {
                            return Err(error("Only unsent messages can be edited."));
                        }
                        let text =
                            text.ok_or_else(|| error("A replacement message is required."))?;
                        let mut prompt = vec![json!({"type":"text", "text":text})];
                        prompt.extend(
                            state.snapshot.queue[index]
                                .prompt
                                .iter()
                                .filter(|b| b["type"] != "text")
                                .cloned(),
                        );
                        state.validate_prompt(&prompt, false)?;
                        state.snapshot.queue[index].prompt = Arc::new(prompt);
                        state.snapshot.queue[index].error = None;
                    }
                    _ => {
                        if index > 0
                            && state.snapshot.queue[index - 1].status == "queued"
                            && state.snapshot.queue[index].status == "queued"
                        {
                            state.snapshot.queue.swap(index, index - 1);
                        } else {
                            return Err(error("This message cannot be moved earlier."));
                        }
                    }
                }
            }
            _ => return Err(error("Unknown queue action.")),
        }
        if serde_json::to_vec(&state.snapshot.queue)?.len() > state::MAX_QUEUE_BYTES {
            state.snapshot.queue = previous_queue;
            state.snapshot.queue_paused = previous_paused;
            return Err(error(
                "The queue exceeds 32 MiB. Remove an item before adding more attachments.",
            ));
        }
        if let Err(e) = owner.persist_queue(&state) {
            state.snapshot.queue = previous_queue;
            state.snapshot.queue_paused = previous_paused;
            return Err(e);
        }
        state.changed();
    }
    owner.wake.notify_one();
    owner.publish()
}

#[tauri::command]
pub async fn native_session_cancel(app: AppHandle, target: Target) -> AppResult<()> {
    get(&app, &target)?.request_stop().await
}

#[tauri::command]
pub async fn native_session_end(app: AppHandle, target: Target) -> AppResult<()> {
    get(&app, &target)?.end().await
}

pub fn has_unreleased_session(app: &AppHandle, id: &str) -> AppResult<bool> {
    Ok(app
        .state::<SessionManager>()
        .sessions
        .lock()
        .map_err(error)?
        .get(id)
        .is_some_and(|owner| !owner.finished.load(Ordering::SeqCst)))
}

pub async fn forget(app: &AppHandle, id: &str) -> AppResult<()> {
    let owner = app
        .state::<SessionManager>()
        .sessions
        .lock()
        .map_err(error)?
        .get(id)
        .cloned();
    if let Some(owner) = owner {
        owner.end().await?;
        app.state::<SessionManager>()
            .sessions
            .lock()
            .map_err(error)?
            .remove(id);
    }
    Ok(())
}

pub async fn shutdown(app: &AppHandle) {
    let owners = match app.state::<SessionManager>().sessions.lock() {
        Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
        Err(e) => {
            eprintln!("[ACP] shutdown: {e}");
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
            Ok(Err(e)) => eprintln!("[ACP] shutdown: {e}"),
            Err(e) => eprintln!("[ACP] shutdown task: {e}"),
        }
    }
}
