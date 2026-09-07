//! Maps Copilot CLI permission prompts onto the scoped decisions the runtime
//! accepts, so the desktop UI can offer the same "allow once / allow for this
//! session / always allow" choices the terminal does instead of re-asking for
//! every single file.

use github_copilot_sdk::{rpc::PermissionDecision, PermissionRequestData};
use serde_json::{json, Value};

use crate::session_interactions::{InteractionRequest, PermissionScope};

/// A prompt to show the user plus the decisions each broader scope maps to.
pub struct PermissionPlan {
    pub request: InteractionRequest,
    pub session: Option<PermissionDecision>,
    pub location: Option<PermissionDecision>,
}

pub const ALLOW_ONCE: &str = "allow-once";
pub const ALLOW_SESSION: &str = "allow-session";
pub const ALLOW_ALWAYS: &str = "allow-always";

const MAX_DETAIL: usize = 20_000;

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|found| !found.is_empty())
        .map(str::to_owned)
}

fn list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    format!(
        "{}\n... [truncated]",
        text.chars().take(limit).collect::<String>()
    )
}

/// The registrable domain the CLI keys URL approvals on.
fn domain_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match authority.rsplit_once(':') {
        // Leave IPv6 literals intact; only strip a trailing numeric port.
        Some((head, port))
            if !head.ends_with(']')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            head
        }
        _ => authority,
    };
    let host = host.trim();
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn decision(value: Value) -> Option<PermissionDecision> {
    serde_json::from_value(value).ok()
}

fn for_session(approval: Value) -> Option<PermissionDecision> {
    decision(json!({ "kind": "approve-for-session", "approval": approval }))
}

fn for_location(approval: Value, location_key: &str) -> Option<PermissionDecision> {
    decision(json!({
        "kind": "approve-for-location",
        "approval": approval,
        "locationKey": location_key,
    }))
}

/// Both broader scopes share an approval shape for every tool prompt kind.
fn both(
    approval: Value,
    location_key: &str,
) -> (Option<PermissionDecision>, Option<PermissionDecision>) {
    (
        for_session(approval.clone()),
        for_location(approval, location_key),
    )
}

/// Wording for the two broader scopes, tuned per prompt kind so the user knows
/// exactly how much they are granting.
fn scope_labels(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "read" => (
            "Allows Copilot to read any file for the rest of this session.",
            "Always allows Copilot to read files in this worktree.",
        ),
        "write" => (
            "Allows Copilot to edit any file for the rest of this session.",
            "Always allows Copilot to edit files in this worktree.",
        ),
        "commands" => (
            "Allows this command for the rest of this session.",
            "Always allows this command in this worktree.",
        ),
        "mcp" => (
            "Allows this MCP tool for the rest of this session.",
            "Always allows this MCP tool in this worktree.",
        ),
        "url" => (
            "Allows this domain for the rest of this session.",
            "Always allows this domain, in every session.",
        ),
        "memory" => (
            "Allows memory updates for the rest of this session.",
            "Always allows memory updates in this worktree.",
        ),
        "custom-tool" => (
            "Allows this tool for the rest of this session.",
            "Always allows this tool in this worktree.",
        ),
        "path" => (
            "Allows these paths for the rest of this session.",
            "Always allows these paths in this worktree.",
        ),
        _ => (
            "Allows this request for the rest of this session.",
            "Always allows this request in this worktree.",
        ),
    }
}

