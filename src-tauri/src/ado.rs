use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::az::{classify_az_generic_failure, run_az, run_az_with_body, AzError};
use crate::error::AppResult;
use crate::git::run_git;
use crate::pr_review::{
    clamp_text, diff_blobs, is_markdown_path, looks_binary, normalize_path, PrChangedFile,
    PrChangedFilesResult, PrCommentAnchor, PrFileContent, PrFileContentResult, PrFileDiff,
    PrFileDiffResult, PrMutationResult, PrReviewDetail, PrReviewDetailResult,
};
use crate::reviews::{
    categorize, ident_eq, short_ref, RepoOpenPrsResult, RepoPr, RepoPrComment, RepoPrCommentAuthor,
    RepoPrThread, RepoPrThreadStatus, RepoPrThreadsResult,
};

#[derive(Debug, Clone)]
pub struct AdoRemote {
    pub org: String,
    pub project: String,
    pub repo: String,
}

pub fn parse_ado_remote(raw_url: &str) -> Option<AdoRemote> {
    static HTTPS: OnceLock<Regex> = OnceLock::new();
    static DEV_AZURE_PATH: OnceLock<Regex> = OnceLock::new();
    static VS_HOST: OnceLock<Regex> = OnceLock::new();
    static VS_PATH: OnceLock<Regex> = OnceLock::new();
    static SSH_MODERN: OnceLock<Regex> = OnceLock::new();
    static SSH_LEGACY: OnceLock<Regex> = OnceLock::new();

    let url = raw_url.trim();
    if url.is_empty() {
        return None;
    }

    let https = HTTPS.get_or_init(|| Regex::new(r"(?i)^https?://([^/]+)/(.+)$").unwrap());
    if let Some(caps) = https.captures(url) {
        let mut host = caps.get(1)?.as_str().to_string();
        let mut path = caps.get(2)?.as_str().trim_end_matches('/').to_string();
        if let Some(idx) = host.find('@') {
            host = host[idx + 1..].to_string();
        }

        if host.eq_ignore_ascii_case("dev.azure.com") {
            let path_re = DEV_AZURE_PATH
                .get_or_init(|| Regex::new(r"(?i)^([^/]+)/(.+?)/_git/([^/]+)$").unwrap());
            let m = path_re.captures(&path)?;
            return Some(AdoRemote {
                org: safe_decode(m.get(1)?.as_str()),
                project: safe_decode(m.get(2)?.as_str()),
                repo: safe_decode(&strip_git_suffix(m.get(3)?.as_str())),
            });
        }

        let vs_host =
            VS_HOST.get_or_init(|| Regex::new(r"(?i)^([^.]+)\.visualstudio\.com$").unwrap());
        if let Some(m) = vs_host.captures(&host) {
            if path.len() >= "DefaultCollection/".len()
                && path[.."DefaultCollection/".len()].eq_ignore_ascii_case("DefaultCollection/")
            {
                path = path["DefaultCollection/".len()..].to_string();
            }
            let path_re = VS_PATH.get_or_init(|| Regex::new(r"(?i)^(.+?)/_git/([^/]+)$").unwrap());
            let captures = path_re.captures(&path)?;
            return Some(AdoRemote {
                org: safe_decode(m.get(1)?.as_str()),
                project: safe_decode(captures.get(1)?.as_str()),
                repo: safe_decode(&strip_git_suffix(captures.get(2)?.as_str())),
            });
        }
    }

    let modern =
        SSH_MODERN.get_or_init(|| Regex::new(r"(?i)^[^@]+@ssh\.dev\.azure\.com:v3/(.+)$").unwrap());
    if let Some(caps) = modern.captures(url) {
        let rest = caps.get(1)?.as_str();
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() < 3 {
            return None;
        }
        return Some(AdoRemote {
            org: safe_decode(parts[0]),
            project: safe_decode(parts[1]),
            repo: safe_decode(&strip_git_suffix(&parts[2..].join("/"))),
        });
    }

    let legacy = SSH_LEGACY.get_or_init(|| {
        Regex::new(r"(?i)^[^@]+@([^.]+)\.vs-ssh\.visualstudio\.com:v3/(.+)$").unwrap()
    });
    if let Some(caps) = legacy.captures(url) {
        let parts: Vec<&str> = caps.get(2)?.as_str().split('/').collect();
        if parts.len() < 3 {
            return None;
        }
        return Some(AdoRemote {
            org: safe_decode(caps.get(1)?.as_str()),
            project: safe_decode(parts[1]),
            repo: safe_decode(&strip_git_suffix(&parts[2..].join("/"))),
        });
    }

    None
}

