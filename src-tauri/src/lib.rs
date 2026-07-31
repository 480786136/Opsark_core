use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
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

#[derive(Default)]
struct ExecutionManager {
    executions: Mutex<HashMap<String, Arc<AtomicBool>>>,
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
struct CommandOutputEvent {
    execution_id: String,
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

#[derive(Debug, Deserialize)]
struct AiRequirementDecision {
    intent: String,
    answer: Option<String>,
    constraints: Option<ExecutionConstraints>,
    #[serde(default)]
    steps: Vec<AiPlanStep>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionConstraints {
    #[serde(default)]
    change_policy: String,
    #[serde(default)]
    environment_policy: String,
    #[serde(default)]
    failure_policy: String,
    #[serde(default)]
    prohibited_actions: Vec<String>,
    #[serde(default)]
    required_conditions: Vec<String>,
    #[serde(default)]
    user_directives: Vec<String>,
}

#[derive(Debug, Serialize)]
struct RequirementProcessingResult {
    intent: String,
    answer: Option<String>,
    plan: Vec<PlanStep>,
    constraints: Option<ExecutionConstraints>,
}

fn normalize_execution_constraints(
    constraints: Option<ExecutionConstraints>,
) -> ExecutionConstraints {
    let constraints = constraints.unwrap_or_default();
    let normalize_policy = |value: String, allowed: &[&str]| {
        if allowed.contains(&value.as_str()) {
            value
        } else {
            "unspecified".to_string()
        }
    };
    let normalize_items = |items: Vec<String>| {
        items
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .take(12)
            .collect()
    };
    ExecutionConstraints {
        change_policy: normalize_policy(
            constraints.change_policy,
            &[
                "unspecified",
                "read_only",
                "requested_changes_only",
                "allow_necessary_changes",
            ],
        ),
        environment_policy: normalize_policy(
            constraints.environment_policy,
            &[
                "unspecified",
                "preserve",
                "allow_isolated_changes",
                "allow_host_changes",
            ],
        ),
        failure_policy: normalize_policy(
            constraints.failure_policy,
            &["unspecified", "strict", "best_effort"],
        ),
        prohibited_actions: normalize_items(constraints.prohibited_actions),
        required_conditions: normalize_items(constraints.required_conditions),
        user_directives: normalize_items(constraints.user_directives),
    }
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

fn emit_command_output(app: &AppHandle, execution_id: &str, data: impl Into<String>, stream: &str) {
    let _ = app.emit(
        "command-output",
        CommandOutputEvent {
            execution_id: execution_id.to_string(),
            data: data.into(),
            stream: stream.to_string(),
        },
    );
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn execution_pid_file(execution_id: &str) -> Result<String, String> {
    if execution_id.is_empty()
        || execution_id.len() > 160
        || !execution_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("执行标识不合法".into());
    }
    Ok(format!("/tmp/opsark-{execution_id}.pid"))
}

fn ssh_exec_streaming(
    app: &AppHandle,
    session: &Session,
    execution_id: &str,
    command: &str,
    cancelled: &AtomicBool,
) -> Result<(String, i32), String> {
    let pid_file = execution_pid_file(execution_id)?;
    let wrapped = format!(
        "pid_file={}; setsid sh -lc {} & child=$!; printf '%s' \"$child\" > \"$pid_file\"; wait \"$child\"; code=$?; rm -f \"$pid_file\"; exit \"$code\"",
        shell_quote(&pid_file),
        shell_quote(command),
    );
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
    channel
        .exec(&wrapped)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
    session.set_blocking(false);
    let mut combined = String::new();
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = channel.close();
            return Ok((combined.trim().to_string(), 130));
        }
        let mut received = false;
        match channel.read(&mut stdout_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                let chunk = String::from_utf8_lossy(&stdout_buffer[..size]).to_string();
                combined.push_str(&chunk);
                emit_command_output(app, execution_id, chunk, "stdout");
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("读取远程标准输出失败：{error}")),
        }
        match channel.stderr().read(&mut stderr_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                let chunk = String::from_utf8_lossy(&stderr_buffer[..size]).to_string();
                if !combined.is_empty() && !combined.ends_with('\n') {
                    combined.push('\n');
                }
                combined.push_str(&chunk);
                emit_command_output(app, execution_id, chunk, "stderr");
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("读取远程错误输出失败：{error}")),
        }
        if channel.eof() {
            break;
        }
        if !received {
            thread::sleep(std::time::Duration::from_millis(35));
        }
    }
    session.set_blocking(true);
    channel.wait_close().map_err(|error| error.to_string())?;
    Ok((
        combined.trim().to_string(),
        channel.exit_status().unwrap_or(1),
    ))
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

fn convert_ai_plan_steps(raw_steps: Vec<AiPlanStep>) -> Result<Vec<PlanStep>, String> {
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
async fn execute_ssh_command(
    app: AppHandle,
    manager: State<'_, ExecutionManager>,
    host: String,
    port: u16,
    username: String,
    password: String,
    command: String,
    approved_high_risk: bool,
    execution_id: String,
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
    execution_pid_file(&execution_id)?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    manager
        .executions
        .lock()
        .map_err(|_| "执行状态锁异常")?
        .insert(execution_id.clone(), cancel_flag.clone());
    let app_handle = app.clone();
    let id = execution_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&host, port, &username, &password)?;
        ssh_exec_streaming(&app_handle, &session, &id, &command, cancel_flag.as_ref())
            .map(|(output, status)| (command, output, status))
    })
    .await
    .map_err(|error| format!("远程执行线程异常：{error}"))?;
    manager
        .executions
        .lock()
        .map_err(|_| "执行状态锁异常")?
        .remove(&execution_id);
    let (command, output, status) = result?;
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

