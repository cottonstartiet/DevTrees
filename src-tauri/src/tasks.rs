use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::DbState;
use crate::error::{AppError, AppResult};

const MAX_ATTACHMENTS: usize = 32;
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachmentSelection {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub staged: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    /// "task" | "browser-code-review"
    pub intent: String,
    /// "todo" | "in_progress" | "review" | "done"
    pub status: String,
    pub repository_id: String,
    pub repository_name: String,
    pub repository_path: String,
    pub worktree_path: String,
    pub worktree_branch: Option<String>,
    pub pending_worktree_name: Option<String>,
    pub copilot_session_id: Option<String>,
    pub queue_status: String,
    pub queue_order: i64,
    pub sort_order: i64,
    pub execution_target_key: String,
    pub attachments: Vec<TaskAttachment>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickTaskAttachmentsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<TaskAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PickTaskAttachmentsResult {
    fn ok(attachments: Vec<TaskAttachment>) -> Self {
        Self {
            ok: true,
            attachments: Some(attachments),
            error: None,
            message: None,
        }
    }

    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            attachments: None,
            error: Some("invalid-attachment".into()),
            message: Some(message.into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<Task>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl TaskResult {
    fn ok(task: Task) -> Self {
        Self {
            ok: true,
            task: Some(task),
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            task: None,
            error: Some(code.to_string()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTaskResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<Task>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl MoveTaskResult {
    fn ok(tasks: Vec<Task>) -> Self {
        Self {
            ok: true,
            tasks: Some(tasks),
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            tasks: None,
            error: Some(code.to_string()),
            message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTaskResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl DeleteTaskResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            error: Some(code.to_string()),
            message,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_valid_status(status: &str) -> bool {
    matches!(status, "todo" | "in_progress" | "review" | "done")
}

fn is_valid_intent(intent: &str) -> bool {
    matches!(intent, "task" | "browser-code-review")
}

fn initial_status_for_intent(intent: &str) -> &'static str {
    if intent == "browser-code-review" {
        "review"
    } else {
        "todo"
    }
}

fn normalize_target_part(value: &str, path: bool) -> String {
    let mut normalized = value.trim().replace('/', "\\").to_lowercase();
    if path {
        while normalized.contains("\\\\") {
            normalized = normalized.replace("\\\\", "\\");
        }
        while normalized.ends_with('\\') && !normalized.ends_with(":\\") {
            normalized.pop();
        }
    }
    normalized
}

pub(crate) fn execution_target_key(
    repository_id: &str,
    worktree_path: &str,
    pending_worktree_name: Option<&str>,
) -> String {
    let repository = normalize_target_part(repository_id, false);
    let (kind, target) = match pending_worktree_name.filter(|name| !name.trim().is_empty()) {
        Some(name) => ("planned", normalize_target_part(name, false)),
        None => ("path", normalize_target_part(worktree_path, true)),
    };
    format!(
        "r{}:{}|{}{}:{}",
        repository.len(),
        repository,
        kind,
        target.len(),
        target
    )
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        intent: row.get(3)?,
        status: row.get(4)?,
        repository_id: row.get(5)?,
        repository_name: row.get(6)?,
        repository_path: row.get(7)?,
        worktree_path: row.get(8)?,
        worktree_branch: row.get(9)?,
        pending_worktree_name: row.get(10)?,
        copilot_session_id: row.get(11)?,
        queue_status: row.get(12)?,
        queue_order: row.get(13)?,
        sort_order: row.get(14)?,
        execution_target_key: row.get(15)?,
        attachments: Vec::new(),
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, title, description, intent, status, repository_id, repository_name,
     repository_path, worktree_path, worktree_branch, pending_worktree_name,
     copilot_session_id, queue_status, queue_order, sort_order,
     execution_target_key, created_at, updated_at";

fn load_attachments(conn: &Connection, task_id: &str) -> rusqlite::Result<Vec<TaskAttachment>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, mime_type, size_bytes
         FROM task_attachments WHERE task_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let attachments = stmt
        .query_map([task_id], |row| {
            Ok(TaskAttachment {
                id: row.get(0)?,
                name: row.get(1)?,
                mime_type: row.get(2)?,
                size_bytes: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })?
        .collect();
    attachments
}

fn load_tasks(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM tasks ORDER BY status ASC, sort_order ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_task)?;
    let mut tasks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for task in &mut tasks {
        task.attachments = load_attachments(conn, &task.id)?;
    }
    Ok(tasks)
}

fn load_task(conn: &Connection, id: &str) -> rusqlite::Result<Option<Task>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM tasks WHERE id = ?1");
    let mut task = conn.query_row(&sql, [id], row_to_task).optional()?;
    if let Some(task) = &mut task {
        task.attachments = load_attachments(conn, id)?;
    }
    Ok(task)
}

fn next_sort_order(conn: &Connection, status: &str) -> i64 {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE status = ?1",
        [status],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn next_queue_order(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE(MAX(queue_order), -1) + 1 FROM tasks",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn is_valid_queue_status(status: &str) -> bool {
    matches!(status, "queued" | "running" | "complete" | "failed")
}

fn validate_uuid(value: &str, label: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(value).map_err(|_| AppError::msg(format!("Invalid {label}.")))?;
    Ok(())
}

fn attachment_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::msg(error.to_string()))?
        .join("task-attachments"))
}

fn stage_dir(root: &Path, stage_id: &str) -> AppResult<PathBuf> {
    validate_uuid(stage_id, "attachment stage id")?;
    Ok(root.join("staging").join(stage_id))
}

fn task_attachment_dir(root: &Path, task_id: &str) -> AppResult<PathBuf> {
    validate_uuid(task_id, "task id")?;
    Ok(root.join("tasks").join(task_id))
}

fn attachment_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "ts" | "tsx" | "js" | "jsx" | "css" | "html" | "htm" | "py" | "rs"
        | "go" | "java" | "cs" | "cpp" | "c" | "h" | "sql" | "sh" | "ps1" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
}

fn validate_attachment_set(attachments: &[TaskAttachmentSelection]) -> AppResult<()> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(AppError::msg(format!(
            "Attach at most {MAX_ATTACHMENTS} files."
        )));
    }
    let mut total = 0u64;
    let mut ids = std::collections::HashSet::new();
    for attachment in attachments {
        validate_uuid(&attachment.id, "attachment id")?;
        if !ids.insert(attachment.id.as_str()) {
            return Err(AppError::msg(
                "The same attachment was selected more than once.",
            ));
        }
        if attachment.name.trim().is_empty()
            || Path::new(&attachment.name)
                .file_name()
                .is_none_or(|name| name != attachment.name.as_str())
        {
            return Err(AppError::msg("Every attachment needs a valid filename."));
        }
        if attachment.size_bytes > MAX_ATTACHMENT_BYTES {
            return Err(AppError::msg(format!(
                "{} exceeds the 25 MiB attachment limit.",
                attachment.name
            )));
        }
        total = total.saturating_add(attachment.size_bytes);
    }
    if total > MAX_TOTAL_ATTACHMENT_BYTES {
        return Err(AppError::msg(
            "Task attachments exceed the 64 MiB combined limit.",
        ));
    }
    Ok(())
}

struct AttachmentChanges {
    promoted: Vec<PathBuf>,
    removed: Vec<PathBuf>,
}

fn reconcile_attachments(
    conn: &Connection,
    root: &Path,
    task_id: &str,
    stage_id: &str,
    selections: &[TaskAttachmentSelection],
) -> AppResult<AttachmentChanges> {
    validate_attachment_set(selections)?;
    let stage = stage_dir(root, stage_id)?;
    let task_dir = task_attachment_dir(root, task_id)?;
    fs::create_dir_all(&task_dir)?;

    let existing: Vec<(String, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, stored_name FROM task_attachments WHERE task_id = ?1")?;
        let rows = stmt
            .query_map([task_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|(id, _)| id.as_str()).collect();
    let selected_persisted: std::collections::HashSet<&str> = selections
        .iter()
        .filter(|item| !item.staged)
        .map(|item| item.id.as_str())
        .collect();
    if selected_persisted
        .iter()
        .any(|id| !existing_ids.contains(id))
    {
        return Err(AppError::msg(
            "An attachment no longer belongs to this task. Reopen the task and try again.",
        ));
    }

    for attachment in selections.iter().filter(|item| item.staged) {
        let source = stage.join(&attachment.id);
        let metadata = fs::metadata(&source).map_err(|_| {
            AppError::msg(format!(
                "{} is no longer available. Attach it again.",
                attachment.name
            ))
        })?;
        if metadata.len() != attachment.size_bytes {
            return Err(AppError::msg(format!(
                "{} changed while it was being attached.",
                attachment.name
            )));
        }
    }

    let mut promoted = Vec::new();
    for attachment in selections.iter().filter(|item| item.staged) {
        let source = stage.join(&attachment.id);
        let destination = task_dir.join(&attachment.id);
        if let Err(error) = fs::copy(&source, &destination) {
            for path in &promoted {
                let _ = fs::remove_file(path);
            }
            return Err(error.into());
        }
        promoted.push(destination);
        if let Err(error) = conn.execute(
            "INSERT INTO task_attachments
                 (id, task_id, name, mime_type, size_bytes, stored_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?1, ?6)",
            rusqlite::params![
                attachment.id,
                task_id,
                attachment.name,
                attachment.mime_type,
                attachment.size_bytes as i64,
                now_ms()
            ],
        ) {
            for path in &promoted {
                let _ = fs::remove_file(path);
            }
            return Err(error.into());
        }
    }

    let removed = existing
        .into_iter()
        .filter(|(id, _)| !selected_persisted.contains(id.as_str()))
        .map(|(_, stored_name)| task_dir.join(stored_name))
        .collect::<Vec<_>>();
    for path in &removed {
        let stored_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::msg("Attachment storage is invalid."))?;
        conn.execute(
            "DELETE FROM task_attachments WHERE task_id = ?1 AND stored_name = ?2",
            rusqlite::params![task_id, stored_name],
        )?;
    }
    Ok(AttachmentChanges { promoted, removed })
}

fn finish_attachment_changes(root: &Path, stage_id: &str, changes: AttachmentChanges) {
    for path in changes.removed {
        let _ = fs::remove_file(path);
    }
    if let Ok(stage) = stage_dir(root, stage_id) {
        let _ = fs::remove_dir_all(stage);
    }
    let _ = changes.promoted;
}

fn rollback_promoted_attachments(changes: &AttachmentChanges) {
    for path in &changes.promoted {
        let _ = fs::remove_file(path);
    }
}

#[derive(Clone)]
pub struct PreparedTaskAttachment {
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub path: PathBuf,
}

fn safe_materialized_name(id: &str, name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{id}-{}", cleaned.trim_matches('.'))
}

fn ensure_attachment_git_exclude(folder_path: &str) -> AppResult<()> {
    let output = crate::git::run_git_blocking(
        &[
            "rev-parse".into(),
            "--path-format=absolute".into(),
            "--git-path".into(),
            "info/exclude".into(),
        ],
        folder_path,
    )?;
    let exclude = PathBuf::from(output.stdout.trim());
    if let Some(parent) = exclude.parent() {
        fs::create_dir_all(parent)?;
    }
    let marker = ".devtrees/attachments/\n";
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if !existing
        .lines()
        .any(|line| line.trim() == ".devtrees/attachments/")
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(exclude)?;
        if !existing.is_empty() && !existing.ends_with('\n') {
            file.write_all(b"\n")?;
        }
        file.write_all(marker.as_bytes())?;
    }
    Ok(())
}

pub fn prepare_task_attachments(
    app: &AppHandle,
    task_id: &str,
    folder_path: &str,
    requested: &[TaskAttachment],
) -> AppResult<Vec<PreparedTaskAttachment>> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    validate_uuid(task_id, "task id")?;
    let state = app.state::<DbState>();
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let root = attachment_root(app)?;
    let task_dir = task_attachment_dir(&root, task_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, mime_type, size_bytes, stored_name
         FROM task_attachments WHERE task_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let stored = stmt
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?.max(0) as u64,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    drop(conn);
    let requested_ids = requested
        .iter()
        .map(|attachment| attachment.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if stored.len() != requested_ids.len()
        || stored
            .iter()
            .any(|(id, _, _, _, _)| !requested_ids.contains(id.as_str()))
    {
        return Err(AppError::msg(
            "Task attachments changed before the session started. Try again.",
        ));
    }

    let materialized_dir = PathBuf::from(folder_path)
        .join(".devtrees")
        .join("attachments")
        .join(task_id);
    if materialized_dir.exists() {
        fs::remove_dir_all(&materialized_dir)?;
    }
    fs::create_dir_all(&materialized_dir)?;
    ensure_attachment_git_exclude(folder_path)?;
    let mut prepared = Vec::new();
    for (id, name, mime_type, size_bytes, stored_name) in stored {
        let source = task_dir.join(stored_name);
        let metadata = fs::metadata(&source).map_err(|_| {
            AppError::msg(format!(
                "{name} is missing from managed storage. Attach it again."
            ))
        })?;
        if metadata.len() != size_bytes {
            return Err(AppError::msg(format!(
                "{name} no longer matches the saved attachment."
            )));
        }
        let destination = materialized_dir.join(safe_materialized_name(&id, &name));
        fs::copy(source, &destination)?;
        prepared.push(PreparedTaskAttachment {
            name,
            mime_type,
            size_bytes,
            path: destination,
        });
    }
    Ok(prepared)
}

pub fn cleanup_attachment_storage(app: &AppHandle) -> AppResult<()> {
    let root = attachment_root(app)?;
    let staging = root.join("staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let tasks_root = root.join("tasks");
    if !tasks_root.exists() {
        return Ok(());
    }
    let state = app.state::<DbState>();
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    for entry in fs::read_dir(&tasks_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if !exists {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn pick_task_attachments(app: AppHandle, stage_id: String) -> AppResult<PickTaskAttachmentsResult> {
    let root = attachment_root(&app)?;
    let stage = stage_dir(&root, &stage_id)?;
    let Some(files) = app
        .dialog()
        .file()
        .set_title("Attach files to task")
        .blocking_pick_files()
    else {
        return Ok(PickTaskAttachmentsResult::ok(Vec::new()));
    };
    if files.len() > MAX_ATTACHMENTS {
        return Ok(PickTaskAttachmentsResult::err(format!(
            "Select at most {MAX_ATTACHMENTS} files."
        )));
    }
    fs::create_dir_all(&stage)?;
    let mut attachments = Vec::new();
    let mut total = 0u64;
    for file in files {
        let path = file
            .into_path()
            .map_err(|error| AppError::msg(error.to_string()))?;
        let mime_type = attachment_mime(&path);
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() {
            return Ok(PickTaskAttachmentsResult::err(
                "Only regular files can be attached.",
            ));
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Ok(PickTaskAttachmentsResult::err(format!(
                "{} exceeds the 25 MiB attachment limit.",
                path.file_name()
                    .map(|name| name.to_string_lossy())
                    .unwrap_or_default()
            )));
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_TOTAL_ATTACHMENT_BYTES {
            return Ok(PickTaskAttachmentsResult::err(
                "Selected files exceed the 64 MiB combined limit.",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let name = path
            .file_name()
            .ok_or_else(|| AppError::msg("The selected file has no name."))?
            .to_string_lossy()
            .to_string();
        fs::copy(&path, stage.join(&id))?;
        attachments.push(TaskAttachment {
            id,
            name,
            mime_type: mime_type.into(),
            size_bytes: metadata.len(),
        });
    }
    Ok(PickTaskAttachmentsResult::ok(attachments))
}

#[tauri::command]
pub async fn tasks_pick_attachments(
    app: AppHandle,
    stage_id: String,
) -> AppResult<PickTaskAttachmentsResult> {
    tauri::async_runtime::spawn_blocking(move || pick_task_attachments(app, stage_id))
        .await
        .map_err(|error| AppError::msg(format!("Attaching files failed: {error}")))?
}

#[tauri::command]
pub async fn tasks_discard_attachment_stage(app: AppHandle, stage_id: String) -> AppResult<()> {
    let stage = stage_dir(&attachment_root(&app)?, &stage_id)?;
    if stage.exists() {
        fs::remove_dir_all(stage)?;
    }
    Ok(())
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn tasks_list(state: State<'_, DbState>) -> AppResult<Vec<Task>> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    Ok(load_tasks(&conn)?)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn tasks_create(
    app: AppHandle,
    state: State<'_, DbState>,
    title: String,
    description: String,
    intent: Option<String>,
    repository_id: String,
    repository_name: String,
    repository_path: String,
    worktree_path: String,
    worktree_branch: Option<String>,
    pending_worktree_name: Option<String>,
    attachment_stage_id: String,
    attachments: Vec<TaskAttachmentSelection>,
) -> AppResult<TaskResult> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Ok(TaskResult::err(
            "invalid-title",
            Some("Title is required.".into()),
        ));
    }
    let intent = intent.unwrap_or_else(|| "task".into());
    if !is_valid_intent(&intent) {
        return Ok(TaskResult::err(
            "invalid-intent",
            Some("Task intent is not supported.".into()),
        ));
    }
    let status = initial_status_for_intent(&intent);

    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let sort_order = next_sort_order(&conn, status);
    let queue_order = next_queue_order(&conn);
    let execution_target_key = execution_target_key(
        &repository_id,
        &worktree_path,
        pending_worktree_name.as_deref(),
    );
    let root = attachment_root(&app)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO tasks (
            id, title, description, intent, status, repository_id, repository_name, repository_path,
            worktree_path, worktree_branch, pending_worktree_name, copilot_session_id,
            queue_status, queue_order, sort_order, execution_target_key, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL,
                   'queued', ?12, ?13, ?14, ?15, ?15)",
        rusqlite::params![
            id,
            trimmed_title,
            description,
            intent,
            status,
            repository_id,
            repository_name,
            repository_path,
            worktree_path,
            worktree_branch,
            pending_worktree_name,
            queue_order,
            sort_order,
            execution_target_key,
            now
        ],
    )?;
    let changes = match reconcile_attachments(&tx, &root, &id, &attachment_stage_id, &attachments) {
        Ok(changes) => changes,
        Err(error) => {
            return Ok(TaskResult::err(
                "invalid-attachment",
                Some(error.to_string()),
            ))
        }
    };
    if let Err(error) = tx.commit() {
        rollback_promoted_attachments(&changes);
        return Err(error.into());
    }
    finish_attachment_changes(&root, &attachment_stage_id, changes);

    match load_task(&conn, &id)? {
        Some(task) => Ok(TaskResult::ok(task)),
        None => Ok(TaskResult::err(
            "unknown",
            Some("Task created but could not be located afterwards.".into()),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn tasks_update(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    title: String,
    description: String,
    repository_id: String,
    repository_name: String,
    repository_path: String,
    worktree_path: String,
    worktree_branch: Option<String>,
    pending_worktree_name: Option<String>,
    attachment_stage_id: String,
    attachments: Vec<TaskAttachmentSelection>,
) -> AppResult<TaskResult> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Ok(TaskResult::err(
            "invalid-title",
            Some("Title is required.".into()),
        ));
    }

    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    if load_task(&conn, &id)?.is_none() {
        return Ok(TaskResult::err("not-found", None));
    }

    let now = now_ms();
    let execution_target_key = execution_target_key(
        &repository_id,
        &worktree_path,
        pending_worktree_name.as_deref(),
    );
    let root = attachment_root(&app)?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE tasks SET title = ?2, description = ?3, repository_id = ?4, repository_name = ?5,
            repository_path = ?6, worktree_path = ?7, worktree_branch = ?8,
            pending_worktree_name = ?9, execution_target_key = ?10, updated_at = ?11
         WHERE id = ?1",
        rusqlite::params![
            id,
            trimmed_title,
            description,
            repository_id,
            repository_name,
            repository_path,
            worktree_path,
            worktree_branch,
            pending_worktree_name,
            execution_target_key,
            now
        ],
    )?;
    let changes = match reconcile_attachments(&tx, &root, &id, &attachment_stage_id, &attachments) {
        Ok(changes) => changes,
        Err(error) => {
            return Ok(TaskResult::err(
                "invalid-attachment",
                Some(error.to_string()),
            ))
        }
    };
    if let Err(error) = tx.commit() {
        rollback_promoted_attachments(&changes);
        return Err(error.into());
    }
    finish_attachment_changes(&root, &attachment_stage_id, changes);

    match load_task(&conn, &id)? {
        Some(task) => Ok(TaskResult::ok(task)),
        None => Ok(TaskResult::err("not-found", None)),
    }
}

#[tauri::command]
pub async fn tasks_move(
    state: State<'_, DbState>,
    id: String,
    status: String,
    before_id: Option<String>,
) -> AppResult<MoveTaskResult> {
    if !is_valid_status(&status) {
        return Ok(MoveTaskResult::err(
            "unknown",
            Some("Invalid status.".into()),
        ));
    }

    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let Some(existing) = load_task(&conn, &id)? else {
        return Ok(MoveTaskResult::err("not-found", None));
    };

    let tx = conn.transaction()?;
    {
        // Compute the destination column's order with `id` removed, then splice it back
        // in either before `before_id` or at the end, and persist contiguous sort_orders.
        let mut stmt = tx.prepare(
            "SELECT id FROM tasks WHERE status = ?1 AND id != ?2 ORDER BY sort_order ASC",
        )?;
        let mut ids: Vec<String> = stmt
            .query_map(rusqlite::params![status, id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let insert_at = match &before_id {
            Some(before) => ids.iter().position(|x| x == before).unwrap_or(ids.len()),
            None => ids.len(),
        };
        ids.insert(insert_at, id.clone());

        let now = now_ms();
        let entering_queue =
            matches!(status.as_str(), "todo" | "review") && existing.status != status;
        let queue_order = if entering_queue {
            Some(next_queue_order(&tx))
        } else {
            None
        };
        let queue_status = if entering_queue {
            Some("queued")
        } else if existing.queue_status == "running"
            && existing.status == "todo"
            && status == "in_progress"
        {
            None
        } else if !matches!(status.as_str(), "todo" | "review") {
            Some("complete")
        } else {
            None
        };
        let mut update_status = tx.prepare(
            "UPDATE tasks SET status = ?1, sort_order = ?2,
                queue_status = COALESCE(?3, queue_status),
                queue_order = COALESCE(?4, queue_order),
                updated_at = ?5
             WHERE id = ?6",
        )?;
        for (index, task_id) in ids.iter().enumerate() {
            if task_id == &id {
                update_status.execute(rusqlite::params![
                    status,
                    index as i64,
                    queue_status,
                    queue_order,
                    now,
                    task_id
                ])?;
            } else {
                tx.execute(
                    "UPDATE tasks SET sort_order = ?1 WHERE id = ?2",
                    rusqlite::params![index as i64, task_id],
                )?;
            }
        }
    }
    tx.commit()?;

    Ok(MoveTaskResult::ok(load_tasks(&conn)?))
}

#[tauri::command]
pub async fn tasks_delete(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
) -> AppResult<DeleteTaskResult> {
    validate_uuid(&id, "task id")?;
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let worktree_path = conn
        .query_row(
            "SELECT worktree_path FROM tasks WHERE id = ?1",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let changed = conn.execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
    if changed == 0 {
        return Ok(DeleteTaskResult::err("not-found", None));
    }
    drop(conn);
    let directory = task_attachment_dir(&attachment_root(&app)?, &id)?;
    if directory.exists() {
        if let Err(error) = fs::remove_dir_all(directory) {
            eprintln!("failed to remove task attachment directory: {error}");
        }
    }
    if let Some(worktree_path) = worktree_path {
        let materialized = PathBuf::from(worktree_path)
            .join(".devtrees")
            .join("attachments")
            .join(&id);
        if materialized.exists() {
            if let Err(error) = fs::remove_dir_all(materialized) {
                eprintln!("failed to remove materialized task attachments: {error}");
            }
        }
    }
    Ok(DeleteTaskResult::ok())
}

#[tauri::command]
pub async fn tasks_set_copilot_session(
    state: State<'_, DbState>,
    id: String,
    copilot_session_id: String,
) -> AppResult<TaskResult> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    if load_task(&conn, &id)?.is_none() {
        return Ok(TaskResult::err("not-found", None));
    }
    let now = now_ms();
    conn.execute(
        "UPDATE tasks SET copilot_session_id = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, copilot_session_id, now],
    )?;
    match load_task(&conn, &id)? {
        Some(task) => Ok(TaskResult::ok(task)),
        None => Ok(TaskResult::err("not-found", None)),
    }
}

#[tauri::command]
pub async fn tasks_set_queue_status(
    state: State<'_, DbState>,
    id: String,
    queue_status: String,
) -> AppResult<TaskResult> {
    if !is_valid_queue_status(&queue_status) {
        return Ok(TaskResult::err(
            "unknown",
            Some("Invalid task queue status.".into()),
        ));
    }
    if queue_status == "running" {
        return Ok(TaskResult::err(
            "unknown",
            Some("Use the task run claim to reserve its worktree.".into()),
        ));
    }
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    if load_task(&conn, &id)?.is_none() {
        return Ok(TaskResult::err("not-found", None));
    }
    conn.execute(
        "UPDATE tasks SET queue_status = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, queue_status, now_ms()],
    )?;
    match load_task(&conn, &id)? {
        Some(task) => Ok(TaskResult::ok(task)),
        None => Ok(TaskResult::err("not-found", None)),
    }
}

fn claim_task_run(conn: &mut Connection, id: &str) -> rusqlite::Result<TaskResult> {
    let tx = conn.transaction()?;
    let Some(task) = load_task(&tx, id)? else {
        return Ok(TaskResult::err("not-found", None));
    };
    let conflicting_title: Option<String> = tx
        .query_row(
            "SELECT title FROM tasks
             WHERE execution_target_key = ?1 AND id != ?2
               AND (
                 queue_status = 'running'
                 OR EXISTS (
                   SELECT 1 FROM terminal_sessions
                   WHERE terminal_sessions.id = tasks.copilot_session_id
                     AND terminal_sessions.status IN ('starting', 'working', 'waiting-input')
                 )
               )
             ORDER BY updated_at ASC LIMIT 1",
            rusqlite::params![task.execution_target_key, id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(title) = conflicting_title {
        return Ok(TaskResult::err(
            "target-busy",
            Some(format!(
                "\"{title}\" is already running in this repository worktree."
            )),
        ));
    }
    tx.execute(
        "UPDATE tasks SET queue_status = 'running', updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now_ms()],
    )?;
    let claimed = load_task(&tx, id)?.expect("claimed task must still exist");
    tx.commit()?;
    Ok(TaskResult::ok(claimed))
}

#[tauri::command]
pub async fn tasks_claim_run(state: State<'_, DbState>, id: String) -> AppResult<TaskResult> {
    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    Ok(claim_task_run(&mut conn, &id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                intent TEXT NOT NULL DEFAULT 'task',
                status TEXT NOT NULL, repository_id TEXT NOT NULL, repository_name TEXT NOT NULL,
                repository_path TEXT NOT NULL, worktree_path TEXT NOT NULL, worktree_branch TEXT,
                pending_worktree_name TEXT, copilot_session_id TEXT, queue_status TEXT NOT NULL,
                queue_order INTEGER NOT NULL, sort_order INTEGER NOT NULL,
                execution_target_key TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE terminal_sessions (
                id TEXT PRIMARY KEY, status TEXT NOT NULL
            );
            CREATE TABLE task_attachments (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
                stored_name TEXT NOT NULL, created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, target: &str, queue_status: &str) {
        conn.execute(
            "INSERT INTO tasks
                (id, title, status, repository_id, repository_name, repository_path,
                 worktree_path, queue_status, queue_order, sort_order, execution_target_key,
                 created_at, updated_at)
             VALUES (?1, ?1, 'todo', 'repo', 'Repo', 'C:\\repo', 'C:\\repo',
                     ?3, 0, 0, ?2, 1, 1)",
            rusqlite::params![id, target, queue_status],
        )
        .unwrap();
    }

    #[test]
    fn target_keys_normalize_case_separators_and_trailing_slashes() {
        assert_eq!(
            execution_target_key("Repo-ID", "C:/Work/Tree/", None),
            execution_target_key("repo-id", "c:\\work\\tree", None)
        );
        assert_eq!(
            execution_target_key("Repo-ID", "C:\\Repo", Some(" Feature-One ")),
            execution_target_key("repo-id", "ignored", Some("feature-one"))
        );
    }

    #[test]
    fn browser_reviews_start_in_review_status() {
        assert_eq!(initial_status_for_intent("task"), "todo");
        assert_eq!(initial_status_for_intent("browser-code-review"), "review");
    }

    #[test]
    fn tasks_hydrate_attachment_metadata() {
        let conn = connection();
        insert(&conn, "task", "target", "queued");
        conn.execute(
            "INSERT INTO task_attachments
                (id, task_id, name, mime_type, size_bytes, stored_name, created_at)
             VALUES (?1, 'task', 'requirements.docx',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                     42, ?1, 1)",
            ["00000000-0000-4000-8000-000000000001"],
        )
        .unwrap();
        let loaded = load_task(&conn, "task").unwrap().unwrap();
        assert_eq!(loaded.attachments.len(), 1);
        assert_eq!(loaded.attachments[0].name, "requirements.docx");
        assert_eq!(loaded.attachments[0].size_bytes, 42);
    }

    #[test]
    fn attachment_selection_rejects_duplicate_ids_and_paths() {
        let attachment = TaskAttachmentSelection {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: "notes.md".into(),
            mime_type: "text/markdown".into(),
            size_bytes: 10,
            staged: true,
        };
        assert!(validate_attachment_set(&[attachment.clone()]).is_ok());
        assert!(validate_attachment_set(&[attachment.clone(), attachment]).is_err());
        assert!(validate_attachment_set(&[TaskAttachmentSelection {
            id: "00000000-0000-4000-8000-000000000002".into(),
            name: "..\\secret.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 10,
            staged: true,
        }])
        .is_err());
    }

    #[test]
    fn claim_serializes_one_target_and_allows_independent_targets() {
        let mut conn = connection();
        insert(&conn, "running", "target-a", "running");
        insert(&conn, "blocked", "target-a", "queued");
        insert(&conn, "independent", "target-b", "queued");

        let blocked = claim_task_run(&mut conn, "blocked").unwrap();
        assert!(!blocked.ok);
        assert_eq!(blocked.error.as_deref(), Some("target-busy"));
        let status: String = conn
            .query_row(
                "SELECT queue_status FROM tasks WHERE id = 'blocked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "queued");

        let independent = claim_task_run(&mut conn, "independent").unwrap();
        assert!(independent.ok);
    }

    #[test]
    fn completed_or_failed_tasks_release_the_target() {
        for released_status in ["complete", "failed"] {
            let mut conn = connection();
            insert(&conn, "previous", "target", released_status);
            insert(&conn, "next", "target", "queued");
            assert!(claim_task_run(&mut conn, "next").unwrap().ok);
        }
    }

    #[test]
    fn active_linked_session_keeps_the_target_after_board_completion() {
        let mut conn = connection();
        insert(&conn, "active", "target", "complete");
        conn.execute(
            "UPDATE tasks SET copilot_session_id = 'session' WHERE id = 'active'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_sessions (id, status) VALUES ('session', 'working')",
            [],
        )
        .unwrap();
        insert(&conn, "next", "target", "queued");

        let blocked = claim_task_run(&mut conn, "next").unwrap();
        assert!(!blocked.ok);
        assert_eq!(blocked.error.as_deref(), Some("target-busy"));

        conn.execute(
            "UPDATE terminal_sessions SET status = 'idle' WHERE id = 'session'",
            [],
        )
        .unwrap();
        assert!(claim_task_run(&mut conn, "next").unwrap().ok);
    }
}
