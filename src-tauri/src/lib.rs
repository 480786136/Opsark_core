use serde::{de::DeserializeOwned, Deserialize, Serialize};
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
const STRICT_JSON_OUTPUT_RULE: &str = "输出格式是强制协议：必须只返回一个完整、可由标准 JSON 解析器直接解析的对象；禁止 Markdown 代码块、前后说明、注释、尾随逗号、NaN/Infinity 和未转义的反斜杠。必须严格使用系统消息指定的字段、类型和枚举值，不得增加或省略必填字段。返回前请自检 JSON 语法和结构。";
const PLAN_STEP_OUTPUT_CONTRACT: &str = r#"输出必须是 {"steps":[...]} 对象，steps 必须至少有 1 个元素。
每个元素必须严格包含且只包含：{"title":"非空字符串","description":"非空字符串","command":"非空字符串","expected":"非空字符串","validation":"非空字符串","risk":"low|medium|high"}。
字段内容应清晰、直接并保持完成任务所需的完整信息。command 和 validation 可以包含换行，但必须按标准 JSON 规则转义。
Shell 反斜杠在 JSON 字符串内必须写成双反斜杠，例如 Shell 的 \( 必须输出为 \\( 的 JSON 文本。
输出前逐个检查六个字段，必须保证整个 JSON 对象完整闭合，不得截断任何字段。"#;
const REQUIREMENT_CLASSIFICATION_CONTRACT: &str = r#"本阶段只做需求分类和约束提取，禁止输出 steps、command、validation 或执行计划。咨询类必须严格输出：{"intent":"answer","answer":"非空回答","constraints":null}。执行类必须严格输出：{"intent":"execute","answer":"","constraints":{"changePolicy":"unspecified|read_only|requested_changes_only|allow_necessary_changes","environmentPolicy":"unspecified|preserve|allow_isolated_changes|allow_host_changes","failurePolicy":"unspecified|strict|best_effort","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]}}。顶层只允许 intent、answer、constraints 三个字段。"#;
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
const GENERAL_REVIEW_SYSTEM: &str = "你是通用运维执行复核员。根据原始用户目标、executionConstraints、完整计划、已完成记录、当前步骤真实证据和剩余步骤，判断工作流应 continue、adjust 或 complete。只返回包含 decision、reason、summary 的 JSON 对象。不得把真实失败改写为成功，不得虚构证据、新命令或新的用户授权。当前异常若不阻断整体目标，或剩余计划有明确且符合约束的恢复路径，返回 continue；若已阻断目标、证据不足或剩余计划无法处理，返回 adjust；只有用户整体目标已被真实证据充分证明时才返回 complete。对只读发现，得到“不存在”或异常状态是有效结果，应根据剩余计划判断。对变更步骤，后置条件未满足时不得 complete。当 trigger 为长时间运行定期复核时，continue 表示继续等待，adjust 表示停止并调整，complete 仅在 periodicObservation.passed=true 时表示停止等待并进入正式校验。安全拦截、用户审批、真实执行结果和程序门禁不可被覆盖。";
const MODEL_RESPONSE_ATTEMPTS: usize = 3;
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

fn parse_model_json<T: DeserializeOwned>(content: &str) -> Result<T, String> {
    let cleaned = clean_json_content(content);
    let repaired = repair_invalid_json_escapes(cleaned);
    serde_json::from_str(cleaned)
        .or_else(|_| serde_json::from_str(&repaired))
        .map_err(|strict_error| strict_error.to_string())
        .or_else(|strict_error| {
            json5::from_str(cleaned)
                .or_else(|_| json5::from_str(&repaired))
                .map_err(|lenient_error| {
                    format!("标准 JSON 解析失败：{strict_error}；宽松解析也失败：{lenient_error}")
                })
        })
}

fn parse_ai_plan_steps(content: &str) -> Result<Vec<AiPlanStep>, String> {
    if let Ok(steps) = parse_model_json::<Vec<AiPlanStep>>(content) {
        return Ok(steps);
    }
    let object: Value = parse_model_json(content)?;
    serde_json::from_value(object.get("steps").cloned().unwrap_or(Value::Null))
        .map_err(|error| error.to_string())
}

async fn post_model_request(
    url: &str,
    api_key: &str,
    body: &Value,
    request_name: &str,
    timeout_seconds: u64,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|error| format!("{request_name}客户端初始化失败：{error}"))?;
    let mut last_retryable_error = String::new();

    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        let response = match client
            .post(url)
            .bearer_auth(api_key)
            .json(body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_retryable_error = format!("{request_name}请求失败：{error}");
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
                break;
            }
        };
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("未提供")
            .to_string();
        let response_bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_retryable_error = format!("{request_name}接口响应读取不完整：{error}");
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
                break;
            }
        };
        let payload: Value = match serde_json::from_slice(&response_bytes) {
            Ok(payload) => payload,
            Err(error) => {
                last_retryable_error = format!(
                    "{request_name}接口返回了无法解析的 HTTP 响应（状态 {status}，Content-Type {content_type}，{} 字节）：{error}",
                    response_bytes.len()
                );
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
                break;
            }
        };

        if status.is_success() {
            return Ok(payload);
        }
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        let error = format!("{request_name}接口返回 {status}：{message}");
        if (status.as_u16() == 429 || status.is_server_error()) && attempt < MODEL_RESPONSE_ATTEMPTS
        {
            last_retryable_error = error;
            continue;
        }
        return Err(error);
    }

    Err(format!(
        "{last_retryable_error}（已自动重试 {} 次）",
        MODEL_RESPONSE_ATTEMPTS - 1
    ))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn credential_account(kind: &str, id: &str) -> Result<String, String> {
    if !matches!(kind, "server" | "model" | "secret") {
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
        "printf '%s\\n' \"$(hostname)\" \"$(uname -srm)\" \"$(. /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-Unknown})\" \"$(nproc 2>/dev/null || echo 1)\" \"$(free -m 2>/dev/null | awk '/Mem:/{printf \\\"%.1f\\\", $2/1024}' || echo 0)\" \"$(df -BG / 2>/dev/null | awk 'NR==2{gsub(/G/,\\\"\\\",$2); print $2}' || echo 0)\" \"$(uptime -p 2>/dev/null || uptime)\"",
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
        let parsed = payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| "模型响应缺少计划内容".to_string())
            .and_then(|content| {
                parse_ai_plan_steps(content)
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
        let parsed = payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| "模型响应缺少需求理解结果".to_string())
            .and_then(|content| {
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
            "answer" if !decision.answer.trim().is_empty() && decision.constraints.is_null() => {
                None
            }
            "answer" => Some("咨询类响应的 answer 必须是非空字符串".to_string()),
            "execute"
                if decision.answer.trim().is_empty()
                    && serde_json::from_value::<ExecutionConstraints>(
                        decision.constraints.clone(),
                    )
                    .is_ok() =>
            {
                None
            }
            "execute" => {
                Some("执行类响应的 answer 必须为空字符串，constraints 必须包含合法字段".to_string())
            }
            _ => Some("需求分类 intent 只能是 answer 或 execute".to_string()),
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
    })
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut decoded = None;
    let mut last_error = String::new();
    for attempt in 1..=MODEL_RESPONSE_ATTEMPTS {
        let response = match client.get(&url).bearer_auth(&api_key).send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = format!("无法连接模型服务：{error}");
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
                break;
            }
        };
        let status = response.status();
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = format!("模型列表接口响应读取不完整：{error}");
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
                break;
            }
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(payload) => {
                decoded = Some((status, payload));
                break;
            }
            Err(error) => {
                last_error = format!(
                    "模型列表接口返回了无法解析的 HTTP 响应（状态 {status}，{} 字节）：{error}",
                    bytes.len()
                );
                if attempt < MODEL_RESPONSE_ATTEMPTS {
                    continue;
                }
            }
        }
    }
    let (status, payload) = decoded.ok_or_else(|| {
        format!(
            "{last_error}（已自动重试 {} 次）",
            MODEL_RESPONSE_ATTEMPTS - 1
        )
    })?;
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
        let parsed = payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| "模型结果复核缺少内容".to_string())
            .and_then(|content| {
                parse_model_json(content)
                    .map_err(|error| format!("模型结果复核结构解析失败：{error}"))
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

#[tauri::command]
fn generate_plan(requirement: String) -> Vec<PlanStep> {
    vec![step(
        0,
        "采集目标相关事实",
        &format!("仅读取执行环境基础信息，供后续理解用户需求：{requirement}"),
        "uname -a && pwd",
        "获得可用于后续判断的基础事实",
        "uname -a >/dev/null && pwd >/dev/null",
    )]
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
        assert_eq!(
            credential_account("secret", "DB_PASSWORD").unwrap(),
            "secret:DB_PASSWORD"
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
    fn parses_lenient_model_plan_when_standard_json_is_not_available() {
        let loose = r#"{steps:[{title:'检查',description:'读取状态',command:'pwd',expected:'返回目录',validation:'pwd >/dev/null',risk:'low',}],}"#;
        let steps = parse_ai_plan_steps(loose).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].command, "pwd");
    }

    #[test]
    fn repairs_missing_presentational_plan_fields_but_rejects_missing_execution_fields() {
        let missing_title = r#"{"steps":[{"description":"检查目标是否正常。","command":"custom-tool inspect","expected":"","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
        let repairable = parse_ai_plan_steps(missing_title).unwrap();
        assert!(
            validate_ai_plan_contract(&repairable, &AiGenerationSettings::default())
                .unwrap_err()
                .contains("title")
        );
        let normalized = convert_ai_plan_steps(repairable).unwrap();
        assert_eq!(normalized[0].title, "检查目标是否正常");
        assert!(!normalized[0].expected.is_empty());

        let missing_command = r#"{"steps":[{"title":"检查","description":"检查目标","expected":"返回状态","validation":"custom-tool inspect >/dev/null","risk":"low"}]}"#;
        let error =
            convert_ai_plan_steps(parse_ai_plan_steps(missing_command).unwrap()).unwrap_err();
        assert!(error.contains("command 或 validation"));
    }

    #[test]
    fn plan_length_limits_are_optional_and_allow_multiline_commands() {
        let long_command = format!("echo start\n{}", "x".repeat(1500));
        let steps = vec![AiPlanStep {
            title: "一个超过旧标题长度限制但依然是合法计划步骤的完整标题".into(),
            description: "读取并处理真实环境信息".into(),
            command: long_command,
            expected: "获得完整结果".into(),
            validation: "test -f /tmp/result\nprintf 'ok\\n'".into(),
            risk: Some("low".into()),
        }];
        assert!(validate_ai_plan_contract(&steps, &AiGenerationSettings::default()).is_ok());

        let limited = AiGenerationSettings {
            limit_output: true,
            max_text_chars: 10,
            max_command_chars: 100,
            ..AiGenerationSettings::default()
        };
        assert!(validate_ai_plan_contract(&steps, &limited).is_err());
    }

    #[test]
    fn plan_step_count_limit_is_only_applied_when_enabled() {
        let steps = (0..8)
            .map(|index| AiPlanStep {
                title: format!("步骤 {}", index + 1),
                description: "执行必要操作".into(),
                command: format!("echo {index}"),
                expected: "命令正常完成".into(),
                validation: "true".into(),
                risk: Some("low".into()),
            })
            .collect::<Vec<_>>();

        let unlimited = AiGenerationSettings::default();
        assert!(validate_ai_plan_contract(&steps, &unlimited).is_ok());
        assert_eq!(convert_ai_plan_steps(steps.clone()).unwrap().len(), 8);

        let limited = AiGenerationSettings {
            limit_output: true,
            max_plan_steps: 6,
            ..AiGenerationSettings::default()
        };
        assert!(validate_ai_plan_contract(&steps, &limited)
            .unwrap_err()
            .contains("不能超过配置的 6 个"));
    }

    #[test]
    fn parses_answer_and_execute_requirement_intents() {
        let answer: AiRequirementDecision = serde_json::from_str(
            r#"{"intent":"answer","answer":"这是风险咨询。","constraints":null}"#,
        )
        .unwrap();
        assert_eq!(answer.intent, "answer");

        let execute: AiRequirementDecision = serde_json::from_str(
            r#"{"intent":"execute","answer":"","constraints":{"changePolicy":"requested_changes_only","environmentPolicy":"preserve","failurePolicy":"best_effort","prohibitedActions":["升级宿主运行时"],"requiredConditions":["保留当前环境"],"userDirectives":["尽力尝试"]}}"#,
        )
        .unwrap();
        assert_eq!(execute.intent, "execute");
        let constraints = normalize_execution_constraints(Some(
            serde_json::from_value(execute.constraints).unwrap(),
        ));
        assert_eq!(constraints.environment_policy, "preserve");
        assert_eq!(constraints.failure_policy, "best_effort");
        assert_eq!(constraints.prohibited_actions, vec!["升级宿主运行时"]);

        let mixed_stage = r#"{"intent":"execute","answer":"","constraints":null,"steps":[]}"#;
        assert!(serde_json::from_str::<AiRequirementDecision>(mixed_stage).is_err());
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
            None,
        ))
        .expect("DeepSeek plan generation failed");
        assert!(!plan.is_empty());
        assert!(plan.iter().all(|step| !step.command.trim().is_empty()));
    }
}