pub fn build_ado_pr_web_url(remote: &AdoRemote, pr_id: i64) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{}",
        encode_uri_component(&remote.org),
        encode_uri_component(&remote.project),
        encode_uri_component(&remote.repo),
        pr_id
    )
}

pub fn build_ado_commit_url(remote: &AdoRemote, sha: &str) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_git/{}/commit/{}",
        encode_uri_component(&remote.org),
        encode_uri_component(&remote.project),
        encode_uri_component(&remote.repo),
        encode_uri_component(sha)
    )
}

pub fn build_ado_branch_url(remote: &AdoRemote, branch: &str) -> String {
    let encoded_branch = encode_uri_component(branch)
        .replace("%2F", "/")
        .replace("%2f", "/");
    format!(
        "https://dev.azure.com/{}/{}/_git/{}?version=GB{}",
        encode_uri_component(&remote.org),
        encode_uri_component(&remote.project),
        encode_uri_component(&remote.repo),
        encoded_branch
    )
}

pub fn build_ado_pr_thread_url(remote: &AdoRemote, pr_id: i64, thread_id: i64) -> String {
    format!(
        "{}?discussionId={thread_id}",
        build_ado_pr_web_url(remote, pr_id)
    )
}

pub async fn resolve_ado_remote(folder_path: &str) -> Result<AdoRemote, (String, Option<String>)> {
    if folder_path.trim().is_empty() {
        return Err((
            "git-failed".to_string(),
            Some("folderPath is required".to_string()),
        ));
    }

    let origin = match run_git(
        vec!["remote".into(), "get-url".into(), "origin".into()],
        folder_path.to_string(),
    )
    .await
    {
        Ok(out) => out.stdout.trim().to_string(),
        Err(err) => return Err(("no-origin".to_string(), Some(err.message))),
    };

    if origin.is_empty() {
        return Err(("no-origin".to_string(), None));
    }

    match parse_ado_remote(&origin) {
        Some(remote) => Ok(remote),
        None => Err((
            "unsupported-remote".to_string(),
            Some(format!(
                "Origin is not a recognized Azure DevOps Services remote: {origin}"
            )),
        )),
    }
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &byte in s.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn safe_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return s.to_string();
            }
            let hi = from_hex(bytes[i + 1]);
            let lo = from_hex(bytes[i + 2]);
            let (Some(hi), Some(lo)) = (hi, lo) else {
                return s.to_string();
            };
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn strip_git_suffix(s: &str) -> String {
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".git") {
        s[..s.len() - 4].to_string()
    } else {
        s.to_string()
    }
}

fn parse_json_from_az_output(stdout: &str) -> Result<Value, serde_json::Error> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }

    let first_bracket = trimmed.find('[');
    let first_brace = trimmed.find('{');
    let start = match (first_bracket, first_brace) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let json_text = start.map(|idx| &trimmed[idx..]).unwrap_or(trimmed);
    serde_json::from_str(json_text)
}

fn normalise_thread_status(value: &Value) -> RepoPrThreadStatus {
    if let Some(s) = value.as_str() {
        match s.to_ascii_lowercase().as_str() {
            "active" => return RepoPrThreadStatus::Active,
            "pending" => return RepoPrThreadStatus::Pending,
            "fixed" => return RepoPrThreadStatus::Fixed,
            "wontfix" => return RepoPrThreadStatus::WontFix,
            "closed" => return RepoPrThreadStatus::Closed,
            "bydesign" => return RepoPrThreadStatus::ByDesign,
            "unknown" => return RepoPrThreadStatus::Unknown,
            _ => {}
        }
    }
    if let Some(n) = value.as_i64().or_else(|| value.as_u64().map(|v| v as i64)) {
        return match n {
            1 => RepoPrThreadStatus::Active,
            2 => RepoPrThreadStatus::Fixed,
            3 => RepoPrThreadStatus::WontFix,
            4 => RepoPrThreadStatus::Closed,
            5 => RepoPrThreadStatus::ByDesign,
            6 => RepoPrThreadStatus::Pending,
            _ => RepoPrThreadStatus::Unknown,
        };
    }
    RepoPrThreadStatus::Unknown
}

fn normalise_comment_type(value: &Value) -> &'static str {
    if let Some(s) = value.as_str() {
        match s.to_ascii_lowercase().as_str() {
            "text" => return "text",
            "codechange" => return "codeChange",
            "system" => return "system",
            _ => {}
        }
    }
    if let Some(n) = value.as_i64().or_else(|| value.as_u64().map(|v| v as i64)) {
        return match n {
            1 => "text",
            2 => "codeChange",
            3 => "system",
            _ => "unknown",
        };
    }
    "unknown"
}

