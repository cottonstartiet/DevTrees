use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;

pub struct AzOutput {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum AzError {
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

pub async fn run_az(args: Vec<String>) -> Result<AzOutput, AzError> {
    tauri::async_runtime::spawn_blocking(move || run_az_blocking(&args))
        .await
        .map_err(|e| AzError::Failed {
            stdout: String::new(),
            stderr: format!("az task panicked: {e}"),
            code: None,
        })?
}

fn run_az_blocking(args: &[String]) -> Result<AzOutput, AzError> {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("az").args(args);
        cmd
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new("az");
        cmd.args(args);
        cmd
    };

    configure_no_window(&mut cmd);

    let output = match cmd.output() {
        Ok(output) => output,
        Err(err) => {
            #[cfg(not(windows))]
            {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Err(AzError::NotInstalled);
                }
            }

            return Err(AzError::Failed {
                stdout: String::new(),
                stderr: err.to_string(),
                code: None,
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        return Ok(AzOutput { stdout, stderr });
    }

    let stderr_trimmed = stderr.trim();
    if stderr_trimmed.contains("is not recognized as an internal or external command")
        || stderr_trimmed.contains("command not found")
    {
        return Err(AzError::NotInstalled);
    }

    Err(AzError::Failed {
        stdout,
        stderr,
        code: output.status.code(),
    })
}

pub fn classify_az_generic_failure(stderr: &str) -> Option<(String, String)> {
    static EXTENSION_MISSING: OnceLock<Vec<Regex>> = OnceLock::new();
    static NOT_LOGGED_IN: OnceLock<Vec<Regex>> = OnceLock::new();

    let extension_missing = EXTENSION_MISSING.get_or_init(|| {
        vec![
            Regex::new(r"(?i)is misspelled or not recognized").unwrap(),
            Regex::new(r"(?i)no installed CLI command").unwrap(),
            Regex::new(r"(?i)azure-devops.*not installed").unwrap(),
            Regex::new(r"(?i)'repos' is misspelled").unwrap(),
            Regex::new(r"(?i)'pipelines' is misspelled").unwrap(),
        ]
    });
    if extension_missing.iter().any(|re| re.is_match(stderr)) {
        return Some((
            "az-extension-missing".to_string(),
            "Run: az extension add --name azure-devops".to_string(),
        ));
    }

    let not_logged_in = NOT_LOGGED_IN.get_or_init(|| {
        vec![
            Regex::new(r#"(?i)Please run ['"]?az login"#).unwrap(),
            Regex::new(r"(?i)\baz login\b").unwrap(),
            Regex::new(r"(?i)AADSTS").unwrap(),
            Regex::new(r"(?i)TokenCredentialUnavailable").unwrap(),
            Regex::new(r"(?i)not signed in").unwrap(),
            Regex::new(r"(?i)TF400813").unwrap(),
            Regex::new(
                r"(?i)Before you can run Azure DevOps commands, you need to run the login command",
            )
            .unwrap(),
        ]
    });
    if not_logged_in.iter().any(|re| re.is_match(stderr)) {
        return Some(("az-not-logged-in".to_string(), "Run: az login".to_string()));
    }

    None
}
