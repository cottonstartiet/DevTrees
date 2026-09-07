use rusqlite::{params, Connection};

use super::{report, source};

fn store() -> Connection {
    let conn = source::empty_store().unwrap();
    conn.execute(
        "INSERT INTO sessions VALUES ('a', 'repo-a', NULL), ('b', 'repo-b', NULL)",
        [],
    )
    .unwrap();
    conn
}

fn turn(conn: &Connection, session: &str, index: i64, when: &str, prompt: &str) {
    conn.execute(
        "INSERT INTO turns VALUES (?1, ?2, ?3, ?4)",
        params![session, index, when, prompt],
    )
    .unwrap();
}

fn usage(conn: &Connection, session: &str, when: &str, cost: Option<i64>, duration: Option<f64>) {
    conn.execute(
        "INSERT INTO assistant_usage_events VALUES (?1, ?2, 'model', 100, 20, 10, 0, ?3, ?4, 30)",
        params![session, when, cost, duration],
    )
    .unwrap();
}

fn now(conn: &Connection) -> String {
    // Convert a chosen local wall-clock time through SQLite, keeping tests independent of host TZ.
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', '2026-09-07 12:00:00', 'utc')",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn local(conn: &Connection, wall: &str) -> String {
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1, 'utc')",
        [wall],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn consistent_calendar_windows_and_distinct_requests_and_calls() {
    let conn = store();
    turn(
        &conn,
        "a",
        0,
        &local(&conn, "2026-09-01 00:00:00"),
        "Implement a feature with tests",
    );
    turn(
        &conn,
        "a",
        1,
        &local(&conn, "2026-08-31 23:59:59"),
        "Previous period",
    );
    turn(
        &conn,
        "b",
        0,
        &local(&conn, "2026-09-07 13:00:00"),
        "Future prompt",
    );
    usage(
        &conn,
        "a",
        &local(&conn, "2026-09-01 01:00:00"),
        Some(100),
        Some(1000.0),
    );
    usage(
        &conn,
        "a",
        &local(&conn, "2026-09-01 02:00:00"),
        Some(200),
        Some(3000.0),
    );
    let summary = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(summary.daily.len(), 7);
    assert_eq!(summary.from_date, "2026-09-01");
    assert_eq!(summary.totals.turns, 1);
    assert_eq!(summary.previous.turns, 1);
    assert_eq!(summary.daily[0].events, 2);
    assert_eq!(summary.daily[0].turns, 1);
    assert_eq!(summary.totals.cost_nano_aiu, 300);
    assert_eq!(summary.totals.avg_response_ms, Some(2000.0));
}

#[test]
fn mixed_sqlite_and_iso_timestamps_are_chronological() {
    let conn = store();
    let iso = local(&conn, "2026-09-07 09:00:00");
    let sqlite = iso.replace('T', " ").replace('Z', "");
    turn(&conn, "a", 0, &iso, "Add explicit tests");
    turn(&conn, "a", 1, &sqlite, "Add explicit tests");
    let summary = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(summary.totals.turns, 2);
    assert_eq!(summary.totals.active_days, 1);
}

#[test]
fn filters_apply_to_all_sections_and_previous_period() {
    let conn = store();
    for session in ["a", "b"] {
        turn(
            &conn,
            session,
            0,
            &local(&conn, "2026-09-06 09:00:00"),
            "Implement the requested function and test it",
        );
        turn(
            &conn,
            session,
            1,
            &local(&conn, "2026-08-30 09:00:00"),
            "previous",
        );
        usage(
            &conn,
            session,
            &local(&conn, "2026-09-06 09:00:00"),
            Some(10),
            Some(100.0),
        );
    }
    let result = report::build(source::load(&conn, 7, Some("repo-a"), &now(&conn)).unwrap());
    assert_eq!(result.totals.sessions, 1);
    assert_eq!(result.previous.turns, 1);
    assert_eq!(result.totals.cost_nano_aiu, 10);
    assert_eq!(result.top_repositories.len(), 1);
    assert_eq!(result.repositories.len(), 2);
    assert!(result
        .practices
        .examples
        .iter()
        .all(|e| e.repository == "repo-a"));
}

