use super::*;
use serde_json::json;

fn state() -> State {
    State {
        session: TerminalSession {
            id: "session".into(),
            task_id: None,
            folder_path: ".".into(),
            label: "Test".into(),
            repository: None,
            branch: None,
            status: Status::Working,
            last_activity: String::new(),
            pending_prompt: None,
            created_at: 1,
            updated_at: 1,
            transport: "sdk".into(),
            generation: Some("generation".into()),
            revision: 1,
            observed_at: None,
            observation_error: None,
        },
        base_status: Status::Working,
        pending: BTreeMap::new(),
        next_request: 0,
        entries: VecDeque::new(),
        next_seq: 0,
        message_sequences: HashMap::new(),
        error: None,
        dirty: false,
        history_truncated: false,
    }
}

fn question(message: &str) -> InteractionRequest {
    InteractionRequest::Question {
        message: message.into(),
        choices: vec!["alpha".into(), "beta".into()],
        allow_freeform: false,
    }
}

fn answer() -> InteractionAnswer {
    InteractionAnswer::Question {
        answer: "alpha".into(),
        was_freeform: false,
    }
}

fn event(kind: &str, data: Value) -> SessionEvent {
    serde_json::from_value(json!({
        "id": uuid::Uuid::new_v4().to_string(), "timestamp":"2026-09-06T12:00:00Z",
        "parentId": null, "type":kind, "data":data,
    }))
    .unwrap()
}

#[test]
fn pending_queue_survives_unrelated_progress_and_idle() {
    let mut state = state();
    let (first, mut first_result) = state.enqueue(question("First"));
    let (_, mut second_result) = state.enqueue(question("Second"));
    let first_id = state.pending[&first].interaction.id.clone();
    state.ingest(event("session.idle", json!({})));
    assert!(state.session.status == Status::WaitingInput);
    assert_eq!(state.snapshot().interactions.len(), 2);
    assert!(state
        .respond(
            &first_id,
            InteractionAnswer::Permission {
                action: "allow-once".into()
            }
        )
        .is_err());
    assert_eq!(state.pending.len(), 2);
    state.respond(&first_id, answer()).unwrap();
    assert!(matches!(
        first_result.try_recv(),
        Ok(InteractionAnswer::Question { .. })
    ));
    assert!(second_result.try_recv().is_err());
    assert!(state.session.status == Status::WaitingInput);
    assert_eq!(state.session.pending_prompt.as_deref(), Some("Second"));
    let second_id = state.snapshot().interactions[0].id.clone();
    state
        .respond(&second_id, InteractionAnswer::Cancel)
        .unwrap();
    assert!(matches!(
        second_result.try_recv(),
        Ok(InteractionAnswer::Cancel)
    ));
    assert!(state.session.status == Status::Idle);
}

#[test]
fn competing_surfaces_deliver_exactly_one_response() {
    let mut state = state();
    let (key, mut response) = state.enqueue(question("Choose"));
    let id = state.pending[&key].interaction.id.clone();
    let owner = Arc::new(Mutex::new(state));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let owner = owner.clone();
            let id = id.clone();
            std::thread::spawn(move || owner.lock().unwrap().respond(&id, answer()).is_ok())
        })
        .collect();
    let succeeded = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|success| *success)
        .count();
    assert_eq!(succeeded, 1);
    assert!(matches!(
        response.try_recv(),
        Ok(InteractionAnswer::Question { .. })
    ));
    assert!(owner.lock().unwrap().pending.is_empty());
}

#[test]
fn dropped_callback_is_removed_without_retry_or_success() {
    let mut state = state();
    let (key, response) = state.enqueue(question("Choose"));
    let id = state.pending[&key].interaction.id.clone();
    drop(response);
    assert!(state.respond(&id, answer()).is_err());
    assert!(state.pending.is_empty());
    assert!(state.respond(&id, answer()).is_err());
}

#[test]
fn repeated_questions_receive_fresh_opaque_ids() {
    let mut state = state();
    let (first, _rx) = state.enqueue(question("Same"));
    let old_id = state.pending[&first].interaction.id.clone();
    state.respond(&old_id, answer()).unwrap();
    let (second, _rx) = state.enqueue(question("Same"));
    assert_ne!(old_id, state.pending[&second].interaction.id);
    assert!(state.respond(&old_id, answer()).is_err());
    assert_eq!(state.pending.len(), 1);
}

#[test]
fn deltas_and_completion_replace_one_message_without_truncation() {
    let mut state = state();
    state.ingest(event(
        "assistant.message_delta",
        json!({"messageId":"a","deltaContent":"hello "}),
    ));
    state.ingest(event(
        "assistant.message_delta",
        json!({"messageId":"a","deltaContent":"world"}),
    ));
    state.ingest(event(
        "assistant.message",
        json!({"messageId":"a","content":"complete".repeat(2_000)}),
    ));
    assert_eq!(state.entries.len(), 1);
    assert!(
        matches!(&state.entries[0], Entry::AssistantMessage { text, .. } if text.len() == 16_000)
    );
    state.ingest(event(
        "tool.execution_start",
        json!({"toolCallId":"tool-1","toolName":"read","arguments":{"path":"file"}}),
    ));
    state.ingest(event(
        "tool.execution_complete",
        json!({"toolCallId":"tool-1","success":true,"result":{"content":"ok"}}),
    ));
    assert_eq!(state.entries.len(), 2);
    assert!(
        matches!(&state.entries[1], Entry::ToolCall { success:Some(true),result:Some(text), .. } if text == "ok")
    );
}

#[test]
fn human_responses_are_not_added_to_transcript_or_session_metadata() {
    let mut state = state();
    let (key, _rx) = state.enqueue(InteractionRequest::Question {
        message: "Input".into(),
        choices: vec![],
        allow_freeform: true,
    });
    let id = state.pending[&key].interaction.id.clone();
    state
        .respond(
            &id,
            InteractionAnswer::Question {
                answer: "private-form-value".into(),
                was_freeform: true,
            },
        )
        .unwrap();
    let snapshot = serde_json::to_string(&state.snapshot()).unwrap();
    assert!(!snapshot.contains("private-form-value"));
    assert!(state.entries.is_empty());
}

#[test]
fn ended_turns_do_not_leave_running_tools_or_resurrect_ended_sessions() {
    let mut state = state();
    state.ingest(event(
        "tool.execution_start",
        json!({"toolCallId":"pending","toolName":"ask_user"}),
    ));
    state.ingest(event("session.idle", json!({})));
    assert!(matches!(
        &state.entries[0],
        Entry::ToolCall {
            success: Some(false),
            result: Some(_),
            ..
        }
    ));
    state.base_status = Status::Done;
    state.changed();
    let revision = state.session.revision;
    state.ingest(event("assistant.turn_start", json!({})));
    assert!(state.session.status == Status::Done);
    assert_eq!(state.session.revision, revision);
}

#[test]
fn bounded_history_explicitly_reports_omitted_entries() {
    let mut state = state();
    for _ in 0..=MAX_ENTRIES {
        state.ingest(event("user.message", json!({"content":"message"})));
    }
    assert_eq!(state.entries.len(), MAX_ENTRIES);
    assert!(state.snapshot().history_truncated);
}
