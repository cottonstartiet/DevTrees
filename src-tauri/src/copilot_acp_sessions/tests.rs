use super::*;

#[test]
fn acp_exact_permission_options_reject_invented_grants() {
    let request = InteractionRequest::AcpPermission {
        message: "Read file?".into(),
        options: serde_json::from_value(json!([
            {"optionId":"opaque:yes","name":"Allow once","kind":"allow_once"},
            {"optionId":"opaque:no","name":"Deny","kind":"reject_once"}
        ]))
        .unwrap(),
        detail: "{}".into(),
    };
    assert!(request
        .validate(&InteractionAnswer::Permission {
            action: "opaque:yes".into()
        })
        .is_ok());
    assert!(request
        .validate(&InteractionAnswer::Permission {
            action: "allow-always".into()
        })
        .is_err());
    assert!(request.validate(&InteractionAnswer::Cancel).is_ok());
}

#[test]
fn acp_permission_response_preserves_the_current_opaque_option_id() {
    let response =
        acp::RequestPermissionResponse::new(permission_outcome(InteractionAnswer::Permission {
            action: "opaque:remember-this-request".into(),
        }));
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["outcome"]["outcome"], "selected");
    assert_eq!(value["outcome"]["optionId"], "opaque:remember-this-request");

    let cancelled = serde_json::to_value(acp::RequestPermissionResponse::new(permission_outcome(
        InteractionAnswer::Cancel,
    )))
    .unwrap();
    assert_eq!(cancelled["outcome"]["outcome"], "cancelled");
}

#[test]
fn permission_profile_controls_only_validated_copilot_flags() {
    assert_eq!(
        copilot_server_args(crate::settings::CopilotPermissionProfile::Default),
        ["--acp", "--stdio", "--no-auto-update", "--no-remote"]
    );
    assert_eq!(
        copilot_server_args(crate::settings::CopilotPermissionProfile::AllowAll),
        [
            "--acp",
            "--stdio",
            "--no-auto-update",
            "--no-remote",
            "--allow-all"
        ]
    );
}

#[test]
fn permission_history_uses_the_current_offered_option_kind() {
    let options: Vec<crate::terminal_sessions::TerminalSessionPermissionOption> =
        serde_json::from_value(json!([
            {"optionId":"once","name":"Allow once","kind":"allow_once"},
            {"optionId":"always","name":"Allow always","kind":"allow_always"},
            {"optionId":"no","name":"Reject","kind":"reject_once"},
            {"optionId":"never","name":"Always reject","kind":"reject_always"}
        ]))
        .unwrap();
    for (action, expected, kind) in [
        ("once", "Allowed once", "allow_once"),
        (
            "always",
            "Saved as a project-scoped approval when supported",
            "allow_always",
        ),
        ("no", "Rejected once", "reject_once"),
        (
            "never",
            "Saved as a project-scoped rejection when supported",
            "reject_always",
        ),
    ] {
        assert_eq!(
            permission_resolution(
                &options,
                &InteractionAnswer::Permission {
                    action: action.into()
                }
            ),
            (expected.into(), Some(kind.into()))
        );
    }
    assert_eq!(
        permission_resolution(&options, &InteractionAnswer::Cancel),
        ("Cancelled".into(), None)
    );
}

#[test]
fn acp_live_round_trip_is_explicitly_opt_in() {
    // CI remains deterministic and never consumes model credits or starts the user's CLI.
    assert!(state::MAX_PROMPT_BYTES < process::MAX_FRAME_BYTES);
}