#[tauri::command(async)]
async fn cancel_ssh_execution(
    manager: State<'_, ExecutionManager>,
    host: String,
    port: u16,
    username: String,
    password: String,
    execution_id: String,
) -> Result<(), String> {
    let pid_file = execution_pid_file(&execution_id)?;
    if let Some(flag) = manager
        .executions
        .lock()
        .map_err(|_| "执行状态锁异常")?
        .get(&execution_id)
        .cloned()
    {
        flag.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&host, port, &username, &password)?;
        let command = format!(
            "if test -s {0}; then pid=$(cat {0}); kill -TERM -- -\"$pid\" 2>/dev/null || kill -TERM \"$pid\" 2>/dev/null || true; sleep 1; kill -KILL -- -\"$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true; rm -f {0}; fi",
            shell_quote(&pid_file),
        );
        ssh_exec(&session, &command).map(|_| ())
    })
    .await
    .map_err(|error| format!("终止执行线程异常：{error}"))?
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
    let system = "你是一位谨慎的资深 Linux 运维工程师。请根据服务器上下文，为用户需求生成可审查且精简的执行计划。只返回一个合法 JSON 对象，固定格式为 {\"steps\":[...]}，不要 Markdown。通常生成 3 至 7 步；把同类环境检查合并为一个诊断步骤，不要再创建与每步 validation 重复的复查步骤。Shell 命令中出现的反斜杠必须按 JSON 规范转义为双反斜杠。steps 中每个对象必须包含 title、description、command、expected、validation、risk；risk 只能是 low、medium、high。validation 必须是独立、只读、可执行的 Shell 校验命令，退出码 0 代表成功获得了足够判断 expected 的结果，不要填写自然语言。状态探测不能把业务分支当成执行失败：如果下一步会创建或安装资源，前置检查应同时允许“已存在”和“不存在”两种有效结果，并把状态输出交给执行后的模型复核决定继续还是提前完成；只有检查命令本身失败或输出无效时，validation 才应退出非 0。诊断查询发现无匹配、未监听、HTTP 非 2xx 或日志中存在 ERROR，都是需要记录的有效状态，不等于检查命令执行失败。端口监听本身不能证明属于目标项目：必须结合 PID/进程、容器端口映射、Nginx upstream、项目配置或 HTTP 响应内容建立归属；Docker proxy 或 Nginx 监听也不能单独证明目标页面可访问。只有实际 curl 得到可识别的目标页面响应，才能给出已验证访问地址。用户仅报告空白页、打不开、超时、报错或要求检查状态时，首轮计划必须全部为只读诊断，禁止擅自重启、安装、升级或修改配置；只有用户明确要求修复或变更时才生成变更步骤。不要假设项目使用默认端口，排查页面问题应依次核实进程/容器、监听归属、反向代理、HTTP 状态与内容、目标项目日志及依赖关系。先诊断后变更，最后复查；禁止生成 rm -rf、格式化磁盘、删除账号等不可逆命令。上下文中的 secretVariables 只有名称和说明，没有值；命令需要这些值时必须原样使用对应 placeholder（例如 ${secret.DB_PASSWORD}），严禁猜测或要求模型读取真实值。";
    let deployment_rules = "生成代码项目部署计划时必须遵守：先生成只读发现步骤，克隆后读取 README、清单、锁文件、构建脚本和 engines，并采集操作系统版本、处理器架构、libc、C++ ABI、包管理器和容器能力；禁止把环境检查与依赖安装、构建或服务变更合并。发现步骤的 validation 只验证文件可读、JSON 可解析和证据可获得，不能要求 engines 等可选字段必须存在；字段缺失是有效观察状态，应继续从锁文件和实际构建工具推断要求。相同目的的运行时或清单检查只能生成一步。每个远程步骤运行在独立的非交互 Shell 中，cd、export、source、alias 和 PATH 修改不会自动保留到下一步；依赖这些环境的命令和 validation 必须在各自命令内显式初始化。发现证据齐全后再选择与真实平台兼容的变更方案。若运行时不满足要求，必须在依赖安装和构建之前安排兼容的升级或隔离切换步骤及复查；不得笼统假设最低版本，也不能只依据安装器退出码判断成功，必须在同一主机实际执行新二进制并验证版本与 ABI。禁止 curl|bash 远程脚本安装；不要在新二进制验证可运行前修改全局默认运行时。宿主平台无法支持时优先采用兼容容器或隔离构建环境，不得强行升级系统 libc/libstdc++。除非用户明确要求清理，并且前序真实证据确认了精确残留路径及其确实阻断当前目标，否则禁止生成 rm、删除安装目录或“清理残留”步骤。存在锁文件时优先采用项目指定包管理器及冻结安装方式。不要手动安装单个依赖绕过 404，不要永久修改全局镜像源。构建成功后再配置服务，最终验证产物、进程或静态目录、端口/代理归属及实际 HTTP 内容。";
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": format!("{system}\n{deployment_rules}")},
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
    convert_ai_plan_steps(raw_steps)
}

