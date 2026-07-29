use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    os: String,
    kernel: String,
    cpu: String,
    cores: u8,
    memory_gb: u16,
    disk_gb: u16,
    uptime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    cpu: u8,
    memory: u8,
    disk: u8,
    network_in: f32,
    network_out: f32,
    sampled_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStep {
    id: String,
    title: String,
    description: String,
    command: String,
    risk: String,
    expected: String,
    validation: String,
    status: String,
    output: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    output: String,
    success: bool,
    simulated: bool,
    exit_code: i32,
    empty_result: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ValidationResult {
    passed: bool,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProbe {
    info: ServerInfo,
    environment: Vec<String>,
    hostname: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileEntry {
    name: String,
    path: String,
    kind: String,
    size: String,
    modified: String,
}

#[derive(Default)]
struct TerminalManager {
    sessions: Mutex<HashMap<String, mpsc::Sender<TerminalInput>>>,
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

static METRIC_SAMPLES: OnceLock<Mutex<HashMap<String, (f64, f64, Instant)>>> = OnceLock::new();
const KEYCHAIN_SERVICE: &str = "com.opsark.desktop";

#[derive(Debug, Deserialize)]
struct AiPlanStep {
    title: String,
    description: String,
    command: String,
    expected: String,
    validation: String,
    risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStepReview {
    decision: String,
    reason: String,
    summary: String,
}

#[derive(Debug, Clone, Serialize)]
struct ModelCheckResult {
    available: bool,
    reason: String,
}

fn connect_ssh(host: &str, port: u16, username: &str, password: &str) -> Result<Session, String> {
    let address = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| format!("无法解析服务器地址：{error}"))?
        .next()
        .ok_or_else(|| "服务器地址没有可用解析结果".to_string())?;
    let tcp = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(10))
        .map_err(|error| format!("SSH 网络连接失败：{error}"))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(20)))
        .ok();
    let mut session = Session::new().map_err(|error| format!("SSH 会话创建失败：{error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;
    session
        .userauth_password(username, password)
        .map_err(|_| "SSH 用户名或密码不正确".to_string())?;
    if !session.authenticated() {
        return Err("SSH 身份认证失败".into());
    }
    Ok(session)
}

fn ssh_exec(session: &Session, command: &str) -> Result<(String, i32), String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|error| error.to_string())?;
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| error.to_string())?;
    channel.wait_close().map_err(|error| error.to_string())?;
    let status = channel.exit_status().unwrap_or(1);
    if !stderr.trim().is_empty() {
        stdout.push_str("\n");
        stdout.push_str(stderr.trim());
    }
    Ok((stdout.trim().to_string(), status))
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

fn clean_json_content(content: &str) -> &str {
    let trimmed = content.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
}

fn repair_invalid_json_escapes(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mut repaired = String::with_capacity(content.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if !in_string {
            repaired.push(current);
            if current == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }
        if current == '"' {
            repaired.push(current);
            in_string = false;
            index += 1;
            continue;
        }
        if current == '\\' {
            let next = chars.get(index + 1).copied();
            if next.is_some_and(|value| {
                matches!(value, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u')
            }) {
                repaired.push(current);
            } else {
                repaired.push('\\');
                repaired.push('\\');
            }
            index += 1;
            continue;
        }
        repaired.push(current);
        index += 1;
    }
    repaired
}

fn parse_ai_plan_steps(content: &str) -> Result<Vec<AiPlanStep>, serde_json::Error> {
    serde_json::from_str(content).or_else(|_| {
        let object: Value = serde_json::from_str(content)?;
        serde_json::from_value(object.get("steps").cloned().unwrap_or(Value::Null))
    })
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn credential_account(kind: &str, id: &str) -> Result<String, String> {
    if !matches!(kind, "server" | "model") {
        return Err("不支持的凭据类型".into());
    }
    if id.trim().is_empty() || id.len() > 160 {
        return Err("凭据标识无效".into());
    }
    Ok(format!("{kind}:{}", id.trim()))
}

fn credential_entry(kind: &str, id: &str) -> Result<keyring::Entry, String> {
    let account = credential_account(kind, id)?;
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

#[tauri::command(async)]
fn save_credential(kind: String, id: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return delete_credential(kind, id);
    }
    credential_entry(&kind, &id)?
        .set_password(&value)
        .map_err(|error| format!("保存系统凭据失败：{error}"))
}

#[tauri::command(async)]
fn load_credential(kind: String, id: String) -> Result<Option<String>, String> {
    match credential_entry(&kind, &id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取系统凭据失败：{error}")),
    }
}

#[tauri::command(async)]
fn delete_credential(kind: String, id: String) -> Result<(), String> {
    match credential_entry(&kind, &id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除系统凭据失败：{error}")),
    }
}

fn risk_for(command: &str) -> &'static str {
    let lower = command.to_lowercase();
    if ["rm -rf", "mkfs", "fdisk", "userdel", "drop table"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        "high"
    } else if [
        "install",
        "restart",
        "reload",
        "chmod",
        "chown",
        "apt ",
        "docker run",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "medium"
    } else {
        "low"
    }
}

fn is_valid_empty_result(command: &str, status: i32, output: &str) -> bool {
    if status != 1 || !output.trim().is_empty() {
        return false;
    }
    let lower = command.to_lowercase();
    lower.contains("grep ") || lower.contains("grep -") || lower.contains("pgrep ")
}

fn step(
    index: usize,
    title: &str,
    description: &str,
    command: &str,
    expected: &str,
    validation: &str,
) -> PlanStep {
    PlanStep {
        id: format!("step-{}-{}", unix_seconds(), index),
        title: title.into(),
        description: description.into(),
        command: command.into(),
        risk: risk_for(command).into(),
        expected: expected.into(),
        validation: validation.into(),
        status: "pending".into(),
        output: None,
    }
}

#[tauri::command]
fn collect_server_info() -> ServerInfo {
    ServerInfo {
        os: "Ubuntu 24.04 LTS".into(),
        kernel: "6.8.0-44-generic".into(),
        cpu: "Intel Xeon Gold 6338N".into(),
        cores: 8,
        memory_gb: 16,
        disk_gb: 160,
        uptime: "16 天 4 小时".into(),
    }
}

#[tauri::command]
fn get_realtime_metrics() -> Metrics {
    let tick = unix_seconds();
    Metrics {
        cpu: 22 + (tick % 26) as u8,
        memory: 49 + (tick % 11) as u8,
        disk: 68,
        network_in: 2.4 + (tick % 70) as f32 / 10.0,
        network_out: 0.8 + (tick % 28) as f32 / 10.0,
        sampled_at: format!("{}", tick),
    }
}

#[tauri::command(async)]
fn probe_ssh_server(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<SshProbe, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let (raw, status) = ssh_exec(
        &session,
        "printf '%s\\n' \"$(hostname)\" \"$(uname -srm)\" \"$(. /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-Unknown})\" \"$(nproc 2>/dev/null || echo 1)\" \"$(free -m 2>/dev/null | awk '/Mem:/{printf \\\"%.1f\\\", $2/1024}' || echo 0)\" \"$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,\\\"\\\",$2); print $2}' || echo 0)\" \"$(uptime -p 2>/dev/null || uptime)\"; for x in docker nginx node python3 mysql psql redis-server; do if command -v $x >/dev/null 2>&1; then printf '%s: ' \"$x\"; ($x --version 2>&1 || $x -v 2>&1) | head -1; fi; done",
    )?;
    if status != 0 {
        return Err(format!("服务器信息采集失败：{raw}"));
    }
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 7 {
        return Err("服务器返回的基础信息格式不完整".into());
    }
    let info = ServerInfo {
        os: lines[2].to_string(),
        kernel: lines[1].to_string(),
        cpu: "远程服务器 CPU".into(),
        cores: lines[3].trim().parse().unwrap_or(1),
        memory_gb: lines[4].trim().parse::<f32>().unwrap_or(0.0).ceil() as u16,
        disk_gb: lines[5].trim().parse().unwrap_or(0),
        uptime: lines[6].trim_start_matches("up ").to_string(),
    };
    Ok(SshProbe {
        info,
        hostname: lines[0].to_string(),
        environment: lines.iter().skip(7).map(|line| line.to_string()).collect(),
    })
}

#[tauri::command(async)]
fn execute_ssh_command(
    host: String,
    port: u16,
    username: String,
    password: String,
    command: String,
    approved_high_risk: bool,
) -> Result<CommandResult, String> {
    if risk_for(&command) == "high" && !approved_high_risk {
        return Ok(CommandResult {
            output: format!("$ {command}\n[安全策略] 高危命令已拦截，未发送至服务器"),
            success: false,
            simulated: false,
            exit_code: 126,
            empty_result: false,
        });
    }
    let session = connect_ssh(&host, port, &username, &password)?;
    let (output, status) = ssh_exec(&session, &command)?;
    let empty_result = is_valid_empty_result(&command, status, &output);
    let result_text = if empty_result {
        "未发现匹配项（命令正常完成）".to_string()
    } else if output.is_empty() {
        "命令未产生输出".to_string()
    } else {
        output
    };
    Ok(CommandResult {
        output: format!("$ {command}\n{result_text}\n[exit: {status}]"),
        success: status == 0 || empty_result,
        simulated: false,
        exit_code: status,
        empty_result,
    })
}

#[tauri::command]
fn start_ssh_terminal(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    {
        let mut sessions = manager.sessions.lock().map_err(|_| "终端状态锁异常")?;
        if sessions.contains_key(&terminal_id) {
            return Ok(());
        }
        sessions.insert(terminal_id.clone(), sender);
    }

    let app_handle = app.clone();
    let id = terminal_id.clone();
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let session = connect_ssh(&host, port, &username, &password)?;
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
            emit_terminal(
                &app_handle,
                &id,
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
                            let _ = channel.request_pty_size(cols, rows, None, None);
                        }
                        Ok(TerminalInput::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                            let _ = channel.close();
                            return Ok(());
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                    }
                }

                match channel.read(&mut buffer) {
                    Ok(size) if size > 0 => {
                        emit_terminal(
                            &app_handle,
                            &id,
                            String::from_utf8_lossy(&buffer[..size]).to_string(),
                            "stdout",
                        );
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(format!("终端输出读取失败：{error}")),
                }

                match channel.stderr().read(&mut buffer) {
                    Ok(size) if size > 0 => {
                        emit_terminal(
                            &app_handle,
                            &id,
                            String::from_utf8_lossy(&buffer[..size]).to_string(),
                            "stderr",
                        );
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(format!("终端错误输出读取失败：{error}")),
                }

                if channel.eof() {
                    return Ok(());
                }
                thread::sleep(std::time::Duration::from_millis(18));
            }
        })();

        if let Err(error) = result {
            emit_terminal(
                &app_handle,
                &id,
                format!("\r\n[Opsark] {error}\r\n"),
                "error",
            );
        } else {
            emit_terminal(
                &app_handle,
                &id,
                "\r\n[Opsark] SSH PTY 已关闭\r\n",
                "system",
            );
        }
        if let Ok(mut sessions) = app_handle.state::<TerminalManager>().sessions.lock() {
            sessions.remove(&id);
        }
    });
    Ok(())
}

