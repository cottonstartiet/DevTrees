use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

use crate::ado::{build_ado_work_item_url, resolve_ado_remote, AdoRemote};
use crate::az::{classify_az_generic_failure, run_az, AzError};
use crate::error::AppResult;
use crate::gh::{is_not_logged_in, run_gh, GhError};
use crate::github::resolve_github_remote;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskImportItem {
    provider: String,
    id: String,
    display_id: String,
    title: String,
    description: String,
    state: String,
    url: String,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskImportResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<TaskImportItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl TaskImportResult {
    fn ok(items: Vec<TaskImportItem>) -> Self {
        Self {
            ok: true,
            items: Some(items),
            code: None,
            message: None,
        }
    }

    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            items: None,
            code: Some(code.to_string()),
            message,
        }
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn compact_html(value: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static WHITESPACE: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(r"(?is)<[^>]*>").unwrap());
    let whitespace = WHITESPACE.get_or_init(|| Regex::new(r"[ \t\r\f\v]+").unwrap());
    let text = tags.replace_all(value, " ");
    whitespace
        .replace_all(
            &text
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'"),
            " ",
        )
        .trim()
        .to_string()
}

fn parse_github_items(
    stdout: &str,
    owner: &str,
    repository: &str,
) -> Result<Vec<TaskImportItem>, String> {
    let parsed: Value =
        serde_json::from_str(stdout).map_err(|err| format!("Could not parse gh output: {err}"))?;
    let values = parsed
        .as_array()
        .ok_or_else(|| "GitHub CLI returned an unexpected response.".to_string())?;
    values
        .iter()
        .map(|value| {
            let number = value
                .get("number")
                .and_then(Value::as_i64)
                .ok_or_else(|| "A GitHub issue was missing its number.".to_string())?;
            let title = string_field(value, "title");
            let url = string_field(value, "url");
            if title.is_empty() || url.is_empty() {
                return Err("A GitHub issue was missing its title or URL.".to_string());
            }
            Ok(TaskImportItem {
                provider: "github".to_string(),
                id: format!("{owner}/{repository}#{number}"),
                display_id: format!("#{number}"),
                title,
                description: string_field(value, "body"),
                state: string_field(value, "state"),
                url,
                updated_at: value
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn parse_ado_items(stdout: &str, remote: &AdoRemote) -> Result<Vec<TaskImportItem>, String> {
    let parsed: Value =
        serde_json::from_str(stdout).map_err(|err| format!("Could not parse az output: {err}"))?;
    let values = parsed
        .as_array()
        .ok_or_else(|| "Azure CLI returned an unexpected response.".to_string())?;
    values
        .iter()
        .map(|value| {
            let fields = value
                .get("fields")
                .and_then(Value::as_object)
                .ok_or_else(|| "An Azure DevOps task was missing its fields.".to_string())?;
            let id = value
                .get("id")
                .and_then(Value::as_i64)
                .or_else(|| fields.get("System.Id").and_then(Value::as_i64))
                .ok_or_else(|| "An Azure DevOps task was missing its ID.".to_string())?;
            let title = fields
                .get("System.Title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if title.is_empty() {
                return Err("An Azure DevOps task was missing its title.".to_string());
            }
            Ok(TaskImportItem {
                provider: "ado".to_string(),
                id: format!("{}/{}/{id}", remote.org, remote.project),
                display_id: format!("AB#{id}"),
                title,
                description: fields
                    .get("System.Description")
                    .and_then(Value::as_str)
                    .map(compact_html)
                    .unwrap_or_default(),
                state: fields
                    .get("System.State")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                url: build_ado_work_item_url(remote, id),
                updated_at: fields
                    .get("System.ChangedDate")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn gh_failure(error: GhError) -> TaskImportResult {
    match error {
        GhError::NotInstalled => TaskImportResult::err(
            "gh-not-installed",
            Some("GitHub CLI (gh) was not found on PATH.".to_string()),
        ),
        GhError::Failed { stderr, .. } if is_not_logged_in(&stderr) => {
            TaskImportResult::err("gh-not-logged-in", Some("Run: gh auth login".to_string()))
        }
        GhError::Failed {
            stdout,
            stderr,
            code,
        } => {
            let message = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else if !stdout.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                format!(
                    "GitHub CLI failed{}.",
                    code.map(|v| format!(" ({v})")).unwrap_or_default()
                )
            };
            TaskImportResult::err("gh-failed", Some(message))
        }
    }
}

fn az_failure(error: AzError) -> TaskImportResult {
    match error {
        AzError::NotInstalled => TaskImportResult::err(
            "az-not-installed",
            Some("Azure CLI (az) was not found on PATH.".to_string()),
        ),
        AzError::Failed { stderr, .. } => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                return TaskImportResult::err(&code, Some(message));
            }
            TaskImportResult::err(
                "az-failed",
                Some(if stderr.trim().is_empty() {
                    "Azure CLI failed without an error message.".to_string()
                } else {
                    stderr.trim().to_string()
                }),
            )
        }
    }
}

#[tauri::command]
pub async fn github_task_imports(repository_path: String) -> AppResult<TaskImportResult> {
    let remote = match resolve_github_remote(&repository_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(TaskImportResult::err(&code, message)),
    };
    let output = match run_gh(
        vec![
            "issue".into(),
            "list".into(),
            "--state".into(),
            "open".into(),
            "--assignee".into(),
            "@me".into(),
            "--limit".into(),
            "200".into(),
            "--json".into(),
            "number,title,body,url,state,updatedAt".into(),
        ],
        repository_path,
    )
    .await
    {
        Ok(output) => output,
        Err(error) => return Ok(gh_failure(error)),
    };
    match parse_github_items(&output.stdout, &remote.owner, &remote.repo) {
        Ok(items) => Ok(TaskImportResult::ok(items)),
        Err(message) => Ok(TaskImportResult::err("invalid-response", Some(message))),
    }
}

#[tauri::command]
pub async fn ado_task_imports(repository_path: String) -> AppResult<TaskImportResult> {
    let remote = match resolve_ado_remote(&repository_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(TaskImportResult::err(&code, message)),
    };
    let wiql = "SELECT [System.Id], [System.Title], [System.Description], [System.State], \
                [System.ChangedDate] FROM WorkItems WHERE [System.TeamProject] = @project \
                AND [System.WorkItemType] = 'Task' AND [System.AssignedTo] = @Me \
                AND [System.State] NOT IN ('Closed', 'Removed', 'Done') \
                ORDER BY [System.ChangedDate] DESC";
    let output = match run_az(vec![
        "boards".into(),
        "query".into(),
        "--org".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--project".into(),
        remote.project.clone(),
        "--wiql".into(),
        wiql.into(),
        "--output".into(),
        "json".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(error) => return Ok(az_failure(error)),
    };
    match parse_ado_items(&output.stdout, &remote) {
        Ok(items) => Ok(TaskImportResult::ok(items)),
        Err(message) => Ok(TaskImportResult::err("invalid-response", Some(message))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_issue_items() {
        let items = parse_github_items(
            r#"[{"number":42,"title":"Fix it","body":"Details","url":"https://github.com/o/r/issues/42","state":"OPEN","updatedAt":"2026-01-01T00:00:00Z"}]"#,
            "o",
            "r",
        )
        .unwrap();
        assert_eq!(items[0].id, "o/r#42");
        assert_eq!(items[0].display_id, "#42");
    }

    #[test]
    fn parses_ado_task_items_and_strips_html() {
        let items = parse_ado_items(
            r#"[{"id":7,"fields":{"System.Title":"Ship it","System.Description":"<p>Useful &amp; clear</p>","System.State":"Active","System.ChangedDate":"2026-01-01T00:00:00Z"}}]"#,
            &AdoRemote {
                org: "org".into(),
                project: "project".into(),
                repo: "repo".into(),
            },
        )
        .unwrap();
        assert_eq!(items[0].id, "org/project/7");
        assert_eq!(items[0].description, "Useful & clear");
    }
}
