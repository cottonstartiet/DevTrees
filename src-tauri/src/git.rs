use std::process::Command;

use crate::error::AppError;

/// Output of a git invocation.
pub struct GitOutput {
    pub stdout: String,
}

/// A git command that exited non-zero. Mirrors the Electron `GitError`: the message
/// prefers stderr, then stdout, then a generic fallback.
#[derive(Debug)]
pub struct GitError {
    pub message: String,
    pub stderr: String,
}

impl From<GitError> for AppError {
    fn from(e: GitError) -> Self {
        AppError::Message(e.message)
    }
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: never flash a console window when spawning git from the GUI.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// Run `git <args>` in `cwd`, returning stdout/stderr on success or a `GitError` on
/// a non-zero exit. Runs the blocking child process off the async runtime so it
/// never stalls the UI thread.
pub async fn run_git(args: Vec<String>, cwd: String) -> Result<GitOutput, GitError> {
    tauri::async_runtime::spawn_blocking(move || run_git_blocking(&args, &cwd))
        .await
        .map_err(|e| GitError {
            message: format!("git task panicked: {e}"),
            stderr: String::new(),
        })?
}

/// Synchronous git invocation, suitable for use inside `spawn_blocking` or other
/// already-blocking contexts.
pub fn run_git_blocking(args: &[String], cwd: &str) -> Result<GitOutput, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    configure_no_window(&mut cmd);

    let output = cmd.output().map_err(|e| GitError {
        message: format!("failed to run git: {e}"),
        stderr: String::new(),
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(GitOutput { stdout })
    } else {
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "git failed".to_string()
        };
        Err(GitError { message, stderr })
    }
}
