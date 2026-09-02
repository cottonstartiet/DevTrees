use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

use super::{
    AgentPendingInteraction, AgentSession, AgentSessionActivity, AgentSessionEvent,
    AgentSessionLifecycle, AgentSessionPurpose,
};

pub fn insert_session(conn: &Connection, session: &AgentSession) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sessions
           (id, sdk_session_id, purpose, label, folder_path, branch, repository, provider,
            pr_id, pr_title, lifecycle, activity, current_intent, last_error, created_at,
            updated_at, completed_at, last_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18)",
        params![
            session.id,
            session.sdk_session_id,
            session.purpose.as_str(),
            session.label,
            session.folder_path,
            session.branch,
            session.repository,
            session.provider,
            session.pr_id,
            session.pr_title,
            session.lifecycle.as_str(),
            session.activity.as_str(),
            session.current_intent,
            session.last_error,
            session.created_at,
            session.updated_at,
            session.completed_at,
            session.last_seq,
        ],
    )?;
    Ok(())
}

pub fn update_session(conn: &Connection, session: &AgentSession) -> AppResult<()> {
    conn.execute(
        "UPDATE agent_sessions
         SET sdk_session_id = ?1, lifecycle = ?2, activity = ?3, current_intent = ?4,
             last_error = ?5, updated_at = ?6, completed_at = ?7, last_seq = ?8
         WHERE id = ?9",
        params![
            session.sdk_session_id,
            session.lifecycle.as_str(),
            session.activity.as_str(),
            session.current_intent,
            session.last_error,
            session.updated_at,
            session.completed_at,
            session.last_seq,
            session.id,
        ],
    )?;
    Ok(())
}

pub fn insert_event(conn: &Connection, event: &AgentSessionEvent) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO agent_session_events
           (event_id, session_id, seq, event_type, parent_id, agent_id, ephemeral, data_json,
            timestamp, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event.id,
            event.session_id,
            event.seq,
            event.event_type,
            event.parent_id,
            event.agent_id,
            event.ephemeral,
            serde_json::to_string(&event.data)?,
            event.timestamp,
            super::now_ms(),
        ],
    )?;
    Ok(())
}

pub fn list_sessions(conn: &Connection) -> AppResult<Vec<AgentSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, sdk_session_id, purpose, label, folder_path, branch, repository, provider,
                pr_id, pr_title, lifecycle, activity, current_intent, last_error, created_at,
                updated_at, completed_at, last_seq
         FROM agent_sessions
        WHERE lifecycle != 'stopped' OR purpose = 'pr_review'
         ORDER BY updated_at ASC",
    )?;
    let sessions = stmt
        .query_map([], map_session)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sessions)
}

pub fn load_session(conn: &Connection, id: &str) -> AppResult<AgentSession> {
    conn.query_row(
        "SELECT id, sdk_session_id, purpose, label, folder_path, branch, repository, provider,
                pr_id, pr_title, lifecycle, activity, current_intent, last_error, created_at,
                updated_at, completed_at, last_seq
         FROM agent_sessions WHERE id = ?1",
        [id],
        map_session,
    )
    .optional()?
    .ok_or_else(|| AppError::msg("Agent session not found."))
}

pub fn find_session_by_sdk_id(
    conn: &Connection,
    sdk_session_id: &str,
) -> AppResult<Option<AgentSession>> {
    Ok(conn
        .query_row(
            "SELECT id, sdk_session_id, purpose, label, folder_path, branch, repository, provider,
                    pr_id, pr_title, lifecycle, activity, current_intent, last_error, created_at,
                    updated_at, completed_at, last_seq
             FROM agent_sessions WHERE sdk_session_id = ?1",
            [sdk_session_id],
            map_session,
        )
        .optional()?)
}

pub fn find_review_session(
    conn: &Connection,
    folder_path: &str,
    provider: &str,
    pr_id: &str,
) -> AppResult<Option<AgentSession>> {
    Ok(conn
        .query_row(
            "SELECT id, sdk_session_id, purpose, label, folder_path, branch, repository, provider,
                    pr_id, pr_title, lifecycle, activity, current_intent, last_error, created_at,
                    updated_at, completed_at, last_seq
             FROM agent_sessions
             WHERE purpose = 'pr_review' AND lower(folder_path) = lower(?1)
               AND provider = ?2 AND pr_id = ?3
             ORDER BY created_at DESC LIMIT 1",
            params![folder_path, provider, pr_id],
            map_session,
        )
        .optional()?)
}

pub fn load_events(conn: &Connection, session_id: &str) -> AppResult<Vec<AgentSessionEvent>> {
    let mut stmt = conn.prepare(
        "SELECT event_id, session_id, seq, event_type, parent_id, agent_id, ephemeral,
                data_json, timestamp
         FROM agent_session_events
         WHERE session_id = ?1
         ORDER BY seq ASC",
    )?;
    let events = stmt
        .query_map([session_id], |row| {
            let data_json: String = row.get(7)?;
            Ok(AgentSessionEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                seq: row.get(2)?,
                event_type: row.get(3)?,
                parent_id: row.get(4)?,
                agent_id: row.get(5)?,
                ephemeral: row.get(6)?,
                data: serde_json::from_str(&data_json).unwrap_or(serde_json::Value::Null),
                timestamp: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(events)
}

pub fn insert_interaction(
    conn: &Connection,
    interaction: &AgentPendingInteraction,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_pending_interactions
           (id, session_id, kind, request_id, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            interaction.id(),
            interaction.session_id(),
            interaction.kind(),
            interaction.request_id(),
            serde_json::to_string(interaction)?,
            interaction.created_at(),
        ],
    )?;
    Ok(())
}

pub fn remove_interaction(conn: &Connection, interaction_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM agent_pending_interactions WHERE id = ?1",
        [interaction_id],
    )?;
    Ok(())
}

pub fn load_interactions(
    conn: &Connection,
    session_id: &str,
) -> AppResult<Vec<AgentPendingInteraction>> {
    let mut stmt = conn.prepare(
        "SELECT payload_json FROM agent_pending_interactions
         WHERE session_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| row.get::<_, String>(0))?;
    let mut interactions = Vec::new();
    for row in rows {
        interactions.push(serde_json::from_str(&row?).map_err(AppError::from)?);
    }
    Ok(interactions)
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSession> {
    let purpose: String = row.get(2)?;
    let lifecycle: String = row.get(10)?;
    let activity: String = row.get(11)?;
    Ok(AgentSession {
        id: row.get(0)?,
        sdk_session_id: row.get(1)?,
        purpose: AgentSessionPurpose::parse(&purpose),
        label: row.get(3)?,
        folder_path: row.get(4)?,
        branch: row.get(5)?,
        repository: row.get(6)?,
        provider: row.get(7)?,
        pr_id: row.get(8)?,
        pr_title: row.get(9)?,
        lifecycle: AgentSessionLifecycle::parse(&lifecycle),
        activity: AgentSessionActivity::parse(&activity),
        current_intent: row.get(12)?,
        last_error: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        completed_at: row.get(16)?,
        last_seq: row.get(17)?,
    })
}
