//! Provider-agnostic types and diff plumbing for the in-app pull-request review workspace.
//!
//! Mirrors `src/shared/pr-review.ts`. Both the Azure DevOps (`ado.rs`) and GitHub (`github.rs`)
//! backends produce these shapes so the renderer never branches on provider.
//!
//! Diffs always come from the provider API. GitHub returns a unified patch per file, which
//! [`parse_unified_patch`] normalises; Azure DevOps exposes no patch endpoint, so the backend
//! fetches both blobs and diffs them here with [`diff_blobs`].

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

use crate::reviews::RepoPrThread;

/// Hard cap on blob/patch size fed to the diff engine and the renderer. Anything larger is
/// truncated and flagged so the UI can say so instead of freezing.
pub const MAX_FILE_BYTES: usize = 1_000_000;
/// Hard cap on the number of lines rendered for a single file.
pub const MAX_FILE_LINES: usize = 20_000;
/// Lines of unchanged context kept around each change when diffing blobs.
const DIFF_CONTEXT: usize = 3;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewDetail {
    /// "github" | "ado"
    pub provider: String,
    pub id: i64,
    pub title: String,
    pub description: String,
    pub author: String,
    pub source_ref: String,
    pub target_ref: String,
    pub head_sha: String,
    pub base_sha: String,
    pub web_url: String,
    pub is_draft: bool,
    /// "open" | "merged" | "abandoned" | "unknown"
    pub state: String,
    /// "none" | "approved" | "approvedWithSuggestions" | "waitingForAuthor" | "rejected"
    pub my_vote: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    /// "add" | "edit" | "delete" | "rename"
    pub change_type: String,
    pub additions: i64,
    pub deletions: i64,
    pub is_binary: bool,
    pub is_markdown: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffLine {
    /// "context" | "add" | "del"
    pub kind: String,
    pub base_line: Option<i64>,
    pub head_line: Option<i64>,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffHunk {
    pub header: String,
    pub base_start: i64,
    pub base_lines: i64,
    pub head_start: i64,
    pub head_lines: i64,
    pub lines: Vec<PrDiffLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrFileDiff {
    pub path: String,
    pub hunks: Vec<PrDiffHunk>,
    pub is_binary: bool,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrFileContent {
    pub path: String,
    /// "base" | "head"
    pub side: String,
    pub text: String,
    pub is_binary: bool,
    pub truncated: bool,
}

/// Where a new comment thread is pinned. Deserialized from the renderer.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrCommentAnchor {
    pub file_path: String,
    /// "right" | "left"
    pub side: String,
    pub start_line: i64,
    pub end_line: i64,
    /// "diff" | "preview"
    pub origin: String,
}

impl PrCommentAnchor {
    pub fn is_right(&self) -> bool {
        !self.side.eq_ignore_ascii_case("left")
    }

    /// Normalised, ordered, 1-based inclusive line range.
    pub fn range(&self) -> (i64, i64) {
        let start = self.start_line.max(1);
        let end = self.end_line.max(start);
        (start, end)
    }
}

macro_rules! pr_result {
    ($name:ident, $field:ident, $ty:ty) => {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub $field: Option<$ty>,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub code: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub message: Option<String>,
        }

        impl $name {
            pub fn ok(value: $ty) -> Self {
                Self {
                    ok: true,
                    $field: Some(value),
                    code: None,
                    message: None,
                }
            }

            pub fn err(code: impl Into<String>, message: Option<String>) -> Self {
                Self {
                    ok: false,
                    $field: None,
                    code: Some(code.into()),
                    message,
                }
            }
        }
    };
}

pr_result!(PrReviewDetailResult, detail, PrReviewDetail);
pr_result!(PrChangedFilesResult, files, Vec<PrChangedFile>);
pr_result!(PrFileDiffResult, diff, PrFileDiff);
pr_result!(PrFileContentResult, content, PrFileContent);

/// Result of a write (create thread / reply / resolve / vote). `thread` is populated when the
/// provider hands back the created or updated thread.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrMutationResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<RepoPrThread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PrMutationResult {
    pub fn ok(thread: Option<RepoPrThread>) -> Self {
        Self {
            ok: true,
            thread,
            code: None,
            message: None,
        }
    }

    pub fn err(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            ok: false,
            thread: None,
            code: Some(code.into()),
            message,
        }
    }
}

/// True for markdown paths, which get the Diff | Preview | Raw toggle in the workspace.
pub fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
}

/// Repository-relative path with forward slashes and no leading slash, as the UI and both
/// providers' comment APIs expect.
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

