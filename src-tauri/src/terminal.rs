use crate::ssh::connect_ssh;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Default)]
pub(crate) struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    next_generation: Arc<AtomicU64>,
}

struct TerminalSession {
    generation: u64,
    sender: mpsc::Sender<TerminalInput>,
}

enum TerminalInput {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

enum QueuedTerminalInput {
    Data { data: Vec<u8>, written: usize },
    Resize(u32, u32),
    Close,
}

impl From<TerminalInput> for QueuedTerminalInput {
    fn from(input: TerminalInput) -> Self {
        match input {
            TerminalInput::Data(data) => Self::Data { data, written: 0 },
            TerminalInput::Resize(cols, rows) => Self::Resize(cols, rows),
            TerminalInput::Close => Self::Close,
        }
    }
}

#[derive(Debug, PartialEq)]
enum TerminalWriteProgress {
    Progressed,
    Blocked,
    ControlReady,
    Idle,
}

/// Advances the first queued data message without ever discarding an unwritten
/// suffix. `ssh2::Channel` is non-blocking in terminal sessions, so both a
/// partial write and `WouldBlock` are normal and must be resumed on a later
/// loop iteration. A pending flush is completed before a following resize or
/// close operation, preserving the order in which inputs were submitted.
fn advance_terminal_write<W: Write>(
    writer: &mut W,
    pending: &mut VecDeque<QueuedTerminalInput>,
    flush_pending: &mut bool,
) -> std::io::Result<TerminalWriteProgress> {
    if *flush_pending {
        match writer.flush() {
            Ok(()) => *flush_pending = false,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(TerminalWriteProgress::Blocked);
            }
            Err(error) => return Err(error),
        }
    }

    let Some(front) = pending.front_mut() else {
        return Ok(TerminalWriteProgress::Idle);
    };
    let QueuedTerminalInput::Data { data, written } = front else {
        return Ok(TerminalWriteProgress::ControlReady);
    };

    if *written >= data.len() {
        pending.pop_front();
        return Ok(TerminalWriteProgress::Progressed);
    }

    match writer.write(&data[*written..]) {
        Ok(0) => Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "terminal channel accepted zero input bytes",
        )),
        Ok(size) => {
            *written += size;
            *flush_pending = true;
            if *written == data.len() {
                pending.pop_front();
            }
            Ok(TerminalWriteProgress::Progressed)
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Ok(TerminalWriteProgress::Blocked)
        }
        Err(error) => Err(error),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEvent {
    terminal_id: String,
    generation: u64,
    data: String,
    stream: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    terminal_id: String,
    generation: u64,
    status: String,
    reason: Option<String>,
    retryable: bool,
}

#[derive(Debug, PartialEq)]
enum TerminalExit {
    ClosedByClient,
    RemoteEof,
}

impl TerminalManager {
    fn register(
        &self,
        terminal_id: &str,
        sender: mpsc::Sender<TerminalInput>,
    ) -> Result<Option<u64>, String> {
        let mut sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        if sessions.contains_key(terminal_id) {
            return Ok(None);
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        sessions.insert(
            terminal_id.to_string(),
            TerminalSession { generation, sender },
        );
        Ok(Some(generation))
    }

    fn send(&self, terminal_id: &str, input: TerminalInput) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| "SSH PTY 尚未连接".to_string())?;
        session
            .sender
            .send(input)
            .map_err(|_| "SSH PTY 已断开".to_string())
    }

    fn remove(&self, terminal_id: &str) -> Result<Option<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "终端状态锁异常".to_string())
            .map(|mut sessions| sessions.remove(terminal_id))
    }

    fn remove_generation(&self, terminal_id: &str, generation: u64) -> Result<bool, String> {
        let mut sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        let owns_session = sessions
            .get(terminal_id)
            .is_some_and(|session| session.generation == generation);
        if owns_session {
            sessions.remove(terminal_id);
        }
        Ok(owns_session)
    }

    fn generation(&self, terminal_id: &str) -> Result<Option<u64>, String> {
        self.sessions
            .lock()
            .map_err(|_| "终端状态锁异常".to_string())
            .map(|sessions| sessions.get(terminal_id).map(|session| session.generation))
    }

    fn close(&self, terminal_id: &str) -> Result<(), String> {
        if let Some(session) = self.remove(terminal_id)? {
            let _ = session.sender.send(TerminalInput::Close);
        }
        Ok(())
    }
}

