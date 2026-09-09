use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::AppResult;
use crate::pr_review::{
    clamp_text, diff_blobs, is_markdown_path, looks_binary, normalize_path, PrChangedFile,
    PrFileContent, PrFileDiff, MAX_FILE_BYTES,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReviewChangedFilesResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<PrChangedFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReviewFileDiffResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<PrFileDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReviewFileContentResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<PrFileContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

macro_rules! result_impl {
    ($name:ident, $field:ident, $ty:ty) => {
        impl $name {
            fn ok(value: $ty) -> Self {
                Self {
                    ok: true,
                    $field: Some(value),
                    error: None,
                }
            }

            fn err(error: impl Into<String>) -> Self {
                Self {
                    ok: false,
                    $field: None,
                    error: Some(error.into()),
                }
            }
        }
    };
}

result_impl!(LocalReviewChangedFilesResult, files, Vec<PrChangedFile>);
result_impl!(LocalReviewFileDiffResult, diff, PrFileDiff);
result_impl!(LocalReviewFileContentResult, content, PrFileContent);

#[derive(Clone, Debug, PartialEq, Eq)]
struct StatusEntry {
    path: String,
    previous_path: Option<String>,
    index_status: char,
    worktree_status: char,
}

impl StatusEntry {
    fn change_type(&self) -> &'static str {
        if self.index_status == 'R' || self.worktree_status == 'R' {
            "rename"
        } else if self.index_status == 'D' || self.worktree_status == 'D' {
            "delete"
        } else if (self.index_status == '?' && self.worktree_status == '?')
            || self.index_status == 'A'
            || self.worktree_status == 'A'
        {
            "add"
        } else {
            "edit"
        }
    }

    fn is_untracked(&self) -> bool {
        self.index_status == '?' && self.worktree_status == '?'
    }

    fn has_head_file(&self) -> bool {
        !self.is_untracked() && self.index_status != 'A'
    }

    fn base_path(&self) -> &str {
        self.previous_path.as_deref().unwrap_or(&self.path)
    }

    fn has_current_file(&self) -> bool {
        self.index_status != 'D' && self.worktree_status != 'D'
    }
}

struct RepositorySnapshot {
    root: PathBuf,
    entries: Vec<StatusEntry>,
}

struct FilePair {
    base: Vec<u8>,
    head: Vec<u8>,
    truncated: bool,
}

fn command_output(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| format!("Failed to run Git: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if !stderr.trim().is_empty() {
            stderr.trim()
        } else if !stdout.trim().is_empty() {
            stdout.trim()
        } else {
            "Git failed"
        };
        Err(message.to_string())
    }
}

fn parse_status(output: &[u8]) -> Vec<StatusEntry> {
    let tokens: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        if token.len() < 4 {
            index += 1;
            continue;
        }
        let index_status = token[0] as char;
        let worktree_status = token[1] as char;
        let path = normalize_path(&String::from_utf8_lossy(&token[3..]));
        let mut previous_path = None;
        if matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C') {
            if let Some(previous) = tokens.get(index + 1) {
                previous_path = Some(normalize_path(&String::from_utf8_lossy(previous)));
                index += 1;
            }
        }
        entries.push(StatusEntry {
            path,
            previous_path,
            index_status,
            worktree_status,
        });
        index += 1;
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries
}

fn load_snapshot(folder_path: &str) -> Result<RepositorySnapshot, String> {
    let folder = fs::canonicalize(folder_path)
        .map_err(|error| format!("The working copy could not be opened: {error}"))?;
    let root_output = command_output(&folder, &["rev-parse", "--show-toplevel"])?;
    let root_text = String::from_utf8_lossy(&root_output);
    let root = fs::canonicalize(root_text.trim())
        .map_err(|error| format!("The repository root could not be resolved: {error}"))?;
    if !folder.starts_with(&root) {
        return Err("The selected folder is outside the repository root.".to_string());
    }
    let status = command_output(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(RepositorySnapshot {
        root,
        entries: parse_status(&status),
    })
}

fn validate_requested_entry<'a>(
    snapshot: &'a RepositorySnapshot,
    requested: &str,
) -> Result<&'a StatusEntry, String> {
    if requested.is_empty()
        || requested.contains('\\')
        || Path::new(requested)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("The requested file path is not a valid repository-relative path.".to_string());
    }
    let wanted = normalize_path(requested);
    snapshot
        .entries
        .iter()
        .find(|entry| entry.path == wanted)
        .ok_or_else(|| "The requested file is not in the current working-copy changes.".to_string())
}

fn read_worktree_file(
    snapshot: &RepositorySnapshot,
    entry: &StatusEntry,
) -> Result<Vec<u8>, String> {
    let path = snapshot.root.join(Path::new(&entry.path));
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("The current file could not be read: {error}"))?;
    if metadata.file_type().is_symlink() {
        return fs::read_link(&path)
            .map(|target| target.to_string_lossy().as_bytes().to_vec())
            .map_err(|error| format!("The symbolic link could not be read: {error}"));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("The current file path could not be resolved: {error}"))?;
    if !canonical.starts_with(&snapshot.root) {
        return Err("The requested file resolves outside the repository root.".to_string());
    }
    if !metadata.is_file() {
        return Err("The requested working-copy entry is not a regular file.".to_string());
    }
    fs::read(canonical).map_err(|error| format!("The current file could not be read: {error}"))
}