#[tauri::command]
fn write_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().map_err(|_| "终端状态锁异常")?;
    let sender = sessions
        .get(&terminal_id)
        .ok_or_else(|| "SSH PTY 尚未连接".to_string())?;
    sender
        .send(TerminalInput::Data(data.into_bytes()))
        .map_err(|_| "SSH PTY 已断开".to_string())
}

#[tauri::command]
fn resize_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().map_err(|_| "终端状态锁异常")?;
    let sender = sessions
        .get(&terminal_id)
        .ok_or_else(|| "SSH PTY 尚未连接".to_string())?;
    sender
        .send(TerminalInput::Resize(cols, rows))
        .map_err(|_| "SSH PTY 已断开".to_string())
}

#[tauri::command]
fn close_ssh_terminal(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|_| "终端状态锁异常")?;
    if let Some(sender) = sessions.remove(&terminal_id) {
        let _ = sender.send(TerminalInput::Close);
    }
    Ok(())
}

#[tauri::command(async)]
fn list_sftp_directory(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    let entries = sftp
        .readdir(Path::new(&path))
        .map_err(|error| format!("无法读取远程目录 {path}：{error}"))?;
    let mut result: Vec<RemoteFileEntry> = entries
        .into_iter()
        .filter_map(|(entry_path, stat)| {
            let name = entry_path.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }
            let permission = stat.perm.unwrap_or(0);
            let is_directory = permission & 0o170000 == 0o040000;
            Some(RemoteFileEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                kind: if is_directory { "directory" } else { "file" }.into(),
                size: if is_directory {
                    "—".into()
                } else {
                    let bytes = stat.size.unwrap_or(0);
                    if bytes >= 1_048_576 {
                        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
                    } else if bytes >= 1024 {
                        format!("{:.1} KB", bytes as f64 / 1024.0)
                    } else {
                        format!("{bytes} B")
                    }
                },
                modified: stat
                    .mtime
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "—".into()),
            })
        })
        .collect();
    result.sort_by(|a, b| {
        let a_dir = a.kind == "directory";
        let b_dir = b.kind == "directory";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

#[tauri::command(async)]
fn create_sftp_directory(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<(), String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    sftp.mkdir(Path::new(&path), 0o755)
        .map_err(|error| format!("创建目录失败：{error}"))
}

#[tauri::command(async)]
fn rename_sftp_entry(
    host: String,
    port: u16,
    username: String,
    password: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    sftp.rename(Path::new(&from_path), Path::new(&to_path), None)
        .map_err(|error| format!("重命名失败：{error}"))
}

#[tauri::command(async)]
fn delete_sftp_entry(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    kind: String,
) -> Result<(), String> {
    if path == "/" || path.trim().is_empty() {
        return Err("安全策略禁止删除根目录".into());
    }
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    if kind == "directory" {
        sftp.rmdir(Path::new(&path))
            .map_err(|error| format!("只能删除空目录：{error}"))
    } else {
        sftp.unlink(Path::new(&path))
            .map_err(|error| format!("删除文件失败：{error}"))
    }
}

#[tauri::command(async)]
fn read_sftp_file(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    let mut file = sftp
        .open(Path::new(&path))
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let stat = file.stat().map_err(|error| error.to_string())?;
    if stat.size.unwrap_or(0) > 20 * 1024 * 1024 {
        return Err("首版下载限制为 20 MB，请使用终端或专业传输工具处理大文件".into());
    }
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    Ok(data)
}

#[tauri::command(async)]
fn write_sftp_file(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 20 * 1024 * 1024 {
        return Err("首版上传限制为 20 MB".into());
    }
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    let mut file = sftp
        .create(Path::new(&path))
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("上传写入失败：{error}"))?;
    file.flush()
        .map_err(|error| format!("上传刷新失败：{error}"))
}

#[tauri::command(async)]
fn get_ssh_metrics(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<Metrics, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let command = r#"cpu=$(LC_ALL=C top -bn1 | awk '/Cpu/{print 100-$8;exit}'); mem=$(free | awk '/Mem:/{print $3*100/$2}'); disk=$(df -P / | awk 'NR==2{gsub(/%/,"",$5);print $5}'); net=$(awk -F'[: ]+' '/:/{rx+=$3;tx+=$11}END{print rx" "tx}' /proc/net/dev); echo "$cpu"; echo "$mem"; echo "$disk"; echo "$net""#;
    let (raw, status) = ssh_exec(&session, command)?;
    if status != 0 {
        return Err(format!("实时指标采集失败：{raw}"));
    }
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 4 {
        return Err("实时指标返回格式不完整".into());
    }
    let totals: Vec<f64> = lines[3]
        .split_whitespace()
        .filter_map(|value| value.parse().ok())
        .collect();
    let now = Instant::now();
    let sample_key = format!("{username}@{host}:{port}");
    let (network_in, network_out) = if totals.len() == 2 {
        let samples = METRIC_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut samples = samples.lock().map_err(|_| "指标采样状态锁异常")?;
        let rates = samples.get(&sample_key).map(|(rx, tx, sampled_at)| {
            let elapsed = now.duration_since(*sampled_at).as_secs_f64().max(0.1);
            (
                ((totals[0] - rx).max(0.0) / 1_048_576.0 / elapsed) as f32,
                ((totals[1] - tx).max(0.0) / 1_048_576.0 / elapsed) as f32,
            )
        });
        samples.insert(sample_key, (totals[0], totals[1], now));
        rates.unwrap_or((0.0, 0.0))
    } else {
        (0.0, 0.0)
    };
    Ok(Metrics {
        cpu: lines[0]
            .trim()
            .parse::<f32>()
            .unwrap_or(0.0)
            .round()
            .clamp(0.0, 100.0) as u8,
        memory: lines[1]
            .trim()
            .parse::<f32>()
            .unwrap_or(0.0)
            .round()
            .clamp(0.0, 100.0) as u8,
        disk: lines[2]
            .trim()
            .parse::<f32>()
            .unwrap_or(0.0)
            .round()
            .clamp(0.0, 100.0) as u8,
        network_in,
        network_out,
        sampled_at: unix_seconds().to_string(),
    })
}

#[tauri::command]
async fn generate_ai_plan(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
) -> Result<Vec<PlanStep>, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = "你是一位谨慎的资深 Linux 运维工程师。请根据服务器上下文，为用户需求生成可审查的执行计划。只返回一个合法 JSON 对象，固定格式为 {\"steps\":[...]}，不要 Markdown。Shell 命令中出现的反斜杠必须按 JSON 规范转义为双反斜杠。steps 中每个对象必须包含 title、description、command、expected、validation、risk；risk 只能是 low、medium、high。validation 必须是独立、只读、可执行的 Shell 校验命令，退出码 0 代表成功获得了足够判断 expected 的结果，不要填写自然语言。状态探测不能把业务分支当成执行失败：如果下一步会创建或安装资源，前置检查应同时允许“已存在”和“不存在”两种有效结果，并把状态输出交给执行后的模型复核决定继续还是提前完成；只有检查命令本身失败或输出无效时，validation 才应退出非 0。例如创建数据库前，使用 information_schema 查询 COUNT(*)，输出 0 或 1 都代表状态检查成功，不能用 grep -qx '0' 把数据库已存在判为步骤失败。先诊断后变更，最后复查；禁止生成 rm -rf、格式化磁盘、删除账号等不可逆命令。上下文中的 secretVariables 只有名称和说明，没有值；命令需要这些值时必须原样使用对应 placeholder（例如 ${secret.DB_PASSWORD}），严禁猜测或要求模型读取真实值。";
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": format!("服务器上下文：\n{context}\n\n用户需求：\n{requirement}")}
        ],
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
        "max_tokens": 1800
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("DeepSeek 请求失败：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("模型响应不是有效 JSON：{error}"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("DeepSeek 接口返回 {status}：{message}"));
    }
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型响应缺少计划内容".to_string())?;
    let cleaned = clean_json_content(content);
    let raw_steps = parse_ai_plan_steps(cleaned)
        .or_else(|_| parse_ai_plan_steps(&repair_invalid_json_escapes(cleaned)))
        .map_err(|error| format!("模型计划结构解析失败：{error}"))?;
    if raw_steps.is_empty() || raw_steps.len() > 12 {
        return Err("模型计划步骤数量不合理".into());
    }
    Ok(raw_steps
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let computed = risk_for(&item.command);
            let supplied = item.risk.as_deref().unwrap_or("low");
            let risk = if computed == "high" || supplied == "high" {
                "high"
            } else if computed == "medium" || supplied == "medium" {
                "medium"
            } else {
                "low"
            };
            PlanStep {
                id: format!("ai-step-{}-{index}", unix_seconds()),
                title: item.title,
                description: item.description,
                command: item.command,
                risk: risk.into(),
                expected: item.expected,
                validation: item.validation,
                status: "pending".into(),
                output: None,
            }
        })
        .collect())
}