/// Heuristic binary detection: a NUL byte in the first 8 KB.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Clamp text to the size guards, reporting whether it was truncated.
pub fn clamp_text(text: &str) -> (String, bool) {
    let mut truncated = false;
    let mut out = if text.len() > MAX_FILE_BYTES {
        truncated = true;
        // Cut on a char boundary at or below the cap.
        let mut end = MAX_FILE_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    } else {
        text.to_string()
    };

    if out.lines().count() > MAX_FILE_LINES {
        truncated = true;
        out = out
            .lines()
            .take(MAX_FILE_LINES)
            .collect::<Vec<_>>()
            .join("\n");
    }

    (out, truncated)
}

fn hunk_header(base_start: i64, base_lines: i64, head_start: i64, head_lines: i64) -> String {
    format!("@@ -{base_start},{base_lines} +{head_start},{head_lines} @@")
}

/// Parse a unified patch body (as returned by GitHub's `pulls/{n}/files[].patch`) into hunks.
///
/// The input contains only `@@` headers and `+`/`-`/` ` lines — no `diff --git` preamble — but
/// leading `diff`/`index`/`---`/`+++` lines are tolerated and skipped.
pub fn parse_unified_patch(patch: &str) -> Vec<PrDiffHunk> {
    let mut hunks: Vec<PrDiffHunk> = Vec::new();
    let mut base_cursor = 0i64;
    let mut head_cursor = 0i64;

    for line in patch.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);

        if line.starts_with("@@") {
            if let Some((base_start, base_lines, head_start, head_lines)) = parse_hunk_header(line) {
                base_cursor = base_start;
                head_cursor = head_start;
                hunks.push(PrDiffHunk {
                    header: hunk_header(base_start, base_lines, head_start, head_lines),
                    base_start,
                    base_lines,
                    head_start,
                    head_lines,
                    lines: Vec::new(),
                });
            }
            continue;
        }

        let Some(hunk) = hunks.last_mut() else {
            continue;
        };

        if line.starts_with("\\") {
            // "\ No newline at end of file" — carries no line of its own.
            continue;
        }
        if line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            continue;
        }

        let (marker, text) = match line.chars().next() {
            Some(c @ ('+' | '-' | ' ')) => (c, &line[1..]),
            None => (' ', ""),
            Some(_) => (' ', line),
        };

        match marker {
            '+' => {
                hunk.lines.push(PrDiffLine {
                    kind: "add".to_string(),
                    base_line: None,
                    head_line: Some(head_cursor),
                    text: text.to_string(),
                });
                head_cursor += 1;
            }
            '-' => {
                hunk.lines.push(PrDiffLine {
                    kind: "del".to_string(),
                    base_line: Some(base_cursor),
                    head_line: None,
                    text: text.to_string(),
                });
                base_cursor += 1;
            }
            _ => {
                hunk.lines.push(PrDiffLine {
                    kind: "context".to_string(),
                    base_line: Some(base_cursor),
                    head_line: Some(head_cursor),
                    text: text.to_string(),
                });
                base_cursor += 1;
                head_cursor += 1;
            }
        }
    }

    hunks
}

/// Parse `@@ -a,b +c,d @@` into `(base_start, base_lines, head_start, head_lines)`.
fn parse_hunk_header(line: &str) -> Option<(i64, i64, i64, i64)> {
    let body = line.trim_start_matches('@').trim();
    let mut parts = body.split_whitespace();
    let base = parts.next()?.strip_prefix('-')?;
    let head = parts.next()?.strip_prefix('+')?;

    let (base_start, base_lines) = parse_range(base)?;
    let (head_start, head_lines) = parse_range(head)?;
    Some((base_start, base_lines, head_start, head_lines))
}

fn parse_range(range: &str) -> Option<(i64, i64)> {
    let mut it = range.split(',');
    let start: i64 = it.next()?.parse().ok()?;
    let count: i64 = match it.next() {
        Some(value) => value.parse().ok()?,
        None => 1,
    };
    // An empty side has start 0 in unified diffs; the first real line is 1.
    Some((if count == 0 { start } else { start.max(1) }, count))
}