fn emit_terminal_status(
    app: &AppHandle,
    terminal_id: &str,
    generation: u64,
    status: &str,
    reason: Option<String>,
    retryable: bool,
) {
    let _ = app.emit(
        "terminal-status",
        TerminalStatusEvent {
            terminal_id: terminal_id.to_string(),
            generation,
            status: status.to_string(),
            reason,
            retryable,
        },
    );
}

fn is_retryable_terminal_error(error: &str) -> bool {
    !error.contains("身份认证失败") && !error.contains("密码")
}

fn emit_terminal(
    app: &AppHandle,
    terminal_id: &str,
    generation: u64,
    data: impl Into<String>,
    stream: &str,
) {
    let _ = app.emit(
        "terminal-output",
        TerminalEvent {
            terminal_id: terminal_id.to_string(),
            generation,
            data: data.into(),
            stream: stream.to_string(),
        },
    );
}

fn run_terminal_session(
    app: &AppHandle,
    terminal_id: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    cols: u32,
    rows: u32,
    generation: u64,
    receiver: mpsc::Receiver<TerminalInput>,
) -> Result<TerminalExit, String> {
    let session = connect_ssh(host, port, username, password)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建终端通道：{error}"))?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((cols.max(2), rows.max(1), 0, 0)),
        )
        .map_err(|error| format!("无法申请远程 PTY：{error}"))?;
    channel
        .shell()
        .map_err(|error| format!("无法启动远程 Shell：{error}"))?;
    session.set_blocking(false);
    emit_terminal_status(app, terminal_id, generation, "connected", None, false);

    let mut buffer = [0_u8; 8192];
    let mut pending_inputs = VecDeque::<QueuedTerminalInput>::new();
    let mut input_flush_pending = false;
    let mut receiver_disconnected = false;
    loop {
        // Bound each drain so a continuously typing producer cannot starve
        // pending writes or remote output handling.
        for _ in 0..256 {
            if receiver_disconnected {
                break;
            }
            match receiver.try_recv() {
                Ok(input) => pending_inputs.push_back(input.into()),
                Err(mpsc::TryRecvError::Disconnected) => {
                    receiver_disconnected = true;
                    pending_inputs.push_back(QueuedTerminalInput::Close);
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        // Keep Data, Resize, and Close in submission order. A blocked or
        // partial data write remains at the front and is resumed next tick.
        // The work budget keeps terminal output responsive during large pastes.
        for _ in 0..256 {
            match advance_terminal_write(
                &mut channel,
                &mut pending_inputs,
                &mut input_flush_pending,
            ) {
                Ok(TerminalWriteProgress::Progressed) => continue,
                Ok(TerminalWriteProgress::Blocked | TerminalWriteProgress::Idle) => break,
                Ok(TerminalWriteProgress::ControlReady) => match pending_inputs.pop_front() {
                    Some(QueuedTerminalInput::Resize(cols, rows)) => {
                        channel
                            .request_pty_size(cols, rows, None, None)
                            .map_err(|error| format!("终端尺寸调整失败：{error}"))?;
                    }
                    Some(QueuedTerminalInput::Close) => {
                        let _ = channel.close();
                        return Ok(TerminalExit::ClosedByClient);
                    }
                    Some(QueuedTerminalInput::Data { .. }) | None => {
                        unreachable!("terminal input queue changed while processing its front")
                    }
                },
                Err(error) => return Err(format!("终端输入发送失败：{error}")),
            }
        }

        match channel.read(&mut buffer) {
            Ok(size) if size > 0 => emit_terminal(
                app,
                terminal_id,
                generation,
                String::from_utf8_lossy(&buffer[..size]).to_string(),
                "stdout",
            ),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("终端输出读取失败：{error}")),
        }

        match channel.stderr().read(&mut buffer) {
            Ok(size) if size > 0 => emit_terminal(
                app,
                terminal_id,
                generation,
                String::from_utf8_lossy(&buffer[..size]).to_string(),
                "stderr",
            ),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("终端错误输出读取失败：{error}")),
        }

        if channel.eof() {
            return Ok(TerminalExit::RemoteEof);
        }
        thread::sleep(Duration::from_millis(18));
    }
}