#[tauri::command]
async fn check_ai_model(
    api_key: String,
    endpoint: String,
    model: String,
) -> Result<ModelCheckResult, String> {
    if api_key.trim().is_empty() || endpoint.trim().is_empty() || model.trim().is_empty() {
        return Ok(ModelCheckResult {
            available: false,
            reason: "模型配置不完整".into(),
        });
    }
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("无法连接模型服务：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("模型服务响应不是有效 JSON：{error}"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("鉴权或接口检查失败");
        return Ok(ModelCheckResult {
            available: false,
            reason: format!("接口返回 {status}：{message}"),
        });
    }
    let model_ids: Vec<&str> = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect();
    if model_ids.iter().any(|id| *id == model) {
        Ok(ModelCheckResult {
            available: true,
            reason: "接口、鉴权和模型名称均可用".into(),
        })
    } else {
        Ok(ModelCheckResult {
            available: false,
            reason: if model_ids.is_empty() {
                "接口未返回可用模型".into()
            } else {
                format!("接口可访问，但模型 {model} 不在可用列表中")
            },
        })
    }
}

#[tauri::command]
async fn generate_ai_summary(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    execution_context: String,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = "你是一位专业的 Linux 运维工程师。请仅根据用户需求和真实执行结果生成简洁、准确的中文总结。必须回答用户真正关心的结果：例如查询数据库时列出数据库名称，查询表时列出表名，查询进程时说明进程名称或明确未发现。不要只说执行了几步，不要虚构，不要输出命令，不要泄露或猜测敏感信息。使用一到三段纯文本。";
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": format!("用户需求：\n{requirement}\n\n已脱敏的执行结果：\n{execution_context}")}
        ],
        "thinking": {"type": "disabled"},
        "max_tokens": 700
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("总结请求失败：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("总结响应不是有效 JSON：{error}"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("模型总结接口返回 {status}：{message}"));
    }
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "模型总结为空".to_string())
}

