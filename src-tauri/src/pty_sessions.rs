//! App-owned Copilot processes with ordered, bounded terminal replay.
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

#[cfg(not(windows))]
use portable_pty::ChildKiller;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::terminal_sessions::{self, StartTerminalSessionRequest, TerminalSessionResult};

const MAX_IN_FLIGHT: usize = 128 * 1024;
const MAX_REPLAY: usize = 2 * 1024 * 1024;
const MAX_CHECKPOINT: usize = 8 * 1024 * 1024;
const MAX_INPUT: usize = 64 * 1024;

fn failure(error: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("Copilot terminal: {error}"))
}

fn valid_size(rows: u16, cols: u16) -> bool {
    (2..=200).contains(&rows) && (2..=400).contains(&cols)
}

/// Checkpoints are accepted only between complete UTF-8 / VT sequences.
/// A serializer cannot preserve a parser's partially received escape sequence.
#[derive(Default)]
struct SequenceTail {
    bytes: Vec<u8>,
    string: bool,
    utf8_remaining: u8,
}

impl SequenceTail {
    fn feed(&mut self, data: &[u8]) -> AppResult<bool> {
        for byte in data {
            self.process(*byte);
            if self.bytes.len() > MAX_INPUT {
                return Err(failure(
                    "unterminated terminal control sequence exceeded 64 KiB",
                ));
            }
        }
        Ok(self.bytes.is_empty())
    }

