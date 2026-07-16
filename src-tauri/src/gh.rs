use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;

pub struct GhOutput {
    pub stdout: String,
}

#[derive(Debug)]
pub enum GhError {
    NotInstalled,
    Failed {
        stdout: String,
        stderr: String,
        code: Option<i32>,
    },
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// Run the GitHub CLI (`gh`) with `cwd` as the working directory so the host and repository are
/// inferred from the repository's git remote (supports github.com and GitHub Enterprise).
pub async fn run_gh(args: Vec<String>, cwd: String) -> Result<GhOutput, GhError> {
    tauri::async_runtime::spawn_blocking(move || run_gh_blocking(&args, &cwd))
        .await
        .map_err(|e| GhError::Failed {
            stdout: String::new(),
            stderr: format!("gh task panicked: {e}"),
            code: None,
        })?
}

fn run_gh_blocking(args: &[String], cwd: &str) -> Result<GhOutput, GhError> {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("gh").args(args);
        cmd
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new("gh");
        cmd.args(args);
        cmd
    };

    cmd.current_dir(cwd);
    configure_no_window(&mut cmd);

    let output = match cmd.output() {
        Ok(output) => output,
        Err(err) => {
            #[cfg(not(windows))]
            {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Err(GhError::NotInstalled);
                }
            }

            return Err(GhError::Failed {
                stdout: String::new(),
                stderr: err.to_string(),
                code: None,
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        return Ok(GhOutput { stdout });
    }

    let stderr_trimmed = stderr.trim();
    if stderr_trimmed.contains("is not recognized as an internal or external command")
        || stderr_trimmed.contains("command not found")
    {
        return Err(GhError::NotInstalled);
    }

    Err(GhError::Failed {
        stdout,
        stderr,
        code: output.status.code(),
    })
}

/// Detect a "not authenticated" failure from `gh` stderr so the UI can prompt `gh auth login`.
pub fn is_not_logged_in(stderr: &str) -> bool {
    static NOT_LOGGED_IN: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = NOT_LOGGED_IN.get_or_init(|| {
        vec![
            Regex::new(r"(?i)gh auth login").unwrap(),
            Regex::new(r"(?i)not logged into").unwrap(),
            Regex::new(r"(?i)authentication required").unwrap(),
            Regex::new(r"(?i)no authentication token").unwrap(),
            Regex::new(r"(?i)To get started with GitHub CLI").unwrap(),
        ]
    });
    patterns.iter().any(|re| re.is_match(stderr))
}