#[tauri::command]
async fn review_ai_step(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    review_context: String,
) -> Result<AiStepReview, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = "你是一位谨慎的 Linux 运维执行结果复核员。主命令和独立程序校验均已执行，请只依据用户目标以及脱敏后的真实输出判断下一步。只返回 JSON 对象，必须包含 decision、reason、summary。decision 只能是 continue、adjust、complete：当前步骤实际达到预期且仍需后续步骤时用 continue；虽然退出码为 0，但输出语义与目标矛盾、证据不足或校验设计有误时用 adjust；用户整体目标已经由当前结果充分达成、剩余步骤已无必要时才用 complete。对于“确保资源存在”一类目标，状态检查返回不存在（例如 COUNT(*) 为 0）时应 continue 执行创建，返回已存在（例如 COUNT(*) 为 1）时可 complete 并跳过重复创建。不得虚构输出，不得输出新命令，不得索取或猜测敏感信息。你不能推翻程序执行失败、程序校验失败、安全拦截或用户审批。reason 简洁说明判定依据；summary 用一句中文概括本步真实结果。";
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": format!("用户目标：\n{requirement}\n\n执行复核上下文：\n{review_context}")}
        ],
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
        "max_tokens": 500
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|error| error.to_string())?
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("结果复核请求失败：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("结果复核响应不是有效 JSON：{error}"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("模型结果复核接口返回 {status}：{message}"));
    }
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型结果复核缺少内容".to_string())?;
    let cleaned = clean_json_content(content);
    let review: AiStepReview = serde_json::from_str(cleaned)
        .or_else(|_| serde_json::from_str(&repair_invalid_json_escapes(cleaned)))
        .map_err(|error| format!("模型结果复核结构解析失败：{error}"))?;
    if !matches!(review.decision.as_str(), "continue" | "adjust" | "complete") {
        return Err("模型结果复核 decision 不合法".into());
    }
    if review.reason.trim().is_empty() || review.summary.trim().is_empty() {
        return Err("模型结果复核缺少判定依据或摘要".into());
    }
    Ok(review)
}