#[tauri::command]
pub(crate) fn start_ssh_terminal(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
) -> Result<u64, String> {
    let (sender, receiver) = mpsc::channel();
    let Some(generation) = manager.register(&terminal_id, sender)? else {
        return manager
            .generation(&terminal_id)?
            .ok_or_else(|| "终端会话代次丢失".to_string());
    };
    emit_terminal_status(&app, &terminal_id, generation, "connecting", None, false);

    let app_handle = app.clone();
    let terminal_manager = manager.inner().clone();
    thread::spawn(move || {
        let result = run_terminal_session(
            &app_handle,
            &terminal_id,
            &host,
            port,
            &username,
            &password,
            cols,
            rows,
            generation,
            receiver,
        );
        let cleanup_result = terminal_manager.remove_generation(&terminal_id, generation);
        match result {
            Err(error) => {
                emit_terminal(
                    &app_handle,
                    &terminal_id,
                    generation,
                    format!("\r\n[Opsark] {error}\r\n"),
                    "error",
                );
                let retryable = is_retryable_terminal_error(&error);
                emit_terminal_status(
                    &app_handle,
                    &terminal_id,
                    generation,
                    "error",
                    Some(error),
                    retryable,
                );
            }
            Ok(TerminalExit::RemoteEof) => {
                emit_terminal(
                    &app_handle,
                    &terminal_id,
                    generation,
                    "\r\n[Opsark] 远程 SSH PTY 已断开\r\n",
                    "system",
                );
                emit_terminal_status(
                    &app_handle,
                    &terminal_id,
                    generation,
                    "disconnected",
                    None,
                    true,
                );
            }
            Ok(TerminalExit::ClosedByClient) => {
                emit_terminal(
                    &app_handle,
                    &terminal_id,
                    generation,
                    "\r\n[Opsark] SSH PTY 已关闭\r\n",
                    "system",
                );
                emit_terminal_status(
                    &app_handle,
                    &terminal_id,
                    generation,
                    "disconnected",
                    None,
                    false,
                );
            }
        }
        if let Err(error) = cleanup_result {
            emit_terminal(
                &app_handle,
                &terminal_id,
                generation,
                format!("\r\n[Opsark] {error}\r\n"),
                "error",
            );
        }
    });
    Ok(generation)
}

#[tauri::command]
pub(crate) fn write_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    manager.send(&terminal_id, TerminalInput::Data(data.into_bytes()))
}

#[tauri::command]
pub(crate) fn resize_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    manager.send(&terminal_id, TerminalInput::Resize(cols, rows))
}

