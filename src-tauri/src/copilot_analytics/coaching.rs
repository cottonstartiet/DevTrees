use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::report::{percent, source};
use super::source::{Data, Turn, PROMPT_LIMIT};

static CONSTRAINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(must|should|only|without|avoid|preserve|at least|at most|do not|don't|constraint|require)\b").unwrap()
});
static SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(acceptance|criteria|expected|expect|should return|should output|result should|success|passes|passing)\b").unwrap()
});
static VERIFY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(test|tests|verify|validate|check|confirm|assert|prove|coverage)\b").unwrap()
});
static FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(#file\b|[\w-]+\.(rs|tsx?|jsx?|py|go|cs|java|md|json|ya?ml|toml|css|html)\b|```|https?://)").unwrap()
});
static STRUCTURED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:[-*] |\d+[.)] |#{1,6} )").unwrap());
static SPEC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(specification|spec|requirements?|acceptance criteria|design doc|prd|rfc|plan)\b",
    )
    .unwrap()
});
static VARIABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)https?://\S+|[a-z]:\\[^\s]+|(?:\./|/)[\w./-]+|`[^`]+`|"[^"]+"|\b\d+\b"#)
        .unwrap()
});
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}][\p{L}\p{N}_-]*").unwrap());
static INTENTS: LazyLock<Vec<(&str, Regex)>> = LazyLock::new(|| {
    [
        (
            "Debugging",
            r"(?i)\b(fix|bug|error|exception|crash|debug|broken|failing|panic)\b",
        ),
        (
            "Review",
            r"(?i)\b(review|audit|inspect|explain|understand|analyze)\b",
        ),
        (
            "Planning",
            r"(?i)\b(plan|architect|design|outline|strategy|roadmap|spec|proposal)\b",
        ),
        (
            "Exploration",
            r"(?i)\b(research|explore|learn|compare|tutorial|experiment)\b",
        ),
        (
            "Implementation",
            r"(?i)\b(implement|build|create|add|refactor|write|generate|update|remove)\b",
        ),
    ]
    .into_iter()
    .map(|(name, pattern)| (name, Regex::new(pattern).unwrap()))
    .collect()
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub session_id: String,
    pub turn_index: i64,
    pub source: String,
    pub repository: String,
    pub date: String,
    pub text: String,
    pub issues: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimension {
    pub name: String,
    pub score: f64,
    pub explanation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPoint {
    pub date: String,
    pub score: f64,
    pub prompts: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub name: String,
    pub sessions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub observation: String,
    pub recommendation: String,
    pub evidence_count: usize,
    pub sample_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub occurrences: usize,
    pub sessions: usize,
    pub repositories: Vec<String>,
    pub sources: Vec<String>,
    pub examples: Vec<Example>,
    pub draft: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Practices {
    pub analyzed_prompts: usize,
    pub available_prompts: usize,
    pub excluded_prompts: usize,
    pub sampled: bool,
    pub truncated_prompts: usize,
    pub score: Option<f64>,
    pub grade: Option<String>,
    pub dimensions: Vec<Dimension>,
    pub trend: Vec<PromptPoint>,
    pub intents: Vec<Intent>,
    pub classified_sessions: usize,
    pub spec_eligible_sessions: usize,
    pub spec_driven_sessions: usize,
    pub findings: Vec<Finding>,
    pub examples: Vec<Example>,
    pub unstructured_examples: Vec<Example>,
    pub workflows: Vec<Workflow>,
}

fn noise(text: &str) -> bool {
    let text = text.trim().to_lowercase();
    text.is_empty()
        || matches!(
            text.trim_end_matches(['.', '!', '?']),
            "yes"
                | "no"
                | "ok"
                | "okay"
                | "continue"
                | "go ahead"
                | "try again"
                | "retry"
                | "thanks"
                | "thank you"
                | "proceed"
        )
        || text.starts_with("<system")
        || text.starts_with("<environment")
        || text.starts_with("<instructions")
        || text.starts_with("# agents.md instructions")
}

fn scores(text: &str) -> [f64; 5] {
    let chars = text.chars().count();
    let structure = STRUCTURED.is_match(text);
    [
        if CONSTRAINT.is_match(text) {
            100.0
        } else {
            0.0
        },
        if SUCCESS.is_match(text) { 100.0 } else { 0.0 },
        if VERIFY.is_match(text) { 100.0 } else { 0.0 },
        if FILE.is_match(text) { 100.0 } else { 0.0 },
        (if chars >= 100 {
            40.0
        } else if chars >= 50 {
            20.0
        } else {
            0.0
        }) + if structure { 30.0 } else { 0.0 }
            + if text.lines().filter(|line| !line.trim().is_empty()).count() >= 4 {
                30.0
            } else {
                0.0
            },
    ]
}

fn example(data: &Data, turn: &Turn, issues: Vec<String>) -> Example {
    Example {
        session_id: turn.session.clone(),
        turn_index: turn.index,
        source: source(data, &turn.session).into(),
        repository: data
            .session_repos
            .get(&turn.session)
            .cloned()
            .unwrap_or("Unassigned".into()),
        date: turn.date.clone(),
        text: turn.prompt.chars().take(240).collect(),
        issues,
    }
}

fn fingerprint(text: &str) -> String {
    let lower = text.to_lowercase();
    let normalized = VARIABLE.replace_all(&lower, " variable ");
    WORD.find_iter(&normalized)
        .map(|word| word.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn analyze(data: &Data) -> Practices {
    let current: Vec<_> = data
        .turns
        .iter()
        .filter(|turn| turn.timestamp >= data.start)
        .collect();
    let available_prompts = current.iter().filter(|t| !t.prompt.is_empty()).count();
    let selected: Vec<_> = current
        .iter()
        .copied()
        .filter(|turn| {
            !noise(&turn.prompt)
                && (turn.prompt.chars().count() >= 30
                    || data.first_turns.get(&turn.session) == Some(&turn.index))
        })
        .collect();
    let mut dimension_totals = [0.0; 5];
    let mut daily: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut graded = Vec::new();
    let mut session_prompts: BTreeMap<&str, Vec<&Turn>> = BTreeMap::new();
    let mut workflow_buckets: BTreeMap<String, Vec<&Turn>> = BTreeMap::new();
    for turn in &selected {
        let dimensions = scores(&turn.prompt);
        let score = dimensions.iter().sum::<f64>() / 5.0;
        for (i, dimension) in dimensions.iter().enumerate() {
            dimension_totals[i] += dimension;
        }
        let day = daily.entry(turn.date.clone()).or_default();
        day.0 += score;
        day.1 += 1;
        let issues: Vec<String> = [
            "No explicit constraint",
            "No explicit success criterion",
            "No verification keyword",
            "No inline file, URL or code reference",
            "Little structural detail",
        ]
        .into_iter()
        .zip(dimensions)
        .filter(|(_, score)| *score == 0.0)
        .map(|(label, _)| label.into())
        .collect();
        graded.push((score, *turn, issues));
        session_prompts.entry(&turn.session).or_default().push(turn);
        if (30..=2_000).contains(&turn.prompt.chars().count()) && !turn.truncated {
            let key = fingerprint(&turn.prompt);
            if key.split_whitespace().count() >= 4 {
                workflow_buckets.entry(key).or_default().push(turn);
            }
        }
    }
    let score = (!selected.is_empty())
        .then(|| dimension_totals.iter().sum::<f64>() / (selected.len() * 5) as f64);
    let grade = score.map(|score| {
        match score as u32 {
            80.. => "A",
            60..=79 => "B",
            40..=59 => "C",
            20..=39 => "D",
            _ => "F",
        }
        .into()
    });
    let names = [
        "Constraints",
        "Success criteria",
        "Verification",
        "Inline context",
        "Specificity",
    ];
    let explanations = [
        "Presence of explicit constraints such as must, only, preserve or avoid.",
        "Presence of expected outcomes or acceptance-criteria keywords.",
        "Presence of test, verify, validate or related keywords.",
        "File names, #file, URLs or fenced code in the prompt text. Automatically supplied context is not measured.",
        "Prompt length, lists/headings and multiline structure. More text does not necessarily mean a better prompt.",
    ];
    let dimensions = if selected.is_empty() {
        Vec::new()
    } else {
        names
            .into_iter()
            .zip(explanations)
            .enumerate()
            .map(|(i, (name, explanation))| Dimension {
                name: name.into(),
                score: dimension_totals[i] / selected.len() as f64,
                explanation: explanation.into(),
            })
            .collect()
    };
    let mut intents: BTreeMap<&str, usize> = [
        "Planning",
        "Implementation",
        "Debugging",
        "Review",
        "Exploration",
        "Unclassified",
    ]
    .into_iter()
    .map(|name| (name, 0))
    .collect();
    for prompts in session_prompts.values() {
        let mut intent = "Unclassified";
        let mut best = 0;
        for (name, pattern) in INTENTS.iter() {
            let count = prompts
                .iter()
                .filter(|turn| pattern.is_match(&turn.prompt))
                .count();
            if count > best {
                best = count;
                intent = name;
            }
        }
        *intents.entry(intent).or_default() += 1;
    }
    let mut starts = Vec::new();
    let counts: BTreeMap<&str, usize> = current.iter().fold(BTreeMap::new(), |mut counts, turn| {
        *counts.entry(&turn.session).or_default() += 1;
        counts
    });
    for turn in &selected {
        if data.first_turns.get(&turn.session) == Some(&turn.index)
            && counts.get(turn.session.as_str()).copied().unwrap_or(0) >= 3
        {
            starts.push(*turn);
        }
    }
    let unstructured: Vec<_> = starts
        .iter()
        .copied()
        .filter(|t| !SPEC.is_match(&t.prompt) && !STRUCTURED.is_match(&t.prompt))
        .collect();
    let mut findings = Vec::new();
    if selected.len() >= 10 {
        let missing_verification = selected
            .iter()
            .filter(|turn| !VERIFY.is_match(&turn.prompt))
            .count();
        if percent(missing_verification, selected.len()).is_some_and(|pct| pct > 60.0) {
            findings.push(Finding {
                id: "verification".into(), title: "Make verification explicit".into(), severity: "suggestion".into(),
                observation: format!("{missing_verification} of {} analyzed prompts have no verification keyword.", selected.len()),
                recommendation: "For implementation tasks, name the expected outcome and the existing tests or checks to run. This heuristic cannot see implicit or repository-provided instructions.".into(),
                evidence_count: missing_verification, sample_size: selected.len(),
            });
        }
        let short = selected
            .iter()
            .filter(|turn| turn.prompt.chars().count() < 30)
            .count();
        if short >= 3 {
            findings.push(Finding { id: "short-starts".into(), title: "Add context to short task starts".into(), severity: "suggestion".into(),
                observation: format!("{short} task-start prompts are shorter than 30 characters."),
                recommendation: "Describe the target, constraints and expected result when starting an unfamiliar task. Short follow-ups are normal and excluded from this check.".into(),
                evidence_count: short, sample_size: selected.len() });
        }
    }
    if starts.len() >= 3 && unstructured.len() * 2 > starts.len() {
        findings.push(Finding { id: "spec-first".into(), title: "Try a structured task brief".into(), severity: "suggestion".into(),
            observation: format!("{} of {} eligible sessions start without detectable spec keywords or list structure.", unstructured.len(), starts.len()),
            recommendation: "For a multi-step task, state scope, constraints and acceptance criteria up front. This measures prompt structure, not task success.".into(),
            evidence_count: unstructured.len(), sample_size: starts.len() });
    }
    let mut clusters: Vec<_> = workflow_buckets
        .into_iter()
        .filter(|(_, turns)| {
            turns.len() >= 3
                && turns
                    .iter()
                    .map(|turn| &turn.session)
                    .collect::<BTreeSet<_>>()
                    .len()
                    >= 2
        })
        .collect();
    clusters.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    let workflows: Vec<_> = clusters.into_iter().take(12).enumerate().map(|(i, (_, turns))| {
        let canonical = turns.iter().min_by_key(|t| t.prompt.len()).unwrap();
        Workflow {
            id: format!("workflow-{i}"), occurrences: turns.len(),
            sessions: turns.iter().map(|turn| &turn.session).collect::<BTreeSet<_>>().len(),
            repositories: turns.iter().filter_map(|turn| data.session_repos.get(&turn.session).cloned()).collect::<BTreeSet<_>>().into_iter().collect(),
            sources: turns.iter().map(|turn| source(data, &turn.session).to_string()).collect::<BTreeSet<_>>().into_iter().collect(),
            examples: turns.iter().take(3).map(|turn| example(data, turn, Vec::new())).collect(),
            draft: format!("# Reusable workflow\n\n## When to use\n{}\n\n## Inputs\n- Identify repository, files and task-specific parameters.\n\n## Steps\n1. Inspect the relevant code and existing conventions.\n2. Perform the requested operation within the stated scope.\n3. Run the repository's relevant checks and report the outcome.\n\n## Review before use\nReplace this draft with precise steps and acceptance criteria for your workflow.\n", canonical.prompt.chars().take(500).collect::<String>()),
        }
    }).collect();
    if !workflows.is_empty() {
        findings.push(Finding { id: "repeated-workflows".into(), title: "Reuse a recurring workflow".into(), severity: "opportunity".into(),
            observation: format!("{} prompt patterns recur at least three times across multiple sessions.", workflows.len()),
            recommendation: "Review the examples below and turn useful repetitions into a saved prompt or skill. Similar wording is only an automation candidate, not measured time savings.".into(),
            evidence_count: workflows.iter().map(|w| w.occurrences).sum(), sample_size: selected.len() });
    }
    graded.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.timestamp.cmp(&b.1.timestamp)));
    Practices {
        analyzed_prompts: selected.len(),
        available_prompts,
        excluded_prompts: available_prompts.saturating_sub(selected.len()),
        sampled: current.len() > PROMPT_LIMIT,
        truncated_prompts: selected.iter().filter(|turn| turn.truncated).count(),
        score,
        grade,
        dimensions,
        trend: daily
            .into_iter()
            .map(|(date, (score, count))| PromptPoint {
                date,
                score: score / count as f64,
                prompts: count,
            })
            .collect(),
        intents: intents
            .into_iter()
            .map(|(name, sessions)| Intent {
                name: name.into(),
                sessions,
            })
            .collect(),
        classified_sessions: session_prompts.len(),
        spec_eligible_sessions: starts.len(),
        spec_driven_sessions: starts.len() - unstructured.len(),
        findings,
        examples: graded
            .into_iter()
            .filter(|(_, _, issues)| !issues.is_empty())
            .take(5)
            .map(|(_, turn, issues)| example(data, turn, issues))
            .collect(),
        unstructured_examples: unstructured
            .iter()
            .take(5)
            .map(|turn| example(data, turn, Vec::new()))
            .collect(),
        workflows,
    }
}
