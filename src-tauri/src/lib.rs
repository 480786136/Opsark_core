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
use std::collections::{HashMap, HashSet};
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
    create_sftp_directory, delete_sftp_entry, list_sftp_directory, read_local_file_for_upload,
    read_sftp_file, rename_sftp_entry, write_sftp_file,
};
use sftp_transfer::{
    cancel_sftp_transfer, download_sftp_transfer, transfer_sftp_between_servers,
    upload_sftp_transfer, SftpTransferManager,
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
模型工具例外：当 command 以 opsark-tool 开头时，validation 固定为 true；该值是工具协议占位，不会被当作远端校验命令执行。工具上下文中 planMode=standalone 的工具必须是 steps 中唯一的步骤，完成后系统会依据 completionMode 继续编排。
Shell 反斜杠在 JSON 字符串内必须写成双反斜杠，例如 Shell 的 \( 必须输出为 \\( 的 JSON 文本。
输出前逐个检查六个字段，必须保证整个 JSON 对象完整闭合，不得截断任何字段。"#;
const REQUIREMENT_CLASSIFICATION_CONTRACT: &str = r#"本阶段只做需求分类、终端上下文判断、约束提取和 Skill 选择，禁止输出 steps、command、validation 或执行计划。必须先判断回答或计划是否依赖用户之前的终端输入/输出：如依赖且 terminalContext.content 未提供或范围不够，返回 terminal_context，terminalContextLines 必须大于当前 includedLines，且不超过 totalLines 和 400；不依赖则不得请求终端内容。context.skillDirectory 是已启用 Skill 目录；对执行类需求，必须按整体目标的语义选择零个、一个或多个可联合使用的 Skill，selectedSkillIds 只能包含目录中的 id，不得因为多 Skill 存在交叉就只选一个。selectionHints 仅是选择提示，不是硬编码触发器；以 name、description 和用户整体目标为准。纯续接需求可复用 context.skillSelection.currentActiveSkillIds；新目标必须重新选择。咨询类必须严格输出：{"intent":"answer","answer":"非空回答","constraints":null,"terminalContextLines":0,"selectedSkillIds":[]}。执行类必须严格输出：{"intent":"execute","answer":"","constraints":{"changePolicy":"unspecified|read_only|requested_changes_only|allow_necessary_changes","environmentPolicy":"unspecified|preserve|allow_isolated_changes|allow_host_changes","failurePolicy":"unspecified|strict|best_effort","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},"terminalContextLines":0,"selectedSkillIds":["skill-id-1","skill-id-2"]}。需要更多终端内容时必须严格输出：{"intent":"terminal_context","answer":"","constraints":null,"terminalContextLines":80,"selectedSkillIds":[]}。顶层只允许 intent、answer、constraints、terminalContextLines、selectedSkillIds 五个字段。"#;
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
7. 下载、安装、构建等可能长时间运行的命令必须保留实时标准输出和真实退出码；不得将整个主命令直接管道给非跟随模式的 tail/head 以截断输出。如需限制展示，应在主命令完成并保存真实退出状态后处理日志。
8. 用户给出的明确命令、地址、标识符或协议必须保持语义不变，除非真实证据证明不可用并明确说明替代原因。
9. 所有远程命令步骤都必须由执行器跟踪到真实退出；不得使用未受管的单独 &、disown、setsid -f 或伪造轮询让进程脱离执行生命周期，也不得用 || true、末尾 ; true 或失败分支 exit 0 掩盖主命令和校验的真实失败。有限操作必须前台执行；长驻进程应使用环境已有的受管机制，并通过独立只读证据校验状态。不得重复已完成的输入、发现、变更或验收步骤。
10. context.activeSkills 是需求理解阶段从已启用目录中选出的领域工作流。存在多个 Skill 时，必须同时遵循全部 Skill 的阶段、工具选择和验收要求，将相容阶段合并且不得静默丢弃任一 Skill；如指令冲突，必须优先满足用户明确约束和核心安全规则，并仅规划可安全确定的阶段。没有激活 Skill 时仅使用通用最小证据流程。工具只能按 context.tools 中的输入协议、planMode 和 completionMode 调用，不得猜测工具能力。需要敏感变量时使用语义明确的 ${secret.NAME} 占位符，禁止把真实值写入计划。

校验规则：
- validation 必须独立、只读且可执行，退出码 0 表示已获得足够判断 expected 的证据。
- 对象不存在、查询无匹配或观察到异常可以是有效发现，不等于命令失败。
- 不得重复已完成步骤，不得生成超出用户授权的不可逆操作。

输出：只返回符合计划输出契约的 JSON 对象。"#;
const GENERAL_DISCOVERY_RULES: &str = "对于需要发现实际实现方式的任务，先读取目标自带的说明、声明、配置、入口和已有状态，由证据确定依赖、运行方式、构建方式、部署方式和验收标准。核心不提供任何领域工具或技术栈的默认方案；只能使用当前证据明确展示的能力。发现步骤的校验只确认证据可获得，不要把可选信息缺失判为失败。";
const GENERAL_REQUIREMENT_SYSTEM: &str = "你是通用运维需求分类与 Skill 编排器，本阶段不生成计划。判断用户是仅需要不依赖当前环境的知识性回答，还是需要读取或改变真实目标环境。需要当前状态、真实数据或任何环境变更时必须返回 execute。结构化约束只能来自用户明确表达，不得猜测或自行增加。对执行类需求，从系统提供的 Skill 目录自主选择所有必要 Skill，允许多个 Skill 联合完成同一目标；不得编造目录外 Skill。";
const GENERAL_SUMMARY_SYSTEM: &str = "你是通用运维结果总结器。仅根据用户目标和脱敏的真实执行证据总结。结构化 result 和 evidence.facts 优先于预期文本和旧总结。有效的“未发现”、“非健康”或“警告”是观察结果，不等于命令执行失败。若存在关键失败且无后续证据证明目标已达成，必须明确说明任务未完成、最终阻断、已确认结果和尚未满足的目标。若目标已达成，必须直接给出用户所需的具体结果。启动信号或中间对象存在不等于业务目标完成，必须以真实退出状态和 Skill 要求的最终验收为准。不得把某个中间信号自动归因给目标对象，除非证据已建立关联。不得虚构、输出命令或泄露敏感信息。使用一至三段中文纯文本。";
const GENERAL_REVIEW_SYSTEM: &str = "你是通用运维执行复核员。根据原始用户目标、executionConstraints、完整计划、已完成记录、当前步骤真实证据和剩余步骤，判断工作流应 continue、adjust 或 complete。只返回包含 decision、reason、summary 的 JSON 对象。不得把真实失败改写为成功，不得虚构证据、新命令或新的用户授权。当前异常若不阻断整体目标，或剩余计划有明确且符合约束的恢复路径，返回 continue；若已阻断目标、证据不足或剩余计划无法处理，返回 adjust；只有用户整体目标已被真实证据充分证明时才返回 complete。对只读发现，得到“不存在”或异常状态是有效结果，应根据剩余计划判断。对变更步骤，后置条件未满足时不得 complete。当 trigger 为长时间运行定期复核时，必须忽略后续步骤是否值得执行，只判断当前命令是否仍需等待：continue 只表示当前命令仍在运行且需继续等待；adjust 表示停止并调整；complete 仅在 periodicObservation.passed=true 时表示当前命令已可停止等待并进入正式校验。不得用“继续执行剩余步骤”作为 continue 的理由。安全拦截、用户审批、真实执行结果和程序门禁不可被覆盖。";
const STRUCTURED_OUTPUT_ATTEMPTS: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(rename = "selectedSkillIds")]
    selected_skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ModelSkillDefinition {
    id: String,
    name: String,
    description: String,
    version: usize,
    instructions: String,
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
    #[serde(rename = "selectedSkillIds")]
    selected_skill_ids: Vec<String>,
    #[serde(rename = "planError", skip_serializing_if = "Option::is_none")]
    plan_error: Option<String>,
}

fn context_with_selected_skills(
    context: &str,
    skill_definitions: &[ModelSkillDefinition],
    selected_skill_ids: &[String],
) -> Result<String, String> {
    let mut value: Value =
        serde_json::from_str(context).map_err(|error| format!("Skill 选择上下文无效：{error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Skill 选择上下文必须是 JSON 对象".to_string())?;
    let definition_by_id: HashMap<&str, &ModelSkillDefinition> = skill_definitions
        .iter()
        .map(|skill| (skill.id.as_str(), skill))
        .collect();
    let selected = selected_skill_ids
        .iter()
        .map(|id| {
            definition_by_id
                .get(id.as_str())
                .copied()
                .ok_or_else(|| format!("模型选择了不在已启用目录中的 Skill：{id}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    object.remove("skillDirectory");
    object.insert(
        "skillSelection".to_string(),
        json!({
            "mode": "model",
            "multiple": true,
            "selectedSkillIds": selected_skill_ids,
        }),
    );
    object.insert(
        "activeSkills".to_string(),
        serde_json::to_value(selected)
            .map_err(|error| format!("Skill 上下文序列化失败：{error}"))?,
    );
    serde_json::to_string(&value).map_err(|error| format!("Skill 上下文序列化失败：{error}"))
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

fn is_model_tool_command(command: &str) -> bool {
    command.split_whitespace().next() == Some("opsark-tool")
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
            if matches!(validation.as_str(), "true" | ":" | "exit 0" | "/bin/true")
                && !is_model_tool_command(&command)
            {
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
    let mut commands = HashSet::new();
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
        let command = item.command.trim();
        if is_model_tool_command(command) && item.validation.trim() != "true" {
            return Err(format!(
                "第 {} 个模型工具步骤的 validation 必须固定为 true",
                index + 1
            ));
        }
        if !commands.insert(command) {
            return Err(format!(
                "第 {} 个计划步骤与前面步骤重复；请只保留一次必要操作",
                index + 1
            ));
        }
        if detaches_untracked_process(command) {
            return Err(format!("第 {} 个计划步骤将进程脱离执行器跟踪；必须使用可跟踪的前台命令或受管服务，并获取真实退出状态", index + 1));
        }
        if masks_failure_status(command) || masks_failure_status(item.validation.trim()) {
            return Err(format!(
                "第 {} 个计划步骤掩盖了命令或校验的失败退出码；必须保留真实结果",
                index + 1
            ));
        }
        if detaches_untracked_process(item.validation.trim()) {
            return Err(format!(
                "第 {} 个计划步骤的 validation 脱离了执行器跟踪",
                index + 1
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

fn plan_repair_instruction(error: &str, previous_steps: Option<&[AiPlanStep]>) -> String {
    let targeted = if error.contains("无业务意义的 validation") {
        "上次计划把普通 Shell 步骤的 validation 写成了 true、:、exit 0 或 /bin/true。只有 command 以 opsark-tool 开头的模型工具步骤才允许 validation 为 true。请保留语义正确的 command，仅为每个普通 Shell 步骤生成独立、只读、能验证 expected 的 validation；不得用空操作代替校验。"
    } else if error.contains("模型工具步骤的 validation 必须固定为 true") {
        "上次计划中 command 以 opsark-tool 开头的步骤属于结构化工具调用。请保留其 command，将该步骤 validation 精确设为 true；普通 Shell 步骤仍必须使用独立只读校验。"
    } else if error.contains("掩盖了命令或校验的失败退出码") {
        "上次计划掩盖了真实失败退出码。请仅修复对应 command 或 validation，移除 || true、末尾 true、失败分支 exit 0 等掩盖逻辑，保留主命令的真实退出状态。"
    } else if error.contains("将进程脱离执行器跟踪") {
        "上次计划使用了未受管的后台运行方式。请仅修复对应步骤，改为执行器可跟踪到真实退出的前台命令，或使用环境已有的受管服务机制并独立验收。"
    } else if error.contains("缺少非空字段") || error.contains("缺少非空 command 或 validation")
    {
        "上次计划存在必填字段缺失。请保留已经完整且正确的步骤和字段，只补齐错误所指的内容。"
    } else if previous_steps.is_some() {
        "请保留上次计划中已经符合用户目标和安全约束的步骤，仅修复错误指向的步骤或字段。"
    } else {
        "上次响应未产生可复用的完整步骤。请根据具体错误重新返回完整、必要且未截断的计划对象。"
    };
    let previous = previous_steps
        .and_then(|steps| serde_json::to_string(&json!({ "steps": steps })).ok())
        .map(|steps| format!("\n上次完整计划：\n{steps}"))
        .unwrap_or_default();
    format!(
        "\n\n上次输出未通过计划校验：{error}。{targeted}\n修复后仍必须返回完整的 {{\"steps\":[...]}} JSON 对象，不得只返回差异或单个字段。{previous}"
    )
}

fn detaches_untracked_process(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let has_disown = lower
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .any(|part| part == "disown");
    if has_disown || lower.contains("setsid -f") || lower.contains("setsid --fork") {
        return true;
    }

    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let characters = lower.chars().collect::<Vec<_>>();
    for (index, character) in characters.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if *character == '\\' && !single_quoted {
            escaped = true;
            continue;
        }
        if *character == '\'' && !double_quoted {
            single_quoted = !single_quoted;
            continue;
        }
        if *character == '"' && !single_quoted {
            double_quoted = !double_quoted;
            continue;
        }
        if *character != '&' || single_quoted || double_quoted {
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|offset| characters.get(offset))
            .copied();
        let next = characters.get(index + 1).copied();
        if previous != Some('>')
            && previous != Some('&')
            && previous != Some('|')
            && next != Some('&')
            && next != Some('>')
        {
            return true;
        }
    }
    false
}

fn masks_failure_status(script: &str) -> bool {
    let lower = script.trim().to_ascii_lowercase();
    let without_trailing_separator = lower.trim_end_matches([';', '\n', '\r', ' ', '\t']);
    if without_trailing_separator.ends_with("|| true")
        || without_trailing_separator.ends_with("|| /bin/true")
        || without_trailing_separator.ends_with("|| :")
        || without_trailing_separator.ends_with("; true")
        || without_trailing_separator.ends_with("\ntrue")
    {
        return true;
    }
    if lower.contains("set +e")
        && (without_trailing_separator.ends_with("; exit 0")
            || without_trailing_separator.ends_with("\nexit 0"))
    {
        return true;
    }
    if ["ssh ", "scp ", "rsync "]
        .iter()
        .any(|command| lower.contains(command))
        && lower.contains("|| echo")
    {
        return true;
    }
    lower
        .rsplit_once("||")
        .is_some_and(|(_, failure_branch)| failure_branch.contains("exit 0"))
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
            plan_repair_instruction(&last_error, last_repairable_steps.as_deref())
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
        let mut fallback_commands = HashSet::new();
        let only_presentational_fields_missing = raw_steps.iter().all(|item| {
            !item.command.trim().is_empty()
                && !item.validation.trim().is_empty()
                && item
                    .risk
                    .as_deref()
                    .is_some_and(|value| matches!(value, "low" | "medium" | "high"))
        });
        let execution_fields_safe = raw_steps.iter().all(|item| {
            fallback_commands.insert(item.command.trim())
                && !detaches_untracked_process(item.command.trim())
                && !detaches_untracked_process(item.validation.trim())
                && !masks_failure_status(item.command.trim())
                && !masks_failure_status(item.validation.trim())
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
        if only_presentational_fields_missing && execution_fields_safe && within_enabled_limits {
            return convert_ai_plan_steps(raw_steps);
        }
    }
    Err(format!(
        "{last_error}（已携带上一版计划和具体错误要求模型针对性修复一次）"
    ))
}

#[tauri::command]
async fn process_ai_requirement(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    skill_definitions: Vec<ModelSkillDefinition>,
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
            "max_tokens": 1200
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
        let available_skill_ids: HashSet<&str> = skill_definitions
            .iter()
            .map(|skill| skill.id.as_str())
            .collect();
        let unique_skill_ids: HashSet<&str> = decision
            .selected_skill_ids
            .iter()
            .map(String::as_str)
            .collect();
        let skill_selection_error = if unique_skill_ids.len() != decision.selected_skill_ids.len() {
            Some("selectedSkillIds 不得包含重复 ID".to_string())
        } else if let Some(id) = decision
            .selected_skill_ids
            .iter()
            .find(|id| !available_skill_ids.contains(id.as_str()))
        {
            Some(format!("selectedSkillIds 包含未启用或不存在的 Skill：{id}"))
        } else {
            None
        };
        let contract_error = match decision.intent.as_str() {
            "answer"
                if !decision.answer.trim().is_empty()
                    && decision.constraints.is_null()
                    && decision.terminal_context_lines == 0
                    && decision.selected_skill_ids.is_empty() =>
            {
                None
            }
            "answer" => {
                Some("咨询类响应的 answer 必须是非空字符串且 selectedSkillIds 必须为空".to_string())
            }
            "execute"
                if decision.answer.trim().is_empty()
                    && serde_json::from_value::<ExecutionConstraints>(
                        decision.constraints.clone(),
                    )
                    .is_ok()
                    && decision.terminal_context_lines == 0
                    && skill_selection_error.is_none() =>
            {
                None
            }
            "execute" => Some(skill_selection_error.unwrap_or_else(|| {
                "执行类响应的 answer 必须为空字符串，constraints 必须包含合法字段".to_string()
            })),
            "terminal_context"
                if decision.answer.trim().is_empty()
                    && decision.constraints.is_null()
                    && decision.selected_skill_ids.is_empty()
                    && (1..=400).contains(&decision.terminal_context_lines) =>
            {
                None
            }
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
            selected_skill_ids: Vec::new(),
            plan_error: None,
        });
    }
    if decision.intent == "terminal_context" {
        return Ok(RequirementProcessingResult {
            intent: "terminal_context".into(),
            answer: None,
            plan: Vec::new(),
            constraints: None,
            terminal_context_lines: decision.terminal_context_lines,
            selected_skill_ids: Vec::new(),
            plan_error: None,
        });
    }

    let selected_skill_ids = decision.selected_skill_ids;
    let constraints = serde_json::from_value::<ExecutionConstraints>(decision.constraints)
        .map(Some)
        .map(normalize_execution_constraints)
        .map_err(|error| format!("需求分类 constraints 结构无效：{error}"))?;
    let plan_context =
        context_with_selected_skills(&context, &skill_definitions, &selected_skill_ids)?;
    let plan_result = generate_ai_plan(
        api_key,
        endpoint,
        model,
        requirement,
        plan_context,
        generation_settings,
    )
    .await;
    let (plan, plan_error) = match plan_result {
        Ok(plan) => (plan, None),
        Err(error) => (
            Vec::new(),
            Some(format!("需求已判定为执行类，但计划生成失败：{error}")),
        ),
    };
    Ok(RequirementProcessingResult {
        intent: "execute".into(),
        answer: None,
        plan,
        constraints: Some(constraints),
        terminal_context_lines: 0,
        selected_skill_ids,
        plan_error,
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
            read_local_file_for_upload,
            write_sftp_file,
            upload_sftp_transfer,
            download_sftp_transfer,
            transfer_sftp_between_servers,
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