    fn process(&mut self, byte: u8) {
        if self.utf8_remaining > 0 {
            if byte & 0xc0 == 0x80 {
                self.bytes.push(byte);
                self.utf8_remaining -= 1;
                if self.utf8_remaining == 0 {
                    self.bytes.clear();
                }
                return;
            }
            self.bytes.clear();
            self.utf8_remaining = 0;
        }
        if self.string {
            let terminated = byte == 7 || (byte == b'\\' && self.bytes.last() == Some(&0x1b));
            self.bytes.push(byte);
            if terminated || matches!(byte, 0x18 | 0x1a) {
                self.bytes.clear();
                self.string = false;
            }
            return;
        }
        if byte == 0x1b {
            self.bytes.clear();
            self.bytes.push(byte);
        } else if matches!(byte, 0x18 | 0x1a) {
            self.bytes.clear();
        } else if self.bytes.first() == Some(&0x1b) {
            self.bytes.push(byte);
            if self.bytes.len() == 2 {
                self.string = matches!(byte, b']' | b'P' | b'_' | b'^' | b'X');
                if !self.string && byte != b'[' && !(0x20..=0x2f).contains(&byte) {
                    self.bytes.clear();
                }
            } else if (0x40..=0x7e).contains(&byte) {
                self.bytes.clear();
            }
        } else if byte >= 0xc2 {
            self.utf8_remaining = match byte {
                0xc2..=0xdf => 1,
                0xe0..=0xef => 2,
                0xf0..=0xf4 => 3,
                _ => 0,
            };
            if self.utf8_remaining > 0 {
                self.bytes.push(byte);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    attachment: String,
    generation: String,
    seq: u64,
    reset: bool,
    replay: bool,
    ready: bool,
    checkpointable: bool,
    rows: u16,
    cols: u16,
    data: Vec<u8>,
    ended: bool,
}

#[derive(Clone, Deserialize)]
pub struct Checkpoint {
    data: String,
    rows: u16,
    cols: u16,
}

struct Chunk {
    seq: u64,
    data: Vec<u8>,
    boundary: bool,
    rows: u16,
    cols: u16,
}

struct Subscriber {
    id: String,
    channel: Channel<TerminalOutput>,
    sent: VecDeque<(u64, usize)>,
    bytes: usize,
    next: u64,
    last_sent: u64,
}

struct OutputState {
    journal: VecDeque<Chunk>,
    retained: usize,
    seq: u64,
    consumed: u64,
    checkpoint: Option<(u64, Checkpoint)>,
    tail: SequenceTail,
    rows: u16,
    cols: u16,
    subscriber: Option<Subscriber>,
    stopping: bool,
    ended: bool,
    error: Option<String>,
}

impl OutputState {
    fn new() -> Self {
        Self {
            journal: VecDeque::new(),
            retained: 0,
            seq: 0,
            consumed: 0,
            checkpoint: None,
            tail: SequenceTail::default(),
            rows: 36,
            cols: 110,
            subscriber: None,
            stopping: false,
            ended: false,
            error: None,
        }
    }

    fn append(&mut self, generation: &str, data: &[u8]) -> AppResult<()> {
        let boundary = self.tail.feed(data)?;
        self.seq += 1;
        self.retained += data.len().max(1);
        self.journal.push_back(Chunk {
            seq: self.seq,
            data: data.to_vec(),
            boundary,
            rows: self.rows,
            cols: self.cols,
        });
        self.pump(generation);
        Ok(())
    }

    fn send(&mut self, message: TerminalOutput) {
        if let Some(subscriber) = &mut self.subscriber {
            let len = message.data.len().max(1);
            let seq = message.seq;
            if subscriber.channel.send(message).is_err() {
                self.subscriber = None;
                return;
            }
            subscriber.sent.push_back((seq, len));
            subscriber.bytes += len;
            subscriber.last_sent = seq;
        }
    }

    fn pump(&mut self, generation: &str) {
        loop {
            let Some(subscriber) = &self.subscriber else {
                return;
            };
            if subscriber.bytes >= MAX_IN_FLIGHT {
                return;
            }
            let Some(chunk) = self
                .journal
                .iter()
                .find(|chunk| chunk.seq >= subscriber.next)
            else {
                return;
            };
            let message = TerminalOutput {
                attachment: subscriber.id.clone(),
                generation: generation.into(),
                seq: chunk.seq,
                reset: false,
                replay: chunk.seq <= self.consumed,
                ready: chunk.seq == self.seq,
                checkpointable: chunk.boundary,
                rows: chunk.rows,
                cols: chunk.cols,
                data: chunk.data.clone(),
                ended: self.ended,
            };
            if let Some(subscriber) = &mut self.subscriber {
                subscriber.next = chunk.seq + 1;
            }
            self.send(message);
        }
    }

    fn attach(&mut self, generation: &str, id: String, channel: Channel<TerminalOutput>) {
        let (seq, checkpoint) = self.checkpoint.clone().unwrap_or((
            0,
            Checkpoint {
                data: "\x1bc".into(),
                rows: 36,
                cols: 110,
            },
        ));
        self.subscriber = Some(Subscriber {
            id: id.clone(),
            channel,
            sent: VecDeque::new(),
            bytes: 0,
            next: seq + 1,
            last_sent: seq,
        });
        self.send(TerminalOutput {
            attachment: id,
            generation: generation.into(),
            seq,
            reset: true,
            replay: true,
            ready: seq == self.seq,
            checkpointable: false,
            rows: checkpoint.rows,
            cols: checkpoint.cols,
            data: checkpoint.data.into_bytes(),
            ended: self.ended,
        });
        self.pump(generation);
    }

    fn acknowledge(
        &mut self,
        generation: &str,
        attachment: &str,
        seq: u64,
        checkpoint: Option<Checkpoint>,
    ) -> AppResult<()> {
        let checkpoint = checkpoint.filter(|_| {
            self.checkpoint
                .as_ref()
                .is_none_or(|(current, _)| seq > *current)
        });
        let Some(subscriber) = &mut self.subscriber else {
            return Ok(());
        };
        if subscriber.id != attachment {
            return Ok(());
        }
        if seq > subscriber.last_sent {
            return Err(failure("invalid terminal acknowledgement"));
        }
        if let Some(checkpoint) = &checkpoint {
            if checkpoint.data.len() > MAX_CHECKPOINT
                || !valid_size(checkpoint.rows, checkpoint.cols)
            {
                return Err(failure("terminal checkpoint is out of bounds"));
            }
            if !self
                .journal
                .iter()
                .any(|chunk| chunk.seq == seq && chunk.boundary)
            {
                return Err(failure(
                    "terminal checkpoint is not at a complete output boundary",
                ));
            }
        }
        while subscriber
            .sent
            .front()
            .is_some_and(|(sent, _)| *sent <= seq)
        {
            if let Some((_, len)) = subscriber.sent.pop_front() {
                subscriber.bytes -= len;
            }
        }
        self.consumed = self.consumed.max(seq);
        if let Some(checkpoint) = checkpoint {
            if self
                .checkpoint
                .as_ref()
                .is_none_or(|(current, _)| seq > *current)
            {
                self.checkpoint = Some((seq, checkpoint));
                while self.journal.front().is_some_and(|chunk| chunk.seq <= seq) {
                    if let Some(chunk) = self.journal.pop_front() {
                        self.retained -= chunk.data.len().max(1);
                    }
                }
            }
        }
        self.pump(generation);
        Ok(())
    }
}

struct PtySession {
    generation: String,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[cfg(not(windows))]
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<OutputState>,
    capacity: Condvar,
    #[cfg(windows)]
    job: WindowsJob,
}

impl PtySession {
    fn stop(&self) -> AppResult<()> {
        self.output.lock().map_err(failure)?.stopping = true;
        self.capacity.notify_all();
        #[cfg(windows)]
        self.job.terminate()?;
        #[cfg(not(windows))]
        self.killer.lock().map_err(failure)?.kill()?;
        Ok(())
    }

    fn output_failed(&self, error: String) {
        if let Ok(mut output) = self.output.lock() {
            output.error = Some(error);
        }
        if let Err(error) = self.stop() {
            eprintln!("[terminal] stop failed: {error}");
        }
    }
}

#[derive(Default)]
pub struct PtySessionManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    launching: Mutex<HashSet<String>>,
}

impl PtySessionManager {
    fn get(&self, id: &str, generation: &str) -> AppResult<Arc<PtySession>> {
        let sessions = self.sessions.lock().map_err(failure)?;
        let session = sessions
            .get(id)
            .ok_or_else(|| failure("session is disconnected"))?;
        if session.generation != generation {
            return Err(failure("this terminal belongs to an older process"));
        }
        Ok(session.clone())
    }

    pub fn shutdown(&self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                if let Err(error) = session.stop() {
                    eprintln!("[terminal] shutdown failed: {error}");
                }
            }
        }
    }

