use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use super::coaching::{self, Practices};
use super::source::{Data, Turn};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub sessions: usize,
    pub turns: usize,
    pub active_days: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_nano_aiu: i64,
    pub usage_records: usize,
    pub credit_records: usize,
    pub avg_response_ms: Option<f64>,
    pub avg_time_to_first_token_ms: Option<f64>,
    pub p50_response_ms: Option<f64>,
    pub p95_response_ms: Option<f64>,
    pub files_created: usize,
    pub files_edited: usize,
    pub unique_files: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Daily {
    pub date: String,
    pub sessions: usize,
    pub turns: usize,
    pub events: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_nano_aiu: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub model: String,
    pub source: String,
    pub events: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_nano_aiu: i64,
    pub credit_records: usize,
    pub input_records: usize,
    pub output_records: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUsage {
    pub repository: String,
    pub sessions: usize,
    pub turns: usize,
    pub events: usize,
    pub cost_nano_aiu: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUsage {
    pub path: String,
    pub repository: String,
    pub creates: usize,
    pub edits: usize,
    pub touches: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSource {
    pub source: String,
    pub sessions: usize,
    pub turns: usize,
    pub sessions_with_usage: usize,
    pub usage_records: usize,
    pub token_records: usize,
    pub credit_records: usize,
    pub timed_records: usize,
    pub avg_response_ms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub usage_available: bool,
    pub files_available: bool,
    pub prompts_available: bool,
    pub sources: Vec<CoverageSource>,
    pub warnings: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cadence {
    pub weekend_turns: usize,
    pub late_night_turns: usize,
    pub active_streak: usize,
    pub longest_streak: usize,
    pub longest_break: usize,
    pub median_prompt_gap_minutes: Option<f64>,
    pub continuity_percent: Option<f64>,
    pub observed_block_minutes: f64,
    pub longest_block_minutes: f64,
    pub long_sessions: usize,
    pub single_turn_sessions: usize,
    pub sessions_with_turns: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hour {
    pub weekday: usize,
    pub hour: usize,
    pub turns: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub current: Cadence,
    pub previous: Cadence,
    pub heatmap: Vec<Hour>,
    pub peak_hour: Option<usize>,
    pub tips: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSummary {
    pub window_days: i64,
    pub source: String,
    pub repository: Option<String>,
    pub repositories: Vec<String>,
    pub calculated_at: String,
    pub from_date: String,
    pub to_date: String,
    pub totals: Totals,
    pub previous: Totals,
    pub daily: Vec<Daily>,
    pub models: Vec<Model>,
    pub top_repositories: Vec<RepositoryUsage>,
    pub top_files: Vec<FileUsage>,
    pub coverage: Coverage,
    pub flow: Flow,
    pub practices: Practices,
}

pub fn percent(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 * 100.0 / denominator as f64)
}

fn percentile(values: &mut [f64], fraction: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[((values.len() as f64 * fraction).ceil() as usize).saturating_sub(1)])
}

fn repo<'a>(data: &'a Data, session: &str) -> &'a str {
    data.session_repos
        .get(session)
        .map(String::as_str)
        .unwrap_or("Unassigned")
}

pub fn source<'a>(data: &'a Data, session: &str) -> &'a str {
    data.session_sources
        .get(session)
        .map(String::as_str)
        .unwrap_or("cli")
}

