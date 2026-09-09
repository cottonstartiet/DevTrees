use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::error::{AppError, AppResult};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
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
    pub created_at: i64,
    pub updated_at: i64,
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

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        status: row.get(3)?,
        repository_id: row.get(4)?,
        repository_name: row.get(5)?,
        repository_path: row.get(6)?,
        worktree_path: row.get(7)?,
        worktree_branch: row.get(8)?,
        pending_worktree_name: row.get(9)?,
        copilot_session_id: row.get(10)?,
        queue_status: row.get(11)?,
        queue_order: row.get(12)?,
        sort_order: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

const SELECT_COLUMNS: &str = "id, title, description, status, repository_id, repository_name,
     repository_path, worktree_path, worktree_branch, pending_worktree_name,
     copilot_session_id, queue_status, queue_order, sort_order,
     created_at, updated_at";

fn load_tasks(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM tasks ORDER BY status ASC, sort_order ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_task)?;
    rows.collect()
}

fn load_task(conn: &Connection, id: &str) -> rusqlite::Result<Option<Task>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM tasks WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_task).optional()
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
    state: State<'_, DbState>,
    title: String,
    description: String,
    repository_id: String,
    repository_name: String,
    repository_path: String,
    worktree_path: String,
    worktree_branch: Option<String>,
    pending_worktree_name: Option<String>,
) -> AppResult<TaskResult> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Ok(TaskResult::err(
            "invalid-title",
            Some("Title is required.".into()),
        ));
    }

    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let sort_order = next_sort_order(&conn, "todo");
    let queue_order = next_queue_order(&conn);
    conn.execute(
        "INSERT INTO tasks (
            id, title, description, status, repository_id, repository_name, repository_path,
            worktree_path, worktree_branch, pending_worktree_name, copilot_session_id,
            queue_status, queue_order, sort_order, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'todo', ?4, ?5, ?6, ?7, ?8, ?9, NULL,
                   'queued', ?10, ?11, ?12, ?12)",
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
            queue_order,
            sort_order,
            now
        ],
    )?;

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
) -> AppResult<TaskResult> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Ok(TaskResult::err(
            "invalid-title",
            Some("Title is required.".into()),
        ));
    }

    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    if load_task(&conn, &id)?.is_none() {
        return Ok(TaskResult::err("not-found", None));
    }

    let now = now_ms();
    conn.execute(
        "UPDATE tasks SET title = ?2, description = ?3, repository_id = ?4, repository_name = ?5,
            repository_path = ?6, worktree_path = ?7, worktree_branch = ?8,
            pending_worktree_name = ?9, updated_at = ?10
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
            now
        ],
    )?;

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
pub async fn tasks_delete(state: State<'_, DbState>, id: String) -> AppResult<DeleteTaskResult> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("db mutex poisoned"))?;
    let changed = conn.execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
    if changed == 0 {
        return Ok(DeleteTaskResult::err("not-found", None));
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