    pub fn stop_session(&self, id: &str) -> AppResult<()> {
        let session = self.sessions.lock().map_err(failure)?.get(id).cloned();
        if let Some(session) = session {
            session.stop()?;
        }
        Ok(())
    }
}

fn command(req: &StartTerminalSessionRequest, id: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("copilot");
    cmd.cwd(&req.folder_path);
    cmd.env("TERM", "xterm-256color");
    // Do not inherit the parent agent/loader role if DevTrees was launched by Copilot.
    // Keep authentication and user permission settings unchanged.
    for key in [
        "COPILOT_AGENT_SESSION_ID",
        "COPILOT_LOADER_PID",
        "COPILOT_CLI",
    ] {
        cmd.env_remove(key);
    }
    cmd.arg("--session-id");
    cmd.arg(id);
    if req.resume_session_id.is_none() {
        if let Some(prompt) = req
            .prompt
            .as_ref()
            .filter(|prompt| !prompt.trim().is_empty())
        {
            cmd.arg("-i");
            cmd.arg(prompt);
        }
    }
    cmd
}

pub fn start(app: AppHandle, req: StartTerminalSessionRequest) -> AppResult<TerminalSessionResult> {
    if !std::path::Path::new(&req.folder_path).is_dir() {
        return Err(failure("the working directory does not exist"));
    }
    let id = match req.resume_session_id.as_deref() {
        Some(id) => uuid::Uuid::parse_str(id).map_err(failure)?.to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let manager = app.state::<PtySessionManager>();
    if manager.sessions.lock().map_err(failure)?.contains_key(&id) {
        return Err(failure("this session is already running"));
    }
    if !manager
        .launching
        .lock()
        .map_err(failure)?
        .insert(id.clone())
    {
        return Err(failure("this session is already starting"));
    }
    let result = start_reserved(&app, &req, &id);
    manager.launching.lock().map_err(failure)?.remove(&id);
    result
}

fn start_reserved(
    app: &AppHandle,
    req: &StartTerminalSessionRequest,
    id: &str,
) -> AppResult<TerminalSessionResult> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 36,
            cols: 110,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(failure)?;
    let mut reader = pair.master.try_clone_reader().map_err(failure)?;
    let writer = pair.master.take_writer().map_err(failure)?;
    let generation = uuid::Uuid::new_v4().to_string();
    let result = terminal_sessions::watch_pty_session(app, req, id, &generation)?;
    let mut child = match pair.slave.spawn_command(command(req, id)) {
        Ok(child) => child,
        Err(error) => {
            terminal_sessions::pty_exited(app, id, &generation, Err(error.to_string()));
            return Err(failure(error));
        }
    };
    drop(pair.slave);
    #[cfg(windows)]
    let job = match WindowsJob::assign(child.as_raw_handle()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            terminal_sessions::pty_exited(app, id, &generation, Err(error.to_string()));
            return Err(error);
        }
    };
    let session = Arc::new(PtySession {
        generation,
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        #[cfg(not(windows))]
        killer: Mutex::new(child.clone_killer()),
        output: Mutex::new(OutputState::new()),
        capacity: Condvar::new(),
        #[cfg(windows)]
        job,
    });
    match app.state::<PtySessionManager>().sessions.lock() {
        Ok(mut sessions) => {
            sessions.insert(id.to_string(), session.clone());
        }
        Err(error) => {
            let message = error.to_string();
            if let Err(error) = session.stop() {
                eprintln!("[terminal] launch cleanup failed: {error}");
                let _ = child.kill();
            }
            let _ = child.wait();
            terminal_sessions::pty_exited(app, id, &session.generation, Err(message.clone()));
            return Err(failure(message));
        }
    }
    let reader_session = session.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0; 8192];
        loop {
            // A disconnected renderer can consume bounded replay space, then applies
            // backpressure. Reattachment/ack or explicit stop always wakes this reader.
            let capacity = (|| -> AppResult<bool> {
                let mut output = reader_session.output.lock().map_err(failure)?;
                while output.retained >= MAX_REPLAY && !output.stopping {
                    output = reader_session.capacity.wait(output).map_err(failure)?;
                }
                Ok(!output.stopping)
            })();
            match capacity {
                Ok(false) => break,
                Err(error) => {
                    reader_session.output_failed(error.to_string());
                    break;
                }
                Ok(true) => {}
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let result =
                        reader_session
                            .output
                            .lock()
                            .map_err(failure)
                            .and_then(|mut output| {
                                output.append(&reader_session.generation, &buf[..n])
                            });
                    if let Err(error) = result {
                        reader_session.output_failed(error.to_string());
                        break;
                    }
                }
                Err(error) => {
                    reader_session.output_failed(error.to_string());
                    break;
                }
            }
        }
    });
    let exit_app = app.clone();
    let exit_id = id.to_string();
    std::thread::spawn(move || {
        let mut exit = child
            .wait()
            .map(|status| status.exit_code())
            .map_err(|error| error.to_string());
        if let Err(error) = session.stop() {
            eprintln!("[terminal] process cleanup failed: {error}");
        }
        if let Ok(mut writer) = session.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = session.master.lock() {
            master.take();
        }
        if reader_thread.join().is_err() {
            exit = Err("Terminal output reader panicked".into());
        }
        if let Ok(mut output) = session.output.lock() {
            output.ended = true;
            if let Some(error) = output.error.take() {
                exit = Err(error);
            }
            if let Err(error) = output.append(&session.generation, &[]) {
                exit = Err(error.to_string());
            }
        }
        terminal_sessions::pty_exited(&exit_app, &exit_id, &session.generation, exit);
        if let Ok(mut sessions) = exit_app.state::<PtySessionManager>().sessions.lock() {
            if sessions
                .get(&exit_id)
                .is_some_and(|current| current.generation == session.generation)
            {
                sessions.remove(&exit_id);
            }
        }
    });
    Ok(result)
}