fn totals(data: &Data, current: bool) -> Totals {
    let mut result = Totals::default();
    let mut sessions = BTreeSet::new();
    let mut days = BTreeSet::new();
    for turn in data
        .turns
        .iter()
        .filter(|t| (t.timestamp >= data.start) == current)
    {
        result.turns += 1;
        sessions.insert(&turn.session);
        days.insert(&turn.date);
    }
    let mut durations = Vec::new();
    let mut first_tokens = Vec::new();
    for usage in data
        .usage
        .iter()
        .filter(|u| (u.timestamp >= data.start) == current)
    {
        sessions.insert(&usage.session);
        days.insert(&usage.date);
        result.usage_records += 1;
        result.input_tokens += usage.input.unwrap_or(0);
        result.output_tokens += usage.output.unwrap_or(0);
        result.cache_read_tokens += usage.cache_read;
        result.cache_write_tokens += usage.cache_write;
        result.cost_nano_aiu += usage.cost.unwrap_or(0);
        result.credit_records += usize::from(usage.cost.is_some());
        if let Some(duration) = usage.duration {
            durations.push(duration);
        }
        if let Some(ttft) = usage.ttft {
            first_tokens.push(ttft);
        }
    }
    result.sessions = sessions.len();
    result.active_days = days.len();
    if !durations.is_empty() {
        result.avg_response_ms = Some(durations.iter().sum::<f64>() / durations.len() as f64);
        result.p50_response_ms = percentile(&mut durations, 0.5);
        result.p95_response_ms = percentile(&mut durations, 0.95);
    }
    if !first_tokens.is_empty() {
        result.avg_time_to_first_token_ms =
            Some(first_tokens.iter().sum::<f64>() / first_tokens.len() as f64);
    }
    let mut files = BTreeSet::new();
    for file in data
        .files
        .iter()
        .filter(|f| (f.timestamp >= data.start) == current)
    {
        result.files_created += usize::from(file.tool == "create");
        result.files_edited += usize::from(file.tool == "edit");
        files.insert((repo(data, &file.session), &file.path));
    }
    result.unique_files = files.len();
    result
}

fn cadence(turns: &[&Turn], dates: &[String]) -> Cadence {
    let mut result = Cadence::default();
    let mut sessions: HashMap<&str, Vec<&Turn>> = HashMap::new();
    let mut active = BTreeSet::new();
    for turn in turns {
        result.weekend_turns += usize::from(turn.weekday == 0 || turn.weekday == 6);
        result.late_night_turns += usize::from(turn.hour >= 22 || turn.hour < 6);
        active.insert(&turn.date);
        sessions.entry(&turn.session).or_default().push(turn);
    }
    result.sessions_with_turns = sessions.len();
    let mut gaps = Vec::new();
    for turns in sessions.values_mut() {
        turns.sort_by_key(|turn| (turn.timestamp, turn.index));
        result.long_sessions += usize::from(turns.len() >= 50);
        result.single_turn_sessions += usize::from(turns.len() == 1);
        for pair in turns.windows(2) {
            if pair[0].date == pair[1].date {
                gaps.push((pair[1].timestamp - pair[0].timestamp) as f64 / 60.0);
            }
        }
    }
    result.median_prompt_gap_minutes = percentile(&mut gaps, 0.5);
    result.continuity_percent =
        percent(gaps.iter().filter(|gap| **gap <= 15.0).count(), gaps.len());
    let mut sorted = turns.to_vec();
    sorted.sort_by_key(|turn| turn.timestamp);
    let mut block = 0.0;
    for pair in sorted.windows(2) {
        let gap = (pair[1].timestamp - pair[0].timestamp) as f64 / 60.0;
        if pair[0].date == pair[1].date && gap <= 15.0 {
            block += gap;
            result.observed_block_minutes += gap;
            result.longest_block_minutes = result.longest_block_minutes.max(block);
        } else {
            block = 0.0;
        }
    }
    let mut streak = 0;
    let mut gap = 0;
    for date in dates {
        if active.contains(date) {
            streak += 1;
            gap = 0;
            result.longest_streak = result.longest_streak.max(streak);
        } else {
            streak = 0;
            gap += 1;
            result.longest_break = result.longest_break.max(gap);
        }
    }
    // The current streak may end yesterday if there is no activity yet today.
    let mut reverse = dates.iter().rev();
    if let Some(today) = reverse.next() {
        result.active_streak = usize::from(active.contains(today));
        for date in reverse {
            if !active.contains(date) {
                break;
            }
            result.active_streak += 1;
        }
    }
    result
}