fn az_failed_message(stdout: &str, stderr: &str, code: Option<i32>) -> String {
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        format!(
            "az exited with code {}",
            code.map_or("?".to_string(), |c| c.to_string())
        )
    }
}

fn parse_millis_for_sort(value: Option<&str>) -> i64 {
    value.and_then(parse_rfc3339_to_millis).unwrap_or(0)
}

fn parse_rfc3339_to_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }

    let year = parse_digits(bytes, 0, 4)? as i32;
    let month = parse_digits(bytes, 5, 2)? as u32;
    let day = parse_digits(bytes, 8, 2)? as u32;
    let hour = parse_digits(bytes, 11, 2)? as i64;
    let minute = parse_digits(bytes, 14, 2)? as i64;
    let second = parse_digits(bytes, 17, 2)? as i64;

    let mut idx = 19;
    let mut millis = 0i64;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let frac_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = std::str::from_utf8(&bytes[frac_start..idx]).ok()?;
        let mut digits = frac.chars().take(3).collect::<String>();
        while digits.len() < 3 {
            digits.push('0');
        }
        millis = digits.parse::<i64>().ok()?;
    }

    let offset_secs = match bytes.get(idx)? {
        b'Z' => 0,
        b'+' | b'-' => {
            let sign = if bytes[idx] == b'+' { 1 } else { -1 };
            if idx + 5 >= bytes.len() || bytes[idx + 3] != b':' {
                return None;
            }
            let offset_hour = parse_digits(bytes, idx + 1, 2)? as i64;
            let offset_minute = parse_digits(bytes, idx + 4, 2)? as i64;
            sign * (offset_hour * 3600 + offset_minute * 60)
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day)?;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_secs;
    Some(seconds * 1_000 + millis)
}

fn parse_digits(bytes: &[u8], start: usize, len: usize) -> Option<i64> {
    let end = start.checked_add(len)?;
    let slice = bytes.get(start..end)?;
    if !slice.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    std::str::from_utf8(slice).ok()?.parse().ok()
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) as i64)
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|v| v as i64))
        .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
}

