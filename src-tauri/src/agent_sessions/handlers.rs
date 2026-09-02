use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use github_copilot_sdk::handler::{
    PermissionHandler, PermissionResult, UserInputHandler, UserInputResponse,
};
use github_copilot_sdk::types::{PermissionRequestData, RequestId, SessionId};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::db::DbState;

use super::policy::{self, PolicyDecision};
use super::{
    finish_interaction, start_interaction, AgentPendingInteraction, AgentPermissionRequest,
    AgentSessionLifecycle, AgentSessionPurpose, AgentUserInputRequest, EVENT_INTERACTION,
};

const INTERACTION_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub struct PermissionResolution {
    pub approve: bool,
    pub feedback: Option<String>,
}

pub struct UserInputResolution {
    pub answer: String,
    pub was_freeform: bool,
}

#[derive(Default)]
pub struct PendingRegistry {
    permission: Mutex<HashMap<String, oneshot::Sender<PermissionResolution>>>,
    user_input: Mutex<HashMap<String, oneshot::Sender<UserInputResolution>>>,
}

impl PendingRegistry {
    pub fn register_permission(&self, id: String, sender: oneshot::Sender<PermissionResolution>) {
        self.permission.lock().unwrap().insert(id, sender);
    }

    pub fn resolve_permission(
        &self,
        id: &str,
        resolution: PermissionResolution,
    ) -> Result<(), PermissionResolution> {
        let sender = self.permission.lock().unwrap().remove(id);
        match sender {
            Some(sender) => sender.send(resolution),
            None => Err(resolution),
        }
    }

    fn cancel_permission(&self, id: &str) {
        self.permission.lock().unwrap().remove(id);
    }

    pub fn register_user_input(&self, id: String, sender: oneshot::Sender<UserInputResolution>) {
        self.user_input.lock().unwrap().insert(id, sender);
    }

    pub fn resolve_user_input(
        &self,
        id: &str,
        resolution: UserInputResolution,
    ) -> Result<(), UserInputResolution> {
        let sender = self.user_input.lock().unwrap().remove(id);
        match sender {
            Some(sender) => sender.send(resolution),
            None => Err(resolution),
        }
    }

    fn cancel_user_input(&self, id: &str) {
        self.user_input.lock().unwrap().remove(id);
    }

    pub fn cancel_all(&self) {
        self.permission.lock().unwrap().clear();
        self.user_input.lock().unwrap().clear();
    }

    pub fn cancel(&self, ids: &[String]) {
        let mut permission = self.permission.lock().unwrap();
        let mut user_input = self.user_input.lock().unwrap();
        for id in ids {
            permission.remove(id);
            user_input.remove(id);
        }
    }
}

pub struct HarnessPermissionHandler {
    app: AppHandle,
    app_session_id: String,
    purpose: AgentSessionPurpose,
    working_directory: PathBuf,
    pending: Arc<PendingRegistry>,
}

impl HarnessPermissionHandler {
    pub fn new(
        app: AppHandle,
        app_session_id: String,
        purpose: AgentSessionPurpose,
        working_directory: PathBuf,
        pending: Arc<PendingRegistry>,
    ) -> Self {
        Self {
            app,
            app_session_id,
            purpose,
            working_directory,
            pending,
        }
    }
}

