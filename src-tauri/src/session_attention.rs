use serde_json::Value;

#[derive(Default)]
pub struct Attention {
    pending: Vec<(String, &'static str, String)>,
    uncorrelated: u64,
}

fn permission_id(data: &Value) -> Option<&str> {
    [
        "requestId",
        "permissionRequestId",
        "permissionId",
        "toolCallId",
    ]
    .iter()
    .find_map(|key| data.get(key).and_then(Value::as_str))
    .or_else(|| {
        data.get("permissionRequest").and_then(|request| {
            ["requestId", "id", "toolCallId"]
                .iter()
                .find_map(|key| request.get(key).and_then(Value::as_str))
        })
    })
}

impl Attention {
    pub fn update(&mut self, kind: &str, data: &Value, description: &str) {
        match kind {
            "permission.requested" => {
                let id = permission_id(data).map(str::to_string).unwrap_or_else(|| {
                    self.uncorrelated += 1;
                    format!("uncorrelated-permission-{}", self.uncorrelated)
                });
                self.insert(&id, "permission", description);
            }
            "tool.execution_start"
                if data
                    .get("toolName")
                    .or_else(|| data.get("name"))
                    .and_then(Value::as_str)
                    == Some("ask_user") =>
            {
                if let Some(id) = data.get("toolCallId").and_then(Value::as_str) {
                    self.insert(id, "question", "Copilot asked you a question.");
                }
            }
            "tool.execution_complete" => {
                if let Some(id) = data.get("toolCallId").and_then(Value::as_str) {
                    self.pending
                        .retain(|(key, kind, _)| key != id || *kind != "question");
                }
            }
            "permission.completed" => {
                if let Some(id) = permission_id(data) {
                    self.pending
                        .retain(|(key, kind, _)| key != id || *kind != "permission");
                } else if let Some(index) = self.pending.iter().position(|(key, kind, _)| {
                    *kind == "permission" && key.starts_with("uncorrelated-permission-")
                }) {
                    // With no identity, resolve one anonymous wait, never every wait.
                    self.pending.remove(index);
                }
            }
            "abort" | "session.error" | "session.resume" => self.pending.clear(),
            _ => {}
        }
    }

    fn insert(&mut self, id: &str, kind: &'static str, prompt: &str) {
        if !self
            .pending
            .iter()
            .any(|(key, existing, _)| key == id && *existing == kind)
        {
            self.pending
                .push((id.to_string(), kind, prompt.to_string()));
        }
    }

    pub fn prompt(&self) -> Option<&str> {
        self.pending.first().map(|(_, _, prompt)| prompt.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unrelated_activity_cannot_clear_a_question() {
        let mut tracker = Attention::default();
        tracker.update(
            "tool.execution_start",
            &json!({"toolName":"ask_user","toolCallId":"question-1"}),
            "",
        );
        tracker.update("assistant.turn_end", &json!({}), "");
        tracker.update(
            "tool.execution_complete",
            &json!({"toolCallId":"other"}),
            "",
        );
        assert!(tracker.prompt().is_some());
        tracker.update(
            "tool.execution_complete",
            &json!({"toolCallId":"question-1"}),
            "",
        );
        assert!(tracker.prompt().is_none());
    }

    #[test]
    fn concurrent_question_and_permission_resolve_independently() {
        let mut tracker = Attention::default();
        tracker.update(
            "permission.requested",
            &json!({"requestId":"p"}),
            "Approve command",
        );
        tracker.update(
            "tool.execution_start",
            &json!({"toolName":"ask_user","toolCallId":"q"}),
            "",
        );
        tracker.update("permission.completed", &json!({"requestId":"p"}), "");
        assert_eq!(tracker.prompt(), Some("Copilot asked you a question."));
        tracker.update("abort", &json!({}), "");
        assert!(tracker.prompt().is_none());
    }

    #[test]
    fn anonymous_permissions_are_counted_and_cannot_clear_identified_waits() {
        let mut tracker = Attention::default();
        tracker.update("permission.requested", &json!({}), "first");
        tracker.update("permission.requested", &json!({}), "second");
        tracker.update(
            "permission.requested",
            &json!({"requestId":"known"}),
            "identified",
        );
        tracker.update("permission.completed", &json!({}), "");
        assert_eq!(tracker.prompt(), Some("second"));
        tracker.update("permission.completed", &json!({}), "");
        tracker.update("permission.completed", &json!({}), "");
        assert_eq!(tracker.prompt(), Some("identified"));
        tracker.update("permission.completed", &json!({"requestId":"known"}), "");
        assert!(tracker.prompt().is_none());
    }

    #[test]
    fn native_cli_permission_fixture_survives_other_activity_until_matching_completion() {
        let mut tracker = Attention::default();
        tracker.update("permission.requested", &json!({
            "requestId":"fixture-permission",
            "agentMode":"interactive",
            "permissionRequest":{"kind":"shell", "toolCallId":"fixture-tool", "intention":"Create marker file"},
            "promptRequest":{"kind":"commands", "toolCallId":"fixture-tool"}
        }), "Create marker file");
        tracker.update(
            "tool.execution_complete",
            &json!({"toolCallId":"fixture-tool"}),
            "",
        );
        tracker.update("model.turn_ended", &json!({}), "");
        assert_eq!(tracker.prompt(), Some("Create marker file"));
        tracker.update("permission.completed", &json!({"requestId":"other"}), "");
        assert!(tracker.prompt().is_some());
        tracker.update(
            "permission.completed",
            &json!({"requestId":"fixture-permission"}),
            "",
        );
        assert!(tracker.prompt().is_none());
    }
}
