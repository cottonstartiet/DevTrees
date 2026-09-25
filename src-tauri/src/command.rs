use std::{
    io::{self, Read},
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crate::process::ProcessScope;

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Run only from a blocking worker. Drain both pipes while waiting, and bound the
/// entire invocation, including descendants that might keep a pipe open.
pub fn output(command: &mut Command) -> io::Result<Output> {
    output_with_timeout(command, COMMAND_TIMEOUT)
}

fn output_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let label = command.get_program().to_string_lossy().into_owned();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let deadline = Instant::now() + timeout;
    let mut child = command.spawn()?;
    let mut scope = match ProcessScope::attach_blocking(&child) {
        Ok(scope) => scope,
        Err(error) => {
            child.kill()?;
            child.wait()?;
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing stdout pipe."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing stderr pipe."))?;
    let (tx, rx) = mpsc::channel();
    for (index, mut pipe) in [
        (0, Box::new(stdout) as Box<dyn Read + Send>),
        (1, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send((index, result));
        });
    }
    drop(tx);
    let mut pipes = [None, None];
    let mut status = None;
    let result = loop {
        while let Ok((index, bytes)) = rx.try_recv() {
            pipes[index] = Some(bytes);
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => break Err(error),
            }
        }
        if let Some(status) = status {
            if pipes.iter().all(Option::is_some) {
                break Ok(Output {
                    status,
                    stdout: pipes[0].take().unwrap()?,
                    stderr: pipes[1].take().unwrap()?,
                });
            }
        }
        if Instant::now() >= deadline {
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("{label} timed out after {} seconds. Its process tree was stopped; inspect the repository before retrying a write.", timeout.as_secs_f64()),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    if result.is_ok() {
        scope.release()?;
    }
    drop(scope);
    if status.is_none() {
        // The owned job/process group has already been terminated; reap the direct child.
        child.wait()?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "command::tests::subprocess_fixture",
                "--nocapture",
            ])
            .env("SWE_FACTORY_PROCESS_FIXTURE", mode);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    #[test]
    fn subprocess_fixture() {
        match std::env::var("SWE_FACTORY_PROCESS_FIXTURE").as_deref() {
            Ok("pipes") => {
                std::io::stdout().write_all(&vec![b'a'; 200_000]).unwrap();
                std::io::stderr().write_all(&vec![b'b'; 200_000]).unwrap();
            }
            Ok("sleep") => thread::sleep(Duration::from_secs(60)),
            Ok("descendant") => {
                let child = fixture("sleep").spawn().unwrap();
                std::fs::write(
                    std::env::var("SWE_FACTORY_PROCESS_PID_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                // Exit while the descendant retains the inherited output pipes.
            }
            Ok("detached") => {
                let child = fixture("complete")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                std::fs::write(
                    std::env::var("SWE_FACTORY_PROCESS_PID_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
            }
            Ok("complete") => {
                thread::sleep(Duration::from_secs(1));
                std::fs::write(
                    format!(
                        "{}.done",
                        std::env::var("SWE_FACTORY_PROCESS_PID_FILE").unwrap()
                    ),
                    "finished",
                )
                .unwrap();
            }
            Ok("failure") => std::process::exit(7),
            _ => {}
        }
    }

    #[test]
    fn command_drains_both_pipes_and_preserves_exit_status() {
        let result = output(&mut fixture("pipes")).unwrap();
        assert!(result.status.success());
        assert!(result.stdout.len() >= 200_000);
        assert!(result.stderr.len() >= 200_000);
        assert_eq!(
            output(&mut fixture("failure")).unwrap().status.code(),
            Some(7)
        );
    }

    #[test]
    fn command_times_out_instead_of_waiting_for_child() {
        let start = Instant::now();
        let error =
            output_with_timeout(&mut fixture("sleep"), Duration::from_millis(100)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn completed_command_preserves_detached_helpers() {
        let path =
            std::env::temp_dir().join(format!("swe-factory-helper-{}.pid", uuid::Uuid::new_v4()));
        let done = path.with_extension("pid.done");
        let mut command = fixture("detached");
        command.env("SWE_FACTORY_PROCESS_PID_FILE", &path);
        assert!(output(&mut command).unwrap().status.success());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !done.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let completed = done.exists();
        std::fs::remove_file(path).unwrap();
        if completed {
            std::fs::remove_file(done).unwrap();
        }
        assert!(completed, "A successful command killed its detached helper");
    }

    #[cfg(windows)]
    #[test]
    fn timeout_terminates_descendant_holding_output_pipe() {
        let path =
            std::env::temp_dir().join(format!("swe-factory-timeout-{}.pid", uuid::Uuid::new_v4()));
        let mut command = fixture("descendant");
        command.env("SWE_FACTORY_PROCESS_PID_FILE", &path);
        let error = output_with_timeout(&mut command, Duration::from_secs(2)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let pid: u32 = std::fs::read_to_string(&path).unwrap().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while crate::terminal_sessions::process_is_running(pid).unwrap()
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        let running = crate::terminal_sessions::process_is_running(pid).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(!running, "The timeout left an owned descendant alive");
    }
}