#[derive(Deserialize)]
pub struct TerminalTarget {
    id: String,
    generation: String,
}

#[tauri::command]
pub fn pty_attach(
    app: AppHandle,
    target: TerminalTarget,
    attachment: String,
    channel: Channel<TerminalOutput>,
) -> AppResult<()> {
    let session = app
        .state::<PtySessionManager>()
        .get(&target.id, &target.generation)?;
    session
        .output
        .lock()
        .map_err(failure)?
        .attach(&session.generation, attachment, channel);
    Ok(())
}

#[tauri::command]
pub fn pty_ack(
    app: AppHandle,
    target: TerminalTarget,
    attachment: String,
    seq: u64,
    checkpoint: Option<Checkpoint>,
) -> AppResult<()> {
    let session = app
        .state::<PtySessionManager>()
        .get(&target.id, &target.generation)?;
    session.output.lock().map_err(failure)?.acknowledge(
        &session.generation,
        &attachment,
        seq,
        checkpoint,
    )?;
    session.capacity.notify_all();
    Ok(())
}

#[tauri::command]
pub fn pty_detach(app: AppHandle, target: TerminalTarget, attachment: String) -> AppResult<()> {
    let session = app
        .state::<PtySessionManager>()
        .get(&target.id, &target.generation)?;
    let mut output = session.output.lock().map_err(failure)?;
    if output
        .subscriber
        .as_ref()
        .is_some_and(|current| current.id == attachment)
    {
        output.subscriber = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_write(app: AppHandle, target: TerminalTarget, data: Vec<u8>) -> AppResult<()> {
    if data.len() > MAX_INPUT {
        return Err(failure("input exceeds 64 KiB; paste a smaller selection"));
    }
    let session = app
        .state::<PtySessionManager>()
        .get(&target.id, &target.generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        if session.output.lock().map_err(failure)?.stopping {
            return Err(failure("session is ending"));
        }
        let mut writer = session.writer.lock().map_err(failure)?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| failure("session has ended"))?;
        writer.write_all(&data)?;
        writer.flush()?;
        Ok(())
    })
    .await
    .map_err(failure)?
}