/// Build the prompt and the scoped decisions for one permission request.
///
/// `location_key` is the git root or working directory the CLI persists
/// "always allow" grants against.
pub fn plan(data: &PermissionRequestData, location_key: &str) -> PermissionPlan {
    let prompt = data
        .extra
        .get("permissionRequest")
        .cloned()
        .unwrap_or_else(|| data.extra.clone());
    let kind = text(&prompt, "kind").unwrap_or_else(|| "permission".into());
    let intention = text(&prompt, "intention");
    let detail = serde_json::to_string_pretty(&prompt).unwrap_or_else(|_| prompt.to_string());

    let (message, target, diff, session, location) = match kind.as_str() {
        "read" => {
            let path = text(&prompt, "path");
            let (session, location) = both(json!({ "kind": "read" }), location_key);
            (
                format!(
                    "Read {}?",
                    path.as_deref().unwrap_or("a file outside this worktree")
                ),
                path,
                None,
                session,
                location,
            )
        }
        "write" => {
            let file = text(&prompt, "fileName");
            let (session, location) = if flag(&prompt, "canOfferSessionApproval") {
                both(json!({ "kind": "write" }), location_key)
            } else {
                (None, None)
            };
            (
                format!("Edit {}?", file.as_deref().unwrap_or("a file")),
                file,
                text(&prompt, "diff"),
                session,
                location,
            )
        }
        "commands" => {
            let command = text(&prompt, "fullCommandText");
            let identifiers = list(&prompt, "commandIdentifiers");
            let (session, location) =
                if flag(&prompt, "canOfferSessionApproval") && !identifiers.is_empty() {
                    both(
                        json!({ "kind": "commands", "commandIdentifiers": identifiers }),
                        location_key,
                    )
                } else {
                    (None, None)
                };
            (
                format!("Run {}?", command.as_deref().unwrap_or("a shell command")),
                command,
                None,
                session,
                location,
            )
        }
        "mcp" => {
            let server = text(&prompt, "serverName");
            let tool = text(&prompt, "toolName");
            let label = text(&prompt, "toolTitle").or_else(|| tool.clone());
            let (session, location) = match (&server, &tool) {
                (Some(server), Some(tool)) => both(
                    json!({ "kind": "mcp", "serverName": server, "toolName": tool }),
                    location_key,
                ),
                _ => (None, None),
            };
            let target = match (&server, &label) {
                (Some(server), Some(label)) => Some(format!("{server} / {label}")),
                (Some(server), None) => Some(server.clone()),
                _ => label.clone(),
            };
            (
                format!(
                    "Run the MCP tool {}?",
                    target.as_deref().unwrap_or("requested by Copilot")
                ),
                target,
                None,
                session,
                location,
            )
        }
        "url" => {
            let url = text(&prompt, "url");
            let domain = url.as_deref().and_then(domain_of);
            let session = domain.as_ref().and_then(|domain| {
                decision(json!({ "kind": "approve-for-session", "domain": domain }))
            });
            let permanent = domain.as_ref().and_then(|domain| {
                decision(json!({ "kind": "approve-permanently", "domain": domain }))
            });
            (
                format!("Open {}?", url.as_deref().unwrap_or("a URL")),
                url,
                None,
                session,
                permanent,
            )
        }
        "memory" => {
            let fact = text(&prompt, "fact");
            let (session, location) = both(json!({ "kind": "memory" }), location_key);
            (
                "Save this to Copilot memory?".to_owned(),
                fact,
                None,
                session,
                location,
            )
        }
        "custom-tool" => {
            let tool = text(&prompt, "toolName");
            let (session, location) = match &tool {
                Some(tool) => both(
                    json!({ "kind": "custom-tool", "toolName": tool }),
                    location_key,
                ),
                None => (None, None),
            };
            (
                format!(
                    "Run the tool {}?",
                    tool.as_deref().unwrap_or("requested by Copilot")
                ),
                tool.clone().or_else(|| text(&prompt, "toolDescription")),
                None,
                session,
                location,
            )
        }
        "path" => {
            let paths = list(&prompt, "paths");
            let access = text(&prompt, "accessKind").unwrap_or_else(|| "access".into());
            (
                format!(
                    "Allow {access} to {}?",
                    if paths.len() == 1 {
                        "this path".to_owned()
                    } else {
                        format!("{} paths", paths.len())
                    }
                ),
                (!paths.is_empty()).then(|| paths.join("\n")),
                None,
                decision(json!({ "kind": "approve-for-session" })),
                None,
            )
        }
        "extension-management" => {
            let operation = text(&prompt, "operation");
            let extension = text(&prompt, "extensionName");
            let (session, location) = match &operation {
                Some(operation) => both(
                    json!({ "kind": "extension-management", "operation": operation }),
                    location_key,
                ),
                None => (None, None),
            };
            (
                format!(
                    "Allow the extension operation {}?",
                    operation.as_deref().unwrap_or("requested by Copilot")
                ),
                extension,
                None,
                session,
                location,
            )
        }
        "factory" => {
            let key = text(&prompt, "approvalKey");
            let approval = key
                .as_ref()
                .map(|key| json!({ "kind": "factory", "approvalKey": key }));
            let session = approval.clone().and_then(for_session);
            let location = approval
                .filter(|_| flag(&prompt, "canPersistApproval"))
                .and_then(|approval| for_location(approval, location_key));
            (
                format!(
                    "Run the factory {}?",
                    key.as_deref().unwrap_or("requested by Copilot")
                ),
                key,
                None,
                session,
                location,
            )
        }
        "extension-permission-access" => {
            let extension = text(&prompt, "extensionName");
            let capabilities = list(&prompt, "capabilities");
            let (session, location) = match &extension {
                Some(extension) => both(
                    json!({ "kind": "extension-permission-access", "extensionName": extension }),
                    location_key,
                ),
                None => (None, None),
            };
            (
                format!(
                    "Grant {} access to {}?",
                    extension.as_deref().unwrap_or("an extension"),
                    if capabilities.is_empty() {
                        "a capability".to_owned()
                    } else {
                        capabilities.join(", ")
                    }
                ),
                extension,
                None,
                session,
                location,
            )
        }
        "extension-env-access" => {
            let extension = text(&prompt, "extensionName");
            let variables = list(&prompt, "environmentVariables");
            let (session, location) = match &extension {
                Some(extension) if !variables.is_empty() => both(
                    json!({
                        "kind": "extension-env-access",
                        "extensionName": extension,
                        "environmentVariables": variables,
                    }),
                    location_key,
                ),
                _ => (None, None),
            };
            (
                format!(
                    "Give {} access to environment variables?",
                    extension.as_deref().unwrap_or("an extension")
                ),
                (!variables.is_empty()).then(|| variables.join(", ")),
                None,
                session,
                location,
            )
        }
        "hook" => (
            format!(
                "Run the hook for {}?",
                text(&prompt, "toolName").unwrap_or_else(|| "a tool".into())
            ),
            text(&prompt, "hookMessage"),
            None,
            None,
            None,
        ),
        _ => (
            "Copilot needs permission".to_owned(),
            None,
            None,
            None,
            None,
        ),
    };

    // Managed policy demands a human decision per request, so never offer to
    // remember the answer.
    let managed = data.managed_approval_required == Some(true);
    let (session, location) = if managed {
        (None, None)
    } else {
        (session, location)
    };

    let (session_label, always_label) = scope_labels(&kind);
    let mut scopes = Vec::new();
    if session.is_some() {
        scopes.push(PermissionScope {
            action: ALLOW_SESSION.into(),
            label: "Allow for this session".into(),
            description: session_label.into(),
        });
    }
    if location.is_some() {
        scopes.push(PermissionScope {
            action: ALLOW_ALWAYS.into(),
            label: "Always allow".into(),
            description: always_label.into(),
        });
    }

    PermissionPlan {
        request: InteractionRequest::Permission {
            message,
            permission_kind: kind,
            target: target.map(|target| clip(&target, MAX_DETAIL)),
            intention,
            diff: diff.map(|diff| clip(&diff, MAX_DETAIL)),
            detail: clip(&detail, MAX_DETAIL),
            managed,
            scopes,
        },
        session,
        location,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data(prompt: Value) -> PermissionRequestData {
        PermissionRequestData {
            kind: None,
            tool_call_id: None,
            managed_approval_required: prompt
                .get("managedApprovalRequired")
                .and_then(Value::as_bool),
            managed_settings_enabled: false,
            extra: json!({ "requestId": "r1", "permissionRequest": prompt }),
        }
    }

    fn actions(request: &InteractionRequest) -> Vec<String> {
        match request {
            InteractionRequest::Permission { scopes, .. } => {
                scopes.iter().map(|scope| scope.action.clone()).collect()
            }
            _ => panic!("expected a permission request"),
        }
    }

    #[test]
    fn read_prompts_offer_session_and_location_scopes() {
        let plan = plan(
            &data(json!({ "kind": "read", "path": "C:\\repo\\a.rs", "intention": "Inspect" })),
            "C:\\repo",
        );
        assert_eq!(actions(&plan.request), ["allow-session", "allow-always"]);
        assert_eq!(
            serde_json::to_value(plan.session.unwrap()).unwrap(),
            json!({ "kind": "approve-for-session", "approval": { "kind": "read" } })
        );
        assert_eq!(
            serde_json::to_value(plan.location.unwrap()).unwrap(),
            json!({
                "kind": "approve-for-location",
                "approval": { "kind": "read" },
                "locationKey": "C:\\repo",
            })
        );
        match &plan.request {
            InteractionRequest::Permission {
                target, message, ..
            } => {
                assert_eq!(target.as_deref(), Some("C:\\repo\\a.rs"));
                assert!(message.contains("a.rs"));
            }
            _ => panic!("expected a permission request"),
        }
    }

    #[test]
    fn command_prompts_carry_their_identifiers() {
        let plan = plan(
            &data(json!({
                "kind": "commands",
                "fullCommandText": "cargo test",
                "commandIdentifiers": ["cargo"],
                "canOfferSessionApproval": true,
            })),
            "C:\\repo",
        );
        assert_eq!(
            serde_json::to_value(plan.session.unwrap()).unwrap(),
            json!({
                "kind": "approve-for-session",
                "approval": { "kind": "commands", "commandIdentifiers": ["cargo"] },
            })
        );
    }

    #[test]
    fn commands_without_an_offer_flag_stay_single_use() {
        let plan = plan(
            &data(json!({
                "kind": "commands",
                "fullCommandText": "rm -rf /",
                "commandIdentifiers": ["rm"],
                "canOfferSessionApproval": false,
            })),
            "C:\\repo",
        );
        assert!(actions(&plan.request).is_empty());
        assert!(plan.session.is_none() && plan.location.is_none());
    }

    #[test]
    fn every_offered_scope_is_accepted_and_unoffered_ones_are_refused() {
        use crate::session_interactions::InteractionAnswer;

        for prompt in [
            json!({ "kind": "read", "path": "a.rs" }),
            json!({
                "kind": "write",
                "fileName": "a.rs",
                "canOfferSessionApproval": true,
            }),
            json!({
                "kind": "commands",
                "fullCommandText": "cargo test",
                "commandIdentifiers": ["cargo"],
                "canOfferSessionApproval": true,
            }),
            json!({ "kind": "url", "url": "https://example.com" }),
            json!({ "kind": "hook", "toolName": "bash" }),
        ] {
            let plan = plan(&data(prompt.clone()), "C:\\repo");
            let offered = actions(&plan.request);
            for action in [ALLOW_ONCE, "deny"] {
                assert!(
                    plan.request
                        .validate(&InteractionAnswer::Permission {
                            action: action.into()
                        })
                        .is_ok(),
                    "{prompt} must always accept {action}"
                );
            }
            for action in [ALLOW_SESSION, ALLOW_ALWAYS] {
                assert_eq!(
                    plan.request
                        .validate(&InteractionAnswer::Permission {
                            action: action.into()
                        })
                        .is_ok(),
                    offered.iter().any(|offer| offer == action),
                    "{prompt} disagrees with itself about {action}"
                );
            }
            // A scope is only advertised when a decision exists to send.
            assert_eq!(
                offered.contains(&ALLOW_SESSION.to_owned()),
                plan.session.is_some()
            );
            assert_eq!(
                offered.contains(&ALLOW_ALWAYS.to_owned()),
                plan.location.is_some()
            );
        }
    }

    #[test]
    fn write_prompts_surface_the_diff() {
        let plan = plan(
            &data(json!({
                "kind": "write",
                "fileName": "src/main.rs",
                "diff": "@@ -1 +1 @@",
                "canOfferSessionApproval": true,
            })),
            "C:\\repo",
        );
        match &plan.request {
            InteractionRequest::Permission { diff, .. } => {
                assert_eq!(diff.as_deref(), Some("@@ -1 +1 @@"))
            }
            _ => panic!("expected a permission request"),
        }
        assert_eq!(actions(&plan.request), ["allow-session", "allow-always"]);
    }

    #[test]
    fn url_prompts_use_domain_scopes() {
        let plan = plan(
            &data(json!({ "kind": "url", "url": "https://User@Example.com:8443/a?b#c" })),
            "C:\\repo",
        );
        assert_eq!(
            serde_json::to_value(plan.session.unwrap()).unwrap(),
            json!({ "kind": "approve-for-session", "domain": "example.com" })
        );
        assert_eq!(
            serde_json::to_value(plan.location.unwrap()).unwrap(),
            json!({ "kind": "approve-permanently", "domain": "example.com" })
        );
    }

    #[test]
    fn managed_prompts_never_offer_to_remember() {
        let plan = plan(
            &data(json!({ "kind": "read", "path": "a.rs", "managedApprovalRequired": true })),
            "C:\\repo",
        );
        assert!(actions(&plan.request).is_empty());
        assert!(plan.session.is_none() && plan.location.is_none());
    }

    #[test]
    fn unknown_kinds_fall_back_to_a_single_use_prompt() {
        let plan = plan(&data(json!({ "kind": "brand-new" })), "C:\\repo");
        assert!(actions(&plan.request).is_empty());
        match &plan.request {
            InteractionRequest::Permission { detail, .. } => assert!(detail.contains("brand-new")),
            _ => panic!("expected a permission request"),
        }
    }

    #[test]
    fn mcp_prompts_scope_to_the_named_tool() {
        let plan = plan(
            &data(json!({
                "kind": "mcp",
                "serverName": "github",
                "toolName": "search_code",
                "toolTitle": "Search code",
            })),
            "C:\\repo",
        );
        assert_eq!(
            serde_json::to_value(plan.session.unwrap()).unwrap(),
            json!({
                "kind": "approve-for-session",
                "approval": { "kind": "mcp", "serverName": "github", "toolName": "search_code" },
            })
        );
    }
}