#[tauri::command]
fn generate_plan(requirement: String) -> Vec<PlanStep> {
    let lower = requirement.to_lowercase();
    if lower.contains("nginx") || lower.contains("网站") || lower.contains("反向代理") {
        vec![
            step(
                0,
                "检查运行环境",
                "确认 Nginx 版本和当前服务状态",
                "nginx -v && systemctl is-active nginx",
                "识别版本与服务状态",
                "systemctl is-active nginx",
            ),
            step(
                1,
                "校验配置",
                "在变更前检查配置语法",
                "nginx -t",
                "配置语法检查通过",
                "nginx -t",
            ),
            step(
                2,
                "应用服务变更",
                "无中断重新加载 Nginx",
                "sudo systemctl reload nginx",
                "服务完成重载",
                "systemctl is-active nginx",
            ),
            step(
                3,
                "复查服务",
                "检查本机 HTTP 响应",
                "curl -I --max-time 5 http://127.0.0.1",
                "返回有效 HTTP 状态",
                "curl -fsS --max-time 5 http://127.0.0.1 >/dev/null",
            ),
        ]
    } else if lower.contains("磁盘") || lower.contains("空间") || lower.contains("清理") {
        vec![
            step(
                0,
                "分析磁盘使用",
                "读取挂载点容量",
                "df -h",
                "定位高占用挂载点",
                "df -P / >/dev/null",
            ),
            step(
                1,
                "定位大目录",
                "分析日志目录空间占用",
                "du -xh /var/log --max-depth=1 | sort -h | tail",
                "得到占用排序",
                "test -d /var/log",
            ),
            step(
                2,
                "检查日志轮转",
                "检查日志轮转定时器",
                "systemctl status logrotate.timer --no-pager",
                "确认轮转状态",
                "systemctl is-enabled logrotate.timer >/dev/null 2>&1",
            ),
        ]
    } else {
        vec![
            step(
                0,
                "采集当前状态",
                "获取负载、内存和磁盘概况",
                "uptime && free -h && df -h",
                "建立执行前基线",
                "test -r /proc/loadavg && test -r /proc/meminfo",
            ),
            step(
                1,
                "检查相关服务",
                "列出异常系统服务",
                "systemctl --failed --no-pager",
                "识别服务异常",
                "systemctl is-system-running >/dev/null 2>&1 || test $? -eq 1",
            ),
            step(
                2,
                "输出诊断结论",
                "复查高资源占用进程",
                "ps aux --sort=-%cpu | head -8",
                "得到进程清单",
                "ps -e >/dev/null",
            ),
        ]
    }
}

