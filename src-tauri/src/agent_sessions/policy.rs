use std::path::{Component, Path, PathBuf};

use github_copilot_sdk::types::{PermissionRequestData, PermissionRequestKind};
use serde_json::Value;

use super::AgentSessionPurpose;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    Approve,
    Prompt,
    Reject,
}

pub fn decide(
    purpose: AgentSessionPurpose,
    working_directory: &Path,
    request: &PermissionRequestData,
) -> PolicyDecision {
    if request.managed_approval_required == Some(true) || request.managed_settings_enabled {
        return unresolved(purpose);
    }

    match request.kind {
        Some(PermissionRequestKind::Read) => {
            if requested_paths_are_bounded(working_directory, &request.extra) {
                PolicyDecision::Approve
            } else {
                unresolved(purpose)
            }
        }
        Some(PermissionRequestKind::Shell) => {
            let command = request
                .extra
                .get("fullCommandText")
                .or_else(|| request.extra.get("command"))
                .and_then(Value::as_str);
            if command.is_some_and(is_safe_read_command)
                && requested_paths_are_bounded(working_directory, &request.extra)
            {
                PolicyDecision::Approve
            } else {
                unresolved(purpose)
            }
        }
        Some(
            PermissionRequestKind::Write
            | PermissionRequestKind::Url
            | PermissionRequestKind::Mcp
            | PermissionRequestKind::CustomTool
            | PermissionRequestKind::Memory
            | PermissionRequestKind::Hook
            | PermissionRequestKind::Unknown,
        )
        | None => unresolved(purpose),
        Some(_) => unresolved(purpose),
    }
}

fn unresolved(purpose: AgentSessionPurpose) -> PolicyDecision {
    if purpose.is_pr_review() {
        PolicyDecision::Reject
    } else {
        PolicyDecision::Prompt
    }
}

fn is_safe_read_command(command: &str) -> bool {
    let normalized = command.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.contains(['\r', '\n', ';', '&', '|', '>', '<', '`'])
        || normalized.contains("$(")
    {
        return false;
    }

    const SAFE_PREFIXES: &[&str] = &[
        "git status",
        "git diff",
        "git log",
        "git show",
        "git branch --show-current",
        "git rev-parse",
        "git remote -v",
        "git ls-files",
        "gh pr view",
        "gh pr diff",
        "gh pr list",
        "az repos pr show",
        "az repos pr list",
    ];
    SAFE_PREFIXES.iter().any(|prefix| {
        normalized == *prefix
            || normalized
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with(char::is_whitespace))
    }) || safe_git_fetch(&normalized)
}

fn safe_git_fetch(command: &str) -> bool {
    let Some(arguments) = command.strip_prefix("git fetch origin ") else {
        return false;
    };
    let tokens = arguments.split_whitespace().collect::<Vec<_>>();
    !tokens.is_empty()
        && tokens.iter().all(|token| {
            !token.starts_with('-')
                && !token.contains("..")
                && token.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "_./-".contains(character)
                })
        })
}

fn requested_paths_are_bounded(working_directory: &Path, payload: &Value) -> bool {
    let mut paths = Vec::new();
    collect_paths(payload, None, &mut paths);
    paths
        .iter()
        .all(|path| path_is_within(path, working_directory))
}

fn collect_paths(value: &Value, key: Option<&str>, paths: &mut Vec<PathBuf>) {
    match value {
        Value::Object(values) => {
            for (child_key, child) in values {
                collect_paths(child, Some(child_key), paths);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_paths(child, key, paths);
            }
        }
        Value::String(value) if key.is_some_and(is_path_key) => {
            paths.push(PathBuf::from(value));
        }
        _ => {}
    }
}

fn is_path_key(key: &str) -> bool {
    matches!(
        key,
        "path" | "fileName" | "filePath" | "possiblePath" | "possiblePaths"
    )
}

fn path_is_within(candidate: &Path, ancestor: &Path) -> bool {
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        ancestor.join(candidate)
    };
    let candidate = normalize(&candidate);
    let ancestor = normalize(ancestor);
    if cfg!(windows) {
        let candidate = candidate.to_string_lossy().to_ascii_lowercase();
        let ancestor = ancestor
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase();
        candidate == ancestor || candidate.starts_with(&format!("{ancestor}\\"))
    } else {
        candidate == ancestor || candidate.starts_with(ancestor)
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use github_copilot_sdk::types::PermissionRequestKind;
    use serde_json::json;

    use super::*;

    fn request(kind: PermissionRequestKind, extra: Value) -> PermissionRequestData {
        PermissionRequestData {
            kind: Some(kind),
            extra,
            ..Default::default()
        }
    }

    #[test]
    fn review_auto_approves_bounded_reads() {
        let decision = decide(
            AgentSessionPurpose::PrReview,
            Path::new("C:\\repo"),
            &request(
                PermissionRequestKind::Read,
                json!({ "fileName": "src\\main.rs" }),
            ),
        );
        assert_eq!(decision, PolicyDecision::Approve);
    }

    #[test]
    fn review_rejects_writes_and_unsafe_shell() {
        assert_eq!(
            decide(
                AgentSessionPurpose::PrReview,
                Path::new("C:\\repo"),
                &request(PermissionRequestKind::Write, json!({})),
            ),
            PolicyDecision::Reject
        );
        assert_eq!(
            decide(
                AgentSessionPurpose::PrReview,
                Path::new("C:\\repo"),
                &request(
                    PermissionRequestKind::Shell,
                    json!({ "fullCommandText": "git diff && git push" }),
                ),
            ),
            PolicyDecision::Reject
        );
    }

    #[test]
    fn review_allows_only_constrained_fetches() {
        assert!(is_safe_read_command("git fetch origin feature/main"));
        assert!(is_safe_read_command("git fetch origin pull/42/head"));
        assert!(!is_safe_read_command(
            "git fetch --upload-pack=malware origin main"
        ));
        assert!(!is_safe_read_command(
            "git fetch https://example.com/repo main"
        ));
    }

    #[test]
    fn interactive_prompts_for_risky_requests() {
        assert_eq!(
            decide(
                AgentSessionPurpose::Interactive,
                Path::new("C:\\repo"),
                &request(PermissionRequestKind::Mcp, json!({})),
            ),
            PolicyDecision::Prompt
        );
    }
}