#[async_trait]
impl PermissionHandler for HarnessPermissionHandler {
    async fn handle(
        &self,
        _session_id: SessionId,
        request_id: RequestId,
        data: PermissionRequestData,
    ) -> PermissionResult {
        match policy::decide(self.purpose, &self.working_directory, &data) {
            PolicyDecision::Approve => return PermissionResult::approve_once(),
            PolicyDecision::Reject => {
                return PermissionResult::reject(Some(
                    "DevTrees policy does not allow this operation in this session.".to_string(),
                ));
            }
            PolicyDecision::Prompt => {}
        }

        let interaction_id = uuid::Uuid::new_v4().to_string();
        let request_id = request_id.to_string();
        let payload = serde_json::to_value(&data).unwrap_or(serde_json::Value::Null);
        let description = data
            .extra
            .get("intention")
            .or_else(|| data.extra.get("fullCommandText"))
            .and_then(|value| value.as_str())
            .unwrap_or("Copilot is requesting permission to perform an operation.")
            .to_string();
        let interaction = AgentPendingInteraction::Permission(AgentPermissionRequest {
            id: interaction_id.clone(),
            session_id: self.app_session_id.clone(),
            request_id,
            tool_name: data
                .extra
                .get("toolName")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            description,
            payload,
            created_at: super::now_ms(),
        });

        let (sender, receiver) = oneshot::channel();
        self.pending
            .register_permission(interaction_id.clone(), sender);
        if start_interaction(
            &self.app,
            &interaction,
            AgentSessionLifecycle::WaitingForPermission,
        )
        .is_err()
        {
            self.pending.cancel_permission(&interaction_id);
            return PermissionResult::user_not_available();
        }
        let _ = self.app.emit(EVENT_INTERACTION, interaction.clone());

        let result = tokio::time::timeout(INTERACTION_TIMEOUT, receiver).await;
        let _ = finish_interaction(&self.app, &self.app_session_id, &interaction_id);

        match result {
            Ok(Ok(resolution)) if resolution.approve => PermissionResult::approve_once(),
            Ok(Ok(resolution)) => PermissionResult::reject(resolution.feedback),
            _ => PermissionResult::user_not_available(),
        }
    }
}

pub struct HarnessUserInputHandler {
    app: AppHandle,
    app_session_id: String,
    purpose: AgentSessionPurpose,
    pending: Arc<PendingRegistry>,
}

impl HarnessUserInputHandler {
    pub fn new(
        app: AppHandle,
        app_session_id: String,
        purpose: AgentSessionPurpose,
        pending: Arc<PendingRegistry>,
    ) -> Self {
        Self {
            app,
            app_session_id,
            purpose,
            pending,
        }
    }
}

#[async_trait]
impl UserInputHandler for HarnessUserInputHandler {
    async fn handle(
        &self,
        _session_id: SessionId,
        question: String,
        choices: Option<Vec<String>>,
        allow_freeform: Option<bool>,
    ) -> Option<UserInputResponse> {
        if self.purpose.is_pr_review() {
            return None;
        }

        let interaction_id = uuid::Uuid::new_v4().to_string();
        let interaction = AgentPendingInteraction::UserInput(AgentUserInputRequest {
            id: interaction_id.clone(),
            session_id: self.app_session_id.clone(),
            request_id: interaction_id.clone(),
            question,
            choices,
            allow_freeform: allow_freeform.unwrap_or(true),
            created_at: super::now_ms(),
        });
        let (sender, receiver) = oneshot::channel();
        self.pending
            .register_user_input(interaction_id.clone(), sender);
        if start_interaction(
            &self.app,
            &interaction,
            AgentSessionLifecycle::WaitingForUser,
        )
        .is_err()
        {
            self.pending.cancel_user_input(&interaction_id);
            return None;
        }
        let _ = self.app.emit(EVENT_INTERACTION, interaction.clone());

        let result = tokio::time::timeout(INTERACTION_TIMEOUT, receiver).await;
        let _ = finish_interaction(&self.app, &self.app_session_id, &interaction_id);
        match result {
            Ok(Ok(resolution)) => Some(UserInputResponse {
                answer: resolution.answer,
                was_freeform: resolution.was_freeform,
            }),
            _ => None,
        }
    }
}

pub fn interaction_belongs_to_session(
    app: &AppHandle,
    interaction_id: &str,
    session_id: &str,
) -> bool {
    let state = app.state::<DbState>();
    let Ok(conn) = state.0.lock() else {
        return false;
    };
    conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM agent_pending_interactions WHERE id = ?1 AND session_id = ?2
         )",
        rusqlite::params![interaction_id, session_id],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}