/// Diff two full file blobs into the same hunk model, used for providers (Azure DevOps) that do
/// not expose a unified patch endpoint.
pub fn diff_blobs(base: &str, head: &str) -> Vec<PrDiffHunk> {
    let diff = TextDiff::from_lines(base, head);
    let mut hunks = Vec::new();

    for group in diff.grouped_ops(DIFF_CONTEXT) {
        let mut lines: Vec<PrDiffLine> = Vec::new();
        let mut base_start = 0i64;
        let mut head_start = 0i64;
        let mut base_lines = 0i64;
        let mut head_lines = 0i64;

        for op in &group {
            for change in diff.iter_changes(op) {
                let text = change
                    .value()
                    .trim_end_matches('\n')
                    .trim_end_matches('\r')
                    .to_string();
                let base_line = change.old_index().map(|i| i as i64 + 1);
                let head_line = change.new_index().map(|i| i as i64 + 1);

                if base_start == 0 {
                    base_start = base_line.unwrap_or(0);
                }
                if head_start == 0 {
                    head_start = head_line.unwrap_or(0);
                }

                let kind = match change.tag() {
                    ChangeTag::Insert => "add",
                    ChangeTag::Delete => "del",
                    ChangeTag::Equal => "context",
                };
                if base_line.is_some() {
                    base_lines += 1;
                }
                if head_line.is_some() {
                    head_lines += 1;
                }

                lines.push(PrDiffLine {
                    kind: kind.to_string(),
                    base_line,
                    head_line,
                    text,
                });
            }
        }

        if lines.is_empty() {
            continue;
        }

        let base_start = base_start.max(1);
        let head_start = head_start.max(1);
        hunks.push(PrDiffHunk {
            header: hunk_header(base_start, base_lines, head_start, head_lines),
            base_start,
            base_lines,
            head_start,
            head_lines,
            lines,
        });
    }

    hunks
}

/// The head-side lines a comment may anchor to, i.e. every line present in the diff.
///
/// GitHub rejects review comments on lines outside the diff, so callers clamp a requested anchor
/// into this set (see `clamp_anchor_to_diff`).
pub fn commentable_head_lines(hunks: &[PrDiffHunk]) -> Vec<i64> {
    let mut lines: Vec<i64> = hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .filter_map(|line| line.head_line)
        .collect();
    lines.sort_unstable();
    lines.dedup();
    lines
}

/// Clamp `(start, end)` to lines that actually appear in the diff.
///
/// Returns `None` when the range shares no line with the diff at all, in which case the caller
/// falls back to a file-level comment that quotes the range.
pub fn clamp_anchor_to_diff(
    commentable: &[i64],
    start: i64,
    end: i64,
) -> Option<(i64, i64)> {
    if commentable.is_empty() {
        return None;
    }
    let inside: Vec<i64> = commentable
        .iter()
        .copied()
        .filter(|line| *line >= start && *line <= end)
        .collect();
    if let (Some(first), Some(last)) = (inside.first(), inside.last()) {
        return Some((*first, *last));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unified_patch_line_numbers() {
        let patch = "@@ -1,3 +1,4 @@\n one\n-two\n+two changed\n+added\n three";
        let hunks = parse_unified_patch(patch);
        assert_eq!(hunks.len(), 1);
        let lines = &hunks[0].lines;
        assert_eq!(lines[0].kind, "context");
        assert_eq!(lines[0].head_line, Some(1));
        assert_eq!(lines[1].kind, "del");
        assert_eq!(lines[1].base_line, Some(2));
        assert_eq!(lines[1].head_line, None);
        assert_eq!(lines[2].kind, "add");
        assert_eq!(lines[2].head_line, Some(2));
        assert_eq!(lines[3].head_line, Some(3));
        assert_eq!(lines[4].kind, "context");
        assert_eq!(lines[4].head_line, Some(4));
    }

    #[test]
    fn diffs_blobs_into_hunks() {
        let base = "a\nb\nc\n";
        let head = "a\nB\nc\n";
        let hunks = diff_blobs(base, head);
        assert_eq!(hunks.len(), 1);
        let adds = hunks[0].lines.iter().filter(|l| l.kind == "add").count();
        let dels = hunks[0].lines.iter().filter(|l| l.kind == "del").count();
        assert_eq!((adds, dels), (1, 1));
    }

    #[test]
    fn clamps_anchor_to_diff_lines() {
        let commentable = vec![10, 11, 12, 20];
        assert_eq!(clamp_anchor_to_diff(&commentable, 5, 11), Some((10, 11)));
        assert_eq!(clamp_anchor_to_diff(&commentable, 13, 19), None);
    }

    #[test]
    fn detects_markdown_paths() {
        assert!(is_markdown_path("docs/README.md"));
        assert!(is_markdown_path("A.MARKDOWN"));
        assert!(!is_markdown_path("src/main.rs"));
    }
}
