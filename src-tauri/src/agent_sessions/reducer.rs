use github_copilot_sdk::types::SessionEvent;

use super::{now_ms, AgentSession, AgentSessionActivity, AgentSessionLifecycle};

pub fn reduce(session: &mut AgentSession, event: &SessionEvent) {
    session.updated_at = now_ms();
    match event.event_type.as_str() {
        "assistant.turn_start" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::None;
            session.current_intent = None;
            session.last_error = None;
        }
        "assistant.intent" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::Intent;
            session.current_intent = event
                .data
                .get("intent")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
        }
        "assistant.reasoning" | "assistant.reasoning_delta" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::Reasoning;
        }
        "assistant.message_delta" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::StreamingMessage;
        }
        "assistant.message" | "assistant.turn_end" => {
            session.activity = AgentSessionActivity::None;
        }
        "tool.execution_start" | "tool.execution_progress" | "tool.execution_partial_result" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::RunningTool;
        }
        "tool.execution_complete" => {
            session.lifecycle = AgentSessionLifecycle::Active;
            session.activity = AgentSessionActivity::None;
        }
        "session.idle" => {
            session.lifecycle = AgentSessionLifecycle::Idle;
            session.activity = AgentSessionActivity::None;
            session.current_intent = None;
            if session.purpose.is_pr_review() && session.completed_at.is_none() {
                session.completed_at = Some(session.updated_at);
            }
        }
        "session.error" => {
            session.lifecycle = AgentSessionLifecycle::Failed;
            session.activity = AgentSessionActivity::None;
            session.current_intent = None;
            session.last_error = event
                .data
                .get("message")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
                .or_else(|| Some("Copilot session failed.".to_string()));
            session.completed_at = Some(session.updated_at);
        }
        "session.shutdown" => {
            session.activity = AgentSessionActivity::None;
            session.current_intent = None;
            if session.purpose.is_pr_review() && session.completed_at.is_none() {
                session.lifecycle = AgentSessionLifecycle::Failed;
                session.last_error =
                    Some("Review ended before Copilot reported completion.".to_string());
                session.completed_at = Some(session.updated_at);
            } else {
                session.lifecycle = AgentSessionLifecycle::Stopped;
                session.completed_at.get_or_insert(session.updated_at);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent_sessions::{AgentSessionPurpose, CreateAgentSessionRequest};

    fn event(event_type: &str, data: serde_json::Value) -> SessionEvent {
        SessionEvent {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            parent_id: None,
            ephemeral: None,
            agent_id: None,
            debug_cli_received_at_ms: None,
            debug_ws_forwarded_at_ms: None,
            event_type: event_type.to_string(),
            data,
        }
    }

    #[test]
    fn idle_completes_review_without_marking_interactive_complete() {
        let mut review = AgentSession::new(CreateAgentSessionRequest {
            purpose: AgentSessionPurpose::PrReview,
            folder_path: "C:\\repo".to_string(),
            prompt: None,
            resume_sdk_session_id: None,
            label: "Review".to_string(),
            branch: None,
            repository: None,
            provider: None,
            pr_id: None,
            pr_title: None,
        });
        reduce(&mut review, &event("session.idle", json!({})));
        assert_eq!(review.lifecycle, AgentSessionLifecycle::Idle);
        assert!(review.completed_at.is_some());

        let mut interactive = AgentSession::new(CreateAgentSessionRequest {
            purpose: AgentSessionPurpose::Interactive,
            folder_path: "C:\\repo".to_string(),
            prompt: None,
            resume_sdk_session_id: None,
            label: "Agent".to_string(),
            branch: None,
            repository: None,
            provider: None,
            pr_id: None,
            pr_title: None,
        });
        reduce(&mut interactive, &event("session.idle", json!({})));
        assert!(interactive.completed_at.is_none());
    }

    #[test]
    fn error_surfaces_message() {
        let mut session = AgentSession::new(CreateAgentSessionRequest {
            purpose: AgentSessionPurpose::Interactive,
            folder_path: "C:\\repo".to_string(),
            prompt: None,
            resume_sdk_session_id: None,
            label: "Agent".to_string(),
            branch: None,
            repository: None,
            provider: None,
            pr_id: None,
            pr_title: None,
        });
        reduce(
            &mut session,
            &event("session.error", json!({ "message": "boom" })),
        );
        assert_eq!(session.lifecycle, AgentSessionLifecycle::Failed);
        assert_eq!(session.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn shutdown_does_not_complete_an_unfinished_review() {
        let mut review = AgentSession::new(CreateAgentSessionRequest {
            purpose: AgentSessionPurpose::PrReview,
            folder_path: "C:\\repo".to_string(),
            prompt: None,
            resume_sdk_session_id: None,
            label: "Review".to_string(),
            branch: None,
            repository: None,
            provider: None,
            pr_id: None,
            pr_title: None,
        });

        reduce(&mut review, &event("session.shutdown", json!({})));

        assert_eq!(review.lifecycle, AgentSessionLifecycle::Failed);
        assert_eq!(
            review.last_error.as_deref(),
            Some("Review ended before Copilot reported completion.")
        );
    }
}