fn head_blob(snapshot: &RepositorySnapshot, path: &str) -> Result<Vec<u8>, String> {
    command_output(
        &snapshot.root,
        &["cat-file", "blob", &format!("HEAD:{path}")],
    )
    .map_err(|error| format!("The HEAD version of {path} could not be read: {error}"))
}

fn file_pair(snapshot: &RepositorySnapshot, entry: &StatusEntry) -> Result<FilePair, String> {
    let base = if entry.has_head_file() {
        head_blob(snapshot, entry.base_path())?
    } else {
        Vec::new()
    };
    let head = if entry.has_current_file() {
        read_worktree_file(snapshot, entry)?
    } else {
        Vec::new()
    };
    let truncated = base.len() > MAX_FILE_BYTES || head.len() > MAX_FILE_BYTES;
    Ok(FilePair {
        base,
        head,
        truncated,
    })
}

fn build_diff(entry: &StatusEntry, pair: FilePair) -> PrFileDiff {
    let is_binary = looks_binary(&pair.base) || looks_binary(&pair.head);
    if is_binary {
        return PrFileDiff {
            path: entry.path.clone(),
            hunks: Vec::new(),
            is_binary: true,
            truncated: pair.truncated,
        };
    }
    let (base, base_truncated) = clamp_text(&String::from_utf8_lossy(&pair.base));
    let (head, head_truncated) = clamp_text(&String::from_utf8_lossy(&pair.head));
    PrFileDiff {
        path: entry.path.clone(),
        hunks: diff_blobs(&base, &head),
        is_binary: false,
        truncated: pair.truncated || base_truncated || head_truncated,
    }
}

fn changed_files(folder_path: &str) -> Result<Vec<PrChangedFile>, String> {
    let snapshot = load_snapshot(folder_path)?;
    let mut files = Vec::new();
    for entry in &snapshot.entries {
        let pair = file_pair(&snapshot, entry)?;
        if pair.base == pair.head && entry.change_type() != "rename" {
            continue;
        }
        let diff = build_diff(entry, pair);
        let additions = diff
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.kind == "add")
            .count() as i64;
        let deletions = diff
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.kind == "del")
            .count() as i64;
        files.push(PrChangedFile {
            path: entry.path.clone(),
            previous_path: if entry.change_type() == "rename" {
                entry.previous_path.clone()
            } else {
                None
            },
            change_type: entry.change_type().to_string(),
            additions,
            deletions,
            is_binary: diff.is_binary,
            is_markdown: is_markdown_path(&entry.path),
        });
    }
    Ok(files)
}

#[tauri::command]
pub async fn repo_local_review_changed_files(
    folder_path: String,
) -> AppResult<LocalReviewChangedFilesResult> {
    let result = tauri::async_runtime::spawn_blocking(move || changed_files(&folder_path)).await;
    Ok(match result {
        Ok(Ok(files)) => LocalReviewChangedFilesResult::ok(files),
        Ok(Err(error)) => LocalReviewChangedFilesResult::err(error),
        Err(error) => LocalReviewChangedFilesResult::err(format!("Review task failed: {error}")),
    })
}

#[tauri::command]
pub async fn repo_local_review_file_diff(
    folder_path: String,
    path: String,
) -> AppResult<LocalReviewFileDiffResult> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = load_snapshot(&folder_path)?;
        let entry = validate_requested_entry(&snapshot, &path)?;
        Ok::<_, String>(build_diff(entry, file_pair(&snapshot, entry)?))
    })
    .await;
    Ok(match result {
        Ok(Ok(diff)) => LocalReviewFileDiffResult::ok(diff),
        Ok(Err(error)) => LocalReviewFileDiffResult::err(error),
        Err(error) => LocalReviewFileDiffResult::err(format!("Review task failed: {error}")),
    })
}