#[test]
#[ignore = "Requires installed/authenticated Copilot; uses only informational /usage"]
fn acp_live_round_trip() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let folder =
            std::env::temp_dir().join(format!("devtrees-acp-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let mut command = tokio::process::Command::new(installed_cli().unwrap());
        command
            .args(["--acp", "--stdio", "--no-auto-update", "--no-remote"])
            .current_dir(&folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
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
        let mut child = command.spawn().unwrap();
        let scope = process::ProcessScope::attach(&child).unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let commands = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed = commands.clone();
        let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
        let output = updates.clone();
        let session_folder = folder.clone();
        let connected = Client
            .builder()
            .on_receive_notification(
                async move |update: acp::SessionNotification, _| {
                    let update = serde_json::to_value(update.update).map_err(protocol_error)?;
                    if update["sessionUpdate"] == "available_commands_update" {
                        *observed.lock().unwrap() =
                            update["availableCommands"].as_array().unwrap().clone();
                    }
                    output.lock().unwrap().push(update);
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |_request: acp::RequestPermissionRequest, responder, _| {
                    responder.respond(acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Cancelled,
                    ))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(
                ByteStreams::new(
                    stdin.compat_write(),
                    process::BoundedRead::new(stdout).compat(),
                ),
                async move |cx: ConnectionTo<Agent>| {
                    let request: acp::InitializeRequest = serde_json::from_value(json!({
                        "protocolVersion":1, "clientCapabilities":{}
                    }))
                    .map_err(protocol_error)?;
                    let init = serde_json::to_value(cx.send_request(request).block_task().await?)
                        .map_err(protocol_error)?;
                    assert_eq!(init["protocolVersion"], 1);
                    let request: acp::NewSessionRequest =
                        serde_json::from_value(json!({"cwd":session_folder,"mcpServers":[]}))
                            .map_err(protocol_error)?;
                    let setup = serde_json::to_value(cx.send_request(request).block_task().await?)
                        .map_err(protocol_error)?;
                    let id = setup["sessionId"].as_str().unwrap().to_string();
                    tokio::time::timeout(Duration::from_secs(15), async {
                        while !commands
                            .lock()
                            .unwrap()
                            .iter()
                            .any(|command| command["name"] == "usage")
                        {
                            tokio::time::sleep(Duration::from_millis(25)).await;
                        }
                    })
                    .await
                    .map_err(protocol_error)?;
                    let request: acp::PromptRequest = serde_json::from_value(json!({
                        "sessionId":id, "prompt":[{"type":"text","text":"/usage"}]
                    }))
                    .map_err(protocol_error)?;
                    let reply = serde_json::to_value(cx.send_request(request).block_task().await?)
                        .map_err(protocol_error)?;
                    assert_eq!(reply["stopReason"], "end_turn");
                    let request: acp::ListSessionsRequest =
                        serde_json::from_value(json!({})).map_err(protocol_error)?;
                    let listed = serde_json::to_value(cx.send_request(request).block_task().await?)
                        .map_err(protocol_error)?;
                    assert!(listed["sessions"].is_array());
                    let request: acp::CloseSessionRequest =
                        serde_json::from_value(json!({"sessionId":id})).map_err(protocol_error)?;
                    cx.send_request(request).block_task().await?;
                    Ok(())
                },
            );
        let result = tokio::time::timeout(Duration::from_secs(90), connected).await;
        drop(scope);
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir(&folder).unwrap();
        result.unwrap().unwrap();
        assert!(updates
            .lock()
            .unwrap()
            .iter()
            .any(|u| u["sessionUpdate"] == "agent_message_chunk"));
    });
}

#[test]
fn acp_bounded_reader_accepts_split_frames_and_rejects_overflow() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let mut reader = process::BoundedRead::new(&b"{}\n{}\n"[..]);
        let mut data = Vec::new();
        reader.read_to_end(&mut data).await.unwrap();
        assert_eq!(data, b"{}\n{}\n");
        let bytes = vec![b'x'; process::MAX_FRAME_BYTES + 1];
        let mut reader = process::BoundedRead::new(bytes.as_slice());
        assert_eq!(
            reader
                .read_to_end(&mut Vec::new())
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    });
}

#[test]
fn acp_transport_handles_setup_decisions_string_ids_and_unknown_methods() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (client, agent) = tokio::io::duplex(8192);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, mut agent_write) = tokio::io::split(agent);
        let seen_update = Arc::new(Notify::new());
        let observed = seen_update.clone();
        let decision_update = seen_update.clone();
        let server = tokio::spawn(async move {
            let mut lines = BufReader::new(agent_read).lines();
            let init: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            // Bidirectional request IDs may overlap while initialization is pending.
            for message in [
                json!({"jsonrpc":"2.0","id":init["id"],"method":"unsupported/method","params":{}}),
                json!({"jsonrpc":"2.0","id":"permission/string","method":"session/request_permission","params":{
                    "sessionId":"opaque-session","toolCall":{"toolCallId":"tool","title":"Read file"},
                    "options":[{"optionId":"deny","name":"Deny","kind":"reject_once"}]
                }}),
                json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"opaque-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}
                }}),
            ] {
                let bytes = format!("{message}\n").into_bytes();
                for fragment in bytes.chunks(11) {
                    agent_write.write_all(fragment).await.unwrap();
                }
            }
            let mut unknown = false;
            let mut permission = false;
            for _ in 0..2 {
                let reply: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                if reply["id"] == init["id"] {
                    assert_eq!(reply["error"]["code"], -32601);
                    unknown = true;
                } else {
                    assert_eq!(reply["id"], "permission/string");
                    assert_eq!(reply["result"]["outcome"]["outcome"], "cancelled");
                    permission = true;
                }
            }
            assert!(unknown && permission);
            agent_write.write_all(format!("{}\n", json!({
                "jsonrpc":"2.0","id":init["id"],"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}
            })).as_bytes()).await.unwrap();
            while lines.next_line().await.unwrap().is_some() {}
        });
        let client = Client.builder()
            .on_receive_notification(
                async move |_update: acp::SessionNotification, _| {
                    observed.notify_one();
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |_request: acp::RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                    let update = decision_update.clone();
                    cx.spawn(async move {
                        update.notified().await;
                        responder.respond(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled))
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(ByteStreams::new(client_write.compat_write(), process::BoundedRead::new(client_read).compat()),
                async move |cx: ConnectionTo<Agent>| {
                    let request: acp::InitializeRequest = serde_json::from_value(json!({"protocolVersion":1,"clientCapabilities":{}})).map_err(protocol_error)?;
                    cx.send_request(request).block_task().await?;
                    Ok(())
                });
        tokio::time::timeout(Duration::from_secs(10), client).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    });
}