fn flow(data: &Data) -> Flow {
    let current_turns: Vec<_> = data
        .turns
        .iter()
        .filter(|t| t.timestamp >= data.start)
        .collect();
    let previous_turns: Vec<_> = data
        .turns
        .iter()
        .filter(|t| t.timestamp < data.start)
        .collect();
    let current = cadence(&current_turns, &data.dates);
    let previous = cadence(&previous_turns, &data.previous_dates);
    let mut heatmap: Vec<_> = (0..7)
        .flat_map(|weekday| {
            (0..24).map(move |hour| Hour {
                weekday,
                hour,
                turns: 0,
            })
        })
        .collect();
    let mut hours = [0usize; 24];
    for turn in &current_turns {
        heatmap[turn.weekday * 24 + turn.hour].turns += 1;
        hours[turn.hour] += 1;
    }
    let peak_hour = hours
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| **count)
        .filter(|(_, count)| **count > 0)
        .map(|(hour, _)| hour);
    let mut tips = Vec::new();
    if current_turns.len() >= 10 {
        if percent(current.late_night_turns, current_turns.len()).is_some_and(|pct| pct > 20.0) {
            tips.push("Over 20% of recorded prompts are between 22:00 and 06:00. Consider protecting an offline window if these hours are unintentional.".into());
        }
        if percent(current.weekend_turns, current_turns.len()).is_some_and(|pct| pct > 30.0) {
            tips.push("Over 30% of recorded prompts are on weekends. Compare this with your preferred schedule; activity alone does not indicate overwork.".into());
        }
        if current.active_streak >= 7 {
            tips.push(format!("Activity appears on {} consecutive days. Consider a break if that is not your intended schedule.", current.active_streak));
        }
        if current.long_sessions > 0 {
            tips.push(format!("{} sessions contain at least 50 turns in this window. Consider starting a focused conversation at the next task boundary.", current.long_sessions));
        }
        if current.continuity_percent.is_some_and(|pct| pct < 40.0) {
            tips.push("Many same-day prompt gaps exceed 15 minutes. If interruptions are unwanted, try reserving a focused work block; gaps may also be deliberate review or agent wait time.".into());
        }
    }
    Flow {
        current,
        previous,
        heatmap,
        peak_hour,
        tips,
    }
}

