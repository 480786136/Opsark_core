use crate::command_guard::risk_for;
use crate::ssh::{
    connect_ssh, execution_pid_file, shell_quote, ssh_exec, ssh_exec_streaming,
    ssh_exec_streaming_with_prompt, InteractivePromptCredential,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Default)]
pub(crate) struct AgentTerminalManager {
    sessions: Arc<Mutex<HashMap<String, AgentSessionState>>>,
    next_session: Arc<AtomicU64>,
    next_generation: Arc<AtomicU64>,
}

#[derive(Clone)]
struct AgentTarget {
    server_id: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Clone)]
struct ActiveExecution {
    execution_id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
struct AgentSessionState {
    task_id: String,
    generation: u64,
    state: String,
    target: AgentTarget,
    context: AgentSessionContext,
    active: Option<ActiveExecution>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionContext {
    cwd: Option<String>,
    #[serde(default)]
    environment: HashMap<String, String>,
    #[serde(default)]
    source_files: Vec<String>,
    shell: String,
    revision: u64,
}

impl Default for AgentSessionContext {
    fn default() -> Self {
        Self {
            cwd: None,
            environment: HashMap::new(),
            source_files: Vec::new(),
            shell: "bash".into(),
            revision: 0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionInfo {
    id: String,
    server_id: String,
    task_id: String,
    generation: u64,
    state: String,
    context: AgentSessionContext,
    created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTerminalEvent {
    session_id: String,
    generation: u64,
    execution_id: Option<String>,
    data: String,
    stream: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCommandResult {
    output: String,
    success: bool,
    simulated: bool,
    exit_code: i32,
    empty_result: bool,
    session_id: String,
    generation: u64,
    scope: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeProgress {
    active: bool,
    process_count: u64,
    cpu_percent: f64,
    io_bytes: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPromptCredential {
    kind: String,
    secret: String,
    username: Option<String>,
    target: Option<String>,
}

fn emit_agent_event(
    app: &AppHandle,
    session_id: &str,
    generation: u64,
    execution_id: Option<&str>,
    data: impl Into<String>,
    stream: &str,
) {
    let _ = app.emit(
        "agent-terminal-output",
        AgentTerminalEvent {
            session_id: session_id.into(),
            generation,
            execution_id: execution_id.map(str::to_string),
            data: data.into(),
            stream: stream.into(),
        },
    );
}

fn validate_context(context: &AgentSessionContext) -> Result<(), String> {
    if !matches!(context.shell.as_str(), "bash" | "sh" | "zsh") {
        return Err("AgentSessionContext shell 不合法".into());
    }
    if let Some(cwd) = &context.cwd {
        if !cwd.starts_with('/') || cwd.contains('\0') || cwd.len() > 4096 {
            return Err("AgentSessionContext cwd 必须是有界的绝对路径".into());
        }
    }
    if context.environment.len() > 64 || context.source_files.len() > 32 {
        return Err("AgentSessionContext 超出数量上限".into());
    }
    for (name, value) in &context.environment {
        let valid_name = !name.is_empty()
            && name.len() <= 128
            && name.chars().enumerate().all(|(index, value)| {
                value == '_'
                    || value.is_ascii_alphanumeric() && (index > 0 || !value.is_ascii_digit())
            });
        let sensitive = [
            "PASSWORD",
            "PASSWD",
            "TOKEN",
            "SECRET",
            "CREDENTIAL",
            "API_KEY",
            "ACCESS_KEY",
            "PRIVATE_KEY",
        ]
        .iter()
        .any(|needle| name.to_ascii_uppercase().contains(needle));
        if !valid_name || sensitive || value.contains('\0') || value.len() > 4096 {
            return Err(format!("AgentSessionContext 环境变量不允许持久化：{name}"));
        }
    }
    for source in &context.source_files {
        if !source.starts_with('/') || source.contains('\0') || source.len() > 4096 {
            return Err("AgentSessionContext sourceFiles 必须是有界的绝对路径".into());
        }
    }
    Ok(())
}

fn command_for_scope(
    scope: &str,
    command: &str,
    context: &AgentSessionContext,
) -> Result<String, String> {
    let shell = context.shell.as_str();
    match scope {
        "isolated_exec" | "managed_service" => Ok(command.to_string()),
        "fresh_interactive_shell" => Ok(format!("{shell} -ic {}", shell_quote(command))),
        "fresh_login_shell" => Ok(format!("{shell} -lc {}", shell_quote(command))),
        "agent_session" => {
            validate_context(context)?;
            let mut replay = Vec::new();
            if let Some(cwd) = &context.cwd {
                replay.push(format!("cd -- {}", shell_quote(cwd)));
            }
            for (name, value) in &context.environment {
                replay.push(format!("export {name}={}", shell_quote(value)));
            }
            for source in &context.source_files {
                replay.push(format!(". {}", shell_quote(source)));
            }
            replay.push(command.to_string());
            Ok(format!("{shell} -lc {}", shell_quote(&replay.join("; "))))
        }
        "user_action" => Err("user_action 必须由用户在自己的 Shell 中执行".into()),
        _ => Err("未知 Agent 执行作用域".into()),
    }
}

impl AgentTerminalManager {
    fn info(session_id: &str, session: &AgentSessionState) -> AgentSessionInfo {
        AgentSessionInfo {
            id: session_id.into(),
            server_id: session.target.server_id.clone(),
            task_id: session.task_id.clone(),
            generation: session.generation,
            state: session.state.clone(),
            context: session.context.clone(),
            created_at: session.created_at.clone(),
        }
    }

    fn begin_execution(
        &self,
        session_id: &str,
        generation: u64,
        execution_id: &str,
        target: (&str, u16, &str),
    ) -> Result<(AgentSessionContext, Arc<AtomicBool>), String> {
        execution_pid_file(execution_id)?;
        let mut sessions = self.sessions.lock().map_err(|_| "Agent 会话状态锁异常")?;
        let session = sessions
            .get_mut(session_id)
            .ok_or("AgentSession 不存在或已关闭")?;
        if session.generation != generation {
            return Err("AgentSession generation 已变更，拒绝向旧通道发送命令".into());
        }
        if (
            session.target.host.as_str(),
            session.target.port,
            session.target.username.as_str(),
        ) != target
        {
            return Err("AgentSession 显式目标与本次 SSH 连接不一致".into());
        }
        if session.active.is_some() {
            return Err("当前 AgentSession 已有命令在执行".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        session.active = Some(ActiveExecution {
            execution_id: execution_id.into(),
            cancel: cancel.clone(),
        });
        session.state = "busy".into();
        Ok((session.context.clone(), cancel))
    }

    fn finish_execution(&self, session_id: &str, execution_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Agent 会话状态锁异常")?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        if session
            .active
            .as_ref()
            .is_some_and(|active| active.execution_id == execution_id)
        {
            session.active = None;
            session.state = "ready".into();
        }
        Ok(())
    }

    fn recover_after_transport_failure(
        &self,
        session_id: &str,
        execution_id: &str,
    ) -> Result<u64, String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Agent 会话状态锁异常")?;
        let session = sessions
            .get_mut(session_id)
            .ok_or("AgentSession 不存在或已关闭")?;
        if session
            .active
            .as_ref()
            .is_some_and(|active| active.execution_id == execution_id)
        {
            session.active = None;
        }
        session.generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        session.state = "ready".into();
        Ok(session.generation)
    }

    fn validate_active_execution(
        &self,
        session_id: &str,
        generation: u64,
        execution_id: &str,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "Agent 会话状态锁异常")?;
        let session = sessions
            .get(session_id)
            .ok_or("AgentSession 不存在或已关闭")?;
        if session.generation != generation {
            return Err("AgentSession generation 已变更".into());
        }
        if session
            .active
            .as_ref()
            .is_none_or(|active| active.execution_id != execution_id)
        {
            return Err("当前 AgentSession 未运行指定 executionId".into());
        }
        Ok(())
    }
}

fn parse_runtime_progress(output: &str) -> AgentRuntimeProgress {
    let value = |key: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
    };
    AgentRuntimeProgress {
        active: value("active") == Some("1"),
        process_count: value("processCount")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        cpu_percent: value("cpuPercent")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0.0),
        io_bytes: value("ioBytes")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
    }
}

#[tauri::command]
pub(crate) fn create_agent_terminal(
    app: AppHandle,
    manager: State<'_, AgentTerminalManager>,
    server_id: String,
    task_id: String,
    host: String,
    port: u16,
    username: String,
) -> Result<AgentSessionInfo, String> {
    if server_id.trim().is_empty()
        || task_id.trim().is_empty()
        || host.trim().is_empty()
        || username.trim().is_empty()
    {
        return Err("AgentSession 缺少显式任务或 SSH 目标".into());
    }
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态锁异常")?;
    if let Some((session_id, session)) = sessions.iter().find(|(_, session)| {
        session.task_id == task_id
            && session.target.server_id == server_id
            && session.state != "closed"
    }) {
        return Ok(AgentTerminalManager::info(session_id, session));
    }
    if sessions
        .values()
        .any(|session| session.task_id == task_id && session.active.is_some())
    {
        return Err("当前任务的 AgentSession 仍在执行，不能切换目标服务器".into());
    }
    // A task has exactly one current execution target. Retire an idle session
    // before creating the replacement so a server.connect step cannot leave a
    // second hidden Agent execution plane behind.
    sessions.retain(|_, session| session.task_id != task_id);
    let sequence = manager.next_session.fetch_add(1, Ordering::Relaxed) + 1;
    let generation = manager.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let session_id = format!("agent-session-{sequence}");
    let session = AgentSessionState {
        task_id,
        generation,
        state: "ready".into(),
        target: AgentTarget {
            server_id,
            host,
            port,
            username,
        },
        context: AgentSessionContext::default(),
        active: None,
        created_at: format!("{}", crate::unix_seconds()),
    };
    let info = AgentTerminalManager::info(&session_id, &session);
    sessions.insert(session_id.clone(), session);
    drop(sessions);
    emit_agent_event(
        &app,
        &session_id,
        generation,
        None,
        "AgentSession ready",
        "system",
    );
    Ok(info)
}

#[tauri::command]
pub(crate) fn update_agent_session_context(
    manager: State<'_, AgentTerminalManager>,
    session_id: String,
    generation: u64,
    mut context: AgentSessionContext,
) -> Result<AgentSessionInfo, String> {
    validate_context(&context)?;
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态锁异常")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("AgentSession 不存在或已关闭")?;
    if session.generation != generation || session.active.is_some() {
        return Err("AgentSession 已变更或正在执行，拒绝更新上下文".into());
    }
    context.revision = session.context.revision + 1;
    session.context = context;
    Ok(AgentTerminalManager::info(&session_id, session))
}

#[tauri::command(async)]
pub(crate) async fn execute_agent_terminal_command(
    app: AppHandle,
    manager: State<'_, AgentTerminalManager>,
    host: String,
    port: u16,
    username: String,
    password: String,
    session_id: String,
    generation: u64,
    execution_id: String,
    command: String,
    scope: String,
    approved_high_risk: bool,
    prompt_credential: Option<AgentPromptCredential>,
) -> Result<AgentCommandResult, String> {
    if let Some(rejection) = crate::command_safety_rejection(&command) {
        return Ok(AgentCommandResult {
            output: rejection.output,
            success: false,
            simulated: false,
            exit_code: rejection.exit_code,
            empty_result: false,
            session_id,
            generation,
            scope,
        });
    }
    if risk_for(&command) == "high" && !approved_high_risk {
        return Ok(AgentCommandResult {
            output: "[安全策略] 高危命令已拦截，未发送至服务器".into(),
            success: false,
            simulated: false,
            exit_code: 126,
            empty_result: false,
            session_id,
            generation,
            scope,
        });
    }
    let (context, cancel) = manager.begin_execution(
        &session_id,
        generation,
        &execution_id,
        (&host, port, &username),
    )?;
    let scoped_command = match command_for_scope(&scope, &command, &context) {
        Ok(command) => command,
        Err(error) => {
            manager.finish_execution(&session_id, &execution_id)?;
            return Err(error);
        }
    };
    emit_agent_event(
        &app,
        &session_id,
        generation,
        Some(&execution_id),
        "",
        "begin",
    );
    let app_handle = app.clone();
    let event_session_id = session_id.clone();
    let event_execution_id = execution_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let ssh = connect_ssh(&host, port, &username, &password)?;
        let mut emit = |chunk: String, stream: &str| {
            emit_agent_event(
                &app_handle,
                &event_session_id,
                generation,
                Some(&event_execution_id),
                chunk,
                stream,
            );
        };
        if let Some(credential) = prompt_credential {
            let credential = InteractivePromptCredential {
                kind: credential.kind,
                username: credential.username,
                secret: credential.secret,
                target: credential.target,
            };
            ssh_exec_streaming_with_prompt(
                &ssh,
                &event_execution_id,
                &scoped_command,
                &cancel,
                &credential,
                &mut emit,
            )
        } else {
            ssh_exec_streaming(
                &ssh,
                &event_execution_id,
                &scoped_command,
                &cancel,
                &mut emit,
            )
        }
    })
    .await
    .map_err(|error| format!("Agent 远程执行线程异常：{error}"));
    let (output, status) = match result {
        Ok(Ok(value)) => {
            manager.finish_execution(&session_id, &execution_id)?;
            value
        }
        Ok(Err(error)) => {
            let next_generation =
                manager.recover_after_transport_failure(&session_id, &execution_id)?;
            emit_agent_event(
                &app,
                &session_id,
                next_generation,
                Some(&execution_id),
                "AgentSession transport recovered; generation changed",
                "error",
            );
            return Err(error);
        }
        Err(error) => {
            let next_generation =
                manager.recover_after_transport_failure(&session_id, &execution_id)?;
            emit_agent_event(
                &app,
                &session_id,
                next_generation,
                Some(&execution_id),
                "AgentSession worker failed; generation changed",
                "error",
            );
            return Err(format!("Agent 远程执行线程异常：{error}"));
        }
    };
    let empty_result = crate::is_valid_empty_result(&command, status, &output);
    let result_text = if empty_result {
        "未发现匹配项（命令正常完成）".into()
    } else if output.is_empty() {
        "命令未产生输出".into()
    } else {
        output
    };
    emit_agent_event(
        &app,
        &session_id,
        generation,
        Some(&execution_id),
        format!("[exit: {status}]"),
        "end",
    );
    Ok(AgentCommandResult {
        output: format!("{result_text}\n[exit: {status}]"),
        success: status == 0 || empty_result,
        simulated: false,
        exit_code: status,
        empty_result,
        session_id,
        generation,
        scope,
    })
}

#[tauri::command(async)]
pub(crate) async fn interrupt_agent_terminal_command(
    manager: State<'_, AgentTerminalManager>,
    host: String,
    port: u16,
    username: String,
    password: String,
    session_id: String,
    generation: u64,
    execution_id: String,
) -> Result<bool, String> {
    let pid_file = execution_pid_file(&execution_id)?;
    let acknowledged = {
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| "Agent 会话状态锁异常")?;
        let session = sessions
            .get(&session_id)
            .ok_or("AgentSession 不存在或已关闭")?;
        if session.generation != generation {
            return Err("AgentSession generation 已变更".into());
        }
        if let Some(active) = &session.active {
            if active.execution_id != execution_id {
                return Err("中断请求与当前 Agent 命令不匹配".into());
            }
            active.cancel.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    };
    if !acknowledged {
        return Ok(true);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&host, port, &username, &password)?;
        let command = format!(
            "if test -s {0}; then pid=$(cat {0}); kill -TERM -- -\"$pid\" 2>/dev/null || kill -TERM \"$pid\" 2>/dev/null || true; sleep 1; kill -KILL -- -\"$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true; rm -f {0}; fi",
            shell_quote(&pid_file),
        );
        ssh_exec(&session, &command).map(|_| true)
    })
    .await
    .map_err(|error| format!("中断 Agent 执行线程异常：{error}"))?
}

#[tauri::command(async)]
pub(crate) async fn sample_agent_terminal_progress(
    manager: State<'_, AgentTerminalManager>,
    host: String,
    port: u16,
    username: String,
    password: String,
    session_id: String,
    generation: u64,
    execution_id: String,
) -> Result<AgentRuntimeProgress, String> {
    manager.validate_active_execution(&session_id, generation, &execution_id)?;
    let pid_file = execution_pid_file(&execution_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&host, port, &username, &password)?;
        let command = format!(
            r#"pid_file={};
if ! test -s "$pid_file"; then printf 'active=0\nprocessCount=0\ncpuPercent=0\nioBytes=0\n'; exit 0; fi
leader=$(cat "$pid_file" 2>/dev/null)
if ! test -n "$leader" || ! kill -0 "$leader" 2>/dev/null; then printf 'active=0\nprocessCount=0\ncpuPercent=0\nioBytes=0\n'; exit 0; fi
pgid=$(ps -o pgid= -p "$leader" 2>/dev/null | tr -d ' ')
stats=$(ps -eo pgid=,%cpu= 2>/dev/null | awk -v g="$pgid" '$1 == g {{ count += 1; cpu += $2 }} END {{ printf "%d %.2f", count, cpu }}')
set -- $stats; count=${{1:-1}}; cpu=${{2:-0}}; io=0
for pid in $(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$pgid" '$2 == g {{ print $1 }}'); do
  if test -r "/proc/$pid/io"; then bytes=$(awk '/^(rchar|wchar):/ {{ sum += $2 }} END {{ print sum + 0 }}' "/proc/$pid/io" 2>/dev/null); io=$((io + bytes)); fi
done
printf 'active=1\nprocessCount=%s\ncpuPercent=%s\nioBytes=%s\n' "$count" "$cpu" "$io""#,
            shell_quote(&pid_file),
        );
        let (output, status) = ssh_exec(&session, &command)?;
        if status != 0 {
            return Err(format!("Agent 运行态采样失败，退出码 {status}"));
        }
        Ok(parse_runtime_progress(&output))
    })
    .await
    .map_err(|error| format!("Agent 运行态采样线程异常：{error}"))?
}

#[tauri::command]
pub(crate) fn close_agent_terminal(
    app: AppHandle,
    manager: State<'_, AgentTerminalManager>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态锁异常")?;
    let session = sessions
        .get(&session_id)
        .ok_or("AgentSession 不存在或已关闭")?;
    if session.active.is_some() {
        return Err("必须先中断当前 Agent 命令再关闭会话".into());
    }
    let generation = session.generation;
    sessions.remove(&session_id);
    drop(sessions);
    emit_agent_event(
        &app,
        &session_id,
        generation,
        None,
        "AgentSession closed",
        "system",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_only_structured_non_secret_context() {
        let context = AgentSessionContext {
            cwd: Some("/opt/app".into()),
            environment: HashMap::from([("NODE_ENV".into(), "production".into())]),
            source_files: vec!["/root/.nvm/nvm.sh".into()],
            shell: "bash".into(),
            revision: 1,
        };
        let command = command_for_scope("agent_session", "node -v", &context).unwrap();
        assert!(command.contains("/opt/app"));
        assert!(command.contains("NODE_ENV"));
        assert!(command.contains("production"));
        assert!(command.contains("/root/.nvm/nvm.sh"));
        assert!(command.contains("node -v"));
    }

    #[test]
    fn rejects_secrets_and_user_shell_injection() {
        let mut context = AgentSessionContext::default();
        context
            .environment
            .insert("API_TOKEN".into(), "private".into());
        assert!(validate_context(&context)
            .unwrap_err()
            .contains("不允许持久化"));
        assert!(command_for_scope(
            "user_action",
            "source ~/.bashrc",
            &AgentSessionContext::default()
        )
        .is_err());
    }

    #[test]
    fn fresh_shell_scopes_are_explicit() {
        let context = AgentSessionContext::default();
        assert_eq!(
            command_for_scope("fresh_interactive_shell", "type nvm", &context).unwrap(),
            "bash -ic 'type nvm'"
        );
        assert_eq!(
            command_for_scope("fresh_login_shell", "type nvm", &context).unwrap(),
            "bash -lc 'type nvm'"
        );
    }

    #[test]
    fn fresh_login_shell_detects_bash_profile_precedence_over_profile() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!(
            "opsark-login-precedence-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            home.join(".profile"),
            "export OPSARK_PROFILE_PRECEDENCE=loaded\n",
        )
        .unwrap();
        std::fs::write(home.join(".bash_profile"), ":\n").unwrap();

        let validation = command_for_scope(
            "fresh_login_shell",
            "test \"${OPSARK_PROFILE_PRECEDENCE-unset}\" = loaded",
            &AgentSessionContext::default(),
        )
        .unwrap();
        let blocked = std::process::Command::new("sh")
            .arg("-c")
            .arg(&validation)
            .env("HOME", &home)
            .status()
            .unwrap();
        assert!(
            !blocked.success(),
            ".bash_profile must prevent the implicit .profile fallback"
        );

        std::fs::remove_file(home.join(".bash_profile")).unwrap();
        let fallback = std::process::Command::new("sh")
            .arg("-c")
            .arg(&validation)
            .env("HOME", &home)
            .status()
            .unwrap();
        std::fs::remove_dir_all(&home).unwrap();
        assert!(
            fallback.success(),
            ".profile must load when no higher-priority file exists"
        );
    }

    #[test]
    fn parses_bounded_runtime_progress() {
        assert_eq!(
            parse_runtime_progress("active=1\nprocessCount=3\ncpuPercent=21.50\nioBytes=4096")
                .process_count,
            3
        );
        assert!(!parse_runtime_progress("active=0").active);
    }
}