#[test]
fn missing_optional_tables_do_not_erase_activity() {
    let conn = store();
    conn.execute_batch("DROP TABLE assistant_usage_events; DROP TABLE session_files;")
        .unwrap();
    turn(
        &conn,
        "a",
        0,
        &local(&conn, "2026-09-06 09:00:00"),
        "Implement a new feature",
    );
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.totals.turns, 1);
    assert!(!result.coverage.usage_available);
    assert_eq!(result.coverage.warnings.len(), 2);
    assert_eq!(result.totals.avg_response_ms, None);
}

#[test]
fn usage_only_sessions_appear_in_daily_and_repository_totals() {
    let conn = store();
    usage(
        &conn,
        "a",
        &local(&conn, "2026-09-06 09:00:00"),
        Some(10),
        None,
    );
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.totals.sessions, 1);
    assert_eq!(result.totals.turns, 0);
    assert_eq!(result.daily.iter().map(|d| d.sessions).sum::<usize>(), 1);
    assert_eq!(result.top_repositories[0].sessions, 1);
    assert_eq!(result.practices.score, None);
}

#[test]
fn weekend_night_and_gap_measurements_use_local_wall_time() {
    let conn = store();
    for (index, wall) in [
        "2026-09-06 23:00:00",
        "2026-09-06 23:10:00",
        "2026-09-07 09:00:00",
    ]
    .iter()
    .enumerate()
    {
        turn(
            &conn,
            "a",
            index as i64,
            &local(&conn, wall),
            "Implement the feature with tests",
        );
    }
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.flow.current.weekend_turns, 2);
    assert_eq!(result.flow.current.late_night_turns, 2);
    assert_eq!(result.flow.current.median_prompt_gap_minutes, Some(10.0));
    assert_eq!(result.flow.current.observed_block_minutes, 10.0);
    assert_eq!(result.flow.current.active_streak, 2);
    assert_eq!(result.flow.heatmap[23].turns, 2);
}

#[test]
fn no_activity_does_not_produce_a_bad_score_or_coaching() {
    let conn = store();
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.practices.score, None);
    assert!(result.practices.findings.is_empty());
    assert!(result.flow.tips.is_empty());
    assert_eq!(result.flow.current.continuity_percent, None);
}

#[test]
fn prompts_exclude_confirmations_and_grade_explicit_structure() {
    let conn = store();
    for (i, text) in [
        "Implement auth.rs.\n- Must preserve compatibility.\n- Expected result: authenticated requests pass.\n- Verify with existing tests.",
        "yes", "<system_reminder>context</system_reminder>", "thanks"
    ].iter().enumerate() {
        turn(&conn, "a", i as i64, &local(&conn, "2026-09-07 09:00:00"), text);
    }
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.practices.analyzed_prompts, 1);
    assert_eq!(result.practices.score, Some(100.0));
    assert_eq!(result.practices.spec_driven_sessions, 1);
}

#[test]
fn resumed_sessions_are_not_misclassified_as_task_starts() {
    let conn = store();
    turn(
        &conn,
        "a",
        0,
        &local(&conn, "2026-07-01 09:00:00"),
        "Plan the task",
    );
    for i in 1..=3 {
        turn(
            &conn,
            "a",
            i,
            &local(&conn, "2026-09-07 09:00:00"),
            "Implement a specific component and verify tests",
        );
    }
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.practices.spec_eligible_sessions, 0);
}

#[test]
fn workflow_clustering_requires_recurrence_across_sessions() {
    let conn = store();
    for (session, index, text) in [
        ("a", 0, "Review the changes in `auth.rs` for regressions"),
        ("a", 1, "Review the changes in `api.rs` for regressions"),
        ("b", 0, "Review the changes in `ui.rs` for regressions"),
        ("b", 1, "Write the changes in `ui.rs` for regressions"),
    ] {
        turn(
            &conn,
            session,
            index,
            &local(&conn, "2026-09-07 09:00:00"),
            text,
        );
    }
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.practices.workflows.len(), 1);
    assert_eq!(result.practices.workflows[0].occurrences, 3);
}

