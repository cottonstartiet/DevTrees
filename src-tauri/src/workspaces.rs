use std::path::absolute;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::git::run_git_blocking;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at: i64,
    /// "github" | "ado" | "other"
    pub remote_kind: String,
}

/// Discriminated-union result matching the Electron `AddWorkspaceResult`
/// (`{ ok: true, workspace } | { ok: false, error, message? }`). Fields are omitted
/// when absent so the JSON shape matches what the renderer expects.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorkspaceResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<Workspace>,
    /// "cancelled" | "not-a-git-repo" | "already-added" | "unknown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AddWorkspaceResult {
    fn ok(workspace: Workspace) -> Self {
        Self {
            ok: true,
            workspace: Some(workspace),
            error: None,
            message: None,
        }
    }
    fn err(code: &str, message: Option<String>) -> Self {
        Self {
            ok: false,
            workspace: None,
            error: Some(code.to_string()),
            message,
        }
    }
}

struct BaseWorkspace {
    id: String,
    path: String,
    name: String,
    added_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn path_key(p: &str) -> String {
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

fn is_git_repo(folder: &str) -> bool {
    // `.git` can be a directory (regular clone) or a file (submodule / worktree gitlink).
    std::path::Path::new(folder).join(".git").exists()
}

/// Classify an origin remote URL as GitHub, Azure DevOps, or other. Ported from
/// `classifyRemoteUrl` in `workspaces.ts`.
pub fn classify_remote_url(url: &str) -> &'static str {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "other";
    }

    static GITHUB: OnceLock<Vec<Regex>> = OnceLock::new();
    static ADO: OnceLock<Vec<Regex>> = OnceLock::new();

    let github = GITHUB.get_or_init(|| {
        vec![
            Regex::new(r"(?i)^(https?|ssh)://(?:[^@/]+@)?github\.com[/:]").unwrap(),
            Regex::new(r"(?i)^[^@\s]+@github\.com:").unwrap(),
        ]
    });
    let ado = ADO.get_or_init(|| {
        vec![
            Regex::new(r"(?i)^(https?|ssh)://(?:[^@/]+@)?dev\.azure\.com[/:]").unwrap(),
            Regex::new(r"(?i)^(https?|ssh)://(?:[^@/]+@)?ssh\.dev\.azure\.com[/:]").unwrap(),
            Regex::new(r"(?i)^(https?|ssh)://(?:[^@/]+@)?[^./@\s]+\.visualstudio\.com[/:]")
                .unwrap(),
            Regex::new(r"(?i)^(https?|ssh)://(?:[^@/]+@)?[^./@\s]+\.vs-ssh\.visualstudio\.com[/:]")
                .unwrap(),
            Regex::new(r"(?i)^[^@\s]+@ssh\.dev\.azure\.com:").unwrap(),
            Regex::new(r"(?i)^[^@\s]+@[^./@\s]+\.vs-ssh\.visualstudio\.com:").unwrap(),
        ]
    });

    if github.iter().any(|r| r.is_match(trimmed)) {
        return "github";
    }
    if ado.iter().any(|r| r.is_match(trimmed)) {
        return "ado";
    }
    "other"
}

fn detect_remote_kind(folder_path: &str) -> String {
    match run_git_blocking(
        &["remote".into(), "get-url".into(), "origin".into()],
        folder_path,
    ) {
        Ok(out) => classify_remote_url(out.stdout.trim()).to_string(),
        Err(_) => "other".to_string(),
    }
}

fn enrich(base: BaseWorkspace) -> Workspace {
    let remote_kind = detect_remote_kind(&base.path);
    Workspace {
        id: base.id,
        path: base.path,
        name: base.name,
        added_at: base.added_at,
        remote_kind,
    }
}