#[tauri::command]
pub async fn ado_pr_threads(
    folder_path: String,
    pull_request_id: i64,
    include_resolved: Option<bool>,
) -> AppResult<RepoPrThreadsResult> {
    if folder_path.trim().is_empty() {
        return Ok(RepoPrThreadsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }
    if pull_request_id <= 0 {
        return Ok(RepoPrThreadsResult::err(
            "git-failed",
            Some("pullRequestId is required".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(RepoPrThreadsResult::err(code, message)),
    };

    let output = match run_az(vec![
        "devops".into(),
        "invoke".into(),
        "--area".into(),
        "git".into(),
        "--resource".into(),
        "pullRequestThreads".into(),
        "--route-parameters".into(),
        format!("project={}", remote.project),
        format!("repositoryId={}", remote.repo),
        format!("pullRequestId={pull_request_id}"),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--api-version".into(),
        "7.1".into(),
        "--http-method".into(),
        "GET".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(AzError::NotInstalled) => {
            return Ok(RepoPrThreadsResult::err(
                "az-not-installed",
                Some("Azure CLI (az) was not found on PATH.".to_string()),
            ))
        }
        Err(AzError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                return Ok(RepoPrThreadsResult::err(code, Some(message)));
            }
            return Ok(RepoPrThreadsResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_json_from_az_output(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(RepoPrThreadsResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };

    let raw_threads = parsed
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| parsed.as_array().cloned())
        .unwrap_or_default();

    let mut threads = Vec::new();
    for raw in raw_threads {
        let Some(thread) = raw.as_object() else {
            continue;
        };
        if thread
            .get("isDeleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }

        let status = normalise_thread_status(thread.get("status").unwrap_or(&Value::Null));
        let is_resolved = !matches!(
            status,
            RepoPrThreadStatus::Active | RepoPrThreadStatus::Pending
        );
        if is_resolved && !include_resolved.unwrap_or(false) {
            continue;
        }

        let mut comments = Vec::new();
        for comment in thread
            .get("comments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let Some(comment) = comment.as_object() else {
                continue;
            };
            if normalise_comment_type(comment.get("commentType").unwrap_or(&Value::Null))
                == "system"
            {
                continue;
            }

            let author = comment.get("author").and_then(Value::as_object);
            comments.push(RepoPrComment {
                id: json_i64(comment.get("id").unwrap_or(&Value::Null)).unwrap_or(0),
                author: RepoPrCommentAuthor {
                    display_name: author
                        .and_then(|a| a.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown")
                        .to_string(),
                    unique_name: author
                        .and_then(|a| a.get("uniqueName"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
                content: comment
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                published_date: comment
                    .get("publishedDate")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        if comments.is_empty() {
            continue;
        }

        let context = thread.get("threadContext").and_then(Value::as_object);
        let file_path = context
            .and_then(|ctx| ctx.get("filePath"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let line_number = context
            .and_then(|ctx| {
                ctx.get("rightFileStart")
                    .and_then(Value::as_object)
                    .and_then(|obj| obj.get("line"))
                    .and_then(json_i64)
                    .or_else(|| {
                        ctx.get("rightFileEnd")
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("line"))
                            .and_then(json_i64)
                    })
                    .or_else(|| {
                        ctx.get("leftFileStart")
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("line"))
                            .and_then(json_i64)
                    })
            })
            .filter(|line| *line > 0);
        let end_line_number = context
            .and_then(|ctx| {
                ctx.get("rightFileEnd")
                    .and_then(Value::as_object)
                    .and_then(|obj| obj.get("line"))
                    .and_then(json_i64)
            })
            .filter(|line| *line > 0)
            .or(line_number);

        let id = json_i64(thread.get("id").unwrap_or(&Value::Null)).unwrap_or(0);
        let last_updated = thread
            .get("lastUpdatedDate")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                thread
                    .get("publishedDate")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });

        threads.push(RepoPrThread {
            id,
            provider_thread_id: id.to_string(),
            status,
            file_path,
            line_number,
            end_line_number,
            is_resolved,
            comments,
            last_updated,
            web_url: if id > 0 {
                build_ado_pr_thread_url(&remote, pull_request_id, id)
            } else {
                build_ado_pr_web_url(&remote, pull_request_id)
            },
        });
    }

    threads.sort_by(|a, b| {
        parse_millis_for_sort(b.last_updated.as_deref())
            .cmp(&parse_millis_for_sort(a.last_updated.as_deref()))
    });

    Ok(RepoPrThreadsResult::ok(threads))
}

/// Resolve the signed-in Azure account's identifier (UPN / `user.name`), lowercased, for categorizing
/// PRs. Best-effort: returns `None` if `az account show` fails, in which case callers treat every PR
/// as "other".
async fn resolve_ado_current_user() -> Option<String> {
    let output = run_az(vec![
        "account".into(),
        "show".into(),
        "--output".into(),
        "json".into(),
    ])
    .await
    .ok()?;

    let parsed = parse_json_from_az_output(&output.stdout).ok()?;
    parsed
        .get("user")
        .and_then(Value::as_object)
        .and_then(|user| user.get("name"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// List all active pull requests for the Azure DevOps repository at `folder_path`, categorized
/// relative to the signed-in user (mine / assigned / other).
#[tauri::command]
pub async fn ado_repo_open_prs(folder_path: String) -> AppResult<RepoOpenPrsResult> {
    if folder_path.trim().is_empty() {
        return Ok(RepoOpenPrsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(RepoOpenPrsResult::err(code, message)),
    };

    let current_user = resolve_ado_current_user().await;

    let output = match run_az(vec![
        "repos".into(),
        "pr".into(),
        "list".into(),
        "--status".into(),
        "active".into(),
        "--top".into(),
        "200".into(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--project".into(),
        remote.project.clone(),
        "--repository".into(),
        remote.repo.clone(),
        "--output".into(),
        "json".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(AzError::NotInstalled) => {
            return Ok(RepoOpenPrsResult::err(
                "az-not-installed",
                Some("Azure CLI (az) was not found on PATH.".to_string()),
            ))
        }
        Err(AzError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                return Ok(RepoOpenPrsResult::err(code, Some(message)));
            }
            return Ok(RepoOpenPrsResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_json_from_az_output(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(RepoOpenPrsResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };

    let Some(items) = parsed.as_array() else {
        return Ok(RepoOpenPrsResult::ok(Vec::new()));
    };

    let prs = items
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            let id = json_i64(item.get("pullRequestId").unwrap_or(&Value::Null))
                .or_else(|| json_i64(item.get("codeReviewId").unwrap_or(&Value::Null)))
                .unwrap_or(0);

            let created_by = item.get("createdBy").and_then(Value::as_object);
            let author = created_by
                .and_then(|c| c.get("displayName"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let author_unique = created_by
                .and_then(|c| c.get("uniqueName"))
                .and_then(Value::as_str)
                .unwrap_or("");

            let is_author = current_user
                .as_deref()
                .map(|me| ident_eq(author_unique, me))
                .unwrap_or(false);
            let is_assigned = current_user
                .as_deref()
                .map(|me| reviewers_contain(item.get("reviewers"), me))
                .unwrap_or(false);

            let web_url = item
                .get("_links")
                .and_then(Value::as_object)
                .and_then(|links| links.get("web"))
                .and_then(Value::as_object)
                .and_then(|web| web.get("href"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| build_ado_pr_web_url(&remote, id));

            RepoPr {
                provider: "ado".to_string(),
                id,
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                author,
                source_ref: short_ref(
                    item.get("sourceRefName")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ),
                target_ref: short_ref(
                    item.get("targetRefName")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ),
                web_url,
                created_at: item
                    .get("creationDate")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_draft: item
                    .get("isDraft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                category: categorize(is_author, is_assigned),
            }
        })
        .collect();

    Ok(RepoOpenPrsResult::ok(prs))
}

/// True if any reviewer in an ADO PR `reviewers` array has a `uniqueName` matching `needle`.
fn reviewers_contain(value: Option<&Value>, needle: &str) -> bool {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|entry| {
                entry
                    .as_object()
                    .and_then(|obj| obj.get("uniqueName"))
                    .and_then(Value::as_str)
                    .map(|unique| ident_eq(unique, needle))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// In-app PR review workspace (see `pr_review.rs` and `src/shared/pr-review.ts`)
// ---------------------------------------------------------------------------

/// `(code, message)` failure pair shared by the review helpers below.
type AzFail = (String, Option<String>);

fn map_az_error(err: AzError) -> AzFail {
    match err {
        AzError::NotInstalled => (
            "az-not-installed".to_string(),
            Some("Azure CLI (az) was not found on PATH.".to_string()),
        ),
        AzError::Failed {
            stdout,
            stderr,
            code,
        } => {
            if let Some((code, message)) = classify_az_generic_failure(&stderr) {
                (code, Some(message))
            } else {
                (
                    "az-failed".to_string(),
                    Some(az_failed_message(&stdout, &stderr, code)),
                )
            }
        }
    }
}

/// Build the `az devops invoke` argument list for one Git-area REST call.
fn invoke_args(
    remote: &AdoRemote,
    resource: &str,
    route_params: &[(&str, String)],
    query_params: &[(&str, String)],
    method: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "devops".into(),
        "invoke".into(),
        "--area".into(),
        "git".into(),
        "--resource".into(),
        resource.into(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--api-version".into(),
        "7.1".into(),
        "--http-method".into(),
        method.into(),
    ];

    args.push("--route-parameters".into());
    args.push(format!("project={}", remote.project));
    args.push(format!("repositoryId={}", remote.repo));
    for (key, value) in route_params {
        args.push(format!("{key}={value}"));
    }

    if !query_params.is_empty() {
        args.push("--query-parameters".into());
        for (key, value) in query_params {
            args.push(format!("{key}={value}"));
        }
    }

    args
}

async fn az_invoke(
    remote: &AdoRemote,
    resource: &str,
    route_params: &[(&str, String)],
    query_params: &[(&str, String)],
    method: &str,
) -> Result<Value, AzFail> {
    let args = invoke_args(remote, resource, route_params, query_params, method);
    let output = run_az(args).await.map_err(map_az_error)?;
    parse_json_from_az_output(&output.stdout).map_err(|err| {
        (
            "az-failed".to_string(),
            Some(format!("Could not parse az output: {err}")),
        )
    })
}

async fn az_invoke_with_body(
    remote: &AdoRemote,
    resource: &str,
    route_params: &[(&str, String)],
    method: &str,
    body: Value,
) -> Result<Value, AzFail> {
    let args = invoke_args(remote, resource, route_params, &[], method);
    let output = run_az_with_body(args, body.to_string())
        .await
        .map_err(map_az_error)?;
    parse_json_from_az_output(&output.stdout).map_err(|err| {
        (
            "az-failed".to_string(),
            Some(format!("Could not parse az output: {err}")),
        )
    })
}

fn map_ado_vote(vote: i64) -> &'static str {
    match vote {
        10 => "approved",
        5 => "approvedWithSuggestions",
        -5 => "waitingForAuthor",
        -10 => "rejected",
        _ => "none",
    }
}

fn vote_to_az_flag(vote: &str) -> Option<&'static str> {
    match vote {
        "approved" => Some("approve"),
        "approvedWithSuggestions" => Some("approve-with-suggestions"),
        "waitingForAuthor" => Some("wait-for-author"),
        "rejected" => Some("reject"),
        "none" => Some("reset"),
        _ => None,
    }
}

fn map_ado_pr_state(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "active" => "open",
        "completed" => "merged",
        "abandoned" => "abandoned",
        _ => "unknown",
    }
}

fn map_ado_change_type(value: &Value) -> &'static str {
    let raw = match value.as_str() {
        Some(s) => s.to_ascii_lowercase(),
        None => match json_i64(value) {
            // VersionControlChangeType bit flags.
            Some(1) => "add".to_string(),
            Some(2) => "edit".to_string(),
            Some(16) => "delete".to_string(),
            Some(32) => "rename".to_string(),
            _ => "edit".to_string(),
        },
    };
    if raw.contains("rename") {
        "rename"
    } else if raw.contains("delete") {
        "delete"
    } else if raw.contains("add") {
        "add"
    } else {
        "edit"
    }
}

/// The commits a PR's diff is computed between: the merge base and the source tip of the latest
/// iteration.
async fn ado_pr_commits(
    remote: &AdoRemote,
    pull_request_id: i64,
) -> Result<(String, String, i64), AzFail> {
    let parsed = az_invoke(
        remote,
        "pullRequestIterations",
        &[("pullRequestId", pull_request_id.to_string())],
        &[],
        "GET",
    )
    .await?;

    let iterations = parsed
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| parsed.as_array().cloned())
        .unwrap_or_default();

    let Some(latest) = iterations.last() else {
        return Err((
            "az-failed".to_string(),
            Some("Pull request has no iterations.".to_string()),
        ));
    };

    let head = latest
        .pointer("/sourceRefCommit/commitId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let base = latest
        .pointer("/commonRefCommit/commitId")
        .and_then(Value::as_str)
        .or_else(|| {
            latest
                .pointer("/targetRefCommit/commitId")
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();
    let iteration_id = latest.get("id").and_then(json_i64).unwrap_or(1);

    Ok((base, head, iteration_id))
}

/// Full text of `path` at `commit`, or `None` when the item does not exist on that side.
async fn ado_file_text(
    remote: &AdoRemote,
    path: &str,
    commit: &str,
) -> Result<Option<(String, bool)>, AzFail> {
    if commit.is_empty() {
        return Ok(None);
    }

    let parsed = az_invoke(
        remote,
        "items",
        &[],
        &[
            ("path", format!("/{}", normalize_path(path))),
            ("versionDescriptor.version", commit.to_string()),
            ("versionDescriptor.versionType", "commit".to_string()),
            ("includeContent", "true".to_string()),
            ("$format", "json".to_string()),
        ],
        "GET",
    )
    .await;

    match parsed {
        Ok(value) => {
            let Some(content) = value.get("content").and_then(Value::as_str) else {
                return Ok(None);
            };
            if looks_binary(content.as_bytes()) {
                return Ok(Some((String::new(), true)));
            }
            Ok(Some((content.to_string(), false)))
        }
        // A missing item on one side (added / deleted file) is expected, not an error.
        Err((code, message)) => {
            let text = message.clone().unwrap_or_default();
            if text.contains("TF401174")
                || text.to_ascii_lowercase().contains("could not be found")
                || text.contains("404")
            {
                Ok(None)
            } else {
                Err((code, message))
            }
        }
    }
}

/// Header detail for the review workspace.
#[tauri::command]
pub async fn ado_pr_detail(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<PrReviewDetailResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrReviewDetailResult::err(code, message)),
    };

    let pr = match az_invoke(
        &remote,
        "pullRequests",
        &[("pullRequestId", pull_request_id.to_string())],
        &[],
        "GET",
    )
    .await
    {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrReviewDetailResult::err(code, message)),
    };

    let current_user = resolve_ado_current_user().await.unwrap_or_default();
    let my_vote = pr
        .get("reviewers")
        .and_then(Value::as_array)
        .and_then(|reviewers| {
            reviewers.iter().find_map(|reviewer| {
                let unique = reviewer.get("uniqueName").and_then(Value::as_str)?;
                if !ident_eq(unique, &current_user) {
                    return None;
                }
                reviewer.get("vote").and_then(json_i64)
            })
        })
        .map(map_ado_vote)
        .unwrap_or("none");

    let (base_sha, head_sha) = match ado_pr_commits(&remote, pull_request_id).await {
        Ok((base, head, _)) => (base, head),
        Err(_) => (
            pr.pointer("/lastMergeTargetCommit/commitId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            pr.pointer("/lastMergeSourceCommit/commitId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    };

    Ok(PrReviewDetailResult::ok(PrReviewDetail {
        provider: "ado".to_string(),
        id: pr
            .get("pullRequestId")
            .and_then(json_i64)
            .unwrap_or(pull_request_id),
        title: pr
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: pr
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: pr
            .pointer("/createdBy/displayName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        source_ref: short_ref(
            pr.get("sourceRefName")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        target_ref: short_ref(
            pr.get("targetRefName")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        head_sha,
        base_sha,
        web_url: build_ado_pr_web_url(&remote, pull_request_id),
        is_draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state: map_ado_pr_state(pr.get("status").and_then(Value::as_str).unwrap_or("")).to_string(),
        my_vote: my_vote.to_string(),
    }))
}

/// The changed-files sidebar contents, taken from the latest iteration's change entries.
///
/// Azure DevOps does not report per-file add/delete counts, so those stay at zero until the file's
/// diff is loaded and the renderer fills them in.
#[tauri::command]
pub async fn ado_pr_changed_files(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<PrChangedFilesResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrChangedFilesResult::err(code, message)),
    };

    let (_, _, iteration_id) = match ado_pr_commits(&remote, pull_request_id).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrChangedFilesResult::err(code, message)),
    };

    let parsed = match az_invoke(
        &remote,
        "pullRequestIterationChanges",
        &[
            ("pullRequestId", pull_request_id.to_string()),
            ("iterationId", iteration_id.to_string()),
        ],
        &[("$top", "2000".to_string())],
        "GET",
    )
    .await
    {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrChangedFilesResult::err(code, message)),
    };

    let entries = parsed
        .get("changeEntries")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| parsed.get("value").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    let mut files = Vec::new();
    for entry in entries.iter().filter_map(Value::as_object) {
        let item = entry.get("item").and_then(Value::as_object);
        let is_folder = item
            .and_then(|i| i.get("isFolder"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_folder {
            continue;
        }
        let Some(raw_path) = item.and_then(|i| i.get("path")).and_then(Value::as_str) else {
            continue;
        };
        let path = normalize_path(raw_path);
        if path.is_empty() {
            continue;
        }

        files.push(PrChangedFile {
            is_markdown: is_markdown_path(&path),
            previous_path: entry
                .get("sourceServerItem")
                .and_then(Value::as_str)
                .map(normalize_path),
            change_type: map_ado_change_type(entry.get("changeType").unwrap_or(&Value::Null))
                .to_string(),
            additions: 0,
            deletions: 0,
            is_binary: false,
            path,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(PrChangedFilesResult::ok(files))
}

/// Unified diff for one file, computed from the base and head blobs since Azure DevOps exposes no
/// patch endpoint.
#[tauri::command]
pub async fn ado_pr_file_diff(
    folder_path: String,
    pull_request_id: i64,
    path: String,
) -> AppResult<PrFileDiffResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };

    let (base_sha, head_sha, _) = match ado_pr_commits(&remote, pull_request_id).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };

    let wanted = normalize_path(&path);
    let base = match ado_file_text(&remote, &wanted, &base_sha).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };
    let head = match ado_file_text(&remote, &wanted, &head_sha).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileDiffResult::err(code, message)),
    };

    if base.as_ref().map(|(_, bin)| *bin).unwrap_or(false)
        || head.as_ref().map(|(_, bin)| *bin).unwrap_or(false)
    {
        return Ok(PrFileDiffResult::ok(PrFileDiff {
            path: wanted,
            hunks: Vec::new(),
            is_binary: true,
            truncated: false,
        }));
    }

    let (base_text, base_truncated) = clamp_text(&base.map(|(text, _)| text).unwrap_or_default());
    let (head_text, head_truncated) = clamp_text(&head.map(|(text, _)| text).unwrap_or_default());

    Ok(PrFileDiffResult::ok(PrFileDiff {
        path: wanted,
        hunks: diff_blobs(&base_text, &head_text),
        is_binary: false,
        truncated: base_truncated || head_truncated,
    }))
}

/// Full text of one side of a file, backing the markdown preview and raw views.
#[tauri::command]
pub async fn ado_pr_file_content(
    folder_path: String,
    pull_request_id: i64,
    path: String,
    side: String,
) -> AppResult<PrFileContentResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };

    let (base_sha, head_sha, _) = match ado_pr_commits(&remote, pull_request_id).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };
    let commit = if side == "base" { base_sha } else { head_sha };

    let wanted = normalize_path(&path);
    let fetched = match ado_file_text(&remote, &wanted, &commit).await {
        Ok(value) => value,
        Err((code, message)) => return Ok(PrFileContentResult::err(code, message)),
    };

    let Some((text, is_binary)) = fetched else {
        return Ok(PrFileContentResult::err(
            "az-failed",
            Some(format!("{wanted} does not exist on the {side} side.")),
        ));
    };

    let (text, truncated) = clamp_text(&text);
    Ok(PrFileContentResult::ok(PrFileContent {
        path: wanted,
        side,
        text,
        is_binary,
        truncated,
    }))
}

/// Create a review comment thread. Azure DevOps accepts an anchor on any line of the file, so
/// markdown preview ranges are posted verbatim.
#[tauri::command]
pub async fn ado_pr_create_thread(
    folder_path: String,
    pull_request_id: i64,
    anchor: Option<PrCommentAnchor>,
    content: String,
) -> AppResult<PrMutationResult> {
    if content.trim().is_empty() {
        return Ok(PrMutationResult::err(
            "az-failed",
            Some("Comment body is required.".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let mut body = serde_json::json!({
        "comments": [{ "parentCommentId": 0, "content": content, "commentType": 1 }],
        "status": 1,
    });

    if let Some(anchor) = anchor {
        let (start, end) = anchor.range();
        let side_start = if anchor.is_right() {
            "rightFileStart"
        } else {
            "leftFileStart"
        };
        let side_end = if anchor.is_right() {
            "rightFileEnd"
        } else {
            "leftFileEnd"
        };
        body["threadContext"] = serde_json::json!({
            "filePath": format!("/{}", normalize_path(&anchor.file_path)),
            side_start: { "line": start, "offset": 1 },
            side_end: { "line": end, "offset": 1 },
        });
    }

    match az_invoke_with_body(
        &remote,
        "pullRequestThreads",
        &[("pullRequestId", pull_request_id.to_string())],
        "POST",
        body,
    )
    .await
    {
        Ok(_) => Ok(PrMutationResult::ok(None)),
        Err((code, message)) => Ok(PrMutationResult::err(code, message)),
    }
}

/// Reply to an existing thread.
#[tauri::command]
pub async fn ado_pr_reply(
    folder_path: String,
    pull_request_id: i64,
    thread_id: String,
    content: String,
) -> AppResult<PrMutationResult> {
    if content.trim().is_empty() {
        return Ok(PrMutationResult::err(
            "az-failed",
            Some("Reply body is required.".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let body = serde_json::json!({ "parentCommentId": 1, "content": content, "commentType": 1 });

    match az_invoke_with_body(
        &remote,
        "pullRequestThreadComments",
        &[
            ("pullRequestId", pull_request_id.to_string()),
            ("threadId", thread_id.clone()),
        ],
        "POST",
        body,
    )
    .await
    {
        Ok(_) => Ok(PrMutationResult::ok(None)),
        Err((code, message)) => Ok(PrMutationResult::err(code, message)),
    }
}

/// Resolve (`fixed`) or reopen (`active`) a thread.
#[tauri::command]
pub async fn ado_pr_set_thread_status(
    folder_path: String,
    pull_request_id: i64,
    thread_id: String,
    resolved: bool,
) -> AppResult<PrMutationResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let body = serde_json::json!({ "status": if resolved { "fixed" } else { "active" } });

    match az_invoke_with_body(
        &remote,
        "pullRequestThreads",
        &[
            ("pullRequestId", pull_request_id.to_string()),
            ("threadId", thread_id.clone()),
        ],
        "PATCH",
        body,
    )
    .await
    {
        Ok(_) => Ok(PrMutationResult::ok(None)),
        Err((code, message)) => Ok(PrMutationResult::err(code, message)),
    }
}

/// Submit the current user's vote on the pull request.
#[tauri::command]
pub async fn ado_pr_set_vote(
    folder_path: String,
    pull_request_id: i64,
    vote: String,
) -> AppResult<PrMutationResult> {
    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(PrMutationResult::err(code, message)),
    };

    let Some(flag) = vote_to_az_flag(&vote) else {
        return Ok(PrMutationResult::err(
            "az-failed",
            Some(format!("Unsupported vote: {vote}")),
        ));
    };

    match run_az(vec![
        "repos".into(),
        "pr".into(),
        "set-vote".into(),
        "--id".into(),
        pull_request_id.to_string(),
        "--vote".into(),
        flag.into(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
    ])
    .await
    {
        Ok(_) => Ok(PrMutationResult::ok(None)),
        Err(err) => {
            let (code, message) = map_az_error(err);
            Ok(PrMutationResult::err(code, message))
        }
    }
}