#[test]
fn missing_usage_columns_preserve_unavailable_values() {
    let conn = store();
    conn.execute_batch("DROP TABLE assistant_usage_events; CREATE TABLE assistant_usage_events(session_id TEXT, created_at TEXT);").unwrap();
    conn.execute(
        "INSERT INTO assistant_usage_events VALUES ('a', ?1)",
        [local(&conn, "2026-09-07 09:00:00")],
    )
    .unwrap();
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.totals.usage_records, 1);
    assert_eq!(result.totals.credit_records, 0);
    assert_eq!(result.models[0].input_records, 0);
    assert_eq!(result.totals.avg_response_ms, None);
    assert!(!result.coverage.warnings.is_empty());
}

#[test]
fn repository_aliases_are_exact_unambiguous_and_filter_history() {
    let conn = store();
    conn.execute(
        "UPDATE sessions SET cwd = '/work/project' WHERE id = 'a'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions VALUES ('c', NULL, '/work/project')",
        [],
    )
    .unwrap();
    for id in ["a", "b", "c"] {
        turn(
            &conn,
            id,
            0,
            &local(&conn, "2026-09-07 09:00:00"),
            "Implement a feature",
        );
    }
    let data = source::load(&conn, 7, Some("repo-a"), &now(&conn)).unwrap();
    assert_eq!(data.turns.len(), 2);
    assert_eq!(data.repositories, vec!["repo-a", "repo-b"]);
    conn.execute(
        "UPDATE sessions SET cwd = '/work/project' WHERE id = 'b'",
        [],
    )
    .unwrap();
    let ambiguous = source::load(&conn, 7, None, &now(&conn)).unwrap();
    assert_eq!(ambiguous.session_repos["c"], "/work/project");
}

#[test]
fn prompt_sampling_keeps_full_activity_counts() {
    let conn = store();
    conn.execute(
        "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x < 5000)
         INSERT INTO turns SELECT 'a', x, ?1, 'Implement the feature and verify the tests' FROM n",
        [local(&conn, "2026-09-07 09:00:00")],
    )
    .unwrap();
    let data = source::load(&conn, 7, None, &now(&conn)).unwrap();
    let result = report::build(data);
    assert_eq!(result.totals.turns, 5001);
    assert_eq!(result.practices.available_prompts, 5000);
    assert!(result.practices.sampled);
    turn(
        &conn,
        "b",
        0,
        &local(&conn, "2026-09-07 09:00:00"),
        &"é".repeat(9000),
    );
    let result = report::build(source::load(&conn, 7, Some("repo-b"), &now(&conn)).unwrap());
    assert_eq!(result.practices.available_prompts, 1);
    assert_eq!(result.practices.truncated_prompts, 1);
    assert!(!result.practices.sampled);
    assert!(result.practices.examples[0].text.chars().count() <= 240);
}

#[test]
fn file_counts_distinguish_observations_from_unique_paths() {
    let conn = store();
    for id in ["a", "a", "b"] {
        conn.execute(
            "INSERT INTO session_files VALUES (?1, ?2, 'src/main.rs', 'edit')",
            params![id, local(&conn, "2026-09-07 09:00:00")],
        )
        .unwrap();
    }
    let result = report::build(source::load(&conn, 7, None, &now(&conn)).unwrap());
    assert_eq!(result.totals.files_edited, 3);
    assert_eq!(result.totals.unique_files, 2);
}

#[test]
#[ignore = "Opt-in read-only smoke check against this machine's saved histories"]
fn local_history_smoke_check() {
    let result = super::read_analytics(30, None);
    assert!(result.ok, "{:?}", result.message);
    let summary = result.summary.unwrap();
    eprintln!(
        "Local analytics: {} sessions, {} turns, {} models, {} warnings",
        summary.totals.sessions,
        summary.totals.turns,
        summary.models.len(),
        summary.coverage.warnings.len()
    );
    for source in summary.coverage.sources {
        eprintln!(
            "{}: {} sessions, {} usage records",
            source.source, source.sessions, source.usage_records
        );
    }
}