fn load_base_workspaces(conn: &Connection) -> AppResult<Vec<BaseWorkspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, name, added_at FROM workspaces ORDER BY sort_order ASC, added_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(BaseWorkspace {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                added_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_workspaces(state: &State<'_, DbState>) -> AppResult<Vec<Workspace>> {
    let bases = {
        let conn = state
            .0
            .lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
        load_base_workspaces(&conn)?
    };
    // git detection runs after the lock is released so it never serializes behind itself.
    Ok(bases.into_iter().map(enrich).collect())
}

fn add_workspace(state: &State<'_, DbState>, folder: &str) -> AddWorkspaceResult {
    let resolved = match absolute(folder) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => folder.to_string(),
    };

    if !std::path::Path::new(&resolved).exists() {
        return AddWorkspaceResult::err("unknown", Some("Folder does not exist.".into()));
    }
    if !is_git_repo(&resolved) {
        return AddWorkspaceResult::err("not-a-git-repo", None);
    }

    let base = BaseWorkspace {
        id: uuid::Uuid::new_v4().to_string(),
        path: resolved.clone(),
        name: std::path::Path::new(&resolved)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        added_at: now_ms(),
    };

    {
        let conn = match state.0.lock() {
            Ok(c) => c,
            Err(_) => return AddWorkspaceResult::err("unknown", Some("db mutex poisoned".into())),
        };
        // New workspaces sort to the bottom of the custom order.
        let next_sort_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces",
                [],
                |r| r.get(0),
            )
            .unwrap_or(base.added_at);
        let result = conn.execute(
            "INSERT INTO workspaces (id, path, name, added_at, path_key, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                base.id,
                base.path,
                base.name,
                base.added_at,
                path_key(&resolved),
                next_sort_order
            ],
        );
        if let Err(err) = result {
            if is_unique_violation(&err) {
                return AddWorkspaceResult::err("already-added", None);
            }
            eprintln!("[workspaces] insert failed: {err}");
            return AddWorkspaceResult::err("unknown", Some(err.to_string()));
        }
    }

    AddWorkspaceResult::ok(enrich(base))
}

fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

// ----- Tauri commands -----

#[tauri::command]
pub async fn workspaces_list(state: State<'_, DbState>) -> AppResult<Vec<Workspace>> {
    load_workspaces(&state)
}

#[tauri::command]
pub async fn workspaces_remove(state: State<'_, DbState>, id: String) -> AppResult<Vec<Workspace>> {
    {
        let conn = state
            .0
            .lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
        conn.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
    }
    load_workspaces(&state)
}

#[tauri::command]
pub async fn workspaces_reorder(
    state: State<'_, DbState>,
    ordered_ids: Vec<String>,
) -> AppResult<Vec<Workspace>> {
    {
        let mut conn = state
            .0
            .lock()
            .map_err(|_| AppError::msg("db mutex poisoned"))?;
        let tx = conn.transaction()?;
        {
            // Build the authoritative order: the requested ids first (deduped, and
            // only those that actually exist), then any remaining existing ids in
            // their current order. This makes the result robust to stale, partial,
            // duplicated, or unknown ids so no row keeps a tying/stale sort_order.
            let mut existing: Vec<String> = {
                let mut stmt =
                    tx.prepare("SELECT id FROM workspaces ORDER BY sort_order ASC, added_at ASC")?;
                let ids = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                ids
            };
            let mut final_order: Vec<String> = Vec::with_capacity(existing.len());
            for id in &ordered_ids {
                if existing.contains(id) && !final_order.contains(id) {
                    final_order.push(id.clone());
                }
            }
            for id in existing.drain(..) {
                if !final_order.contains(&id) {
                    final_order.push(id);
                }
            }
            let mut stmt = tx.prepare("UPDATE workspaces SET sort_order = ?1 WHERE id = ?2")?;
            for (index, id) in final_order.iter().enumerate() {
                stmt.execute(rusqlite::params![index as i64, id])?;
            }
        }
        tx.commit()?;
    }
    load_workspaces(&state)
}

#[tauri::command]
pub async fn workspaces_pick_and_add(
    app: AppHandle,
    state: State<'_, DbState>,
) -> AppResult<AddWorkspaceResult> {
    // The blocking folder picker dispatches the native dialog to the main thread and
    // waits; calling it from this async command thread (not the main thread) is safe.
    let picked = app
        .dialog()
        .file()
        .set_title("Add workspace folder")
        .blocking_pick_folder();

    let Some(folder) = picked else {
        return Ok(AddWorkspaceResult::err("cancelled", None));
    };
    let folder_path = folder
        .into_path()
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(add_workspace(&state, &folder_path.to_string_lossy()))
}
