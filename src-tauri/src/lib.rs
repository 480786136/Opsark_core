mod command_guard;
mod credential;
mod file_tree;
mod json_contract;
mod metrics;
mod model;
mod sftp;
mod sftp_transfer;
mod ssh;
mod terminal;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use command_guard::risk_for;
use credential::{delete_credential, load_credential, save_credential};
use file_tree::{scan_sftp, FileStructureResult};
use json_contract::{parse_model_array_field, parse_model_json};
use metrics::{get_realtime_metrics, get_ssh_metrics};
use model::{check_model_availability, message_content, post_model_request};
use sftp::{
    create_sftp_directory, delete_sftp_entry, list_sftp_directory, read_sftp_file,
    rename_sftp_entry, write_sftp_file,
};
use sftp_transfer::{
    cancel_sftp_transfer, download_sftp_transfer, upload_sftp_transfer, SftpTransferManager,
};
use ssh::{connect_ssh, execution_pid_file, shell_quote, ssh_exec, ssh_exec_streaming};
use terminal::{
    close_ssh_terminal, resize_ssh_terminal, start_ssh_terminal, write_ssh_terminal,
    TerminalManager,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    os: String,
    kernel: String,
    cpu: String,
    cores: u16,
    memory_gb: u32,
    disk_gb: u32,
    uptime: String,
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
#[serde(rename_all = "camelCase")]
struct SshProbe {
    info: ServerInfo,
    environment: Vec<String>,
    hostname: String,
}

#[derive(Default)]
struct ExecutionManager {
    executions: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandOutputEvent {
    execution_id: String,
    data: String,
    stream: String,
}

const STRICT_JSON_OUTPUT_RULE: &str = "输出格式是强制协议：必须只返回一个完整、可由标准 JSON 解析器直接解析的对象；禁止 Markdown 代码块、前后说明、注释、尾随逗号、NaN/Infinity 和未转义的反斜杠。必须严格使用系统消息指定的字段、类型和枚举值，不得增加或省略必填字段。返回前请自检 JSON 语法和结构。";
const PLAN_STEP_OUTPUT_CONTRACT: &str = r#"输出必须是 {"steps":[...]} 对象，steps 必须至少有 1 个元素。
每个元素必须严格包含且只包含：{"title":"非空字符串","description":"非空字符串","command":"非空字符串","expected":"非空字符串","validation":"非空字符串","risk":"low|medium|high"}。
字段内容应清晰、直接并保持完成任务所需的完整信息。command 和 validation 可以包含换行，但必须按标准 JSON 规则转义。
Shell 反斜杠在 JSON 字符串内必须写成双反斜杠，例如 Shell 的 \( 必须输出为 \\( 的 JSON 文本。
输出前逐个检查六个字段，必须保证整个 JSON 对象完整闭合，不得截断任何字段。"#;
const REQUIREMENT_CLASSIFICATION_CONTRACT: &str = r#"本阶段只做需求分类、终端上下文判断和约束提取，禁止输出 steps、command、validation 或执行计划。必须先判断回答或计划是否依赖用户之前的终端输入/输出：如依赖且 terminalContext.content 未提供或范围不够，返回 terminal_context，terminalContextLines 必须大于当前 includedLines，且不超过 totalLines 和 400；不依赖则不得请求终端内容。咨询类必须严格输出：{"intent":"answer","answer":"非空回答","constraints":null,"terminalContextLines":0}。执行类必须严格输出：{"intent":"execute","answer":"","constraints":{"changePolicy":"unspecified|read_only|requested_changes_only|allow_necessary_changes","environmentPolicy":"unspecified|preserve|allow_isolated_changes|allow_host_changes","failurePolicy":"unspecified|strict|best_effort","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},"terminalContextLines":0}。需要更多终端内容时必须严格输出：{"intent":"terminal_context","answer":"","constraints":null,"terminalContextLines":80}。顶层只允许 intent、answer、constraints、terminalContextLines 四个字段。"#;
const SECRET_PLACEHOLDER_RULE: &str = "敏感变量规则：${secret.NAME} 是 Opsark 的执行时传输占位符，不是要保留在远端文件里的字面量。必须原样写成 ${secret.NAME}，绝对不得在美元符号前添加反斜杠。程序会在 SSH 执行前注入真实值，并在输出、日志和模型上下文中脱敏。模型看到的 •••••••• 只表示真实值已被脱敏：它既不是远端文件的实际内容，也不能证明具体密码正确或错误，更不能据此声称占位符未解析。选择变量时名称和说明必须与目标凭据语义一致；若现有变量无法区分目标账户或用途，应使用新的、用途明确的变量名，由界面向用户索取，不能静默借用含义模糊的旧值。写入远端配置后应使用不泄露秘密的功能性后置条件校验；校验命令中仍可使用同一占位符供程序注入。不得要求远端保留 Opsark 占位符，也不得因脱敏标记判定泄露、写入失败或密码错误。除非用户明确禁止持久化密码，不得自行增加该限制。";
const GENERAL_PLAN_SYSTEM: &str = r#"角色：通用运维计划器。

目标：仅根据用户需求、当前上下文和已验证证据，生成当前确实可执行的最小计划。

决策顺序：
1. 先识别用户的整体目标、明确约束和现有证据。
2. 不得预设技术栈、工具、路径、端口、服务名或资源名。
3. 证据不足时，只生成最少必要的只读发现步骤；不得同时生成依赖未知发现结果的推测性变更。
4. 证据充足时，按“必要确认→变更→最终验收”生成最少必要的计划。
5. 每步在独立非交互 Shell 中运行，所需目录和环境必须在当步建立。
6. 用户只要求修改已有资源的部分字段时，必须保留无关内容并做可恢复备份；不得用新模板覆盖整个结构化配置，除非用户明确要求整体替换或证据证明这是完整目标内容。

校验规则：
- validation 必须独立、只读且可执行，退出码 0 表示已获得足够判断 expected 的证据。
- 对象不存在、查询无匹配或观察到异常可以是有效发现，不等于命令失败。
- 不得重复已完成步骤，不得生成超出用户授权的不可逆操作。

输出：只返回符合计划输出契约的 JSON 对象。"#;
const GENERAL_DISCOVERY_RULES: &str = "对于需要发现实际实现方式的任务，先读取目标自带的说明、声明、配置、入口和已有状态，由证据确定依赖、运行方式、构建方式、部署方式和验收标准。核心不提供任何领域工具或技术栈的默认方案；只能使用当前证据明确展示的能力。发现步骤的校验只确认证据可获得，不要把可选信息缺失判为失败。";
const GENERAL_REQUIREMENT_SYSTEM: &str = "你是通用运维需求分类器，本阶段不生成计划。判断用户是仅需要不依赖当前环境的知识性回答，还是需要读取或改变真实目标环境。需要当前状态、真实数据或任何环境变更时必须返回 execute。结构化约束只能来自用户明确表达，不得猜测或自行增加。";
const GENERAL_SUMMARY_SYSTEM: &str = "你是通用运维结果总结器。仅根据用户目标和脱敏的真实执行证据总结。结构化 result 和 evidence.facts 优先于预期文本和旧总结。有效的“未发现”、“非健康”或“警告”是观察结果，不等于命令执行失败。若存在关键失败且无后续证据证明目标已达成，必须明确说明任务未完成、最终阻断、已确认结果和尚未满足的目标。若目标已达成，必须直接给出用户所需的具体结果。不得把某个中间信号自动归因给目标对象，除非证据已建立关联。不得虚构、输出命令或泄露敏感信息。使用一至三段中文纯文本。";
const GENERAL_REVIEW_SYSTEM: &str = "你是通用运维执行复核员。根据原始用户目标、executionConstraints、完整计划、已完成记录、当前步骤真实证据和剩余步骤，判断工作流应 continue、adjust 或 complete。只返回包含 decision、reason、summary 的 JSON 对象。不得把真实失败改写为成功，不得虚构证据、新命令或新的用户授权。当前异常若不阻断整体目标，或剩余计划有明确且符合约束的恢复路径，返回 continue；若已阻断目标、证据不足或剩余计划无法处理，返回 adjust；只有用户整体目标已被真实证据充分证明时才返回 complete。对只读发现，得到“不存在”或异常状态是有效结果，应根据剩余计划判断。对变更步骤，后置条件未满足时不得 complete。当 trigger 为长时间运行定期复核时，必须忽略后续步骤是否值得执行，只判断当前命令是否仍需等待：continue 只表示当前命令仍在运行且需继续等待；adjust 表示停止并调整；complete 仅在 periodicObservation.passed=true 时表示当前命令已可停止等待并进入正式校验。不得用“继续执行剩余步骤”作为 continue 的理由。安全拦截、用户审批、真实执行结果和程序门禁不可被覆盖。";
const STRUCTURED_OUTPUT_ATTEMPTS: usize = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AiPlanStep {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    expected: String,
    #[serde(default)]
    validation: String,
    #[serde(default)]
    risk: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiGenerationSettings {
    limit_output: bool,
    max_plan_steps: usize,
    max_output_tokens: u64,
    max_text_chars: usize,
    max_command_chars: usize,
}

impl Default for AiGenerationSettings {
    fn default() -> Self {
        Self {
            limit_output: false,
            max_plan_steps: 6,
            max_output_tokens: 5000,
            max_text_chars: 200,
            max_command_chars: 4000,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AiRequirementDecision {
    intent: String,
    answer: String,
    constraints: Value,
    #[serde(rename = "terminalContextLines")]
    #[serde(default)]
    terminal_context_lines: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ExecutionConstraints {
    change_policy: String,
    environment_policy: String,
    failure_policy: String,
    prohibited_actions: Vec<String>,
    required_conditions: Vec<String>,
    user_directives: Vec<String>,
}

#[derive(Debug, Serialize)]
struct RequirementProcessingResult {
    intent: String,
    answer: Option<String>,
    plan: Vec<PlanStep>,
    constraints: Option<ExecutionConstraints>,
    #[serde(rename = "terminalContextLines")]
    terminal_context_lines: usize,
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

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn convert_ai_plan_steps(raw_steps: Vec<AiPlanStep>) -> Result<Vec<PlanStep>, String> {
    if raw_steps.is_empty() {
        return Err("模型计划至少需要一个步骤".into());
    }
    raw_steps
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let command = item.command.trim().to_string();
            let validation = item.validation.trim().to_string();
            if command.is_empty() || validation.is_empty() {
                return Err(format!(
                    "第 {} 个计划步骤缺少非空 command 或 validation",
                    index + 1
                ));
            }
            if matches!(validation.as_str(), "true" | ":" | "exit 0" | "/bin/true") {
                return Err(format!(
                    "第 {} 个计划步骤使用了无业务意义的 validation；必须用独立、只读且能验证 expected 的命令",
                    index + 1
                ));
            }
            let description = if item.description.trim().is_empty() {
                item.title.trim().to_string()
            } else {
                item.description.trim().to_string()
            };
            let title = if item.title.trim().is_empty() {
                let candidate = description
                    .split(['。', '；', '\n'])
                    .next()
                    .unwrap_or("")
                    .trim();
                if candidate.is_empty() {
                    format!("执行步骤 {}", index + 1)
                } else {
                    candidate.chars().take(36).collect()
                }
            } else {
                item.title.trim().to_string()
            };
            let description = if description.is_empty() {
                title.clone()
            } else {
                description
            };
            let expected = if item.expected.trim().is_empty() {
                "获得可用于判断用户目标的执行证据".to_string()
            } else {
                item.expected.trim().to_string()
            };
            let computed = risk_for(&item.command);
            let supplied = item
                .risk
                .as_deref()
                .filter(|value| matches!(*value, "low" | "medium" | "high"))
                .ok_or_else(|| format!("第 {} 个计划步骤缺少合法 risk", index + 1))?;
            let risk = if computed == "high" || supplied == "high" {
                "high"
            } else if computed == "medium" || supplied == "medium" {
                "medium"
            } else {
                "low"
            };
            Ok(PlanStep {
                id: format!("ai-step-{}-{index}", unix_seconds()),
                title,
                description,
                command,
                risk: risk.into(),
                expected,
                validation,
                status: "pending".into(),
                output: None,
            })
        })
        .collect()
}

fn validate_ai_plan_contract(
    raw_steps: &[AiPlanStep],
    settings: &AiGenerationSettings,
) -> Result<(), String> {
    if raw_steps.is_empty() {
        return Err("计划 steps 至少需要 1 个元素".into());
    }
    if settings.limit_output && raw_steps.len() > settings.max_plan_steps.max(1) {
        return Err(format!(
            "计划 steps 数量不能超过配置的 {} 个",
            settings.max_plan_steps.max(1)
        ));
    }
    for (index, item) in raw_steps.iter().enumerate() {
        let mut missing = Vec::new();
        if item.title.trim().is_empty() {
            missing.push("title");
        }
        if item.description.trim().is_empty() {
            missing.push("description");
        }
        if item.command.trim().is_empty() {
            missing.push("command");
        }
        if item.expected.trim().is_empty() {
            missing.push("expected");
        }
        if item.validation.trim().is_empty() {
            missing.push("validation");
        }
        if !missing.is_empty() {
            return Err(format!(
                "第 {} 个计划步骤缺少非空字段：{}",
                index + 1,
                missing.join("、")
            ));
        }
        if settings.limit_output
            && (item.title.chars().count() > settings.max_text_chars.max(1)
                || item.description.chars().count() > settings.max_text_chars.max(1)
                || item.expected.chars().count() > settings.max_text_chars.max(1))
        {
            return Err(format!(
                "第 {} 个计划步骤的文本字段超过配置的 {} 字符",
                index + 1,
                settings.max_text_chars.max(1)
            ));
        }
        if settings.limit_output
            && (item.command.chars().count() > settings.max_command_chars.max(1)
                || item.validation.chars().count() > settings.max_command_chars.max(1))
        {
            return Err(format!(
                "第 {} 个计划步骤的 command 或 validation 超过配置的 {} 字符",
                index + 1,
                settings.max_command_chars.max(1)
            ));
        }
        if !item
            .risk
            .as_deref()
            .is_some_and(|value| matches!(value, "low" | "medium" | "high"))
        {
            return Err(format!(
                "第 {} 个计划步骤 risk 必须是 low、medium 或 high",
                index + 1
            ));
        }
    }
    Ok(())
}

fn is_valid_empty_result(command: &str, status: i32, output: &str) -> bool {
    if status != 1 || !output.trim().is_empty() {
        return false;
    }
    let lower = command.to_lowercase();
    lower.contains("grep ") || lower.contains("grep -") || lower.contains("pgrep ")
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
        "printf '%s\\n' \"$(hostname)\" \"$(uname -srm)\" \"$(. /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-Unknown})\" \"$(nproc 2>/dev/null || echo 1)\" \"$(awk '/MemTotal:/{print $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)\" \"$(df -Pk / 2>/dev/null | awk 'NR==2{print $2/1048576}' || echo 0)\" \"$(uptime -p 2>/dev/null || uptime)\"",
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
        memory_gb: lines[4].trim().parse::<f64>().unwrap_or(0.0).ceil() as u32,
        disk_gb: lines[5].trim().parse::<f64>().unwrap_or(0.0).ceil() as u32,
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
        ssh_exec_streaming(
            &session,
            &id,
            &command,
            cancel_flag.as_ref(),
            |chunk, stream| emit_command_output(&app_handle, &id, chunk, stream),
        )
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

#[tauri::command(async)]
fn get_remote_file_structure(
    host: String,
    port: u16,
    username: String,
    password: String,
    root_path: String,
    exclude_directories: Option<Vec<String>>,
    max_depth: Option<usize>,
    max_nodes: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<FileStructureResult, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    scan_sftp(
        &sftp,
        root_path,
        exclude_directories.unwrap_or_default(),
        max_depth.unwrap_or(6),
        max_nodes.unwrap_or(2000),
        include_hidden.unwrap_or(false),
    )
}

#[tauri::command]
async fn generate_ai_plan(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    generation_settings: Option<AiGenerationSettings>,
) -> Result<Vec<PlanStep>, String> {
    let generation_settings = generation_settings.unwrap_or_default();
    let limit_rule = if generation_settings.limit_output {
        format!(
            "已启用用户配置的输出限制：steps 不超过 {} 个；title、description、expected 各不超过 {} 字符；command、validation 各不超过 {} 字符。",
            generation_settings.max_plan_steps.max(1),
            generation_settings.max_text_chars.max(1),
            generation_settings.max_command_chars.max(1),
        )
    } else {
        "用户未启用计划输出限制：不得因步骤数、字段长度或命令换行而省略必要内容；仍应保持计划最少且完整。".to_string()
    };
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = GENERAL_PLAN_SYSTEM;
    let deployment_rules = GENERAL_DISCOVERY_RULES;
    let mut last_error = "模型未返回计划".to_string();
    let mut last_repairable_steps = None;
    for attempt in 0..STRUCTURED_OUTPUT_ATTEMPTS {
        let correction = if attempt == 0 {
            String::new()
        } else {
            format!(
                "\n\n上次输出未通过结构校验：{last_error}。请丢弃上次输出并重新返回完整对象，保持内容必要且完整，不得截断 JSON，逐步补齐所有必填字段。"
            )
        };
        let mut body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{deployment_rules}\n{PLAN_STEP_OUTPUT_CONTRACT}\n{limit_rule}\n{SECRET_PLACEHOLDER_RULE}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("服务器上下文：\n{context}\n\n用户需求：\n{requirement}\n\n返回前再次确认：{PLAN_STEP_OUTPUT_CONTRACT}\n{limit_rule}\n{STRICT_JSON_OUTPUT_RULE}{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"}
        });
        if generation_settings.limit_output {
            body["max_tokens"] = json!(generation_settings.max_output_tokens.max(256));
        }
        let payload = post_model_request(&url, &api_key, &body, "计划生成", 60).await?;
        let finish_reason = payload
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str);
        if finish_reason.is_some_and(|reason| reason != "stop") {
            last_error = if finish_reason == Some("length") {
                "模型计划因达到输出长度上限而被截断".to_string()
            } else {
                format!(
                    "模型计划未正常完成，finish_reason={}",
                    finish_reason.unwrap_or("未知")
                )
            };
            continue;
        }
        let parsed = message_content(&payload, "模型响应缺少计划内容").and_then(|content| {
            parse_model_array_field(content, "steps")
                .map_err(|error| format!("模型计划结构解析失败：{error}"))
        });
        match parsed {
            Ok(raw_steps) => {
                last_repairable_steps = Some(raw_steps.clone());
                match validate_ai_plan_contract(&raw_steps, &generation_settings)
                    .and_then(|_| convert_ai_plan_steps(raw_steps))
                {
                    Ok(plan) => return Ok(plan),
                    Err(error) => last_error = error,
                }
            }
            Err(error) => last_error = error,
        }
    }
    if let Some(raw_steps) = last_repairable_steps {
        let only_presentational_fields_missing = raw_steps.iter().all(|item| {
            !item.command.trim().is_empty()
                && !item.validation.trim().is_empty()
                && item
                    .risk
                    .as_deref()
                    .is_some_and(|value| matches!(value, "low" | "medium" | "high"))
        });
        let within_enabled_limits = !generation_settings.limit_output
            || (raw_steps.len() <= generation_settings.max_plan_steps.max(1)
                && raw_steps.iter().all(|item| {
                    item.title.chars().count() <= generation_settings.max_text_chars.max(1)
                        && item.description.chars().count()
                            <= generation_settings.max_text_chars.max(1)
                        && item.expected.chars().count()
                            <= generation_settings.max_text_chars.max(1)
                        && item.command.chars().count()
                            <= generation_settings.max_command_chars.max(1)
                        && item.validation.chars().count()
                            <= generation_settings.max_command_chars.max(1)
                }));
        if only_presentational_fields_missing && within_enabled_limits {
            return convert_ai_plan_steps(raw_steps);
        }
    }
    Err(format!(
        "{last_error}（已要求模型按严格 JSON 格式重试一次）"
    ))
}

#[tauri::command]
async fn process_ai_requirement(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    generation_settings: Option<AiGenerationSettings>,
) -> Result<RequirementProcessingResult, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = GENERAL_REQUIREMENT_SYSTEM;
    let mut last_error = "模型未返回需求理解结果".to_string();
    let mut valid_decision = None;
    for attempt in 0..STRUCTURED_OUTPUT_ATTEMPTS {
        let correction = if attempt == 0 {
            String::new()
        } else {
            format!(
                "\n\n上次输出未通过需求分类结构校验：{last_error}。请丢弃上次输出，严格按分类契约重新返回完整对象，不得输出 steps 或计划字段。"
            )
        };
        let body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{SECRET_PLACEHOLDER_RULE}\n{REQUIREMENT_CLASSIFICATION_CONTRACT}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("服务器上下文：\n{context}\n\n用户输入：\n{requirement}\n\n返回前再次确认：{REQUIREMENT_CLASSIFICATION_CONTRACT}\n{STRICT_JSON_OUTPUT_RULE}{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": 700
        });
        let payload = post_model_request(&url, &api_key, &body, "需求理解", 45).await?;
        let parsed = message_content(&payload, "模型响应缺少需求理解结果").and_then(|content| {
            parse_model_json(content).map_err(|error| format!("需求理解结构解析失败：{error}"))
        });
        let decision: AiRequirementDecision = match parsed {
            Ok(decision) => decision,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        let contract_error = match decision.intent.as_str() {
            "answer" if !decision.answer.trim().is_empty() && decision.constraints.is_null() && decision.terminal_context_lines == 0 => {
                None
            }
            "answer" => Some("咨询类响应的 answer 必须是非空字符串".to_string()),
            "execute"
                if decision.answer.trim().is_empty()
                    && serde_json::from_value::<ExecutionConstraints>(
                        decision.constraints.clone(),
                    )
                    .is_ok() && decision.terminal_context_lines == 0 =>
            {
                None
            }
            "execute" => {
                Some("执行类响应的 answer 必须为空字符串，constraints 必须包含合法字段".to_string())
            }
            "terminal_context" if decision.answer.trim().is_empty()
                && decision.constraints.is_null()
                && (1..=400).contains(&decision.terminal_context_lines) => None,
            "terminal_context" => Some("终端上下文请求必须给出 1 到 400 行".to_string()),
            _ => Some("需求分类 intent 只能是 answer、execute 或 terminal_context".to_string()),
        };
        if let Some(error) = contract_error {
            last_error = error;
            continue;
        }
        valid_decision = Some(decision);
        break;
    }
    let decision = valid_decision
        .ok_or_else(|| format!("{last_error}（已要求模型按严格 JSON 格式重试一次）"))?;
    if decision.intent == "answer" {
        return Ok(RequirementProcessingResult {
            intent: "answer".into(),
            answer: Some(decision.answer.trim().to_string()),
            plan: Vec::new(),
            constraints: None,
            terminal_context_lines: 0,
        });
    }
    if decision.intent == "terminal_context" {
        return Ok(RequirementProcessingResult {
            intent: "terminal_context".into(),
            answer: None,
            plan: Vec::new(),
            constraints: None,
            terminal_context_lines: decision.terminal_context_lines,
        });
    }

    let constraints = serde_json::from_value::<ExecutionConstraints>(decision.constraints)
        .map(Some)
        .map(normalize_execution_constraints)
        .map_err(|error| format!("需求分类 constraints 结构无效：{error}"))?;
    let plan = generate_ai_plan(
        api_key,
        endpoint,
        model,
        requirement,
        context,
        generation_settings,
    )
    .await
    .map_err(|error| format!("需求已判定为执行类，但计划生成失败：{error}"))?;
    Ok(RequirementProcessingResult {
        intent: "execute".into(),
        answer: None,
        plan,
        constraints: Some(constraints),
        terminal_context_lines: 0,
    })
}

#[tauri::command]
async fn check_ai_model(
    api_key: String,
    endpoint: String,
    model: String,
) -> Result<ModelCheckResult, String> {
    let availability = check_model_availability(&api_key, &endpoint, &model).await?;
    Ok(ModelCheckResult {
        available: availability.available,
        reason: availability.reason,
    })
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
    let system = GENERAL_SUMMARY_SYSTEM;
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": format!("{system}\n{SECRET_PLACEHOLDER_RULE}")},
            {"role": "user", "content": format!("用户需求：\n{requirement}\n\n已脱敏的执行结果：\n{execution_context}")}
        ],
        "thinking": {"type": "disabled"},
        "max_tokens": 700
    });
    let payload = post_model_request(&url, &api_key, &body, "模型总结", 30).await?;
    let content = message_content(&payload, "模型总结为空")?.trim();
    if content.is_empty() {
        Err("模型总结为空".to_string())
    } else {
        Ok(content.to_owned())
    }
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
    let system = GENERAL_REVIEW_SYSTEM;
    let mut last_error = "模型未返回复核结果".to_string();
    for attempt in 0..STRUCTURED_OUTPUT_ATTEMPTS {
        let correction = if attempt == 0 {
            String::new()
        } else {
            format!(
                "\n\n上次输出未通过结构校验：{last_error}。请重新返回同时包含 decision、reason、summary 三个非空字符串的完整 JSON 对象。"
            )
        };
        let body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{SECRET_PLACEHOLDER_RULE}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("用户目标：\n{requirement}\n\n执行复核上下文：\n{review_context}\n\n返回前再次确认：必须为 {{\"decision\":\"continue|adjust|complete\",\"reason\":\"非空字符串\",\"summary\":\"非空字符串\"}}。{STRICT_JSON_OUTPUT_RULE}{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": 500
        });
        let payload = post_model_request(&url, &api_key, &body, "结果复核", 25).await?;
        let parsed = message_content(&payload, "模型结果复核缺少内容").and_then(|content| {
            parse_model_json(content).map_err(|error| format!("模型结果复核结构解析失败：{error}"))
        });
        let review: AiStepReview = match parsed {
            Ok(review) => review,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        if !matches!(review.decision.as_str(), "continue" | "adjust" | "complete") {
            last_error = "模型结果复核 decision 不合法".into();
            continue;
        }
        if review.reason.trim().is_empty() || review.summary.trim().is_empty() {
            last_error = "模型结果复核缺少判定依据或摘要".into();
            continue;
        }
        return Ok(review);
    }
    Err(format!(
        "{last_error}（已要求模型按严格 JSON 格式重试一次）"
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalManager::default())
        .manage(SftpTransferManager::default())
        .manage(ExecutionManager::default())
        .invoke_handler(tauri::generate_handler![
            get_realtime_metrics,
            probe_ssh_server,
            execute_ssh_command,
            cancel_ssh_execution,
            start_ssh_terminal,
            write_ssh_terminal,
            resize_ssh_terminal,
            close_ssh_terminal,
            list_sftp_directory,
            get_remote_file_structure,
            create_sftp_directory,
            rename_sftp_entry,
            delete_sftp_entry,
            read_sftp_file,
            write_sftp_file,
            upload_sftp_transfer,
            download_sftp_transfer,
            cancel_sftp_transfer,
            get_ssh_metrics,
            generate_ai_plan,
            process_ai_requirement,
            check_ai_model,
            generate_ai_summary,
            review_ai_step,
            save_credential,
            load_credential,
            delete_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running Opsark");
}