pub fn build(data: Data) -> AnalyticsSummary {
    let previous = totals(&data, false);
    let totals = totals(&data, true);
    let flow = flow(&data);
    let practices = coaching::analyze(&data);
    let mut daily: BTreeMap<String, Daily> = data
        .dates
        .iter()
        .map(|date| {
            (
                date.clone(),
                Daily {
                    date: date.clone(),
                    ..Default::default()
                },
            )
        })
        .collect();
    let mut day_sessions: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let mut repo_sessions: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let mut repos: BTreeMap<String, RepositoryUsage> = BTreeMap::new();
    let mut models: BTreeMap<(String, String), Model> = BTreeMap::new();
    let mut files: BTreeMap<(String, String), FileUsage> = BTreeMap::new();
    let mut source_sessions: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let mut usage_sessions: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let mut coverage: BTreeMap<String, CoverageSource> = ["cli"]
        .into_iter()
        .map(|name| {
            (
                name.into(),
                CoverageSource {
                    source: name.into(),
                    ..Default::default()
                },
            )
        })
        .collect();
    let mut durations: HashMap<String, f64> = HashMap::new();
    for turn in data
        .turns
        .iter()
        .filter(|turn| turn.timestamp >= data.start)
    {
        if let Some(day) = daily.get_mut(&turn.date) {
            day.turns += 1;
        }
        day_sessions
            .entry(&turn.date)
            .or_default()
            .insert(&turn.session);
        let repo = repo(&data, &turn.session);
        let source = source(&data, &turn.session);
        repo_sessions.entry(repo).or_default().insert(&turn.session);
        repos
            .entry(repo.into())
            .or_insert_with(|| RepositoryUsage {
                repository: repo.into(),
                ..Default::default()
            })
            .turns += 1;
        source_sessions
            .entry(source)
            .or_default()
            .insert(&turn.session);
        coverage
            .entry(source.into())
            .or_insert_with(|| CoverageSource {
                source: source.into(),
                ..Default::default()
            })
            .turns += 1;
    }
    for usage in data
        .usage
        .iter()
        .filter(|usage| usage.timestamp >= data.start)
    {
        if let Some(day) = daily.get_mut(&usage.date) {
            day.events += 1;
            day.input_tokens += usage.input.unwrap_or(0);
            day.output_tokens += usage.output.unwrap_or(0);
            day.cost_nano_aiu += usage.cost.unwrap_or(0);
        }
        day_sessions
            .entry(&usage.date)
            .or_default()
            .insert(&usage.session);
        let repo = repo(&data, &usage.session);
        let source = source(&data, &usage.session);
        repo_sessions
            .entry(repo)
            .or_default()
            .insert(&usage.session);
        source_sessions
            .entry(source)
            .or_default()
            .insert(&usage.session);
        usage_sessions
            .entry(source)
            .or_default()
            .insert(&usage.session);
        let r = repos.entry(repo.into()).or_insert_with(|| RepositoryUsage {
            repository: repo.into(),
            ..Default::default()
        });
        r.events += 1;
        r.cost_nano_aiu += usage.cost.unwrap_or(0);
        let m = models
            .entry((source.into(), usage.model.clone()))
            .or_insert_with(|| Model {
                model: usage.model.clone(),
                source: source.into(),
                ..Default::default()
            });
        m.events += 1;
        m.input_tokens += usage.input.unwrap_or(0);
        m.output_tokens += usage.output.unwrap_or(0);
        m.input_records += usize::from(usage.input.is_some());
        m.output_records += usize::from(usage.output.is_some());
        m.cache_read_tokens += usage.cache_read;
        m.cache_write_tokens += usage.cache_write;
        m.cost_nano_aiu += usage.cost.unwrap_or(0);
        m.credit_records += usize::from(usage.cost.is_some());
        let c = coverage
            .entry(source.into())
            .or_insert_with(|| CoverageSource {
                source: source.into(),
                ..Default::default()
            });
        c.usage_records += 1;
        c.token_records += usize::from(usage.input.is_some() && usage.output.is_some());
        c.credit_records += usize::from(usage.cost.is_some());
        if let Some(duration) = usage.duration {
            c.timed_records += 1;
            *durations.entry(source.into()).or_default() += duration;
        }
    }
    for (date, day) in &mut daily {
        day.sessions = day_sessions.get(date.as_str()).map_or(0, BTreeSet::len);
    }
    for (name, repo) in &mut repos {
        repo.sessions = repo_sessions.get(name.as_str()).map_or(0, BTreeSet::len);
    }
    for (name, c) in &mut coverage {
        c.sessions = source_sessions.get(name.as_str()).map_or(0, BTreeSet::len);
        c.sessions_with_usage = usage_sessions.get(name.as_str()).map_or(0, BTreeSet::len);
        c.avg_response_ms = (c.timed_records > 0)
            .then(|| durations.get(name).copied().unwrap_or(0.0) / c.timed_records as f64);
    }
    for file in data
        .files
        .iter()
        .filter(|file| file.timestamp >= data.start)
    {
        let repository = repo(&data, &file.session);
        let f = files
            .entry((repository.into(), file.path.clone()))
            .or_insert_with(|| FileUsage {
                path: file.path.clone(),
                repository: repository.into(),
                ..Default::default()
            });
        f.touches += 1;
        f.creates += usize::from(file.tool == "create");
        f.edits += usize::from(file.tool == "edit");
    }
    let mut top_repositories: Vec<_> = repos.into_values().collect();
    top_repositories.sort_by(|a, b| {
        b.cost_nano_aiu
            .cmp(&a.cost_nano_aiu)
            .then(b.turns.cmp(&a.turns))
            .then(a.repository.cmp(&b.repository))
    });
    top_repositories.truncate(15);
    let mut models: Vec<_> = models.into_values().collect();
    models.sort_by(|a, b| {
        b.cost_nano_aiu
            .cmp(&a.cost_nano_aiu)
            .then(b.events.cmp(&a.events))
            .then(a.model.cmp(&b.model))
    });
    let mut top_files: Vec<_> = files.into_values().collect();
    top_files.sort_by(|a, b| b.touches.cmp(&a.touches).then(a.path.cmp(&b.path)));
    top_files.truncate(15);
    AnalyticsSummary {
        window_days: data.window,
        source: data.source,
        repository: data.repository,
        repositories: data.repositories,
        calculated_at: data.calculated_at,
        from_date: data.dates.first().cloned().unwrap_or_default(),
        to_date: data.dates.last().cloned().unwrap_or_default(),
        totals,
        previous,
        daily: daily.into_values().collect(),
        models,
        top_repositories,
        top_files,
        coverage: Coverage {
            usage_available: data.usage_available,
            files_available: data.files_available,
            prompts_available: data.prompts_available,
            sources: coverage.into_values().collect(),
            warnings: data.warnings,
        },
        flow,
        practices,
    }
}