#[tauri::command]
pub async fn pty_resize(
    app: AppHandle,
    target: TerminalTarget,
    rows: u16,
    cols: u16,
) -> AppResult<()> {
    if !valid_size(rows, cols) {
        return Err(failure("terminal dimensions are out of range"));
    }
    let session = app
        .state::<PtySessionManager>()
        .get(&target.id, &target.generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        {
            let mut output = session.output.lock().map_err(failure)?;
            if output.stopping {
                return Err(failure("session is ending"));
            }
            if output.rows == rows && output.cols == cols {
                return Ok(());
            }
            output.rows = rows;
            output.cols = cols;
            output.append(&session.generation, &[])?;
        }
        let master = session.master.lock().map_err(failure)?;
        let master = master
            .as_ref()
            .ok_or_else(|| failure("session has ended"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(failure)
    })
    .await
    .map_err(failure)?
}

#[tauri::command]
pub fn pty_stop(app: AppHandle, target: TerminalTarget) -> AppResult<()> {
    app.state::<PtySessionManager>()
        .get(&target.id, &target.generation)?
        .stop()
}

pub async fn stop_and_wait(app: &AppHandle, id: &str, generation: &str) -> AppResult<()> {
    app.state::<PtySessionManager>()
        .get(id, generation)?
        .stop()?;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            {
                let manager = app.state::<PtySessionManager>();
                let sessions = manager.sessions.lock().map_err(failure)?;
                match sessions.get(id) {
                    None => return Ok(()),
                    Some(session) if session.generation != generation => {
                        return Err(failure("The terminal owner changed during shutdown."));
                    }
                    _ => {}
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| failure("The terminal has not released this session. Wait before resuming."))?
}

#[cfg(windows)]
struct WindowsJob(winapi::um::winnt::HANDLE);
// The handle remains open for the owner's lifetime; Windows synchronizes job operations.
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(process: Option<std::os::windows::io::RawHandle>) -> AppResult<Self> {
        use winapi::um::{handleapi::CloseHandle, jobapi2::*, winnt::*};
        let process = process.ok_or_else(|| failure("missing child process handle"))?;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as _,
                std::mem::size_of_val(&limits) as _,
            ) == 0
                || AssignProcessToJobObject(handle, process as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error.into());
            }
            Ok(Self(handle))
        }
    }

    fn terminate(&self) -> AppResult<()> {
        if unsafe { winapi::um::jobapi2::TerminateJobObject(self.0, 1) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            winapi::um::handleapi::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_boundaries_preserve_split_utf8_csi_and_osc() {
        for sequence in [
            "\u{20ac}",
            "\x1b[31m",
            "\x1b]0;title\x07",
            "\x1bPcontent\x1b\\",
        ] {
            let mut tail = SequenceTail::default();
            let bytes = sequence.as_bytes();
            for byte in &bytes[..bytes.len() - 1] {
                assert!(!tail.feed(&[*byte]).unwrap());
            }
            assert!(tail.feed(&bytes[bytes.len() - 1..]).unwrap());
        }
    }

    #[test]
    fn slow_consumers_have_bounded_in_flight_data_and_lossless_replay() {
        let mut output = OutputState::new();
        output.attach("g", "a".into(), Channel::new(|_| Ok(())));
        for _ in 0..40 {
            output.append("g", &vec![b'x'; 8192]).unwrap();
        }
        let subscriber = output.subscriber.as_ref().unwrap();
        assert!(subscriber.bytes <= MAX_IN_FLIGHT + 8192);
        let sent = subscriber.last_sent;
        assert!(sent < output.seq);
        output
            .acknowledge(
                "g",
                "a",
                sent,
                Some(Checkpoint {
                    data: "screen".into(),
                    rows: 36,
                    cols: 110,
                }),
            )
            .unwrap();
        assert!(output.journal.front().unwrap().seq > sent);
        assert!(output.subscriber.as_ref().unwrap().last_sent > sent);
        output.attach("g", "b".into(), Channel::new(|_| Ok(())));
        assert_eq!(output.checkpoint.as_ref().unwrap().0, sent);
        assert!(output.subscriber.as_ref().unwrap().next > sent);
    }

    #[test]
    fn stale_acks_and_partial_sequence_checkpoints_do_not_trim_replay() {
        let mut output = OutputState::new();
        output.attach("g", "new".into(), Channel::new(|_| Ok(())));
        output.append("g", b"\x1b[").unwrap();
        let snapshot = || {
            Some(Checkpoint {
                data: "bad".into(),
                rows: 36,
                cols: 110,
            })
        };
        output.acknowledge("g", "old", 1, snapshot()).unwrap();
        assert!(output.checkpoint.is_none());
        assert!(output.acknowledge("g", "new", 1, snapshot()).is_err());
        assert_eq!(output.retained, 2);
        output.append("g", b"6n").unwrap();
        output.acknowledge("g", "new", 2, None).unwrap();
        assert_eq!(output.retained, 4);
    }

    #[test]
    fn incomplete_control_strings_are_bounded() {
        let mut tail = SequenceTail::default();
        tail.feed(b"\x1b]").unwrap();
        assert!(tail.feed(&vec![b'x'; MAX_INPUT]).is_err());
    }

    #[test]
    fn launch_preserves_prompt_as_one_argument_without_auto_approval() {
        let prompt = "quotes \"hello\" & stuff\nsecond line";
        let request = StartTerminalSessionRequest {
            folder_path: ".".into(),
            prompt: Some(prompt.into()),
            resume_session_id: None,
            label: "test".into(),
            task_id: None,
            repository: None,
            branch: None,
            transport: None,
        };
        let cmd = command(&request, "test-id");
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, ["copilot", "--session-id", "test-id", "-i", prompt]);
    }

    /// Explicit opt-in: uses the installed/authenticated CLI, not a mock or user session.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires an authenticated Copilot CLI and DEVTREES_PTY_FIXTURE_DIR"]
    fn native_cli_question_and_permission_fixture() {
        use std::time::{Duration, Instant};
        let folder = std::env::var("DEVTREES_PTY_FIXTURE_DIR").expect("fixture directory required");
        assert!(std::path::Path::new(&folder).is_dir());
        let id = uuid::Uuid::new_v4().to_string();
        let request = StartTerminalSessionRequest {
            folder_path: folder,
            prompt: Some("This is an isolated terminal integration test. First use ask_user to ask 'Choose a fixture' with exactly two choices alpha and beta. After I answer, use powershell to create ONLY a new file pty-permission-marker.txt containing fixture-ok in the current directory. Do not read any files, run other tools, or access any network. If permission is rejected, say rejected and stop.".into()),
            resume_session_id: None, label: "PTY fixture".into(),
            task_id: None, repository: None, branch: None,
            transport: None,
        };
        let mut cmd = command(&request, &id);
        cmd.args(["--model", "gpt-5.4-mini", "--disable-builtin-mcps"]);
        for name in [
            "github-mcp-server",
            "azure-devops",
            "computer-use",
            "microsoft-learn",
            "workiq",
        ] {
            cmd.args(["--disable-mcp-server", name]);
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 36,
                cols: 110,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let job = WindowsJob::assign(child.as_raw_handle()).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 || send.send(bytes[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let log = dirs::home_dir()
            .unwrap()
            .join(".copilot")
            .join("session-state")
            .join(&id)
            .join("events.jsonl");
        println!("fixture session: {id}");
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut screen = String::new();
        let mut query_cursor = 0;
        let mut answered = false;
        let mut rejected = false;
        let mut question_completed = false;
        let mut permission_completed = false;
        let mut permission_at = None;
        let mut question_at = None;
        let mut question_id = None;
        let mut permission_id = None;
        let mut events_seen = 0;
        let mut observed = Vec::new();
        while Instant::now() < deadline && !permission_completed {
            if let Ok(bytes) = receive.recv_timeout(Duration::from_millis(100)) {
                screen.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(index) = screen[query_cursor..].find("\x1b[6n") {
                    query_cursor += index + 4;
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    writer.flush().unwrap();
                }
            }
            let contents = match std::fs::read_to_string(&log) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!("{error}"),
            };
            let events: Vec<serde_json::Value> = contents
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            for event in events.iter().skip(events_seen) {
                let kind = event["type"].as_str().unwrap_or("");
                observed.push(kind.to_string());
                if kind == "tool.execution_start" && event["data"]["toolName"] == "ask_user" {
                    question_at = Some(Instant::now());
                    question_id = event["data"]["toolCallId"].as_str().map(str::to_string);
                }
                if kind == "tool.execution_complete"
                    && answered
                    && event["data"]["toolCallId"].as_str() == question_id.as_deref()
                {
                    question_completed = true;
                }
                if kind == "permission.requested" {
                    permission_at = Some(Instant::now());
                    permission_id = event["data"]["requestId"].as_str().map(str::to_string);
                    println!("permission fixture: {}", event["data"]);
                }
                if kind == "permission.completed"
                    && event["data"]["requestId"].as_str() == permission_id.as_deref()
                {
                    permission_completed = true;
                    println!("permission completion: {}", event["data"]);
                }
            }
            if question_at.is_some_and(|at| at.elapsed() > Duration::from_secs(2))
                && !answered
                && screen.contains("accept")
            {
                writer.write_all(b"\r").unwrap();
                writer.flush().unwrap();
                answered = true;
            }
            if permission_at.is_some_and(|at| at.elapsed() > Duration::from_secs(2)) && !rejected {
                writer.write_all(b"\x1b").unwrap();
                writer.flush().unwrap();
                rejected = true;
            }
            events_seen = events.len();
        }
        job.terminate().unwrap();
        child.wait().unwrap();
        std::fs::write(
            std::path::Path::new(&request.folder_path).join("screen.vt"),
            &screen,
        )
        .unwrap();
        assert!(
            answered && question_completed,
            "native question was not answered: {observed:?}"
        );
        assert!(
            rejected && permission_completed,
            "native permission events missing: {observed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn owned_job_terminates_the_child_and_its_descendant() {
        use std::io::{BufRead, BufReader};
        use std::os::windows::io::AsRawHandle;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        const PHASE: &str = "DEVTREES_PTY_JOB_TEST_PHASE";
        if let Ok(phase) = std::env::var(PHASE) {
            if phase == "child" {
                let mut signal = [0];
                std::io::stdin().read_exact(&mut signal).unwrap();
                let mut command = Command::new(std::env::current_exe().unwrap());
                command
                    .args([
                        "--exact",
                        "pty_sessions::tests::owned_job_terminates_the_child_and_its_descendant",
                    ])
                    .env(PHASE, "descendant")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                crate::terminal_sessions::configure_no_window(&mut command);
                let mut descendant = command.spawn().unwrap();
                println!("descendant-ready");
                std::io::stdout().flush().unwrap();
                descendant.wait().unwrap();
            } else {
                std::thread::sleep(Duration::from_secs(60));
            }
            return;
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "pty_sessions::tests::owned_job_terminates_the_child_and_its_descendant",
                "--nocapture",
            ])
            .env(PHASE, "child")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::terminal_sessions::configure_no_window(&mut command);
        let mut child = command.spawn().unwrap();
        let job = WindowsJob::assign(Some(child.as_raw_handle())).unwrap();
        child.stdin.take().unwrap().write_all(b"go").unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let (ready, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                if line.contains("descendant-ready") {
                    let _ = ready.send(());
                    break;
                }
                line.clear();
            }
        });
        received
            .recv_timeout(Duration::from_secs(5))
            .expect("descendant did not start");
        job.terminate().unwrap();
        child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut accounting: winapi::um::winnt::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    winapi::um::jobapi2::QueryInformationJobObject(
                        job.0,
                        winapi::um::winnt::JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as _,
                        std::mem::size_of_val(&accounting) as _,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            if accounting.ActiveProcesses == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned descendant survived termination"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