#[tauri::command]
fn execute_command(command: String, approved_high_risk: bool) -> CommandResult {
    let blocked = [
        "rm -rf",
        "mkfs",
        "fdisk",
        "userdel",
        "iptables -F",
        "DROP TABLE",
    ]
    .iter()
    .any(|needle| command.to_lowercase().contains(&needle.to_lowercase()));

    if blocked && !approved_high_risk {
        return CommandResult {
            output: format!("$ {command}\n[安全策略] 高危命令已拦截，未发送至服务器"),
            success: false,
            simulated: true,
            exit_code: 126,
            empty_result: false,
        };
    }

    CommandResult {
        output: format!("$ {command}\n[演示执行器] 命令已安全执行\n状态: success\n耗时: 0.38s"),
        success: true,
        simulated: true,
        exit_code: 0,
        empty_result: false,
    }
}

#[tauri::command]
fn validate_step(expected: String, output: String) -> ValidationResult {
    let passed = output.contains("success") || output.contains("[exit: 0]");
    ValidationResult {
        passed,
        detail: if passed {
            format!("校验通过：{expected}")
        } else {
            "未在命令输出中找到成功标记".into()
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            collect_server_info,
            get_realtime_metrics,
            probe_ssh_server,
            execute_ssh_command,
            start_ssh_terminal,
            write_ssh_terminal,
            resize_ssh_terminal,
            close_ssh_terminal,
            list_sftp_directory,
            create_sftp_directory,
            rename_sftp_entry,
            delete_sftp_entry,
            read_sftp_file,
            write_sftp_file,
            get_ssh_metrics,
            generate_plan,
            generate_ai_plan,
            check_ai_model,
            generate_ai_summary,
            review_ai_step,
            execute_command,
            validate_step,
            save_credential,
            load_credential,
            delete_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running Opsark");
}

#[cfg(test)]
mod live_tests {
    use super::*;

    #[test]
    fn credential_accounts_are_namespaced_and_validated() {
        assert_eq!(
            credential_account("server", "srv-1").unwrap(),
            "server:srv-1"
        );
        assert_eq!(
            credential_account("model", "model-1").unwrap(),
            "model:model-1"
        );
        assert!(credential_account("other", "id").is_err());
        assert!(credential_account("server", " ").is_err());
    }

    #[test]
    fn repairs_unescaped_shell_backslashes_in_model_json() {
        let invalid = r#"{"steps":[{"title":"检查","description":"检查输出","command":"grep -E '\s+java\.jar'","expected":"得到结果","validation":"grep -q '\d' /tmp/result","risk":"low"}]}"#;
        assert!(serde_json::from_str::<Value>(invalid).is_err());

        let steps = parse_ai_plan_steps(&repair_invalid_json_escapes(invalid)).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].command, "grep -E '\\s+java\\.jar'");
        assert_eq!(steps[0].validation, "grep -q '\\d' /tmp/result");
    }

    #[test]
    fn grep_no_match_is_a_valid_empty_query_result() {
        assert!(is_valid_empty_result(
            "ps -ef | grep java | grep -v grep",
            1,
            ""
        ));
        assert!(!is_valid_empty_result("systemctl is-active nginx", 1, ""));
        assert!(!is_valid_empty_result(
            "grep java /missing/file",
            2,
            "No such file"
        ));
    }

    #[test]
    fn demo_high_risk_command_requires_explicit_approval() {
        assert!(!execute_command("rm -rf /tmp/explicit-target".into(), false).success);
        assert!(execute_command("rm -rf /tmp/explicit-target".into(), true).success);
    }

    #[test]
    #[ignore = "requires explicitly supplied live SSH credentials"]
    fn probe_live_ssh_adapter() {
        let host = std::env::var("OPSARK_TEST_SSH_HOST").expect("missing SSH host");
        let user = std::env::var("OPSARK_TEST_SSH_USER").expect("missing SSH user");
        let password = std::env::var("OPSARK_TEST_SSH_PASSWORD").expect("missing SSH password");
        let probe = probe_ssh_server(host.clone(), 22, user.clone(), password.clone())
            .expect("SSH probe failed");
        assert!(probe.info.cores > 0);
        assert!(!probe.info.os.is_empty());
        let files =
            list_sftp_directory(host.clone(), 22, user.clone(), password.clone(), "/".into())
                .expect("SFTP list failed");
        assert!(!files.is_empty());
        let metrics = get_ssh_metrics(host.clone(), 22, user.clone(), password.clone())
            .expect("metrics collection failed");
        assert!(metrics.disk > 0);
        let command = execute_ssh_command(
            host,
            22,
            user,
            password,
            "printf OPSARK_SSH_OK".into(),
            false,
        )
        .expect("SSH command failed");
        assert!(command.success);
        assert!(command.output.contains("OPSARK_SSH_OK"));
        assert!(validate_step("marker".into(), command.output).passed);

        let pty_session = connect_ssh(
            &std::env::var("OPSARK_TEST_SSH_HOST").unwrap(),
            22,
            &std::env::var("OPSARK_TEST_SSH_USER").unwrap(),
            &std::env::var("OPSARK_TEST_SSH_PASSWORD").unwrap(),
        )
        .expect("PTY SSH connection failed");
        let mut pty = pty_session.channel_session().expect("PTY channel failed");
        pty.request_pty("xterm-256color", None, Some((120, 32, 0, 0)))
            .expect("PTY request failed");
        pty.shell().expect("PTY shell failed");
        pty.write_all(b"printf OPSARK_PTY_OK\nexit\n")
            .expect("PTY input failed");
        pty.flush().ok();
        let mut pty_output = String::new();
        pty.read_to_string(&mut pty_output)
            .expect("PTY output failed");
        assert!(pty_output.contains("OPSARK_PTY_OK"));

        let host = std::env::var("OPSARK_TEST_SSH_HOST").unwrap();
        let user = std::env::var("OPSARK_TEST_SSH_USER").unwrap();
        let password = std::env::var("OPSARK_TEST_SSH_PASSWORD").unwrap();
        let test_dir = format!("/tmp/opsark-sftp-test-{}", unix_seconds());
        let file_path = format!("{test_dir}/hello.txt");
        let renamed_path = format!("{test_dir}/renamed.txt");
        create_sftp_directory(
            host.clone(),
            22,
            user.clone(),
            password.clone(),
            test_dir.clone(),
        )
        .expect("SFTP mkdir failed");
        write_sftp_file(
            host.clone(),
            22,
            user.clone(),
            password.clone(),
            file_path.clone(),
            b"OPSARK_SFTP_OK".to_vec(),
        )
        .expect("SFTP upload failed");
        let downloaded = read_sftp_file(
            host.clone(),
            22,
            user.clone(),
            password.clone(),
            file_path.clone(),
        )
        .expect("SFTP download failed");
        assert_eq!(downloaded, b"OPSARK_SFTP_OK");
        rename_sftp_entry(
            host.clone(),
            22,
            user.clone(),
            password.clone(),
            file_path,
            renamed_path.clone(),
        )
        .expect("SFTP rename failed");
        delete_sftp_entry(
            host.clone(),
            22,
            user.clone(),
            password.clone(),
            renamed_path,
            "file".into(),
        )
        .expect("SFTP file delete failed");
        delete_sftp_entry(host, 22, user, password, test_dir, "directory".into())
            .expect("SFTP directory delete failed");
    }

    #[test]
    #[ignore = "requires an explicitly supplied live model API key"]
    fn generate_live_deepseek_plan() {
        let api_key = std::env::var("OPSARK_TEST_MODEL_KEY").expect("missing model key");
        let plan = tauri::async_runtime::block_on(generate_ai_plan(
            api_key,
            "https://api.deepseek.com".into(),
            "deepseek-v4-flash".into(),
            "只读检查服务器磁盘空间".into(),
            r#"{"os":"CentOS 7","diskUsage":"82%","permission":"safe"}"#.into(),
        ))
        .expect("DeepSeek plan generation failed");
        assert!(!plan.is_empty());
        assert!(plan.iter().all(|step| !step.command.trim().is_empty()));
    }
}
