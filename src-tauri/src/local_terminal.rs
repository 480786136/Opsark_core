use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex}};
use tauri::{ipc::Channel, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}
impl Drop for Session {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
#[derive(Default)]
pub struct LocalTerminalManager(Arc<Mutex<HashMap<String, Session>>>);
#[derive(Clone, serde::Serialize)]
pub struct Output { data: Vec<u8>, ended: bool }
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(1, 500), cols: cols.clamp(1, 1000), pixel_width: 0, pixel_height: 0 }
}
#[tauri::command]
pub fn open_local_terminal(state: State<LocalTerminalManager>, id: String, cols: u16, rows: u16, output: Channel<Output>) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(&id) || sessions.len() >= 4 { return Err("Local terminal already open or limit reached".into()); }
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let shell = "powershell.exe".to_string();
    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or("/bin/zsh".into());
    let mut command = CommandBuilder::new(shell);
    #[cfg(windows)]
    command.arg("-NoLogo");
    #[cfg(not(windows))]
    command.arg("-l");
    command.env("TERM", "xterm-256color");
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) { command.cwd(home); }
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    sessions.insert(id.clone(), Session { master: pair.master, writer, child });
    let manager = Arc::downgrade(&state.0);
    let monitor = manager.clone();
    let monitor_id = id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let Some(manager) = monitor.upgrade() else { break; };
        let removed = {
            let Ok(mut sessions) = manager.lock() else { break; };
            let Some(session) = sessions.get_mut(&monitor_id) else { break; };
            if !matches!(session.child.try_wait(), Ok(None)) { sessions.remove(&monitor_id) } else { None }
        };
        if removed.is_some() { drop(removed); break; }
    });
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => { let _ = output.send(Output { data: buffer[..count].to_vec(), ended: false }); },
            }
        }
        if let Some(manager) = manager.upgrade() {
            let removed = manager.lock().ok().and_then(|mut sessions| sessions.remove(&id));
            // Closing ConPTY may emit final output. Keep this reader draining
            // while another thread drops the master handle.
            if let Some(session) = removed { std::thread::spawn(move || drop(session)); }
        }
        let _ = output.send(Output { data: vec![], ended: true });
    });
    Ok(())
}
#[tauri::command]
pub fn write_local_terminal(state: State<LocalTerminalManager>, id: String, data: String) -> Result<(), String> {
    if data.len() > 1_048_576 { return Err("Terminal input too large".into()); }
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Local terminal closed")?;
    session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resize_local_terminal(state: State<LocalTerminalManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    sessions.get(&id).ok_or("Local terminal closed")?.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn close_local_terminal(state: State<LocalTerminalManager>, id: String) -> Result<(), String> {
    let removed = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    drop(removed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_pty_executes_a_real_shell_and_resizes() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        #[cfg(windows)]
        let mut command = CommandBuilder::new("cmd.exe");
        #[cfg(windows)]
        command.args(["/d", "/c", "echo OPSARK_LOCAL_PTY_OK"]);
        #[cfg(not(windows))]
        let mut command = CommandBuilder::new("/bin/sh");
        #[cfg(not(windows))]
        command.args(["-c", "printf OPSARK_LOCAL_PTY_OK"]);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        // Emulate xterm's initial cursor-position response for Windows ConPTY.
        #[cfg(windows)]
        writer.write_all(b"\x1b[1;1R").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            let mut output = String::new();
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 { break; }
                output.push_str(&String::from_utf8_lossy(&bytes[..count]));
                if output.contains("OPSARK_LOCAL_PTY_OK") { let _ = tx.send(output.clone()); }
            }
            let _ = tx.send(output);
        });
        pair.master.resize(size(100, 30)).unwrap();
        assert_eq!(pair.master.get_size().unwrap().cols, 100);
        let result = rx.recv_timeout(std::time::Duration::from_secs(10));
        let _ = child.kill(); let _ = child.wait();
        assert!(result.unwrap().contains("OPSARK_LOCAL_PTY_OK"));
    }
}
