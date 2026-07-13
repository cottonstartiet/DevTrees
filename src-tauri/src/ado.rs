use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::az::{classify_az_generic_failure, run_az, AzError};
use crate::error::AppResult;
use crate::git::run_git;
use crate::reviews::{categorize, ident_eq, short_ref, RepoOpenPrsResult, RepoPr};

#[derive(Debug, Clone)]
pub struct AdoRemote {
    pub org: String,
    pub project: String,
    pub repo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoReviewer {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique_name: Option<String>,
    pub vote: i32,
    pub is_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrDetails {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub is_draft: bool,
    pub source_ref: String,
    pub target_ref: String,
    pub web_url: String,
    pub reviewers: Vec<AdoReviewer>,
    pub creation_date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrDetailsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<AdoPrDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AdoPrDetailsResult {
    fn ok(details: AdoPrDetails) -> Self {
        Self {
            ok: true,
            details: Some(details),
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            details: None,
            code: Some(code.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrCommentAuthor {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrComment {
    pub id: i64,
    pub author: AdoPrCommentAuthor,
    pub content: String,
    pub published_date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrThread {
    pub id: i64,
    pub status: String,
    pub file_path: Option<String>,
    pub line_number: Option<i64>,
    pub comments: Vec<AdoPrComment>,
    pub last_updated: Option<String>,
    pub web_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPrThreadsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threads: Option<Vec<AdoPrThread>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AdoPrThreadsResult {
    fn ok(threads: Vec<AdoPrThread>) -> Self {
        Self {
            ok: true,
            threads: Some(threads),
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            threads: None,
            code: Some(code.into()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoMyOpenPr {
    pub id: i64,
    pub title: String,
    pub source_ref: String,
    pub target_ref: String,
    pub web_url: String,
    pub created_at: Option<String>,
    pub status: String,
    pub is_draft: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoMyOpenPrsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prs: Option<Vec<AdoMyOpenPr>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AdoMyOpenPrsResult {
    fn ok(prs: Vec<AdoMyOpenPr>) -> Self {
        Self {
            ok: true,
            prs: Some(prs),
            code: None,
            message: None,
        }
    }

    fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            prs: None,
            code: Some(code.into()),
            message,
        }
    }
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

fn normalise_vote(value: &Value) -> i32 {
    let n = if let Some(v) = value.as_i64() {
        v
    } else if let Some(v) = value.as_u64() {
        v as i64
    } else if let Some(v) = value.as_str() {
        v.parse::<i64>().unwrap_or(0)
    } else {
        0
    };
    match n {
        10 | 5 | -5 | -10 => n as i32,
        _ => 0,
    }
}

fn normalise_thread_status(value: &Value) -> &'static str {
    if let Some(s) = value.as_str() {
        match s.to_ascii_lowercase().as_str() {
            "active" => return "active",
            "pending" => return "pending",
            "fixed" => return "fixed",
            "wontfix" => return "wontFix",
            "closed" => return "closed",
            "bydesign" => return "byDesign",
            "unknown" => return "unknown",
            _ => {}
        }
    }
    if let Some(n) = value.as_i64().or_else(|| value.as_u64().map(|v| v as i64)) {
        return match n {
            1 => "active",
            2 => "fixed",
            3 => "wontFix",
            4 => "closed",
            5 => "byDesign",
            6 => "pending",
            _ => "unknown",
        };
    }
    "unknown"
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
pub async fn ado_pr_details(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<AdoPrDetailsResult> {
    if folder_path.trim().is_empty() {
        return Ok(AdoPrDetailsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }
    if pull_request_id <= 0 {
        return Ok(AdoPrDetailsResult::err(
            "git-failed",
            Some("pullRequestId is required".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(AdoPrDetailsResult::err(code, message)),
    };

    let output = match run_az(vec![
        "repos".into(),
        "pr".into(),
        "show".into(),
        "--id".into(),
        pull_request_id.to_string(),
        "--organization".into(),
        format!("https://dev.azure.com/{}", remote.org),
        "--output".into(),
        "json".into(),
    ])
    .await
    {
        Ok(output) => output,
        Err(AzError::NotInstalled) => {
            return Ok(AdoPrDetailsResult::err(
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
                return Ok(AdoPrDetailsResult::err(code, Some(message)));
            }
            return Ok(AdoPrDetailsResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_json_from_az_output(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(AdoPrDetailsResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };
    let Some(obj) = parsed.as_object() else {
        return Ok(AdoPrDetailsResult::err(
            "az-failed",
            Some("az output was not an object.".to_string()),
        ));
    };

    let id = json_i64(obj.get("pullRequestId").unwrap_or(&Value::Null))
        .or_else(|| json_i64(obj.get("codeReviewId").unwrap_or(&Value::Null)))
        .unwrap_or(pull_request_id);
    let reviewers = obj
        .get("reviewers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .map(|reviewer| AdoReviewer {
                    display_name: reviewer
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or("Reviewer")
                        .to_string(),
                    unique_name: reviewer
                        .get("uniqueName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    vote: reviewer.get("vote").map(normalise_vote).unwrap_or(0),
                    is_required: reviewer
                        .get("isRequired")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let web_url = obj
        .get("_links")
        .and_then(Value::as_object)
        .and_then(|links| links.get("web"))
        .and_then(Value::as_object)
        .and_then(|web| web.get("href"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| build_ado_pr_web_url(&remote, id));

    Ok(AdoPrDetailsResult::ok(AdoPrDetails {
        id,
        title: obj
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status: obj
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        is_draft: obj.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        source_ref: obj
            .get("sourceRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        target_ref: obj
            .get("targetRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        web_url,
        reviewers,
        creation_date: obj
            .get("creationDate")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

#[tauri::command]
pub async fn ado_pr_threads(
    folder_path: String,
    pull_request_id: i64,
) -> AppResult<AdoPrThreadsResult> {
    if folder_path.trim().is_empty() {
        return Ok(AdoPrThreadsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }
    if pull_request_id <= 0 {
        return Ok(AdoPrThreadsResult::err(
            "git-failed",
            Some("pullRequestId is required".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(AdoPrThreadsResult::err(code, message)),
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
            return Ok(AdoPrThreadsResult::err(
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
                return Ok(AdoPrThreadsResult::err(code, Some(message)));
            }
            return Ok(AdoPrThreadsResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_json_from_az_output(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(AdoPrThreadsResult::err(
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
        if status != "active" && status != "pending" {
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
            comments.push(AdoPrComment {
                id: json_i64(comment.get("id").unwrap_or(&Value::Null)).unwrap_or(0),
                author: AdoPrCommentAuthor {
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

        threads.push(AdoPrThread {
            id,
            status: status.to_string(),
            file_path,
            line_number,
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

    Ok(AdoPrThreadsResult::ok(threads))
}

#[tauri::command]
pub async fn ado_my_open_prs(folder_path: String) -> AppResult<AdoMyOpenPrsResult> {
    if folder_path.trim().is_empty() {
        return Ok(AdoMyOpenPrsResult::err(
            "git-failed",
            Some("folderPath is required".to_string()),
        ));
    }

    let remote = match resolve_ado_remote(&folder_path).await {
        Ok(remote) => remote,
        Err((code, message)) => return Ok(AdoMyOpenPrsResult::err(code, message)),
    };

    let output = match run_az(vec![
        "repos".into(),
        "pr".into(),
        "list".into(),
        "--creator".into(),
        "@me".into(),
        "--status".into(),
        "active".into(),
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
            return Ok(AdoMyOpenPrsResult::err(
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
                return Ok(AdoMyOpenPrsResult::err(code, Some(message)));
            }
            return Ok(AdoMyOpenPrsResult::err(
                "az-failed",
                Some(az_failed_message(&stdout, &stderr, code)),
            ));
        }
    };

    let parsed = match parse_json_from_az_output(&output.stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return Ok(AdoMyOpenPrsResult::err(
                "az-failed",
                Some(format!("Could not parse az output: {err}")),
            ))
        }
    };

    let Some(items) = parsed.as_array() else {
        return Ok(AdoMyOpenPrsResult::ok(Vec::new()));
    };

    let prs = items
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            let id = json_i64(item.get("pullRequestId").unwrap_or(&Value::Null))
                .or_else(|| json_i64(item.get("codeReviewId").unwrap_or(&Value::Null)))
                .unwrap_or(0);
            let web_url = item
                .get("_links")
                .and_then(Value::as_object)
                .and_then(|links| links.get("web"))
                .and_then(Value::as_object)
                .and_then(|web| web.get("href"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if id > 0 {
                        build_ado_pr_web_url(&remote, id)
                    } else {
                        format!(
                            "https://dev.azure.com/{}/{}/_git/{}/pullrequests",
                            encode_uri_component(&remote.org),
                            encode_uri_component(&remote.project),
                            encode_uri_component(&remote.repo)
                        )
                    }
                });

            AdoMyOpenPr {
                id,
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                source_ref: item
                    .get("sourceRefName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                target_ref: item
                    .get("targetRefName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                web_url,
                created_at: item
                    .get("creationDate")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("active")
                    .to_string(),
                is_draft: item
                    .get("isDraft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect();

    Ok(AdoMyOpenPrsResult::ok(prs))
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
