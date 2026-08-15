use crate::ssh::connect_ssh;
use serde::Serialize;
use std::collections::HashMap;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEvent {
    terminal_id: String,
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

fn emit_terminal(app: &AppHandle, terminal_id: &str, data: impl Into<String>, stream: &str) {
    let _ = app.emit(
        "terminal-output",
        TerminalEvent {
            terminal_id: terminal_id.to_string(),
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
    generation: u64,
    receiver: mpsc::Receiver<TerminalInput>,
) -> Result<TerminalExit, String> {
    let session = connect_ssh(host, port, username, password)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建终端通道：{error}"))?;
    channel
        .request_pty("xterm-256color", None, Some((120, 32, 0, 0)))
        .map_err(|error| format!("无法申请远程 PTY：{error}"))?;
    channel
        .shell()
        .map_err(|error| format!("无法启动远程 Shell：{error}"))?;
    session.set_blocking(false);
    emit_terminal_status(app, terminal_id, generation, "connected", None, false);
    emit_terminal(
        app,
        terminal_id,
        format!("\r\n[Opsark] 已建立真实 SSH PTY：{username}@{host}\r\n"),
        "system",
    );

    let mut buffer = [0_u8; 8192];
    loop {
        loop {
            match receiver.try_recv() {
                Ok(TerminalInput::Data(data)) => {
                    if let Err(error) = channel.write_all(&data) {
                        if error.kind() != std::io::ErrorKind::WouldBlock {
                            return Err(format!("终端输入发送失败：{error}"));
                        }
                    }
                    let _ = channel.flush();
                }
                Ok(TerminalInput::Resize(cols, rows)) => {
                    channel
                        .request_pty_size(cols, rows, None, None)
                        .map_err(|error| format!("终端尺寸调整失败：{error}"))?;
                }
                Ok(TerminalInput::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = channel.close();
                    return Ok(TerminalExit::ClosedByClient);
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        match channel.read(&mut buffer) {
            Ok(size) if size > 0 => emit_terminal(
                app,
                terminal_id,
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
            generation,
            receiver,
        );
        let cleanup_result = terminal_manager.remove_generation(&terminal_id, generation);
        match result {
            Err(error) => {
                emit_terminal(
                    &app_handle,
                    &terminal_id,
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
}