#[tauri::command]
pub async fn repo_local_review_file_content(
    folder_path: String,
    path: String,
) -> AppResult<LocalReviewFileContentResult> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = load_snapshot(&folder_path)?;
        let entry = validate_requested_entry(&snapshot, &path)?;
        if !entry.has_current_file() {
            return Err("The requested file has been deleted from the working copy.".to_string());
        }
        let bytes = read_worktree_file(&snapshot, entry)?;
        if looks_binary(&bytes) {
            return Err("Binary file content cannot be displayed.".to_string());
        }
        let (text, truncated) = clamp_text(&String::from_utf8_lossy(&bytes));
        Ok::<_, String>(PrFileContent {
            path: entry.path.clone(),
            side: "head".to_string(),
            text,
            is_binary: false,
            truncated,
        })
    })
    .await;
    Ok(match result {
        Ok(Ok(content)) => LocalReviewFileContentResult::ok(content),
        Ok(Err(error)) => LocalReviewFileContentResult::err(error),
        Err(error) => LocalReviewFileContentResult::err(format!("Review task failed: {error}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parses_and_maps_porcelain_entries() {
        let entries = parse_status(
            b" M edit.txt\0A  added.txt\0?? new.txt\0R  renamed.txt\0old.txt\0 D gone.txt\0",
        );
        assert_eq!(
            entries
                .iter()
                .find(|e| e.path == "edit.txt")
                .unwrap()
                .change_type(),
            "edit"
        );
        assert_eq!(
            entries
                .iter()
                .find(|e| e.path == "added.txt")
                .unwrap()
                .change_type(),
            "add"
        );
        assert_eq!(
            entries
                .iter()
                .find(|e| e.path == "new.txt")
                .unwrap()
                .change_type(),
            "add"
        );
        assert_eq!(
            entries
                .iter()
                .find(|e| e.path == "gone.txt")
                .unwrap()
                .change_type(),
            "delete"
        );
        let renamed = entries.iter().find(|e| e.path == "renamed.txt").unwrap();
        assert_eq!(renamed.change_type(), "rename");
        assert_eq!(renamed.previous_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn rejects_traversal_and_non_changed_paths() {
        let snapshot = RepositorySnapshot {
            root: PathBuf::from("repo"),
            entries: vec![StatusEntry {
                path: "src/file.rs".to_string(),
                previous_path: None,
                index_status: ' ',
                worktree_status: 'M',
            }],
        };
        assert!(validate_requested_entry(&snapshot, "../secret").is_err());
        assert!(validate_requested_entry(&snapshot, "src\\file.rs").is_err());
        assert!(validate_requested_entry(&snapshot, "src/other.rs").is_err());
        assert!(validate_requested_entry(&snapshot, "src/file.rs").is_ok());
    }

    #[test]
    fn builds_added_deleted_and_binary_diffs() {
        let added = StatusEntry {
            path: "new.txt".to_string(),
            previous_path: None,
            index_status: '?',
            worktree_status: '?',
        };
        let diff = build_diff(
            &added,
            FilePair {
                base: Vec::new(),
                head: b"one\ntwo\n".to_vec(),
                truncated: false,
            },
        );
        assert_eq!(
            diff.hunks
                .iter()
                .flat_map(|hunk| &hunk.lines)
                .filter(|line| line.kind == "add")
                .count(),
            2
        );

        let deleted = StatusEntry {
            path: "gone.txt".to_string(),
            previous_path: None,
            index_status: ' ',
            worktree_status: 'D',
        };
        let diff = build_diff(
            &deleted,
            FilePair {
                base: b"old\n".to_vec(),
                head: Vec::new(),
                truncated: false,
            },
        );
        assert_eq!(
            diff.hunks[0]
                .lines
                .iter()
                .filter(|line| line.kind == "del")
                .count(),
            1
        );

        let binary = build_diff(
            &added,
            FilePair {
                base: Vec::new(),
                head: b"\0binary".to_vec(),
                truncated: false,
            },
        );
        assert!(binary.is_binary);
        assert!(binary.hunks.is_empty());

        let large = build_diff(
            &added,
            FilePair {
                base: Vec::new(),
                head: vec![b'x'; MAX_FILE_BYTES + 1],
                truncated: true,
            },
        );
        assert!(large.truncated);
    }

    #[test]
    fn reads_aggregate_working_tree_changes_from_git() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("local-review-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test"]);
        fs::write(root.join("edit.txt"), "before\n").unwrap();
        fs::write(root.join("delete.txt"), "delete me\n").unwrap();
        fs::write(root.join("rename.txt"), "rename me\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "initial"]);

        fs::write(root.join("edit.txt"), "staged\n").unwrap();
        git(&root, &["add", "edit.txt"]);
        fs::write(root.join("edit.txt"), "working tree\n").unwrap();
        fs::remove_file(root.join("delete.txt")).unwrap();
        git(&root, &["mv", "rename.txt", "renamed.txt"]);
        fs::write(root.join("untracked.txt"), "new\n").unwrap();
        fs::write(root.join("binary.bin"), b"\0data").unwrap();

        let files = changed_files(root.to_str().unwrap()).unwrap();
        let find = |path: &str| files.iter().find(|file| file.path == path).unwrap();
        assert_eq!(find("edit.txt").change_type, "edit");
        assert_eq!(find("edit.txt").additions, 1);
        assert_eq!(find("edit.txt").deletions, 1);
        assert_eq!(find("delete.txt").change_type, "delete");
        assert_eq!(find("renamed.txt").change_type, "rename");
        assert_eq!(
            find("renamed.txt").previous_path.as_deref(),
            Some("rename.txt")
        );
        assert_eq!(find("untracked.txt").change_type, "add");
        assert!(find("binary.bin").is_binary);

        fs::remove_dir_all(root).unwrap();
    }
}