#[tauri::command]
pub(crate) fn close_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
) -> Result<(), String> {
    manager.close(&terminal_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    enum WriteAttempt {
        Accept(usize),
        WouldBlock,
    }

    struct ScriptedWriter {
        write_attempts: VecDeque<WriteAttempt>,
        flush_attempts: VecDeque<std::io::Result<()>>,
        accepted: Vec<u8>,
    }

    impl ScriptedWriter {
        fn new(write_attempts: impl IntoIterator<Item = WriteAttempt>) -> Self {
            Self {
                write_attempts: write_attempts.into_iter().collect(),
                flush_attempts: VecDeque::new(),
                accepted: Vec::new(),
            }
        }
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            match self.write_attempts.pop_front() {
                Some(WriteAttempt::Accept(limit)) => {
                    let size = limit.min(buffer.len());
                    self.accepted.extend_from_slice(&buffer[..size]);
                    Ok(size)
                }
                Some(WriteAttempt::WouldBlock) => {
                    Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
                }
                None => {
                    self.accepted.extend_from_slice(buffer);
                    Ok(buffer.len())
                }
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flush_attempts.pop_front().unwrap_or(Ok(()))
        }
    }

    #[test]
    fn keeps_the_first_session_when_registering_a_duplicate_id() {
        let manager = TerminalManager::default();
        let (first_sender, first_receiver) = mpsc::channel();
        let (duplicate_sender, _duplicate_receiver) = mpsc::channel();

        assert!(manager
            .register("terminal-1", first_sender)
            .unwrap()
            .is_some());
        assert!(manager
            .register("terminal-1", duplicate_sender)
            .unwrap()
            .is_none());
        manager
            .send("terminal-1", TerminalInput::Data(b"pwd\n".to_vec()))
            .unwrap();

        match first_receiver.try_recv().unwrap() {
            TerminalInput::Data(data) => assert_eq!(data, b"pwd\n"),
            _ => panic!("首个会话收到了错误的终端消息"),
        }
    }

    #[test]
    fn rejects_writes_and_resizes_for_unknown_sessions() {
        let manager = TerminalManager::default();

        assert_eq!(
            manager
                .send("missing", TerminalInput::Data(Vec::new()))
                .unwrap_err(),
            "SSH PTY 尚未连接"
        );
        assert_eq!(
            manager
                .send("missing", TerminalInput::Resize(120, 32))
                .unwrap_err(),
            "SSH PTY 尚未连接"
        );
    }

    #[test]
    fn retries_network_failures_but_not_authentication_failures() {
        assert!(is_retryable_terminal_error("连接超时"));
        assert!(!is_retryable_terminal_error("SSH 身份认证失败"));
    }

    #[test]
    fn closes_sessions_idempotently_and_removes_the_sender() {
        let manager = TerminalManager::default();
        let (sender, receiver) = mpsc::channel();
        manager.register("terminal-1", sender).unwrap();

        manager.close("terminal-1").unwrap();
        assert!(matches!(receiver.try_recv(), Ok(TerminalInput::Close)));
        manager.close("terminal-1").unwrap();
        assert_eq!(
            manager
                .send("terminal-1", TerminalInput::Data(Vec::new()))
                .unwrap_err(),
            "SSH PTY 尚未连接"
        );
    }

    #[test]
    fn stale_thread_cleanup_does_not_remove_a_reconnected_session() {
        let manager = TerminalManager::default();
        let (first_sender, _first_receiver) = mpsc::channel();
        let first_generation = manager
            .register("terminal-1", first_sender)
            .unwrap()
            .unwrap();
        manager.close("terminal-1").unwrap();

        let (replacement_sender, replacement_receiver) = mpsc::channel();
        manager.register("terminal-1", replacement_sender).unwrap();
        assert!(!manager
            .remove_generation("terminal-1", first_generation)
            .unwrap());

        manager
            .send("terminal-1", TerminalInput::Data(b"whoami\n".to_vec()))
            .unwrap();
        assert!(matches!(
            replacement_receiver.try_recv(),
            Ok(TerminalInput::Data(data)) if data == b"whoami\n"
        ));
    }

    #[test]
    fn reports_disconnected_session_channels() {
        let manager = TerminalManager::default();
        let (sender, receiver) = mpsc::channel();
        manager.register("terminal-1", sender).unwrap();
        drop(receiver);

        assert_eq!(
            manager
                .send("terminal-1", TerminalInput::Resize(80, 24))
                .unwrap_err(),
            "SSH PTY 已断开"
        );
    }

    #[test]
    fn resumes_partial_and_would_block_writes_without_reordering_controls() {
        let mut writer = ScriptedWriter::new([
            WriteAttempt::Accept(2),
            WriteAttempt::WouldBlock,
            WriteAttempt::Accept(4),
            WriteAttempt::Accept(3),
        ]);
        let mut pending = VecDeque::from([
            QueuedTerminalInput::Data {
                data: b"abcdef".to_vec(),
                written: 0,
            },
            QueuedTerminalInput::Resize(120, 40),
            QueuedTerminalInput::Data {
                data: b"ghi".to_vec(),
                written: 0,
            },
            QueuedTerminalInput::Close,
        ]);
        let mut flush_pending = false;

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Progressed
        );
        assert_eq!(writer.accepted, b"ab");
        assert!(matches!(
            pending.front(),
            Some(QueuedTerminalInput::Data { written: 2, .. })
        ));

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Blocked
        );
        assert_eq!(writer.accepted, b"ab");
        assert!(matches!(
            pending.front(),
            Some(QueuedTerminalInput::Data { written: 2, .. })
        ));

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Progressed
        );
        assert_eq!(writer.accepted, b"abcdef");
        assert!(matches!(
            pending.front(),
            Some(QueuedTerminalInput::Resize(120, 40))
        ));

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::ControlReady
        );
        assert!(matches!(
            pending.pop_front(),
            Some(QueuedTerminalInput::Resize(120, 40))
        ));

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Progressed
        );
        assert_eq!(writer.accepted, b"abcdefghi");
        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::ControlReady
        );
        assert!(matches!(pending.front(), Some(QueuedTerminalInput::Close)));
    }

    #[test]
    fn retries_a_blocked_flush_before_allowing_close() {
        let mut writer = ScriptedWriter::new([WriteAttempt::Accept(3)]);
        writer
            .flush_attempts
            .push_back(Err(std::io::Error::from(std::io::ErrorKind::WouldBlock)));
        writer.flush_attempts.push_back(Ok(()));
        let mut pending = VecDeque::from([
            QueuedTerminalInput::Data {
                data: b"bye".to_vec(),
                written: 0,
            },
            QueuedTerminalInput::Close,
        ]);
        let mut flush_pending = false;

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Progressed
        );
        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::Blocked
        );
        assert!(flush_pending);
        assert!(matches!(pending.front(), Some(QueuedTerminalInput::Close)));

        assert_eq!(
            advance_terminal_write(&mut writer, &mut pending, &mut flush_pending).unwrap(),
            TerminalWriteProgress::ControlReady
        );
        assert!(!flush_pending);
        assert_eq!(writer.accepted, b"bye");
    }
}
