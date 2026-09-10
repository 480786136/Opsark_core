// Tauri commands intentionally expose flat invoke parameters so the generated
// JavaScript boundary remains explicit and auditable.
#![allow(clippy::too_many_arguments)]

mod agent_terminal;
mod command_guard;
mod credential;
mod evidence_store;
mod file_tree;
mod json_contract;
mod local_terminal;
mod model_parameters;
mod knowledge;
mod metrics;
mod model;
mod prompt_layers;
mod sftp;
mod sftp_transfer;
mod ssh;
mod task_logs;
mod terminal;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use agent_terminal::{
    close_agent_terminal, create_agent_terminal, execute_agent_terminal_command,
    interrupt_agent_terminal_command, sample_agent_terminal_progress, update_agent_session_context,
    AgentTerminalManager,
};
use command_guard::risk_for;
use credential::{delete_credential, load_credential, save_credential};
use file_tree::{scan_sftp, FileStructureResult};
use json_contract::{parse_model_array_field, parse_model_json};
use metrics::{get_realtime_metrics, get_ssh_metrics};
use model::{check_model_availability, message_content, post_model_request};
use sftp::{
    create_sftp_directory, delete_sftp_entry, list_sftp_directory, read_local_file_for_upload,
    read_sftp_file, read_sftp_file_prefix, rename_sftp_entry, write_sftp_file,
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
    kind: String,
    title: String,
    description: String,
    command: String,
    risk: String,
    expected: String,
    validation: String,
    execution_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_context_change: Option<Value>,
    runtime_class: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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
每个元素必须严格包含：{"kind":"observe|change","title":"非空字符串","description":"非空字符串","command":"非空字符串","expected":"非空字符串","validation":"字符串","risk":"low|medium|high"}。可选字段只允许 executionScope、validationScope、runtimeClass 和 sessionContextChange；省略时程序使用安全默认值。executionScope 可为 agent_session|isolated_exec|managed_service|user_action；validationScope 可为 isolated_exec|fresh_interactive_shell|fresh_login_shell；runtimeClass 可为 bounded|progressive|persistent_service。sessionContextChange 仅能与 agent_session 同时使用，可包含绝对 cwd、非敏感 environment、绝对 sourceFiles 和 bash|sh|zsh shell；禁止放入凭据或 ${secret.NAME}。
observe 表示只读查询或诊断：主命令输出和退出状态就是观察证据，validation 必须为空字符串，不得生成第二条重复查询。change 表示会改变目标状态：validation 必须是非空、独立、只读的后置条件。command 和 validation 可以包含换行，但必须按标准 JSON 规则转义。
模型工具例外：工具命令必须严格写成 opsark-tool <toolId> <JSON参数对象>，toolId 前不得添加 --，且必须按工具 inputSchema 提供必填参数；禁止只输出 opsark-tool、缺少参数或使用数组参数。当 command 以 opsark-tool 开头时，validation 必须固定为 JSON 字符串 "true"，即输出 "validation":"true"；禁止输出 JSON 布尔值 true。该字符串是工具协议占位，不会被当作远端校验命令执行。工具上下文中 planMode=standalone 的工具必须是 steps 中唯一的步骤，完成后系统会依据 completionMode 继续编排。
planMode=read_batch 的工具可以组成纯只读批次：所有步骤 kind=observe，参数必须已经由用户或真实证据确定，不能依赖本批次尚未返回的结果；不能混入 Shell、变更或 standalone 工具。程序逐项执行，失败即停止，整批结束再分析结果。context.expand 只展开活动 Skill 规则，不证明任何业务目标完成。
Shell 反斜杠在 JSON 字符串内必须写成双反斜杠，例如 Shell 的 \( 必须输出为 \\( 的 JSON 文本。
输出前逐个检查七个字段，必须保证整个 JSON 对象完整闭合，不得截断任何字段。"#;
const NEXT_STAGE_DECISION_SYSTEM: &str = r#"本调用把阶段结束后的整体完成判断和下一阶段规划合并为一次决策。GENERAL_PLAN_SYSTEM 的全部证据、安全、授权、Skill 和最小计划规则仍然生效；仅以本联合输出契约替代其中“只返回计划对象”的输出要求。

完成证据门禁：
- 必须先把用户整体目标逐项与 context.baseSnapshot 中作用域匹配的结构化 result/evidence，以及全部 context.activeSkills 的最终验收要求进行比较。
- 计划文字、步骤标题、expected、阶段 summary、模型 review、指令和待执行步骤都不是完成证据；历史证据只能证明其自身 scope，不能外推当前状态。
- 任一目标尚无证据、证据过期或作用域不匹配，或者存在未恢复的执行失败、安全拦截、审批/输入阻断、冲突证据或未满足的 Skill 验收条件时，禁止返回 complete。
- 只有结构化成功证据已经充分证明整体目标及全部最终验收条件时才能返回 complete，并且 steps 必须为空数组。
- 尚未完成时必须在同一个响应中返回至少一个当前证据允许的最小下一阶段步骤。当前阶段正常结束且可直接推进时返回 continue；需要因失败、阻断、证据缺口或错误假设改变方案时返回 adjust。不得重复已经有结构化完成证据的工作。"#;
const NEXT_STAGE_OUTPUT_CONTRACT: &str = r#"输出必须严格为 {"decision":"complete|continue|adjust","reason":"非空字符串","summary":"非空字符串","steps":[]}，顶层不得增加其他字段。
decision=complete 时 steps 必须严格为空数组。decision=continue 或 adjust 时 steps 必须至少有 1 个元素。
每个步骤必须严格包含：{"kind":"observe|change","title":"非空字符串","description":"非空字符串","command":"非空字符串","expected":"非空字符串","validation":"字符串","risk":"low|medium|high"}。可选字段只允许 executionScope、validationScope、runtimeClass 和 sessionContextChange；其枚举、作用域、独立校验、长任务和进程跟踪要求与 GENERAL_PLAN_SYSTEM 相同。
observe 的 validation 必须为空字符串；change 的 validation 必须是非空、独立、只读的后置条件。工具命令必须严格写成 opsark-tool <toolId> <JSON参数对象> 并符合 context.tools 的 inputSchema。当 command 以 opsark-tool 开头时，validation 必须固定为 JSON 字符串 "true"，即输出 "validation":"true"；禁止输出 JSON 布尔值 true。context.activeSkills 禁止的工具不得出现在 steps 中。工具上下文中 planMode=standalone 的工具必须是 steps 中唯一的步骤。
planMode=read_batch 允许参数已经确定的纯 observe 工具批次；不能混入 Shell、变更或 standalone，也不能预设前一步工具输出。整批结束后再判断下一阶段。planMode、completionMode、executionMode 是工具目录元数据，由编排器读取，禁止复制到 steps 的对象字段中；步骤只能使用输出协议声明的字段。
command 和 validation 中的换行及反斜杠必须按标准 JSON 规则转义。返回前必须同时自检决策分支、所有计划字段和完整 JSON 结构。"#;
const REQUIREMENT_CLASSIFICATION_CONTRACT: &str = r#"本阶段只做需求分类、任务关系判断、终端上下文判断、执行约束提取和 Skill 选择，禁止输出 steps、command、validation 或执行计划。context.taskGoal.rootGoal 是当前任务长期绑定的整体目标，currentInstruction 只是上一轮指令。必须判断本次输入与整体目标的关系：new_goal=独立的新执行目标；continue=继续/重试原目标；supplement=为原目标补充条件；side_question=临时咨询且不改变原目标；replace_goal=用户明确放弃原目标并替换；cancel_goal=明确取消原目标。不得仅因用户提出另一个问题就隐式覆盖原目标；新执行目标使用 new_goal，只有明确“改为/不要原目标/替换为”才用 replace_goal。必须先判断回答或计划是否依赖用户之前的终端输入/输出：如依赖且 terminalContext.content 未提供或范围不够，返回 terminal_context，terminalContextLines 必须大于当前 includedLines，且不超过 totalLines 和 400；不依赖则不得请求终端内容。对 execute，constraints.changePolicy 是本轮权威的只读/变更边界：查询现状、列表、检查和定位故障必须为 read_only；用户明确要求安装、修改、构建、部署、传输或其他环境变更时为 requested_changes_only；只有用户明确允许为达成目标执行必要的附加变更时才为 allow_necessary_changes。execute 不得返回 unspecified。environmentPolicy、failurePolicy、prohibitedActions、requiredConditions 和 userDirectives 只能来自用户明确表达，不得猜测或自行增加。context.skillDirectory 中的名称、description 和 selectionHints 用于语义选择；category 只用于管理和导航，不得触发 Skill。只选择直接适用于整体目标、本轮显式子目标或已有证据证明必需阶段的 Skill，允许复合需求选择多个 Skill；不得因为目录中存在相近领域或关键词局部相似而强行匹配。零匹配是正常且合法的结果，此时 selectedSkillIds=[]，后续使用通用流程。selectedSkillIds 是本轮完整集合，continue/supplement 也必须移除不再适用或上轮误选的 Skill，程序不会自动并集。咨询类必须严格输出：{"intent":"answer","relation":"side_question|cancel_goal","answer":"非空回答","constraints":null,"terminalContextLines":0,"selectedSkillIds":[]}。执行类必须严格输出：{"intent":"execute","relation":"new_goal|continue|supplement|replace_goal","answer":"","constraints":{"changePolicy":"read_only|requested_changes_only|allow_necessary_changes","environmentPolicy":"unspecified|preserve|allow_isolated_changes|allow_host_changes","failurePolicy":"unspecified|strict|best_effort","prohibitedActions":[],"requiredConditions":[],"userDirectives":[]},"terminalContextLines":0,"selectedSkillIds":[]}。需要更多终端内容时必须严格输出：{"intent":"terminal_context","relation":null,"answer":"","constraints":null,"terminalContextLines":80,"selectedSkillIds":[]}。顶层只允许 intent、relation、answer、constraints、terminalContextLines、selectedSkillIds 六个字段。"#;
const SECRET_PLACEHOLDER_RULE: &str = "敏感变量规则：${secret.NAME} 是 Opsark 的执行时传输占位符，不是要保留在远端文件里的字面量。必须原样写成 ${secret.NAME}，绝对不得在美元符号前添加反斜杠。程序会在 SSH 执行前注入真实值，并在输出、日志和模型上下文中脱敏。模型看到的 •••••••• 只表示真实值已被脱敏：它既不是远端文件的实际内容，也不能证明具体密码正确或错误，更不能据此声称占位符未解析。选择变量时名称和说明必须与目标凭据语义一致；若现有变量无法区分目标账户或用途，应使用新的、用途明确的变量名，由界面向用户索取，不能静默借用含义模糊的旧值。写入远端配置后应使用不泄露秘密的功能性后置条件校验；校验命令中仍可使用同一占位符供程序注入。不得要求远端保留 Opsark 占位符，也不得因脱敏标记判定泄露、写入失败或密码错误。除非用户明确禁止持久化密码，不得自行增加该限制。";
const REVIEW_SECRET_PLACEHOLDER_RULE: &str = "复核上下文中的 ${secret.NAME} 是执行时占位符，•••••••• 表示真实值已脱敏；不得据此判断占位符未解析、执行失败或发生泄露。";
const GENERAL_PLAN_SYSTEM: &str = r#"角色：通用运维计划器。

目标：仅根据用户需求、当前上下文和已验证证据，生成当前确实可执行的最小计划。

决策顺序：
1. 先识别用户的整体目标、明确约束和现有证据。
   context.taskGoal.rootGoal 存在时它是不可被“继续、重试、补充”等短指令覆盖的最终目标；currentInstruction 只决定本轮增量。计划必须继续满足整体目标，并复用历史已完成证据。
2. 不得预设技术栈、工具、路径、端口、服务名或资源名。
3. 证据不足时，只生成最少必要的只读发现步骤；不得同时生成依赖未知发现结果的推测性变更。
   当当前阻断发生在依赖解析、编译、打包或镜像构建阶段时，本阶段只能生成修复构建及验收构建产物的最少步骤。构建产物未经结构化程序证据确认前，不得生成启动、后台运行、部署、端口探测或应用健康检查步骤；待产物验收成功后再续接独立部署阶段。
4. 证据充足时，按“必要确认→变更→最终验收”生成最少必要的计划。
5. 默认每步在独立非交互 Shell 中运行，所需目录和环境必须在当步建立。只有后续步骤确实需要复用工作目录、非敏感环境变量或 source 文件时，才可选用 executionScope=agent_session 并用 sessionContextChange 明确记录可重放状态；主 command 仍必须自行建立它当次依赖的环境。
6. 用户只要求修改已有资源的部分字段时，必须保留无关内容并做可恢复备份；不得用新模板覆盖整个结构化配置，除非用户明确要求整体替换或证据证明这是完整目标内容。
7. 下载、安装、构建等可能长时间运行的命令必须保留实时标准输出和真实退出码；不得将整个主命令直接管道给非跟随模式的 tail/head 以截断输出。如需限制展示，应在主命令完成并保存真实退出状态后处理日志。
8. 用户给出的明确命令、地址、标识符或协议必须保持语义不变，除非真实证据证明不可用并明确说明替代原因。
9. 所有远程命令步骤都必须由执行器跟踪到真实退出；不得使用未受管的单独 &、disown、setsid -f 或伪造轮询让进程脱离执行生命周期，也不得用 || true、末尾 ; true 或失败分支 exit 0 掩盖主命令和校验的真实失败。有限操作必须前台执行；长驻进程应使用环境已有的受管机制，并通过独立只读证据校验状态。不得重复已完成的输入、发现、变更或验收步骤。
10. context.activeSkills 是需求理解阶段从已启用目录中选出的领域工作流。存在多个 Skill 时，必须同时遵循全部 Skill 的阶段、工具选择和验收要求，将相容阶段合并且不得静默丢弃任一 Skill；如指令冲突，必须优先满足用户明确约束和核心安全规则，并仅规划可安全确定的阶段。没有激活 Skill 时仅使用通用最小证据流程。工具只能按 context.tools 中的输入协议、planMode 和 completionMode 调用，不得猜测工具能力。需要敏感变量时使用语义明确的 ${secret.NAME} 占位符，禁止把真实值写入计划。不同目标系统、账户、身份或用途的凭据不得静默复用；用途不一致时必须由对应 Skill 指定语义化变量并向用户收集。
11. 用户提供的路径、文件名和其他可能包含空格、括号、通配符或非 ASCII 字符的值，作为 Shell 参数时必须逐项完整安全引用，并在命令支持时使用 -- 结束选项；不得依赖未引用文本恰好能被当前 Shell 解析。
12. 必须先根据步骤本身的副作用选择 kind：只读查询、环境发现和故障诊断是 observe，主命令结果直接作为证据，不生成重复 validation；写入、安装、启停、构建、传输等是 change，必须用独立 validation 验收变更后状态。change 的 validation 运行在独立 Shell，不能读取 command 的变量或标准输出。command 若从配置动态解析目标，validation 必须重新读取同一配置，不得硬编码未证明值。只有 opsark-tool 步骤允许使用 JSON 字符串 "true" 作为 validation，即输出 "validation":"true"；不得输出 JSON 布尔值 true。
13. 下载、包安装、依赖解析、编译和镜像构建可标记 runtimeClass=progressive；受系统服务管理器托管的长驻进程使用 executionScope=managed_service 与 runtimeClass=persistent_service。不确定时省略这些可选字段，由执行器安全分类。

校验规则：
- 以下 validation 规则只适用于 change 步骤：validation 必须独立、只读且可执行，退出码 0 表示已获得足够判断 expected 的证据。
- validation 是新的非交互 Shell 命令，不能读取上一条 command 的标准输出；grep、awk、sed 等读取器必须显式提供文件、管道或输入重定向，禁止裸读终端 stdin。
- 对象不存在、查询无匹配或观察到异常可以是有效发现，不等于命令失败。
- 只读状态发现若把“不存在、未运行、未监听、无匹配”作为有效分类，必须显式区分所用命令文档定义的“无匹配”退出码与真正执行错误：只把已知无匹配码转换为分类输出，其他非零码原样退出；禁止用 command || echo 把所有错误都改成成功。
- 认证失败、权限不足、网络不可达等只能作为阻断证据，不能当作用户查询或变更目标已完成；各领域的成功验收条件由已选 Skill 定义。
- 不得重复已完成步骤，不得生成超出用户授权的不可逆操作。

输出：只返回符合计划输出契约的 JSON 对象。"#;
const GENERAL_DISCOVERY_RULES: &str = "对于需要发现实际实现方式的任务，先读取目标自带的说明、声明、配置、入口和已有状态，由证据确定依赖、运行方式、构建方式、部署方式和验收标准。核心不提供任何领域工具或技术栈的默认方案；只能使用当前证据明确展示的能力。发现步骤的校验只确认证据可获得，不要把可选信息缺失判为失败。";
const GENERAL_REQUIREMENT_SYSTEM: &str = "你是通用运维需求分类、任务关系判断与 Skill 编排器，本阶段不生成计划。先将用户本次输入和 context.taskGoal.rootGoal 比较，区分继续、补充、旁问、独立新目标、明确替换或取消；不得让‘继续部署’、‘重试’取代整体目标，也不得让临时问题破坏原任务。判断用户是仅需要不依赖当前环境的知识性回答，还是需要读取或改变真实目标环境。需要当前状态、真实数据或任何环境变更时必须返回 execute。对 execute 必须用 constraints.changePolicy 明确表达本轮只读或变更边界，不得返回 unspecified。从系统提供的 Skill 目录中依据名称、适用场景和选择提示进行语义选择，允许复合需求选择零个、一个或多个 Skill；没有直接适用 Skill 时必须返回空数组并使用通用流程，不得选择最相近的 Skill 凑数，也不得编造目录外 Skill。environmentPolicy、failurePolicy 和其他结构化约束只能来自用户明确表达，不得猜测或自行增加。";
const GENERAL_SUMMARY_SYSTEM: &str = "你是通用运维结果总结器。仅根据当前轮用户目标和当前轮脱敏的真实执行证据总结，不得用旧轮证据回答新的状态问题。结构化 result、evidence.facts 和 evidence.scope 优先于预期文本和旧总结。证据只能证明自己的 scope/persistence：agent_session 成功不证明用户已打开 Shell 或新 Shell 自动加载，显式 source 成功不证明启动文件会自动加载。有效的“未发现”、“非健康”或“警告”是观察结果，不等于命令执行失败。若存在关键失败且无后续证据证明目标已达成，必须明确说明任务未完成、最终阻断、已确认结果和尚未满足的目标。不得虚构、输出命令或泄露敏感信息。使用一至三段中文纯文本。";
const GENERAL_REVIEW_SYSTEM: &str = "你是运维执行复核员。根据用户目标、trigger、executionConstraints、当前步骤或 baseSnapshot 的结构化结果、关键错误和剩余步骤，判断 continue、adjust 或 complete。priorVerifiedFacts 只用于避免重复，不能代替当前状态证据。不得把失败改写为成功，不得虚构证据、命令或授权。证据作用域必须与 expected 一致。存在确定恢复路径时 continue；已阻断、证据不足或作用域不匹配时 adjust；只有目标被真实且作用域匹配的证据充分证明时 complete。安全拦截、审批、执行结果和程序门禁不可被覆盖。只返回包含 decision、reason、summary 的 JSON。";
const LONG_RUNNING_REVIEW_SYSTEM: &str = "你是长任务运行状态复核员。输入只包含压缩后的用户目标、当前步骤、下一步骤提示、跨轮关键证据、进度状态和本轮新增终端输出。只判断当前命令应 continue 还是 adjust：语义输出或可验证进度仍在变化时返回 continue；仅旋转图标、时间戳或重复行变化不算进展。连续无进展、出现认证或交互等待、明确错误、达到等待上限时返回 adjust。continue 仅表示继续等待当前命令，不能进入下一步；主命令未返回真实退出且 periodicObservation.passed=false 时不得 complete。terminalOutput.omittedCharacters 仅表示旧输出被压缩，不代表失败；salientEvidence 是前轮已保留的关键错误、警告或里程碑，不得忽略。不得虚构输出、退出码、命令或授权。只返回 decision、reason、summary 三个字段的简短 JSON，reason 和 summary 各不超过 60 个字。";
const STRUCTURED_OUTPUT_ATTEMPTS: usize = 2;
const REQUIREMENT_RELATION_RULE: &str = "关系自检：句式是提问不等于 side_question。例如新任务‘现在有哪些 Java 服务在运行’需要查询真实服务器，应返回 intent=execute、relation=new_goal、changePolicy=read_only、answer=空字符串、selectedSkillIds=[]。只有无需读取真实环境的咨询才使用 answer + side_question；已有整体目标时依据实际关系选择 continue/supplement/new_goal，不得自动替换原目标。";
const PLAN_GENERATION_ATTEMPTS: usize = 3;

fn deserialize_model_validation<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct ModelValidationVisitor;

    impl<'de> serde::de::Visitor<'de> for ModelValidationVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a string or the boolean true")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value.to_string())
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value)
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            if value {
                Ok("true".to_string())
            } else {
                Err(E::custom("validation accepts boolean true only"))
            }
        }
    }

    deserializer.deserialize_any(ModelValidationVisitor)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiPlanStep {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    expected: String,
    #[serde(default, deserialize_with = "deserialize_model_validation")]
    validation: String,
    #[serde(default)]
    risk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    validation_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_context_change: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiNextStageDecision {
    decision: String,
    reason: String,
    summary: String,
    steps: Vec<AiPlanStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiNextStageResult {
    decision: String,
    reason: String,
    summary: String,
    steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct AiPlanStepRepair {
    /// One-based index from the plan returned by the previous model response.
    step_index: usize,
    /// One invalid step may be replaced by one or more focused steps.
    replacement_steps: Vec<AiPlanStep>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AiPlanRepairEnvelope {
    repair: AiPlanStepRepair,
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
    relation: Option<String>,
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
    #[serde(default)]
    allowed_tool_ids: Option<Vec<String>>,
    #[serde(default)]
    forbidden_tool_ids: Vec<String>,
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
    relation: Option<String>,
    answer: Option<String>,
    plan: Vec<PlanStep>,
    constraints: Option<ExecutionConstraints>,
    #[serde(rename = "terminalContextLines")]
    terminal_context_lines: usize,
    #[serde(rename = "selectedSkillIds")]
    selected_skill_ids: Vec<String>,
    #[serde(rename = "planError", skip_serializing_if = "Option::is_none")]
    plan_error: Option<String>,
    #[serde(rename = "developerTrace")]
    developer_trace: ModelDeveloperTrace,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDeveloperTrace {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    normalizations: Vec<String>,
    attempts: Vec<ModelAttemptTrace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelAttemptTrace {
    stage: String,
    attempt: usize,
    duration_ms: u64,
    request: Value,
    response: Option<Value>,
    error: Option<String>,
}

const MODEL_TRACE_ERROR_PREFIX: &str = "OPSARK_MODEL_TRACE_V1:";

fn record_model_attempt(
    trace: &mut ModelDeveloperTrace,
    stage: &str,
    attempt: usize,
    started_at: Instant,
    request: Value,
    response: Option<Value>,
    error: Option<String>,
) {
    trace.attempts.push(ModelAttemptTrace {
        stage: stage.to_string(),
        attempt,
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        request: prompt_layers::prepare_request(&request).0,
        response,
        error,
    });
}

fn traced_model_error(message: String, trace: &ModelDeveloperTrace) -> String {
    let payload = json!({
        "message": message,
        "developerTrace": trace,
    });
    format!("{MODEL_TRACE_ERROR_PREFIX}{payload}")
}

fn developer_model_log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join("developer-model-calls.jsonl"))
}

#[tauri::command]
fn append_task_log(
    app: AppHandle,
    stream: String,
    event: Value,
    context: Value,
) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    task_logs::append(&root, &stream, event, &context)
}

#[tauri::command]
fn save_task_evidence(app: AppHandle, task_id: String, record: Value) -> Result<String, String> {
    evidence_store::save(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &task_id,
        &record,
    )
}

#[tauri::command]
fn read_task_evidence(
    app: AppHandle,
    task_id: String,
    evidence_id: String,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    evidence_store::read(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &task_id,
        &evidence_id,
        offset,
        limit,
    )
}

fn context_with_selected_skills(
    context: &str,
    skill_definitions: &[ModelSkillDefinition],
    selected_skill_ids: &[String],
    execution_constraints: Option<&ExecutionConstraints>,
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
    if let Some(Value::Array(evidence)) = object.get_mut("skillEvidence") {
        evidence.retain(|item| {
            item.get("skillId")
                .and_then(Value::as_str)
                .is_some_and(|id| selected_skill_ids.iter().any(|selected| selected == id))
        });
    }
    if let Some(Value::Array(tools)) = object.get_mut("tools") {
        // A missing allow-list means a legacy/custom Skill whose capabilities
        // are unknown. Keep the planner-visible catalog in that case so prompt
        // optimization cannot silently remove a required custom capability.
        let restrict_to_allow_lists = !selected.is_empty()
            && selected
                .iter()
                .all(|skill| skill.allowed_tool_ids.is_some());
        let allowed_tool_ids = selected
            .iter()
            .flat_map(|skill| skill.allowed_tool_ids.iter().flatten())
            .cloned()
            .collect::<HashSet<_>>();
        tools.retain(|tool| {
            tool.get("id")
                .and_then(Value::as_str)
                .map(|id| {
                    let forbidden = selected
                        .iter()
                        .any(|skill| skill.forbidden_tool_ids.iter().any(|item| item == id));
                    !forbidden
                        && (!restrict_to_allow_lists
                            || allowed_tool_ids.contains(id)
                            || id == "evidence.read")
                })
                .unwrap_or(true)
        });
    }
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
    if let Some(constraints) = execution_constraints {
        object.insert(
            "executionConstraints".to_string(),
            serde_json::to_value(constraints)
                .map_err(|error| format!("执行约束上下文序列化失败：{error}"))?,
        );
    }
    serde_json::to_string(&value).map_err(|error| format!("Skill 上下文序列化失败：{error}"))
}

fn requirement_classification_context(context: &str) -> Result<String, String> {
    let mut value: Value =
        serde_json::from_str(context).map_err(|error| format!("需求分类上下文无效：{error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "需求分类上下文必须是 JSON 对象".to_string())?;
    // Classification selects intent and Skills; executable tool schemas and
    // credentials are planning-only data and previously dominated this call.
    object.remove("tools");
    object.remove("secretVariables");
    object.remove("serverCredentialGroups");
    object.remove("activeSkills");
    serde_json::to_string(&value).map_err(|error| format!("需求分类上下文序列化失败：{error}"))
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

fn classification_contract_error(
    decision: &AiRequirementDecision,
    skill_selection_error: Option<String>,
) -> Option<String> {
    let relation = decision.relation.as_deref();
    match decision.intent.as_str() {
            "answer"
                if !decision.answer.trim().is_empty()
                    && decision.constraints.is_null()
                    && decision.terminal_context_lines == 0
                    && decision.selected_skill_ids.is_empty()
                    && matches!(relation, Some("side_question" | "cancel_goal")) =>
            {
                None
            }
            "answer" => {
                Some("咨询类响应的 answer 必须是非空字符串且 selectedSkillIds 必须为空".to_string())
            }
            "execute"
                if decision.answer.trim().is_empty()
                    && execute_constraints_match_contract(&decision.constraints)
                    && decision.terminal_context_lines == 0
                    && matches!(
                        relation,
                        Some("new_goal" | "continue" | "supplement" | "replace_goal")
                    )
                    && skill_selection_error.is_none() =>
            {
                None
            }
            "execute" => Some(skill_selection_error.unwrap_or_else(|| {
                if !decision.answer.trim().is_empty() {
                    "执行类响应的 answer 必须为空字符串".to_string()
                } else if !execute_constraints_match_contract(&decision.constraints) {
                    "执行类响应的 constraints 必须包含合法字段且 changePolicy 不得为 unspecified".to_string()
                } else if decision.terminal_context_lines != 0 {
                    "执行类响应的 terminalContextLines 必须为 0".to_string()
                } else {
                    "execute.relation 必须为 new_goal、continue、supplement 或 replace_goal；side_question 只适用于 answer。读取真实环境也属于 execute；首次查询用 new_goal，已有目标按实际关系选择，不能因句式是提问就使用 side_question。保留已正确的 answer 和 constraints。".to_string()
                }
            })),
            "terminal_context"
                if decision.answer.trim().is_empty()
                    && decision.constraints.is_null()
                    && decision.relation.is_none()
                    && decision.selected_skill_ids.is_empty()
                    && (1..=400).contains(&decision.terminal_context_lines) =>
            {
                None
            }
            "terminal_context" => Some("终端上下文请求必须给出 1 到 400 行".to_string()),
            _ => Some("需求分类 intent 只能是 answer、execute 或 terminal_context".to_string()),
        }
}

/// A fresh read-only request cannot be a side question to a nonexistent goal.
/// Never infer a new relation when any prior task context is present or unknown.
fn normalize_initial_readonly_relation(
    decision: &mut AiRequirementDecision,
    context: &str,
) -> bool {
    if decision.intent != "execute"
        || decision.relation.as_deref() != Some("side_question")
        || !decision.answer.trim().is_empty()
        || decision.terminal_context_lines != 0
        || !execute_constraints_match_contract(&decision.constraints)
        || decision.constraints["changePolicy"] != "read_only"
    {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(context) else {
        return false;
    };
    let absent = |key: &str| value.get(key).is_none_or(Value::is_null);
    let empty_array = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    };
    if !value.is_object()
        || !absent("taskGoal")
        || !absent("previousExecution")
        || !empty_array("/conversationHistory")
        || !empty_array("/knownExecutionFacts/completedSteps")
    {
        return false;
    }
    decision.relation = Some("new_goal".into());
    true
}

fn execute_constraints_match_contract(value: &Value) -> bool {
    let Ok(constraints) = serde_json::from_value::<ExecutionConstraints>(value.clone()) else {
        return false;
    };
    matches!(
        constraints.change_policy.as_str(),
        "read_only" | "requested_changes_only" | "allow_necessary_changes"
    ) && matches!(
        constraints.environment_policy.as_str(),
        "unspecified" | "preserve" | "allow_isolated_changes" | "allow_host_changes"
    ) && matches!(
        constraints.failure_policy.as_str(),
        "unspecified" | "strict" | "best_effort"
    )
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
    command
        .split_whitespace()
        .next()
        .is_some_and(|token| token.eq_ignore_ascii_case("opsark-tool"))
}

fn model_tool_id(command: &str) -> Option<&str> {
    if !is_model_tool_command(command) {
        return None;
    }
    command
        .split_whitespace()
        .nth(1)
        .map(|tool_id| tool_id.strip_prefix("--").unwrap_or(tool_id))
        .filter(|tool_id| !tool_id.is_empty())
}

fn active_skill_forbidden_tool_ids(context: &str) -> Result<HashSet<String>, String> {
    let value: Value = serde_json::from_str(context)
        .map_err(|error| format!("active Skill 工具策略上下文无效：{error}"))?;
    let Some(active_skills) = value.get("activeSkills") else {
        return Ok(HashSet::new());
    };
    let active_skills = active_skills
        .as_array()
        .ok_or_else(|| "active Skill 工具策略上下文无效：activeSkills 必须是数组".to_string())?;
    let mut forbidden_tool_ids = HashSet::new();
    for (skill_index, skill) in active_skills.iter().enumerate() {
        let Some(raw_tool_ids) = skill.get("forbiddenToolIds") else {
            continue;
        };
        let raw_tool_ids = raw_tool_ids.as_array().ok_or_else(|| {
            format!(
                "active Skill 工具策略上下文无效：第 {} 个 activeSkills.forbiddenToolIds 必须是数组",
                skill_index + 1,
            )
        })?;
        for raw_tool_id in raw_tool_ids {
            let tool_id = raw_tool_id.as_str().ok_or_else(|| {
                format!(
                    "active Skill 工具策略上下文无效：第 {} 个 activeSkills.forbiddenToolIds 只能包含字符串",
                    skill_index + 1,
                )
            })?;
            let tool_id = tool_id.trim();
            if !tool_id.is_empty() {
                forbidden_tool_ids.insert(tool_id.to_string());
            }
        }
    }
    Ok(forbidden_tool_ids)
}

fn context_visible_tool_ids(context: &str) -> Result<Option<HashSet<String>>, String> {
    let value: Value =
        serde_json::from_str(context).map_err(|error| format!("规划工具上下文无效：{error}"))?;
    let Some(tools) = value.get("tools") else {
        // Legacy callers may not carry a tool directory. Preserve their old
        // behavior instead of treating a missing field as an empty policy.
        return Ok(None);
    };
    let tools = tools
        .as_array()
        .ok_or_else(|| "规划工具上下文无效：tools 必须是数组".to_string())?;
    let mut tool_ids = HashSet::new();
    for (index, tool) in tools.iter().enumerate() {
        let tool_id = tool.get("id").and_then(Value::as_str).ok_or_else(|| {
            format!(
                "规划工具上下文无效：第 {} 个 tools.id 必须是字符串",
                index + 1
            )
        })?;
        let tool_id = tool_id.trim();
        if tool_id.is_empty() {
            return Err(format!(
                "规划工具上下文无效：第 {} 个 tools.id 不能为空",
                index + 1
            ));
        }
        tool_ids.insert(tool_id.to_string());
    }
    Ok(Some(tool_ids))
}

fn validate_active_skill_tool_policy(
    raw_steps: &[AiPlanStep],
    forbidden_tool_ids: &HashSet<String>,
) -> Result<(), String> {
    for (index, step) in raw_steps.iter().enumerate() {
        let Some(tool_id) = model_tool_id(step.command.trim()) else {
            continue;
        };
        if forbidden_tool_ids.contains(tool_id) {
            return Err(format!(
                "第 {} 个计划步骤调用了 active Skill 禁止工具 {tool_id}；必须按 active Skill 的工具策略改用允许的工具或 Shell 流程",
                index + 1,
            ));
        }
    }
    Ok(())
}

fn validate_visible_tool_policy(
    raw_steps: &[AiPlanStep],
    visible_tool_ids: Option<&HashSet<String>>,
) -> Result<(), String> {
    let Some(visible_tool_ids) = visible_tool_ids else {
        return Ok(());
    };
    for (index, step) in raw_steps.iter().enumerate() {
        let Some(tool_id) = model_tool_id(step.command.trim()) else {
            continue;
        };
        if !visible_tool_ids.contains(tool_id) {
            return Err(format!(
                "第 {} 个计划步骤调用了当前规划上下文未开放工具 {tool_id}；只能使用 context.tools 中明确提供的工具或 Shell 流程",
                index + 1,
            ));
        }
    }
    Ok(())
}

fn model_tool_protocol_error(command: &str) -> Option<String> {
    if !is_model_tool_command(command) {
        return None;
    }
    let mut parts = command.trim().splitn(3, char::is_whitespace);
    let _protocol = parts.next();
    let raw_tool_id = parts.next().unwrap_or_default().trim();
    let arguments = parts.next().unwrap_or_default().trim();
    if raw_tool_id.is_empty() {
        return Some("缺少唯一工具 ID 和参数对象".into());
    }
    let tool_id = raw_tool_id.strip_prefix("--").unwrap_or(raw_tool_id);
    if tool_id.is_empty()
        || !tool_id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !tool_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Some(format!("工具 ID 格式无效：{raw_tool_id}"));
    }
    if arguments.is_empty() {
        return Some(format!("工具 {tool_id} 缺少参数对象"));
    }
    if arguments.starts_with("--") {
        return None;
    }
    let json_text =
        if arguments.starts_with('\'') && arguments.ends_with('\'') && arguments.len() >= 2 {
            &arguments[1..arguments.len() - 1]
        } else {
            arguments
        };
    match serde_json::from_str::<Value>(json_text) {
        Ok(Value::Object(_)) => None,
        Ok(_) => Some(format!("工具 {tool_id} 的参数必须是 JSON 对象")),
        Err(error) => Some(format!("工具 {tool_id} 的参数 JSON 无法解析：{error}")),
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
            let kind = item.kind.trim().to_string();
            let command = item.command.trim().to_string();
            let validation = item.validation.trim().to_string();
            let tool_command = is_model_tool_command(&command);
            if command.is_empty()
                || !matches!(kind.as_str(), "observe" | "change")
                || (kind == "change" && validation.is_empty())
                || (kind == "observe" && !tool_command && !validation.is_empty())
            {
                return Err(format!("第 {} 个计划步骤的 kind/command/validation 组合无效", index + 1));
            }
            if let Some(error) = model_tool_protocol_error(&command) {
                return Err(format!("第 {} 个计划步骤的 opsark-tool 协议不完整：{error}", index + 1));
            }
            if kind == "change"
                && matches!(validation.as_str(), "true" | ":" | "exit 0" | "/bin/true")
                && !tool_command
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
            let is_observe = kind == "observe";
            let execution_scope = item
                .execution_scope
                .as_deref()
                .unwrap_or("isolated_exec")
                .to_string();
            if !matches!(
                execution_scope.as_str(),
                "agent_session" | "isolated_exec" | "managed_service" | "user_action"
            ) {
                return Err(format!("第 {} 个计划步骤 executionScope 不合法", index + 1));
            }
            let validation_scope = if is_observe {
                None
            } else {
                let scope = item.validation_scope.as_deref().unwrap_or("isolated_exec");
                if !matches!(
                    scope,
                    "isolated_exec" | "fresh_interactive_shell" | "fresh_login_shell"
                ) {
                    return Err(format!("第 {} 个计划步骤 validationScope 不合法", index + 1));
                }
                Some(scope.to_string())
            };
            let runtime_class = item
                .runtime_class
                .as_deref()
                .unwrap_or(if execution_scope == "managed_service" {
                    "persistent_service"
                } else {
                    "bounded"
                })
                .to_string();
            if !matches!(
                runtime_class.as_str(),
                "bounded" | "progressive" | "persistent_service"
            ) {
                return Err(format!("第 {} 个计划步骤 runtimeClass 不合法", index + 1));
            }
            if item.session_context_change.is_some() && execution_scope != "agent_session" {
                return Err(format!(
                    "第 {} 个计划步骤 sessionContextChange 只能用于 agent_session",
                    index + 1
                ));
            }
            Ok(PlanStep {
                id: format!("ai-step-{}-{index}", unix_seconds()),
                kind,
                title,
                description,
                command,
                risk: risk.into(),
                expected,
                validation,
                execution_scope,
                validation_scope,
                session_context_change: item.session_context_change,
                runtime_class,
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
        if item.kind.trim().is_empty() {
            missing.push("kind");
        }
        if item.expected.trim().is_empty() {
            missing.push("expected");
        }
        if !missing.is_empty() {
            return Err(format!(
                "第 {} 个计划步骤缺少非空字段：{}",
                index + 1,
                missing.join("、")
            ));
        }
        let command = item.command.trim();
        let kind = item.kind.trim();
        if !matches!(kind, "observe" | "change") {
            return Err(format!(
                "第 {} 个计划步骤的 kind 必须是 observe 或 change",
                index + 1
            ));
        }
        if kind == "change" && item.validation.trim().is_empty() {
            return Err(format!(
                "第 {} 个 change 步骤缺少非空 validation",
                index + 1
            ));
        }
        if kind == "observe"
            && !is_model_tool_command(command)
            && !item.validation.trim().is_empty()
        {
            return Err(format!(
                "第 {} 个 observe 步骤必须直接使用主命令结果，validation 必须为空字符串",
                index + 1
            ));
        }
        if let Some(error) = model_tool_protocol_error(command) {
            return Err(format!(
                "第 {} 个计划步骤的 opsark-tool 协议不完整：{error}",
                index + 1
            ));
        }
        if is_model_tool_command(command) && item.validation.trim() != "true" {
            return Err(format!(
                "第 {} 个模型工具步骤的 validation 必须固定为 JSON 字符串 \"true\"",
                index + 1
            ));
        }
        if server_connect_credentials_missing(command) {
            return Err(format!(
                "第 {} 个计划步骤的 server.connect 参数不完整；必须提供 credentialRef，或同时提供 username 和 passwordSecretKey。凭据缺失时应先单独调用 user.request_input",
                index + 1,
            ));
        }
        let credential_context = format!(
            "{}\n{}\n{}",
            item.title.to_ascii_lowercase(),
            item.description.to_ascii_lowercase(),
            item.expected.to_ascii_lowercase(),
        );
        let command_lower = command.to_ascii_lowercase();
        let git_credential_bound = command_lower.contains("git")
            && (credential_context.contains("server-credential:")
                || credential_context.contains("${secret.")
                || credential_context.contains("已保存凭据")
                || credential_context.contains("已选凭据")
                || credential_context.contains("使用凭据"));
        if git_credential_bound && command_lower.contains("git_terminal_prompt=0") {
            return Err(format!(
                "第 {} 个计划步骤引用了 Git HTTPS 凭据但禁用了交互认证提示；必须使用 GIT_TERMINAL_PROMPT=1 和受控 PTY 凭据通道",
                index + 1,
            ));
        }
        if detaches_untracked_process(command) {
            return Err(format!("第 {} 个计划步骤将进程脱离执行器跟踪；必须使用可跟踪的前台命令或受管服务，并获取真实退出状态", index + 1));
        }
        if let Some(issue) = plan_safety_issue(command, "command") {
            return Err(format!(
                "第 {} 个计划步骤的 command 未通过执行前安全检查（{}：{}）；必须修复该安全问题且保留真实退出状态",
                index + 1,
                issue.rule_id,
                issue.reason,
            ));
        }
        if kind == "change" {
            if let Some(issue) = plan_safety_issue(item.validation.trim(), "validation") {
                return Err(format!(
                    "第 {} 个计划步骤的 validation 未通过执行前安全检查（{}：{}）；必须修复该安全问题且保留真实退出状态",
                    index + 1,
                    issue.rule_id,
                    issue.reason,
                ));
            }
        }
        if kind == "change" && validation_waits_for_terminal_input(item.validation.trim()) {
            return Err(format!(
                "第 {} 个计划步骤的 validation 会等待终端标准输入；独立校验不能读取上一条 command 的输出，必须显式提供文件、管道或输入重定向",
                index + 1,
            ));
        }
        if kind == "change" && detaches_untracked_process(item.validation.trim()) {
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

/// A structured tool result is already the step's validation evidence. The model
/// occasionally emits an empty validation field for an otherwise valid tool call;
/// fixing that deterministic protocol detail locally avoids resending the complete
/// task, Skill, and tool context to the model.
fn normalize_model_tool_validations(steps: &mut [AiPlanStep]) -> usize {
    let mut normalized = 0;
    for step in steps {
        let command = step.command.trim();
        if step.validation.trim().is_empty()
            && is_model_tool_command(command)
            && model_tool_protocol_error(command).is_none()
        {
            step.validation = "true".into();
            normalized += 1;
        }
    }
    normalized
}

fn next_stage_limit_rule(settings: &AiGenerationSettings) -> String {
    if settings.limit_output {
        format!(
            "已启用用户配置的输出限制：steps 不超过 {} 个；title、description、expected 各不超过 {} 字符；command、validation 各不超过 {} 字符。",
            settings.max_plan_steps.max(1),
            settings.max_text_chars.max(1),
            settings.max_command_chars.max(1),
        )
    } else {
        "用户未启用计划输出限制：不得因步骤数、字段长度或命令换行而省略必要内容；仍应保持计划最少且完整。".to_string()
    }
}

fn build_next_stage_request_body(
    model: &str,
    requirement: &str,
    context: &str,
    settings: &AiGenerationSettings,
) -> Value {
    let limit_rule = next_stage_limit_rule(settings);
    let mut body = json!({
        "_opsarkContext": context,
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": format!(
                    "{GENERAL_PLAN_SYSTEM}\n{GENERAL_DISCOVERY_RULES}\n{NEXT_STAGE_DECISION_SYSTEM}\n{NEXT_STAGE_OUTPUT_CONTRACT}\n{limit_rule}\n{SECRET_PLACEHOLDER_RULE}\n{REVIEW_SECRET_PLACEHOLDER_RULE}\n{STRICT_JSON_OUTPUT_RULE}"
                )
            },
            {
                "role": "user",
                "content": format!(
                    "整体用户目标：\n{requirement}\n\n阶段结束决策上下文：\n{context}\n\n先执行完成证据门禁；若整体目标尚未完成，必须在同一 JSON 中给出当前证据允许的最小下一阶段。"
                )
            }
        ],
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"}
    });
    if settings.limit_output {
        body["max_tokens"] = json!(settings.max_output_tokens);
    }
    body
}

fn validate_and_convert_ai_next_stage(
    raw: AiNextStageDecision,
    settings: &AiGenerationSettings,
    forbidden_tool_ids: &HashSet<String>,
    visible_tool_ids: Option<&HashSet<String>>,
) -> Result<AiNextStageResult, String> {
    let AiNextStageDecision {
        decision,
        reason,
        summary,
        mut steps,
    } = raw;
    let decision = decision.trim().to_string();
    let reason = reason.trim().to_string();
    let summary = summary.trim().to_string();

    if !matches!(decision.as_str(), "complete" | "continue" | "adjust") {
        return Err("阶段联合决策 decision 必须是 complete、continue 或 adjust".into());
    }
    if reason.is_empty() || summary.is_empty() {
        return Err("阶段联合决策缺少非空 reason 或 summary".into());
    }

    let steps = if decision == "complete" {
        if !steps.is_empty() {
            return Err("阶段联合决策为 complete 时 steps 必须为空数组".into());
        }
        Vec::new()
    } else {
        if steps.is_empty() {
            return Err(format!(
                "阶段联合决策为 {decision} 时 steps 至少需要 1 个元素"
            ));
        }
        normalize_model_tool_validations(&mut steps);
        normalize_recoverable_plan_failure_masks(&mut steps);
        validate_ai_plan_contract(&steps, settings)?;
        validate_active_skill_tool_policy(&steps, forbidden_tool_ids)?;
        validate_visible_tool_policy(&steps, visible_tool_ids)?;
        convert_ai_plan_steps(steps)?
    };

    Ok(AiNextStageResult {
        decision,
        reason,
        summary,
        steps,
    })
}

fn plan_repair_instruction(error: &str, previous_steps: Option<&[AiPlanStep]>) -> String {
    let targeted = if error.contains("当前规划上下文未开放工具") {
        "上次计划调用了 context.tools 未开放的工具。只修复命中的工具步骤：只能从当前 context.tools 选择真实可用工具；若当前阶段不需要工具则改用真实可执行的 Shell 流程，不得猜测隐藏工具或重新扩大工具目录。"
    } else if error.contains("active Skill 禁止工具") {
        "上次计划调用了当前 active Skill 明确禁止的工具。只修复命中的工具步骤：删除该工具调用，并严格按 activeSkills.instructions 中声明的允许工具、凭据通道和处理阶段重建。不得用目录中的另一个工具猜测替代方案；必要能力不存在时，应返回真实阻断。"
    } else if error.contains("禁用了交互认证提示") {
        "上次计划已引用已保存的 Git HTTPS 凭据，却同时设置 GIT_TERMINAL_PROMPT=0，使执行器无法通过受控 PTY 回答 Username/Password。仅修复该认证步骤：改为 GIT_TERMINAL_PROMPT=1，保留原始裸 HTTPS URL、credential.helper= 和同一 server-credential 引用；不得重新索取凭据，不得改用 AskPass、URL userinfo、stdin 管道或凭据文件。"
    } else if error.contains("ASKPASS_CREDENTIAL_SCRIPT") {
        "上次计划试图在远端创建或配置 GIT_ASKPASS/SSH_ASKPASS/core.askpass 脚本，这会让凭据进入脚本、环境或进程上下文，已被确定性安全门禁拒绝。只修复命中的凭据传输方式：删除 AskPass 及相关临时脚本、环境变量和清理逻辑，保留可见 PTY 中前台运行的原生 git/ssh/scp 命令。Git HTTPS 使用不含凭据的原始仓库 URL，并在 description 或 expected 中明确引用已确认的 ${secret.GIT_HTTP_CREDENTIAL}；执行器会在独立 PTY 提示响应通道中回应 Username/Password，不得把用户名或密码写入命令。若尚未收集同一仓库主机的用户名和令牌，本轮只调用 user.request_input。不得用 GIT_TERMINAL_PROMPT=0 禁用该通道。"
    } else if error.contains("SECRET_IN_URL") || error.contains("URL_EMBEDDED_CREDENTIAL") {
        "上次计划把密码、令牌或敏感占位符写入了 URL。保留目标主机、仓库路径和协议语义，但必须从 URL 中删除全部凭据 userinfo 和敏感查询参数。对 Git/SSH/SCP 使用可见 PTY 前台命令，在 description 或 expected 中引用语义匹配的 ${secret.KEY}，由执行器的独立提示响应通道注入；不得改用 AskPass、sshpass、环境变量或明文凭据文件。"
    } else if error.contains("SECRET_ENV_ASSIGNMENT") {
        "上次计划把敏感占位符赋给了 Shell/环境变量，存在被子进程、调试输出或进程环境泄露的风险。删除该赋值及依赖它的凭据脚本；Git/SSH/SCP 必须在可见 PTY 前台执行，由执行器独立响应认证提示。其他业务命令仍只能使用原有语义匹配的 ${secret.KEY} 执行时占位，不得改成明文、URL、stdin 管道、AskPass 或凭据文件。"
    } else if error.contains("CREDENTIAL_PERSISTENCE")
        || error.contains("INSECURE_CREDENTIAL_HELPER")
    {
        "上次计划试图使用明文凭据存储、sshpass 或自制交互脚本。删除 credential.helper store、.git-credentials、.netrc、sshpass/expect 及相关写文件逻辑，保留可见 PTY 中的原生前台命令，并仅通过执行器独立提示响应通道使用已确认的语义化敏感变量。"
    } else if error.contains("observe 步骤") || error.contains("kind/command/validation 组合无效")
    {
        "先根据步骤是否改变目标状态修正 kind。只读查询、状态检查、环境发现和故障诊断必须是 kind=observe，保留主 command 并将 validation 设为空字符串，主命令结果就是证据。会写入、安装、启停、构建或传输的步骤必须是 kind=change，并保留独立只读 validation。不得为了满足格式把观察步骤改成变更。"
    } else if error.contains("无业务意义的 validation") {
        "上次计划把普通 Shell change 步骤的 validation 写成了字符串 \"true\"、:、exit 0 或 /bin/true。只有 command 以 opsark-tool 开头的结构化工具步骤才允许使用 JSON 字符串 \"true\"，即输出 \"validation\":\"true\"；禁止输出 JSON 布尔值 true。请保留语义正确的变更 command，并生成独立、只读、能证明 expected 的后置条件；不得用空操作代替校验，也不得重复执行变更命令。如果该步骤本质上只是查询或诊断，则改为 kind=observe 并将 validation 设为空字符串。"
    } else if error.contains("模型工具步骤的 validation 必须固定为") {
        "上次计划中 command 以 opsark-tool 开头的步骤属于结构化工具调用。请保留其 command，将该步骤 validation 精确设为 JSON 字符串 \"true\"，即输出 \"validation\":\"true\"；禁止输出 JSON 布尔值 true。普通 Shell 步骤仍必须使用独立只读校验。"
    } else if error.contains("opsark-tool 协议不完整") {
        "上次计划生成了不完整或格式错误的工具命令。工具调用必须严格写成 opsark-tool <toolId> <JSON参数对象>，例如 opsark-tool files.get_structure {\"rootPath\":\"/opt/app\"}；toolId 前不要添加 --，必须从工具目录选择真实 ID，并按该工具 inputSchema 提供全部必填参数。不得输出单独的 opsark-tool、占位符工具 ID、数组参数或缺少参数的命令。若当前步骤不需要工具，应改用真实可执行的 Shell 命令和独立 validation。"
    } else if error.contains("VALIDATION_FAILURE_ECHOED") {
        "上次 validation 使用了 `检查命令 || echo 状态`，这会把无匹配、权限错误、参数错误等所有非零结果都改成成功。只修复命中的 validation，并先根据 expected 选择语义：若 expected 要求对象确实运行/存在，直接执行能以非零表示不满足的只读检查，不添加失败回退；若 expected 是获得“运行/未运行”等完整状态分类，则显式保存真实退出码，只把该命令文档明确规定的无匹配码转换为有效分类，其他非零码必须原样退出。例如 pgrep 的 0/1/其他可写为 `pgrep -f -- 'pattern' >/dev/null; rc=$?; case \"$rc\" in 0) echo RUNNING;; 1) echo NOT_RUNNING;; *) exit \"$rc\";; esac`。不得把 pgrep 的退出码规则套给 systemctl、curl、ss 或其他命令；应按实际命令语义分别处理。禁止继续使用 `|| echo`、`|| true` 或无条件成功尾部。"
    } else if error.contains("掩盖了失败退出码") || error.contains("未通过执行前安全检查")
    {
        "上次计划掩盖了真实失败退出码。错误已经明确指出对应步骤、command 或 validation 以及命中的结构；请只修复该字段，移除 || true、|| echo、末尾 true、set +e 后 exit 0 或失败分支 exit 0 等掩盖逻辑。关键命令需要经过 head/tail 展示时，必须使用 set -o pipefail 保留管道失败，或先保存真实退出码再展示日志并以该退出码结束。若该字段混合了发现、分支处理和业务操作，请拆成当前证据允许的单一阶段，不得把失败改写为成功。"
    } else if error.contains("server.connect 参数不完整") {
        "上次计划调用 server.connect 时缺少完整凭据。若已有受管凭据，请使用同一目标 server.resolve_connection 返回的 credentialRef；否则本轮只能调用 user.request_input 收集缺失的目标用户名和 password 类型密码，用户提交后再生成连接或传输步骤。不得把当前源服务器地址当作目标地址。"
    } else if error.contains("会等待终端标准输入") {
        "上次计划中的 validation 使用了没有文件、管道或输入重定向的 grep 等读取器。独立校验不会继承 command 的标准输出；请让 validation 重新读取真实目标状态，或显式指定文件/管道/输入重定向，确保它在非交互 Shell 中自行结束。"
    } else if error.contains("将进程脱离执行器跟踪") {
        "上次计划使用了未受管的后台运行方式。仅修复命中步骤，replacementSteps 中禁止出现任何裸 &、nohup 后台启动、disown、setsid -f 或 setsid --fork。有证据证明 systemd 服务单元存在时，使用 systemctl 前台命令启动，并设置 executionScope=managed_service、runtimeClass=persistent_service，validation 使用 systemctl is-active 独立验收。有证据证明项目由 Docker/Compose 或 Supervisor 管理时，分别使用 docker compose 或 supervisorctl 启动并独立查询状态。如果现有证据不能证明可用的服务管理器、服务名或启动方式，不得猜测或伪造受管声明；将原步骤替换为最少的 kind=observe 发现步骤，确认 systemd、Docker/Compose、Supervisor 或项目自带启动声明后再续接启动计划。只修改 executionScope 而保留脱管命令仍然非法。"
    } else if error.contains("缺少非空字段") || error.contains("change 步骤缺少非空 validation")
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

fn plan_error_step_index(error: &str, step_count: usize) -> Option<usize> {
    let rest = error.strip_prefix("第 ")?;
    let digits = rest
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    let one_based = digits.parse::<usize>().ok()?;
    (one_based > 0 && one_based <= step_count).then_some(one_based)
}

fn focused_plan_repair_instruction(
    error: &str,
    previous_steps: &[AiPlanStep],
    one_based_index: usize,
) -> String {
    let invalid_step = previous_steps
        .get(one_based_index.saturating_sub(1))
        .and_then(|step| serde_json::to_string(step).ok())
        .unwrap_or_else(|| "{}".to_string());
    let nearby_titles = previous_steps
        .iter()
        .enumerate()
        .filter(|(index, _)| index.abs_diff(one_based_index.saturating_sub(1)) <= 1)
        .map(|(index, step)| format!("{}. {}", index + 1, step.title))
        .collect::<Vec<_>>()
        .join("\n");
    let full_guidance = plan_repair_instruction(error, None);
    let targeted = full_guidance
        .split("修复后仍必须返回完整的")
        .next()
        .unwrap_or(&full_guidance)
        .trim();
    format!(
        "{targeted}\n\n本轮仅修复第 {one_based_index} 步，不要重返整份计划。原步骤：\n{invalid_step}\n相邻步骤标题：\n{nearby_titles}\n严格返回 {{\"repair\":{{\"stepIndex\":{one_based_index},\"replacementSteps\":[{{\"kind\":\"observe|change\",\"title\":\"...\",\"description\":\"...\",\"command\":\"...\",\"expected\":\"...\",\"validation\":\"...\",\"risk\":\"low|medium|high\"}}]}}}}。replacementSteps 可用一个或多个最小步骤替换原步骤，不得返回其他未修改步骤。"
    )
}

fn apply_plan_step_repair(
    steps: &mut Vec<AiPlanStep>,
    repair: AiPlanStepRepair,
) -> Result<(), String> {
    if repair.step_index == 0 || repair.step_index > steps.len() {
        return Err(format!(
            "局部修复 stepIndex={} 超出上一版计划范围 1..={}",
            repair.step_index,
            steps.len(),
        ));
    }
    if repair.replacement_steps.is_empty() {
        return Err("局部修复 replacementSteps 至少需要一个步骤".into());
    }
    let index = repair.step_index - 1;
    steps.splice(index..=index, repair.replacement_steps);
    Ok(())
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

fn unquoted_shell_projection(script: &str) -> String {
    let mut output = String::with_capacity(script.len());
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    for character in script.chars() {
        let spaces = || " ".repeat(character.len_utf8());
        if escaped {
            output.push_str(&spaces());
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quoted {
            output.push(' ');
            escaped = true;
            continue;
        }
        if character == '\'' && !double_quoted {
            output.push(' ');
            single_quoted = !single_quoted;
            continue;
        }
        if character == '"' && !single_quoted {
            output.push(' ');
            double_quoted = !double_quoted;
            continue;
        }
        if single_quoted || double_quoted {
            output.push_str(&spaces());
        } else {
            output.push(character.to_ascii_lowercase());
        }
    }
    output
}

fn last_unquoted_statement(script: &str) -> String {
    let visible = unquoted_shell_projection(script);
    let mut start = 0usize;
    let mut last = "";
    for index in 0..=visible.len() {
        let ended =
            index == visible.len() || matches!(visible.as_bytes()[index], b';' | b'\n' | b'\r');
        if !ended {
            continue;
        }
        let statement = script[start..index].trim();
        if !statement.is_empty() {
            last = statement;
        }
        start = index.saturating_add(1);
    }
    last.to_ascii_lowercase()
}

fn has_unquoted_failure_echo(script: &str) -> bool {
    let visible = unquoted_shell_projection(script);
    unquoted_double_pipe_offsets(script)
        .into_iter()
        .any(|operator| {
            let branch = visible[operator + 2..].trim_start();
            branch == "echo"
                || branch.starts_with("echo ")
                || branch.starts_with("echo\t")
                || branch.starts_with("echo\n")
                || branch.starts_with("echo\r")
        })
}

fn failure_branch_has_explicit_zero_exit(script: &str) -> bool {
    let visible = unquoted_shell_projection(script);
    for operator in unquoted_double_pipe_offsets(script) {
        let mut start = operator + 2;
        while visible
            .as_bytes()
            .get(start)
            .is_some_and(u8::is_ascii_whitespace)
        {
            start += 1;
        }
        if visible.as_bytes().get(start) == Some(&b'{') {
            let Some(closing) = matching_unquoted_brace(script, start) else {
                continue;
            };
            if explicit_zero_exit_statement(&script[start + 1..closing]).is_some() {
                return true;
            }
            continue;
        }
        let end = visible[start..]
            .find([';', '\n', '\r'])
            .map(|offset| start + offset)
            .unwrap_or(script.len());
        if script[start..end].trim() == "exit 0" {
            return true;
        }
    }
    false
}

fn failure_mask_reason(script: &str) -> Option<&'static str> {
    let lower = unquoted_shell_projection(script.trim());
    let without_trailing_separator = lower.trim_end_matches([';', '\n', '\r', ' ', '\t']);
    if without_trailing_separator.ends_with("|| true")
        || without_trailing_separator.ends_with("|| /bin/true")
        || without_trailing_separator.ends_with("|| :")
    {
        return Some("以 || true（或等价空操作）结束");
    }
    if without_trailing_separator.ends_with("; true")
        || without_trailing_separator.ends_with("\ntrue")
    {
        return Some("以无条件 true 结束");
    }
    if lower.contains("set +e") {
        let final_statement = last_unquoted_statement(script);
        let propagates_captured_status = final_statement.starts_with("exit $")
            || final_statement.starts_with("exit \"$")
            || final_statement.starts_with("exit '$");
        if !propagates_captured_status {
            return Some("set +e 后未以显式保存的真实退出码结束");
        }
    }
    let has_pipefail = lower.contains("set -o pipefail") || lower.contains("set -eo pipefail");
    if !has_pipefail
        && lower.split([';', '\n']).any(|line| {
            [
                "mysql ",
                "mariadb ",
                "psql ",
                "ssh ",
                "scp ",
                "rsync ",
                "dnf ",
                "yum ",
                "apt ",
                "apt-get ",
                "curl ",
                "wget ",
                "git ",
                "npm ",
                "pnpm ",
                "yarn ",
                "composer ",
            ]
            .iter()
            .any(|command| line.contains(command))
                && (line.contains("| head") || line.contains("| tail"))
        })
    {
        return Some("关键命令直接管道到 head/tail，丢失主进程退出码");
    }
    if ["ssh ", "scp ", "rsync "]
        .iter()
        .any(|command| lower.contains(command))
        && has_unquoted_failure_echo(script)
    {
        return Some("SSH/SCP/rsync 失败后仅 echo，导致分支返回成功");
    }
    if failure_branch_has_explicit_zero_exit(script) {
        return Some("失败分支显式 exit 0");
    }
    None
}

const PRESERVED_FAILURE_STATUS_VARIABLE: &str = "__opsark_preserved_failure_status";

fn unquoted_double_pipe_offsets(script: &str) -> Vec<usize> {
    let bytes = script.as_bytes();
    let mut offsets = Vec::new();
    let mut index = 0;
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    while index + 1 < bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if byte == b'\\' && !single_quoted {
            escaped = true;
            index += 1;
            continue;
        }
        if byte == b'\'' && !double_quoted {
            single_quoted = !single_quoted;
            index += 1;
            continue;
        }
        if byte == b'"' && !single_quoted {
            double_quoted = !double_quoted;
            index += 1;
            continue;
        }
        if !single_quoted && !double_quoted && byte == b'|' && bytes[index + 1] == b'|' {
            offsets.push(index);
            index += 2;
            continue;
        }
        index += 1;
    }
    offsets
}

fn matching_unquoted_brace(script: &str, opening: usize) -> Option<usize> {
    let bytes = script.as_bytes();
    if bytes.get(opening) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate().skip(opening) {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' && !single_quoted {
            escaped = true;
            continue;
        }
        if byte == b'\'' && !double_quoted {
            single_quoted = !single_quoted;
            continue;
        }
        if byte == b'"' && !single_quoted {
            double_quoted = !double_quoted;
            continue;
        }
        if single_quoted || double_quoted {
            continue;
        }
        if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn explicit_zero_exit_statement(inner: &str) -> Option<(usize, usize)> {
    let bytes = inner.as_bytes();
    let mut statement_start = 0usize;
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    for index in 0..=bytes.len() {
        let byte = bytes.get(index).copied();
        if index < bytes.len() {
            if escaped {
                escaped = false;
                continue;
            }
            if byte == Some(b'\\') && !single_quoted {
                escaped = true;
                continue;
            }
            if byte == Some(b'\'') && !double_quoted {
                single_quoted = !single_quoted;
                continue;
            }
            if byte == Some(b'"') && !single_quoted {
                double_quoted = !double_quoted;
                continue;
            }
        }
        let statement_ended = index == bytes.len()
            || (!single_quoted && !double_quoted && matches!(byte, Some(b';' | b'\n' | b'\r')));
        if !statement_ended {
            continue;
        }
        let statement = &inner[statement_start..index];
        let trimmed_start = statement.len() - statement.trim_start().len();
        let trimmed = statement.trim();
        if trimmed == "exit 0" {
            let start = statement_start + trimmed_start;
            return Some((start, start + trimmed.len()));
        }
        statement_start = index.saturating_add(1);
    }
    None
}

/// Repairs only an unambiguous shell anti-pattern rejected by the plan gate:
/// `command || { ...; exit 0; }`. The failure branch remains a failure and
/// propagates the exact status produced by `command`.
fn preserve_explicit_failure_branch_status(script: &str) -> Option<String> {
    for operator in unquoted_double_pipe_offsets(script) {
        let mut opening = operator + 2;
        while script
            .as_bytes()
            .get(opening)
            .is_some_and(u8::is_ascii_whitespace)
        {
            opening += 1;
        }
        if script.as_bytes().get(opening) != Some(&b'{') {
            continue;
        }
        let Some(closing) = matching_unquoted_brace(script, opening) else {
            continue;
        };
        let inner = &script[opening + 1..closing];
        let Some((exit_start, exit_end)) = explicit_zero_exit_statement(inner) else {
            continue;
        };

        let mut repaired = String::with_capacity(script.len() + 96);
        repaired.push_str(&script[..opening + 1]);
        repaired.push(' ');
        repaired.push_str(PRESERVED_FAILURE_STATUS_VARIABLE);
        repaired.push_str("=$?;");
        repaired.push_str(&inner[..exit_start]);
        repaired.push_str("exit \"$");
        repaired.push_str(PRESERVED_FAILURE_STATUS_VARIABLE);
        repaired.push('"');
        repaired.push_str(&inner[exit_end..]);
        repaired.push_str(&script[closing..]);
        return Some(repaired);
    }
    None
}

fn normalize_recoverable_plan_failure_masks(steps: &mut [AiPlanStep]) -> usize {
    let mut repaired_fields = 0;
    for step in steps {
        let mut command = step.command.clone();
        let mut command_repaired = false;
        while let Some(repaired) = preserve_explicit_failure_branch_status(&command) {
            command = repaired;
            command_repaired = true;
        }
        if command_repaired {
            step.command = command;
            repaired_fields += 1;
        }

        let mut validation = step.validation.clone();
        let mut validation_repaired = false;
        while let Some(repaired) = preserve_explicit_failure_branch_status(&validation) {
            validation = repaired;
            validation_repaired = true;
        }
        if validation_repaired {
            step.validation = validation;
            repaired_fields += 1;
        }
    }
    repaired_fields
}

fn normalize_recoverable_failure_mask_script(script: &str) -> (String, bool) {
    let mut normalized = script.to_string();
    let mut repaired = false;
    while let Some(next) = preserve_explicit_failure_branch_status(&normalized) {
        normalized = next;
        repaired = true;
    }
    (normalized, repaired)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanSafetyIssue {
    field: String,
    rule_id: String,
    reason: String,
    snippet: String,
    repairable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanStepSafetyAnalysis {
    safe: bool,
    normalized_command: String,
    normalized_validation: String,
    repaired_fields: Vec<String>,
    issues: Vec<PlanSafetyIssue>,
    /// Retained for compatibility with older persisted frontend state.
    issue: Option<PlanSafetyIssue>,
}

fn url_candidates(script: &str) -> Vec<&str> {
    let bytes = script.as_bytes();
    let mut candidates = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = script[search_from..].find("://") {
        let separator = search_from + relative;
        let mut start = separator;
        while start > 0 {
            let character = bytes[start - 1] as char;
            if !(character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')) {
                break;
            }
            start -= 1;
        }
        let mut end = separator + 3;
        while end < bytes.len() {
            let character = bytes[end] as char;
            if character.is_ascii_whitespace() || matches!(character, '\'' | '"' | '`' | '<' | '>')
            {
                break;
            }
            end += 1;
        }
        if start < separator && end > separator + 3 {
            candidates.push(&script[start..end]);
        }
        search_from = end.max(separator + 3);
    }
    candidates
}

fn shell_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn sensitive_environment_assignment(script: &str) -> bool {
    for (equals, _) in script.match_indices('=') {
        let left = script[..equals].trim_end();
        let name = left
            .rsplit_once(|character: char| {
                character.is_ascii_whitespace() || matches!(character, ';' | '|' | '&')
            })
            .map(|(_, value)| value)
            .unwrap_or(left);
        if !shell_identifier(name) {
            continue;
        }
        let right = script[equals + 1..]
            .split([';', '\n', '\r'])
            .next()
            .unwrap_or("")
            .trim_start();
        let upper_name = name.to_ascii_uppercase();
        let sensitive_name = [
            "PASSWORD",
            "PASSWD",
            "TOKEN",
            "SECRET",
            "CREDENTIAL",
            "API_KEY",
            "ACCESS_KEY",
        ]
        .iter()
        .any(|marker| upper_name.contains(marker))
            || upper_name.ends_with("_PWD");
        if sensitive_name || right.contains("${secret.") {
            return true;
        }
    }
    false
}

fn credential_transport_issue(script: &str) -> Option<(&'static str, &'static str, &'static str)> {
    for candidate in url_candidates(script) {
        if candidate.contains("${secret.") {
            return Some((
                "SECRET_IN_URL",
                "敏感变量不得出现在 URL 中；解析后可能进入进程参数、日志和 Git remote 配置",
                "URL 中的 ${secret.NAME}",
            ));
        }
        let (scheme, after_scheme) = candidate.split_once("://").unwrap_or(("", ""));
        let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
        if let Some((userinfo, _)) = authority.rsplit_once('@') {
            if userinfo.contains(':')
                || (!userinfo.is_empty()
                    && (scheme.eq_ignore_ascii_case("http")
                        || scheme.eq_ignore_ascii_case("https")))
            {
                return Some((
                    "URL_EMBEDDED_CREDENTIAL",
                    "HTTPS URL userinfo 中包含用户名或凭据，可能泄露到进程参数、日志和持久化配置",
                    "https://userinfo@host",
                ));
            }
        }
        let lower = candidate.to_ascii_lowercase();
        if [
            "password=",
            "passwd=",
            "pwd=",
            "token=",
            "access_token=",
            "access-token=",
            "api_key=",
            "api-key=",
            "secret=",
            "credential=",
        ]
        .iter()
        .any(|key| lower.contains(&format!("?{key}")) || lower.contains(&format!("&{key}")))
        {
            return Some((
                "URL_EMBEDDED_CREDENTIAL",
                "URL 查询参数中包含凭据字段，可能被日志、代理或历史记录持久化",
                "URL 中的 password/token/secret 参数",
            ));
        }
    }
    let lower = script.to_ascii_lowercase();
    if lower.contains("git_askpass")
        || lower.contains("ssh_askpass")
        || lower.contains("core.askpass")
    {
        return Some((
            "ASKPASS_CREDENTIAL_SCRIPT",
            "禁止在远端命令中创建或配置 AskPass 凭据脚本；应使用执行器独立的 PTY 提示响应通道",
            "GIT_ASKPASS/SSH_ASKPASS/core.askpass",
        ));
    }
    if sensitive_environment_assignment(script) {
        return Some((
            "SECRET_ENV_ASSIGNMENT",
            "禁止把敏感变量解析到 Shell 变量或环境变量；凭据可能被子进程、调试输出或进程环境读取",
            "NAME=${secret.NAME}",
        ));
    }
    if lower.contains("sshpass")
        || ((lower.contains("python")
            || lower.contains("perl")
            || lower.contains("ruby")
            || lower.contains("expect"))
            && lower.contains("${secret.")
            && ["password", "passwd", "token", "credential"]
                .iter()
                .any(|value| lower.contains(value)))
    {
        return Some((
            "INSECURE_CREDENTIAL_HELPER",
            "禁止通过 sshpass 或临时交互脚本传递凭据；应使用执行器独立的 PTY 提示响应通道",
            "sshpass/credential helper script",
        ));
    }
    if lower.contains("credential.helper store")
        || lower.contains("credential.helper=store")
        || lower.contains(".git-credentials")
        || lower.contains(".netrc")
    {
        return Some((
            "CREDENTIAL_PERSISTENCE",
            "禁止把仓库凭据写入明文凭据存储或用户文件",
            "credential.helper store/.netrc/.git-credentials",
        ));
    }
    None
}

fn plan_safety_issue(script: &str, field: &str) -> Option<PlanSafetyIssue> {
    if let Some((rule_id, reason, snippet)) = credential_transport_issue(script) {
        return Some(PlanSafetyIssue {
            field: field.into(),
            rule_id: rule_id.into(),
            reason: reason.into(),
            snippet: snippet.into(),
            repairable: false,
        });
    }
    if field == "validation" && has_unquoted_failure_echo(script) {
        return Some(PlanSafetyIssue {
            field: field.into(),
            rule_id: "VALIDATION_FAILURE_ECHOED".into(),
            reason: "后置校验失败后仅输出提示，无法证明预期结果".into(),
            snippet: "validation || echo".into(),
            repairable: false,
        });
    }
    let reason = failure_mask_reason(script)?;
    let (rule_id, snippet) = match reason {
        "以 || true（或等价空操作）结束" => {
            ("EMPTY_SUCCESS_FALLBACK", "|| true（或等价空操作）")
        }
        "以无条件 true 结束" => ("UNCONDITIONAL_SUCCESS_TAIL", "; true"),
        "set +e 后未以显式保存的真实退出码结束" => {
            ("SET_PLUS_E_STATUS_LOST", "set +e")
        }
        "关键命令直接管道到 head/tail，丢失主进程退出码" => {
            ("PIPELINE_STATUS_LOST", "关键命令 | head/tail")
        }
        "SSH/SCP/rsync 失败后仅 echo，导致分支返回成功" => {
            ("REMOTE_FAILURE_ECHOED", "SSH/SCP/rsync || echo")
        }
        "失败分支显式 exit 0" => ("FAILURE_BRANCH_EXIT_ZERO", "失败分支 exit 0"),
        _ => ("FAILURE_STATUS_MASKED", "退出状态被覆盖"),
    };
    Some(PlanSafetyIssue {
        field: field.into(),
        rule_id: rule_id.into(),
        reason: reason.into(),
        snippet: snippet.into(),
        repairable: rule_id == "FAILURE_BRANCH_EXIT_ZERO"
            && preserve_explicit_failure_branch_status(script).is_some(),
    })
}

fn analyze_plan_step_safety_inner(
    command: &str,
    validation: &str,
    repair: bool,
) -> PlanStepSafetyAnalysis {
    let (normalized_command, command_repaired) = if repair {
        normalize_recoverable_failure_mask_script(command)
    } else {
        (command.to_string(), false)
    };
    let (normalized_validation, validation_repaired) = if repair {
        normalize_recoverable_failure_mask_script(validation)
    } else {
        (validation.to_string(), false)
    };
    let mut repaired_fields = Vec::new();
    if command_repaired {
        repaired_fields.push("command".into());
    }
    if validation_repaired {
        repaired_fields.push("validation".into());
    }
    let mut issues = Vec::new();
    if let Some(issue) = plan_safety_issue(&normalized_command, "command") {
        issues.push(issue);
    }
    if let Some(issue) = plan_safety_issue(&normalized_validation, "validation") {
        issues.push(issue);
    }
    let issue = issues.first().cloned();
    PlanStepSafetyAnalysis {
        safe: issues.is_empty(),
        normalized_command,
        normalized_validation,
        repaired_fields,
        issues,
        issue,
    }
}

#[tauri::command]
fn analyze_plan_step_safety(
    command: String,
    validation: String,
    repair: bool,
) -> PlanStepSafetyAnalysis {
    analyze_plan_step_safety_inner(&command, &validation, repair)
}

#[cfg(test)]
fn masks_failure_status(script: &str) -> bool {
    failure_mask_reason(script).is_some()
}

fn command_safety_rejection(command: &str) -> Option<CommandResult> {
    let issue = plan_safety_issue(command, "command")?;
    Some(CommandResult {
        output: format!(
            "[安全策略] 执行前安全检查未通过（{}）：{}；命令尚未发送到服务器",
            issue.rule_id, issue.reason
        ),
        success: false,
        simulated: false,
        exit_code: 126,
        empty_result: false,
    })
}

fn server_connect_credentials_missing(command: &str) -> bool {
    let lower = command.trim().to_ascii_lowercase();
    if !lower.starts_with("opsark-tool server.connect ") {
        return false;
    }
    let has_credential_ref = lower.contains("credentialref") || lower.contains("--credential-ref");
    let has_username = lower.contains("username") || lower.contains("--username");
    let has_password_secret_key =
        lower.contains("passwordsecretkey") || lower.contains("--password-secret-key");
    !(has_credential_ref || has_username && has_password_secret_key)
}

fn validation_waits_for_terminal_input(script: &str) -> bool {
    let branches = script
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace(';', "\n");
    branches.lines().any(|branch| {
        let command = branch.trim_start();
        let mut words = command.split_whitespace();
        let executable = words.next().unwrap_or("");
        if !matches!(executable, "grep" | "egrep" | "fgrep") {
            return false;
        }
        let arguments = words.take_while(|word| *word != "|").collect::<Vec<_>>();
        let has_input_redirection = arguments.iter().any(|word| word.starts_with('<'));
        let positional_count = arguments
            .iter()
            .filter(|word| !word.starts_with('-') && !word.starts_with('>'))
            .count();
        !has_input_redirection && positional_count < 2
    })
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
    if let Some(rejection) = command_safety_rejection(&command) {
        return Ok(rejection);
    }
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
    app: AppHandle,
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    generation_settings: Option<AiGenerationSettings>,
) -> Result<Vec<PlanStep>, String> {
    let mut developer_trace = ModelDeveloperTrace::default();
    let developer_log_path = developer_model_log_path(&app);
    generate_ai_plan_with_trace(
        api_key,
        endpoint,
        model,
        requirement,
        context,
        generation_settings,
        &mut developer_trace,
        developer_log_path.as_deref(),
    )
    .await
    .map_err(|error| traced_model_error(error, &developer_trace))
}

async fn generate_ai_plan_with_trace(
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    generation_settings: Option<AiGenerationSettings>,
    developer_trace: &mut ModelDeveloperTrace,
    developer_log_path: Option<&Path>,
) -> Result<Vec<PlanStep>, String> {
    let generation_settings = generation_settings.unwrap_or_default();
    let forbidden_tool_ids = active_skill_forbidden_tool_ids(&context)?;
    let visible_tool_ids = context_visible_tool_ids(&context)?;
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
    for attempt in 0..PLAN_GENERATION_ATTEMPTS {
        let focused_repair_index = (attempt > 0)
            .then(|| {
                last_repairable_steps
                    .as_ref()
                    .and_then(|steps: &Vec<AiPlanStep>| {
                        plan_error_step_index(&last_error, steps.len())
                    })
            })
            .flatten();
        let correction = match (focused_repair_index, last_repairable_steps.as_deref()) {
            (Some(index), Some(steps)) => {
                focused_plan_repair_instruction(&last_error, steps, index)
            }
            _ if attempt > 0 => {
                plan_repair_instruction(&last_error, last_repairable_steps.as_deref())
            }
            _ => String::new(),
        };
        let response_contract = if focused_repair_index.is_some() {
            "本轮是局部计划修复，只允许返回 correction 中指定的 repair JSON 对象，不得重返 steps。"
        } else {
            PLAN_STEP_OUTPUT_CONTRACT
        };
        let mut body = json!({
            "_opsarkContext": context,
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{deployment_rules}\n{response_contract}\n{limit_rule}\n{SECRET_PLACEHOLDER_RULE}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("服务器上下文：\n{context}\n\n用户需求：\n{requirement}\n\n严格按系统消息中的计划契约返回。{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"}
        });
        if generation_settings.limit_output {
            body["max_tokens"] = json!(generation_settings.max_output_tokens.max(256));
        }
        let request_snapshot = body.clone();
        let started_at = Instant::now();
        let payload =
            match post_model_request(&url, &api_key, &body, "计划生成", 60, developer_log_path)
                .await
            {
                Ok(payload) => payload,
                Err(error) => {
                    record_model_attempt(
                        developer_trace,
                        "plan_generation",
                        attempt + 1,
                        started_at,
                        request_snapshot,
                        None,
                        Some(error.clone()),
                    );
                    return Err(error);
                }
            };
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
            record_model_attempt(
                developer_trace,
                "plan_generation",
                attempt + 1,
                started_at,
                request_snapshot,
                Some(payload),
                Some(last_error.clone()),
            );
            continue;
        }
        let parsed = message_content(&payload, "模型响应缺少计划内容").and_then(|content| {
            if let (Some(expected_index), Some(previous_steps)) =
                (focused_repair_index, last_repairable_steps.as_ref())
            {
                let envelope =
                    parse_model_json::<AiPlanRepairEnvelope>(content).map_err(|error| {
                        format!("第 {expected_index} 个计划步骤的局部修复结构解析失败：{error}")
                    })?;
                if envelope.repair.step_index != expected_index {
                    return Err(format!(
                        "第 {expected_index} 个计划步骤的局部修复返回了错误 stepIndex={} ",
                        envelope.repair.step_index,
                    ));
                }
                let mut repaired = previous_steps.clone();
                apply_plan_step_repair(&mut repaired, envelope.repair)?;
                Ok(repaired)
            } else {
                parse_model_array_field(content, "steps")
                    .map_err(|error| format!("模型计划结构解析失败：{error}"))
            }
        });
        match parsed {
            Ok(mut raw_steps) => {
                normalize_model_tool_validations(&mut raw_steps);
                normalize_recoverable_plan_failure_masks(&mut raw_steps);
                last_repairable_steps = Some(raw_steps.clone());
                match validate_ai_plan_contract(&raw_steps, &generation_settings)
                    .and_then(|_| {
                        validate_active_skill_tool_policy(&raw_steps, &forbidden_tool_ids)
                    })
                    .and_then(|_| {
                        validate_visible_tool_policy(&raw_steps, visible_tool_ids.as_ref())
                    })
                    .and_then(|_| convert_ai_plan_steps(raw_steps))
                {
                    Ok(plan) => {
                        record_model_attempt(
                            developer_trace,
                            "plan_generation",
                            attempt + 1,
                            started_at,
                            request_snapshot,
                            Some(payload),
                            None,
                        );
                        return Ok(plan);
                    }
                    Err(error) => {
                        last_error = error;
                        record_model_attempt(
                            developer_trace,
                            "plan_generation",
                            attempt + 1,
                            started_at,
                            request_snapshot,
                            Some(payload),
                            Some(last_error.clone()),
                        );
                    }
                }
            }
            Err(error) => {
                last_error = error;
                record_model_attempt(
                    developer_trace,
                    "plan_generation",
                    attempt + 1,
                    started_at,
                    request_snapshot,
                    Some(payload),
                    Some(last_error.clone()),
                );
            }
        }
    }
    if let Some(raw_steps) = last_repairable_steps {
        let only_presentational_fields_missing = raw_steps.iter().all(|item| {
            !item.command.trim().is_empty()
                && matches!(item.kind.trim(), "observe" | "change")
                && ((item.kind.trim() == "observe"
                    && (item.validation.trim().is_empty()
                        || is_model_tool_command(item.command.trim())))
                    || (item.kind.trim() == "change" && !item.validation.trim().is_empty()))
                && item
                    .risk
                    .as_deref()
                    .is_some_and(|value| matches!(value, "low" | "medium" | "high"))
        });
        let execution_fields_safe =
            raw_steps.iter().all(|item| {
                !detaches_untracked_process(item.command.trim())
                    && !detaches_untracked_process(item.validation.trim())
                    && !validation_waits_for_terminal_input(item.validation.trim())
                    && !server_connect_credentials_missing(item.command.trim())
                    && model_tool_protocol_error(item.command.trim()).is_none()
                    && plan_safety_issue(item.command.trim(), "command").is_none()
                    && plan_safety_issue(item.validation.trim(), "validation").is_none()
            }) && validate_active_skill_tool_policy(&raw_steps, &forbidden_tool_ids).is_ok()
                && validate_visible_tool_policy(&raw_steps, visible_tool_ids.as_ref()).is_ok();
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
        "{last_error}（已携带上一版计划和具体错误，连续要求模型针对性修复 {} 次）",
        PLAN_GENERATION_ATTEMPTS - 1,
    ))
}

#[tauri::command]
async fn decide_ai_next_stage(
    app: AppHandle,
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    context: String,
    generation_settings: Option<AiGenerationSettings>,
) -> Result<AiNextStageResult, String> {
    let generation_settings = generation_settings.unwrap_or_default();
    let mut developer_trace = ModelDeveloperTrace::default();
    let forbidden_tool_ids = active_skill_forbidden_tool_ids(&context)
        .map_err(|error| traced_model_error(error, &developer_trace))?;
    let visible_tool_ids = context_visible_tool_ids(&context)
        .map_err(|error| traced_model_error(error, &developer_trace))?;
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let body = build_next_stage_request_body(&model, &requirement, &context, &generation_settings);
    let request_snapshot = body.clone();
    let started_at = Instant::now();
    let developer_log_path = developer_model_log_path(&app);
    let payload = match post_model_request(
        &url,
        &api_key,
        &body,
        "阶段联合决策",
        60,
        developer_log_path.as_deref(),
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) => {
            record_model_attempt(
                &mut developer_trace,
                "next_stage_decision",
                1,
                started_at,
                request_snapshot,
                None,
                Some(error.clone()),
            );
            return Err(traced_model_error(error, &developer_trace));
        }
    };

    let finish_reason = payload
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str);
    if finish_reason.is_some_and(|reason| reason != "stop") {
        let error = if finish_reason == Some("length") {
            "阶段联合决策因达到输出长度上限而被截断".to_string()
        } else {
            format!(
                "阶段联合决策未正常完成，finish_reason={}",
                finish_reason.unwrap_or("未知")
            )
        };
        record_model_attempt(
            &mut developer_trace,
            "next_stage_decision",
            1,
            started_at,
            request_snapshot,
            Some(payload),
            Some(error.clone()),
        );
        return Err(traced_model_error(error, &developer_trace));
    }

    let result = message_content(&payload, "模型响应缺少阶段联合决策内容")
        .and_then(|content| {
            parse_model_json::<AiNextStageDecision>(content)
                .map_err(|error| format!("阶段联合决策结构解析失败：{error}"))
        })
        .and_then(|decision| {
            validate_and_convert_ai_next_stage(
                decision,
                &generation_settings,
                &forbidden_tool_ids,
                visible_tool_ids.as_ref(),
            )
        });

    match result {
        Ok(decision) => {
            record_model_attempt(
                &mut developer_trace,
                "next_stage_decision",
                1,
                started_at,
                request_snapshot,
                Some(payload),
                None,
            );
            Ok(decision)
        }
        Err(error) => {
            record_model_attempt(
                &mut developer_trace,
                "next_stage_decision",
                1,
                started_at,
                request_snapshot,
                Some(payload),
                Some(error.clone()),
            );
            Err(traced_model_error(error, &developer_trace))
        }
    }
}

#[tauri::command]
async fn process_ai_requirement(
    app: AppHandle,
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
    let mut developer_trace = ModelDeveloperTrace::default();
    let developer_log_path = developer_model_log_path(&app);
    let classification_context = requirement_classification_context(&context)
        .map_err(|error| traced_model_error(error, &developer_trace))?;
    for attempt in 0..STRUCTURED_OUTPUT_ATTEMPTS {
        let correction = if attempt == 0 {
            String::new()
        } else {
            format!(
                "\n\n上次输出未通过需求分类结构校验：{last_error}。请丢弃上次输出，严格按分类契约重新返回完整对象，不得输出 steps 或计划字段。"
            )
        };
        let body = json!({
            "_opsarkContext": classification_context,
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{SECRET_PLACEHOLDER_RULE}\n{REQUIREMENT_CLASSIFICATION_CONTRACT}\n{REQUIREMENT_RELATION_RULE}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("服务器上下文：\n{classification_context}\n\n用户输入：\n{requirement}\n\n严格按系统消息中的分类契约返回。{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": 1200
        });
        let request_snapshot = body.clone();
        let started_at = Instant::now();
        let payload = match post_model_request(
            &url,
            &api_key,
            &body,
            "需求理解",
            45,
            developer_log_path.as_deref(),
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) => {
                record_model_attempt(
                    &mut developer_trace,
                    "requirement_classification",
                    attempt + 1,
                    started_at,
                    request_snapshot,
                    None,
                    Some(error.clone()),
                );
                return Err(traced_model_error(error, &developer_trace));
            }
        };
        let parsed = message_content(&payload, "模型响应缺少需求理解结果").and_then(|content| {
            parse_model_json(content).map_err(|error| format!("需求理解结构解析失败：{error}"))
        });
        let mut decision: AiRequirementDecision = match parsed {
            Ok(decision) => decision,
            Err(error) => {
                last_error = error;
                record_model_attempt(
                    &mut developer_trace,
                    "requirement_classification",
                    attempt + 1,
                    started_at,
                    request_snapshot,
                    Some(payload),
                    Some(last_error.clone()),
                );
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
        } else {
            decision
                .selected_skill_ids
                .iter()
                .find(|id| !available_skill_ids.contains(id.as_str()))
                .map(|id| format!("selectedSkillIds 包含未启用或不存在的 Skill：{id}"))
        };
        if skill_selection_error.is_none()
            && normalize_initial_readonly_relation(&mut decision, &context)
        {
            developer_trace.normalizations.push("首次只读执行且无历史目标：relation 从 side_question 规范为 new_goal；原始模型响应保留。".into());
        }
        let contract_error = classification_contract_error(&decision, skill_selection_error);
        if let Some(error) = contract_error {
            last_error = error;
            record_model_attempt(
                &mut developer_trace,
                "requirement_classification",
                attempt + 1,
                started_at,
                request_snapshot,
                Some(payload),
                Some(last_error.clone()),
            );
            continue;
        }
        record_model_attempt(
            &mut developer_trace,
            "requirement_classification",
            attempt + 1,
            started_at,
            request_snapshot,
            Some(payload),
            None,
        );
        valid_decision = Some(decision);
        break;
    }
    let decision = valid_decision.ok_or_else(|| {
        traced_model_error(
            format!("{last_error}（已携带具体分类错误重试一次）"),
            &developer_trace,
        )
    })?;
    if decision.intent == "answer" {
        return Ok(RequirementProcessingResult {
            intent: "answer".into(),
            relation: decision.relation,
            answer: Some(decision.answer.trim().to_string()),
            plan: Vec::new(),
            constraints: None,
            terminal_context_lines: 0,
            selected_skill_ids: Vec::new(),
            plan_error: None,
            developer_trace,
        });
    }
    if decision.intent == "terminal_context" {
        return Ok(RequirementProcessingResult {
            intent: "terminal_context".into(),
            relation: None,
            answer: None,
            plan: Vec::new(),
            constraints: None,
            terminal_context_lines: decision.terminal_context_lines,
            selected_skill_ids: Vec::new(),
            plan_error: None,
            developer_trace,
        });
    }

    let relation = decision.relation;
    let selected_skill_ids = decision.selected_skill_ids;
    let constraints = serde_json::from_value::<ExecutionConstraints>(decision.constraints)
        .map(Some)
        .map(normalize_execution_constraints)
        .map_err(|error| {
            traced_model_error(
                format!("需求分类 constraints 结构无效：{error}"),
                &developer_trace,
            )
        })?;
    let plan_context = context_with_selected_skills(
        &context,
        &skill_definitions,
        &selected_skill_ids,
        Some(&constraints),
    )
    .map_err(|error| traced_model_error(error, &developer_trace))?;
    let plan_result = generate_ai_plan_with_trace(
        api_key,
        endpoint,
        model,
        requirement,
        plan_context,
        generation_settings,
        &mut developer_trace,
        developer_log_path.as_deref(),
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
        relation,
        answer: None,
        plan,
        constraints: Some(constraints),
        terminal_context_lines: 0,
        selected_skill_ids,
        plan_error,
        developer_trace,
    })
}

#[tauri::command]
async fn check_ai_model(
    api_key: String,
    endpoint: String,
    model: String,
    request_parameters: Option<Value>,
) -> Result<ModelCheckResult, String> {
    if let Some(parameters) = request_parameters.filter(|value| value.as_object().is_some_and(|object| !object.is_empty())) {
        let mut body = json!({"model":model,"messages":[{"role":"user","content":"Reply OK."}],"max_tokens":16});
        model_parameters::apply(&mut body, &parameters)?;
        let payload = post_model_request(&format!("{}/chat/completions", endpoint.trim_end_matches('/')), &api_key, &body, "模型参数测试", 60, None).await?;
        message_content(&payload, "模型测试没有返回文本")?;
        return Ok(ModelCheckResult { available: true, reason: "模型生成测试通过，接口已接受请求参数（实际效果以服务端实现为准）".into() });
    }
    let availability = check_model_availability(&api_key, &endpoint, &model).await?;
    Ok(ModelCheckResult {
        available: availability.available,
        reason: availability.reason,
    })
}

#[tauri::command]
async fn generate_ai_summary(
    app: AppHandle,
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    execution_context: String,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = GENERAL_SUMMARY_SYSTEM;
    let body = json!({
        "_opsarkContext": execution_context,
        "model": model,
        "messages": [
            {"role": "system", "content": format!("{system}\n{SECRET_PLACEHOLDER_RULE}")},
            {"role": "user", "content": format!("用户需求：\n{requirement}\n\n已脱敏的执行结果：\n{execution_context}")}
        ],
        "thinking": {"type": "disabled"},
        "max_tokens": 700
    });
    let developer_log_path = developer_model_log_path(&app);
    let payload = post_model_request(
        &url,
        &api_key,
        &body,
        "模型总结",
        30,
        developer_log_path.as_deref(),
    )
    .await?;
    let content = message_content(&payload, "模型总结为空")?.trim();
    if content.is_empty() {
        Err("模型总结为空".to_string())
    } else {
        Ok(content.to_owned())
    }
}

fn is_periodic_long_running_review(review_context: &str) -> bool {
    serde_json::from_str::<Value>(review_context)
        .ok()
        .and_then(|value| value.get("trigger")?.as_str().map(str::to_owned))
        .as_deref()
        == Some("periodic_long_running")
}

#[tauri::command]
async fn review_ai_step(
    app: AppHandle,
    api_key: String,
    endpoint: String,
    model: String,
    requirement: String,
    review_context: String,
) -> Result<AiStepReview, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let periodic_long_running = is_periodic_long_running_review(&review_context);
    let system = if periodic_long_running {
        LONG_RUNNING_REVIEW_SYSTEM
    } else {
        GENERAL_REVIEW_SYSTEM
    };
    let max_tokens = if periodic_long_running { 220 } else { 500 };
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
            "_opsarkContext": review_context,
            "model": model,
            "messages": [
                {"role": "system", "content": format!("{system}\n{REVIEW_SECRET_PLACEHOLDER_RULE}\n{STRICT_JSON_OUTPUT_RULE}")},
                {"role": "user", "content": format!("用户目标：\n{requirement}\n\n执行复核上下文：\n{review_context}\n\n返回前再次确认：必须为 {{\"decision\":\"continue|adjust|complete\",\"reason\":\"非空字符串\",\"summary\":\"非空字符串\"}}。{correction}")}
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens
        });
        let developer_log_path = developer_model_log_path(&app);
        let payload = post_model_request(
            &url,
            &api_key,
            &body,
            "结果复核",
            25,
            developer_log_path.as_deref(),
        )
        .await?;
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
        .manage(local_terminal::LocalTerminalManager::default())
        .manage(AgentTerminalManager::default())
        .manage(SftpTransferManager::default())
        .manage(ExecutionManager::default())
        .invoke_handler(tauri::generate_handler![
            local_terminal::open_local_terminal,
            local_terminal::write_local_terminal,
            local_terminal::resize_local_terminal,
            local_terminal::close_local_terminal,
            append_task_log,
            save_task_evidence,
            read_task_evidence,
            get_realtime_metrics,
            probe_ssh_server,
            execute_ssh_command,
            cancel_ssh_execution,
            create_agent_terminal,
            execute_agent_terminal_command,
            update_agent_session_context,
            interrupt_agent_terminal_command,
            sample_agent_terminal_progress,
            close_agent_terminal,
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
            read_sftp_file_prefix,
            read_local_file_for_upload,
            write_sftp_file,
            upload_sftp_transfer,
            download_sftp_transfer,
            transfer_sftp_between_servers,
            cancel_sftp_transfer,
            get_ssh_metrics,
            analyze_plan_step_safety,
            generate_ai_plan,
            decide_ai_next_stage,
            process_ai_requirement,
            check_ai_model,
            generate_ai_summary,
            review_ai_step,
            save_credential,
            load_credential,
            delete_credential,
            knowledge::knowledge_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Opsark");
}