#[tauri::command]
async fn process_ai_requirement(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
) -> Result<RequirementProcessingResult, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = "你是智能运维控制台的需求理解与规划模型。先判断用户是在咨询，还是要求读取/操作真实服务器，并提取可供整个任务生命周期复用的结构化执行约束。只返回合法 JSON 对象，不要 Markdown。两种固定格式：1）无需读取服务器即可回答的知识解释、风险咨询、方案讨论，返回 {\"intent\":\"answer\",\"answer\":\"准确简洁的中文回答\",\"constraints\":null,\"steps\":[]}；2）需要查询当前服务器状态、读取真实数据、检查服务/文件/数据库，或要求执行任何变更，返回 {\"intent\":\"execute\",\"answer\":\"\",\"constraints\":{\"changePolicy\":\"unspecified|read_only|requested_changes_only|allow_necessary_changes\",\"environmentPolicy\":\"unspecified|preserve|allow_isolated_changes|allow_host_changes\",\"failurePolicy\":\"unspecified|strict|best_effort\",\"prohibitedActions\":[\"用户禁止的动作\"],\"requiredConditions\":[\"继续执行必须满足的条件\"],\"userDirectives\":[\"需要在后续计划和复核中原样遵守的用户指令\"]},\"steps\":[...]}。constraints 必须根据语义提取，不能依赖固定句式：preserve 表示保持当前宿主环境或版本；best_effort 表示用户接受在保留已知风险的前提下进行真实尝试；禁止升级、删除、重启等要求写入 prohibitedActions；版本、路径、范围、工具选择等要求写入 requiredConditions 或 userDirectives。没有明确约束时使用 unspecified 和空数组，不得虚构。不能只根据句式判断：例如“当前 MySQL 有哪些数据库”虽是问句，但必须读取服务器，应为 execute；“删除数据库有什么风险”只是在咨询，应为 answer；“删除 ffp 数据库”应为 execute。询问“如何查看当前这个项目的页面”依赖实际部署结果：只有 previousExecution 中已经存在经 HTTP 验证的明确地址时才可直接回答，否则必须 execute 以核实真实监听归属和页面响应。不得把普通 8080、Docker proxy 或 Nginx 80 端口猜成目标项目端口；端口归属至少要由 PID/进程、容器映射、代理 upstream、项目配置或可识别的 HTTP 内容之一证明，外部可访问还必须有真实 HTTP 验证。previousExecution 是上一轮真实执行证据，后续回答必须以它为准，不能仅依据聊天中的旧总结猜测。execute 计划通常控制在 3 至 7 步，把同类环境检查合并，禁止拆出与每一步 validation 重复的复查步骤。每个步骤必须包含 title、description、command、expected、validation、risk，risk 只能是 low、medium、high。Shell 反斜杠必须按 JSON 规范双写。validation 必须是独立、只读、可执行的 Shell 校验命令，退出码 0 表示校验命令成功获得有效状态；无匹配、未监听、HTTP 异常和发现 ERROR 日志是诊断结果，不是命令执行失败。用户只说页面空白、打不开、超时、报错、为什么或检查运行情况时，首轮只生成只读诊断步骤，禁止擅自加入重启、安装、升级、创建或修改；只有用户明确要求修复/变更时才允许相应操作。诊断页面问题应核实进程或容器、端口实际归属、代理链、HTTP 状态/响应内容、目标项目日志和依赖关系，不假设默认端口。状态探测应允许有效业务分支，不能把“资源不存在”误判为命令失败。先诊断后变更，最后复查；禁止生成 rm -rf、格式化磁盘、删除账号等不可逆命令。敏感变量只能使用上下文提供的 ${secret.NAME} 占位符，严禁猜测值。";
    let deployment_rules = "代码项目部署采用“只读发现→一次计划细化→变更→确定性验收”流程。发现阶段必须检查仓库文档、清单、锁文件、构建脚本、engines、当前运行时、操作系统、架构、libc、C++ ABI、包管理器和容器能力，且不能与依赖安装或服务变更合并。发现步骤的 validation 只验证文件可读、结构可解析、证据可获得；package.json 没有 engines 等可选字段是有效结果，必须继续读取锁文件，不能判为失败。同一目的的清单或运行时检查只能保留一步。每个执行步骤都是独立非交互 Shell，source、export、cd、alias 和 PATH 修改不会跨步骤保留；使用 nvm 等工具时，安装、加载、使用和 validation 都必须在各自命令内显式加载对应环境。运行时不兼容时，方案必须适配真实平台；禁止 curl|bash，禁止在新二进制于同一主机验证版本和 ABI 前修改全局默认值。宿主无法支持时使用兼容容器或隔离构建环境，不得强行升级系统 ABI。用户未明确要求且没有前序证据证明精确路径阻断目标时，禁止生成 rm 或清理安装残留。不要手动安装单个依赖绕过下载错误，不要永久修改全局镜像源。构建成功前不得配置或重载线上服务，最终验证产物、代理归属和真实 HTTP 内容。";
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": format!("{system}\n{deployment_rules}")},
            {"role": "user", "content": format!("服务器上下文：\n{context}\n\n用户输入：\n{requirement}")}
        ],
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
        "max_tokens": 1900
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
        .map_err(|error| format!("需求理解请求失败：{error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("需求理解响应不是有效 JSON：{error}"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("需求理解接口返回 {status}：{message}"));
    }
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型响应缺少需求理解结果".to_string())?;
    let cleaned = clean_json_content(content);
    let decision: AiRequirementDecision = serde_json::from_str(cleaned)
        .or_else(|_| serde_json::from_str(&repair_invalid_json_escapes(cleaned)))
        .map_err(|error| format!("需求理解结构解析失败：{error}"))?;
    match decision.intent.as_str() {
        "answer" => {
            let answer = decision
                .answer
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "咨询类响应缺少回答内容".to_string())?;
            Ok(RequirementProcessingResult {
                intent: "answer".into(),
                answer: Some(answer),
                plan: Vec::new(),
                constraints: None,
            })
        }
        "execute" => Ok(RequirementProcessingResult {
            intent: "execute".into(),
            answer: None,
            plan: convert_ai_plan_steps(decision.steps)?,
            constraints: Some(normalize_execution_constraints(decision.constraints)),
        }),
        _ => Err("需求理解 intent 只能是 answer 或 execute".into()),
    }
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
    let system = "你是一位专业的 Linux 运维工程师。请仅根据用户需求和真实执行结果生成简洁、准确的中文总结。执行结果中的 result 和 evidence.facts 是程序提取的结构化事实，应优先于自然语言预期和旧总结；observationStatus 为 not_found、unhealthy 或 warning 都可能是命令正常完成后的真实观察状态，不能改写成执行失败。只要存在 status=failed 或 executionStatus=failed 的关键步骤，并且没有后续证据证明用户目标已达成，必须明确写“任务未完成”，说明最终阻断、失败前已经确认的有效结果以及尚未满足的目标；不得用 HTTP 200、进程存在或部分文件生成掩盖最终内容校验失败。必须回答用户真正关心的结果：例如查询数据库时列出数据库名称，查询表时列出表名，查询进程时说明进程名称或明确未发现。端口监听不等于属于目标项目：除非输出已经用 PID/进程、容器映射、代理 upstream、项目配置或可识别 HTTP 内容证明归属，否则必须写“端口归属尚未确认”。只有真实 HTTP 校验成功且内容能对应目标项目时，才能说外部访问已就绪并提供地址。不得把 Docker proxy 或 Nginx 的监听直接归因给目标项目。发现任意 ERROR 日志只能作为线索，必须说明其文件/服务来源以及是否有证据与当前症状相关；证据不足时不得断言为根因。只有日志搜索命令执行成功且覆盖了项目配置目录、服务日志或 journal 等合理位置时，才能说未发现相关日志，否则应说日志位置尚未确认。不要只说执行了几步，不要虚构，不要输出命令，不要泄露或猜测敏感信息。使用一到三段纯文本。";
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
    let system = "你是一位谨慎的 Linux 运维执行结果复核员。请依据原始用户目标、结构化 executionConstraints、完整计划、已完成执行记录、当前步骤的脱敏真实输出与结构化证据、剩余计划，判断工作流下一步。只返回 JSON 对象，必须包含 decision、reason、summary。decision 只能是 continue、adjust、complete。你的决定表示工作流是否继续，不得把真实失败改写为成功。executionConstraints 是需求理解阶段提取并贯穿任务的权威约束：changePolicy 限制允许的变更范围，environmentPolicy 限制宿主环境或隔离环境变更，failurePolicy 表示严格停止还是允许保留风险的 best_effort 尝试，prohibitedActions、requiredConditions、userDirectives 必须逐项遵守。不得依赖用户使用某个固定句式，应根据这些结构化约束和原始需求共同判断。当前步骤失败或后置校验未通过，但剩余计划明确能够处理该原因且不违反执行约束时用 continue；失败阻断目标、剩余步骤无法修复、计划偏离约束或证据不足时用 adjust；只有用户整体目标已经由真实证据充分达成时才用 complete。触发前置条件门禁时，如果 failurePolicy 为 best_effort，当前步骤符合 changePolicy、environmentPolicy，且不违反 prohibitedActions 和 requiredConditions，可以 continue 进行一次真实尝试；否则应 adjust。当主命令成功但后置校验失败时必须比较两组证据：只读查询若主输出明确而校验可能受瞬时网络、环境加载或校验表达式影响，可以 continue；变更命令只有在剩余计划明确包含加载环境、修复、重试或再次验证该后置条件时才可 continue，不能直接 complete。当主命令执行失败时，必须保留失败事实；只读诊断已经获得用户需要的有效状态，或剩余计划明确包含针对该失败的恢复路径时可以 continue，否则 adjust。平台或 ABI 不兼容时，只有剩余计划包含符合 executionConstraints 的兼容容器、隔离环境或已证明兼容的运行时方案才可 continue。只读日志查询成功发现 ERROR，代表获得了诊断证据，不是步骤失败；不能仅因为存在 ERROR 就 adjust。某个可选依赖连接失败不能直接认定为用户症状根因。端口监听不能证明属于目标项目，需结合 PID、容器映射、代理 upstream、配置和 HTTP 内容。对于“确保资源存在”类目标，状态检查返回不存在时应 continue 执行创建，返回已存在时可 complete。不得因为有效诊断状态反复重拟计划，不得虚构输出、输出新命令、索取或猜测敏感信息。安全拦截、用户审批、明确的平台硬事实和真实执行结果不可被覆盖；最终是否允许继续仍由程序安全门禁决定。reason 简洁说明判定依据；summary 用一句中文概括本步真实结果。";
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
        .manage(ExecutionManager::default())
        .invoke_handler(tauri::generate_handler![
            collect_server_info,
            get_realtime_metrics,
            probe_ssh_server,
            execute_ssh_command,
            cancel_ssh_execution,
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
            process_ai_requirement,
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
    fn parses_answer_and_execute_requirement_intents() {
        let answer: AiRequirementDecision =
            serde_json::from_str(r#"{"intent":"answer","answer":"这是风险咨询。","steps":[]}"#)
                .unwrap();
        assert_eq!(answer.intent, "answer");
        assert!(answer.steps.is_empty());

        let execute: AiRequirementDecision = serde_json::from_str(
            r#"{"intent":"execute","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve","failurePolicy":"best_effort","prohibitedActions":["升级宿主运行时"],"requiredConditions":["保留当前环境"],"userDirectives":["尽力尝试"]},"steps":[{"title":"检查","description":"读取状态","command":"uptime","expected":"返回负载","validation":"uptime >/dev/null","risk":"low"}]}"#,
        )
        .unwrap();
        assert_eq!(execute.intent, "execute");
        assert_eq!(execute.steps.len(), 1);
        let constraints = normalize_execution_constraints(execute.constraints);
        assert_eq!(constraints.environment_policy, "preserve");
        assert_eq!(constraints.failure_policy, "best_effort");
        assert_eq!(constraints.prohibited_actions, vec!["升级宿主运行时"]);
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
        let command_session =
            connect_ssh(&host, 22, &user, &password).expect("SSH command connection failed");
        let (command_output, command_status) =
            ssh_exec(&command_session, "printf OPSARK_SSH_OK").expect("SSH command failed");
        assert_eq!(command_status, 0);
        assert!(command_output.contains("OPSARK_SSH_OK"));
        assert!(validate_step("marker".into(), command_output).passed);

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
