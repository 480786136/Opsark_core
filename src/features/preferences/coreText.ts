import { i18n, messages as uiMessages } from "./i18n";

const knowledgeErrorKeys = [
  "enableUploadFirst", "noExecutableSteps", "interrupted", "storageCorrupted",
  "requestBusySave", "endpointChangeNeedsKey", "enableNeedsConfiguration", "desktopSaveKey",
  "newEndpointNeedsTest", "requestBusy", "desktopKeychain", "invalidBaseList", "destinationChanged",
  "enableAndSaveKey", "baseChanged", "newerUploadExists", "historyFull", "requestBusyRetry",
  "uploadPaused", "previewConfigurationChanged", "retryLater", "invalidUploadResponse", "uploadFailed",
  "statusQueryDisabled", "recordServiceChanged", "invalidRecordStatus", "invalidEndpoint",
  "endpointRequirements", "desktopConnectionRequired", "invalidKey", "forbidden", "conflict",
  "gone", "payloadTooLarge", "invalidRecord", "rateLimited",
] as const;
const credentialErrorKeys = [
  "credentialLoadFailed", "variableNameRequired", "duplicateSecret", "secretRenameFailed", "secretDeleteFailed",
] as const;

// Translate only known application messages at the presentation boundary. Keep
// persisted task state, user content, model replies and raw command output intact.
const messages: ReadonlyArray<readonly [string, string]> = [
  ...knowledgeErrorKeys.map(key => [uiMessages["zh-CN"].knowledge[key], uiMessages["en-US"].knowledge[key]] as const),
  ...credentialErrorKeys.map(key => [uiMessages["zh-CN"].settings[key], uiMessages["en-US"].settings[key]] as const),
  ["完全托管模式倒计时结束，开始生成后续计划；生成后将自动继续，高风险步骤仍需单独确认。", "The managed-mode countdown has ended. Generating the follow-up plan and continuing automatically; high-risk steps still require approval."],
  ["等待连接", "Waiting to connect"],
  ["身份验证失败", "Authentication failed"],
  ["等待手动重连", "Waiting for manual reconnection"],
  ["SSH 已连接", "SSH connected"],
  ["等待自动重连", "Waiting to reconnect automatically"],
  ["正在验证 SSH 连接", "Verifying the SSH connection"],
  ["等待上一轮连接结束", "Waiting for the previous connection attempt"],
  ["正在确认连接", "Checking the connection"],
  ["已断开连接", "Disconnected"],
  ["SSH 身份认证失败，请检查用户名、密码或服务器认证设置", "SSH authentication failed. Check the username, password, or server authentication settings."],
  ["SSH 密码已过期，请更新服务器凭据", "The SSH password has expired. Update the server credentials."],
  ["SSH 身份认证失败", "SSH authentication failed"],
  ["SSH 连接确认超时", "SSH connection verification timed out"],
  ["连接超时", "Connection timed out"],
  ["用户名或密码不正确", "Incorrect username or password"],
  ["连接未完成，请重试或修改连接信息。", "Connection did not complete. Retry or edit your connection."],
  ["连接失败，请检查密码或服务器配置后重试。", "Connection failed. Check your password or server settings."],
  ["连接未完成，请重试。", "Connection did not complete. Please retry."],
  ["模型已停用", "Model disabled"],
  ["未配置 API Key", "API key not configured"],
  ["未配置接口地址", "Endpoint not configured"],
  ["未配置模型名称", "Model name not configured"],
  ["请完成配置后保存", "Complete the configuration and save"],
  ["正在检查模型服务…", "Checking the model service…"],
  ["需要在 Opsark 桌面端验证真实模型连接", "Use the Opsark desktop app to verify the model connection"],
  ["自定义接口未提供 /models，已保留配置；最终以真实生成请求为准", "This endpoint does not provide /models. Configuration saved; availability will be verified by a generation request."],
  ["接口、鉴权和模型名称均可用", "Endpoint, authentication, and model name verified"],
  ["模型配置不完整", "Model configuration is incomplete"],
  ["请求超时必须是 10-900 秒的整数。", "Request timeout must be an integer from 10 to 900 seconds."],
  ["请填写配置名称、模型名和接口地址。", "Enter a configuration name, model name and endpoint."],
  ["max_tokens / max_completion_tokens：只能选择一项", "max_tokens / max_completion_tokens: choose one"],
  ["reasoning_effort 的值无效", "Invalid reasoning_effort"],
  ["thinking 的值无效", "Invalid thinking"],
  ["SSH 未连接，请先手动重连后再发送需求", "SSH is disconnected. Reconnect manually before sending a request."],
  ["SSH 未连接，请先重连后再执行命令", "SSH is disconnected. Reconnect before running a command."],
  ["当前输入正在提交，请等待提交完成。", "Your input is being submitted. Wait until submission completes."],
  ["所选模型配置不存在，请重新选择模型", "The selected model configuration no longer exists. Select another model."],
  ["当前步骤仍有必需信息待确认，请先完成已有表单后继续。", "Required information is still missing. Complete the current form to continue."],
  ["正在理解需求并汇总服务器上下文…", "Understanding the request and gathering server context…"],
  ["正在进行执行前安全检查…", "Running pre-execution safety checks…"],
  ["等待用户确认", "Waiting for your confirmation"],
  ["终端执行通道待恢复", "Waiting for the terminal execution channel to recover"],
  ["上次终端恢复检查已中断，请检查终端后继续；原执行证据已保留，未确认结果的命令不会自动重放。", "The previous terminal recovery check was interrupted. Check the terminal before continuing. Execution evidence was preserved; commands with unconfirmed outcomes will not be replayed automatically."],
  ["上次业务重新规划因应用重启中断，原计划和证据已保留；请重新规划并评估风险，不会自动执行旧方案。", "Replanning was interrupted by an app restart. The original plan and evidence were preserved. Replan and review the risks; the old plan will not run automatically."],
  ["用户已明确取消当前整体目标。", "You cancelled the current overall goal."],
  ["绑定终端仍未恢复。请重连或刷新终端；系统不会把执行通道故障交给模型改写业务计划。", "The bound terminal has not recovered. Reconnect or refresh it. A terminal connection failure will not cause the model to rewrite the task plan."],
  ["保留的协议事故与当前目标或轮次不一致，请补充当前需求后重新规划。", "The saved protocol incident does not match the current goal or round. Clarify your current request and replan."],
  ["终端恢复检查已结束；当前阻断属于业务流程，请检查证据后手动决定下一步。该入口不会生成业务调整计划。", "The terminal recovery check has finished. The current blocker concerns the task workflow. Review the evidence and decide the next step; this action does not generate a revised plan."],
  ["终端执行通道已恢复，但没有可自动重放的失败步骤。请检查已有执行记录后继续；系统不会仅凭通道恢复宣告目标完成或生成业务调整计划。", "The terminal execution channel has recovered, but no failed step can be replayed automatically. Review the execution history before continuing. Recovery alone does not complete the goal or generate a revised plan."],
  ["当前已验证 SSH 连接下原命令已自动重放过一次，但相同传输故障仍然出现。已停止重复重放；请重新验证连接后继续。", "The command was replayed once on the verified SSH connection, but the same transport failure occurred. Further automatic replay has stopped. Verify the connection again before continuing."],
  ["正在等待绑定终端恢复；终端传输故障不会消耗业务重拟次数，也不会交给模型改写业务计划。", "Waiting for the bound terminal to recover. Terminal transport failures do not consume replanning attempts or trigger model-generated plan changes."],
  ["等待用户明确回答；提交前不会执行后续操作或自动调整。", "Waiting for your explicit response. No further actions or automatic adjustments will run before you submit it."],
  ["计划内容在批准前完成了安全规范化，请检查更新后的最终命令并重新确认。", "The plan was normalized for safety before approval. Review the updated commands and confirm again."],
  ["当前目标和已完成结果已保留，未执行任何新的服务器操作。后续方案待完善；需要确认的操作会在执行前提示。", "The current goal and completed results were preserved, and no new server action was executed. The follow-up plan needs refinement; any required approval will be requested before the relevant action."],
  ["当前检查已完成，系统正在根据已有结果完善后续方案。需要确认的操作会在执行前提示。", "The current checks are complete. The system is refining the follow-up plan from the available results; any required approval will be requested before the relevant action."],
  ["正在根据当前目标和已有结果重新整理后续方案；新步骤将按当前授权逐项进行安全检查…", "Reorganizing the follow-up plan from the current goal and available results. Each new step will be checked against the current authorization…"],
  ["系统已按原任务授权自动衔接重新整理后的计划；后续仍按步骤风险规则执行或等待确认。", "The reorganized plan was connected under the existing task authorization. Each step will still follow the applicable risk checks or wait for approval."],
  ["当前检查结果已保留，但暂时无法形成可执行的后续方案。可以稍后重试生成。", "Current findings were preserved, but an executable follow-up plan is not available yet. You can retry planning later."],
  ["当前结果和已有执行证据已保留，但后续方案暂未就绪。可以稍后重试生成。", "Current results and execution evidence were preserved, but the follow-up plan is not ready yet. You can retry planning later."],
  ["整体目标、Skill 选择和已有证据已保留，未向服务器发送新命令。后续方案待完善，可以稍后重试生成。", "The overall goal, selected skills, and existing evidence were preserved, and no new server command was sent. The follow-up plan needs refinement; you can retry planning later."],
  ["当前目标和已有结果已保留，未向服务器发送新命令。执行方案尚未就绪，可以稍后重试规划。", "The current goal and available results were preserved, and no new server command was sent. The execution plan is not ready yet; you can retry planning later."],
  ["主命令已完成，正在整理观察证据", "Main command completed; collecting observations"],
  ["主命令已完成，正在执行独立后置校验", "Main command completed; running independent post-execution checks"],
  ["用户确认请求已过期", "This confirmation request has expired"],
  ["用户名与密码/令牌必须作为同一凭据组完整提交", "Submit the username and password/token together as a complete credential group"],
  ["系统凭据尚未完整加载，已取消保存以避免误删钥匙串数据", "System credentials have not finished loading. Save cancelled to protect existing keychain data."],
  ["系统凭据读取失败，请手动填写 SSH 密码", "Could not read system credentials. Enter the SSH password manually."],
];

const english = new Map(messages);
const chinese = new Map(messages.map(([zh, en]) => [en, zh]));
const INTERNAL_PLAN_DIAGNOSTIC = /(?:PlanProtocolError|计划协议校验失败|协议修复失败|OBSERVE_COMMAND_MUTATION|PROTOCOL_REPAIR_[A-Z_]+|Skill 选择已保留，计划生成失败|(?:后续|调整)计划生成失败|计划生成未通过)/;

export function isInternalPlanDiagnostic(value: string | undefined | null): boolean {
  return Boolean(value && INTERNAL_PLAN_DIAGNOSTIC.test(value));
}

export function localizeCoreText(value: string | undefined | null, locale: string = i18n.global.locale.value): string {
  if (!value) return "";
  // Persisted tasks from older builds may contain internal plan compiler details.
  // Keep those diagnostics available in developer logs, but never render rule
  // codes, field paths or repair internals in the user conversation.
  if (isInternalPlanDiagnostic(value)) {
    return locale.startsWith("zh")
      ? "当前检查结果和已完成步骤已保留，后续方案需要重新整理。需要确认的操作将在执行前提示。"
      : "Current findings and completed steps were preserved, and the follow-up plan needs to be reorganized. Any required approval will be requested before the relevant action.";
  }
  const httpError = value.match(/^(?:知识服务返回 HTTP |Knowledge service returned HTTP )(\d{3})$/);
  if (httpError) return locale.startsWith("zh") ? `知识服务返回 HTTP ${httpError[1]}` : `Knowledge service returned HTTP ${httpError[1]}`;
  if (locale.startsWith("zh")) return chinese.get(value) ?? value;
  const exact = english.get(value);
  if (exact) return exact;
  // Anchored templates emitted by Core forms; dynamic field names remain original.
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/^(观察模式|安全模式)下，请查看已有结果并手动生成后续计划。$/, m => `In ${m[1] === "观察模式" ? "step-by-step" : "safe"} mode, review the available results and generate the follow-up plan manually.`],
    [/^请选择必填参数“(.+)”$/, m => `Select a value for the required field “${m[1]}”`],
    [/^请填写必填参数“(.+)”$/, m => `Complete the required field “${m[1]}”`],
    [/^参数“(.+)”必须选择当前候选项中的有效选项$/, m => `Select a valid option for “${m[1]}”`],
    [/^参数“(.+)”必须是有效数字$/, m => `“${m[1]}” must be a valid number`],
    [/^工具“(.+)”的信息不完整$/, m => `Tool “${m[1]}” has incomplete configuration`],
    [/^后续方案已重新整理，包含 (\d+) 个执行步骤；系统将按现有授权继续，需要确认的步骤会在执行前单独提示。$/, m => `The follow-up plan has been reorganized with ${m[1]} execution steps. It will continue under the existing authorization, and any required approval will be requested before the relevant step.`],
    [/^后续方案包含一项具体变更。步骤“(.+)”将修改目标状态，请核对已确认决定：([\s\S]+)。本次确认仅授权本步骤展示的具体变更，不撤销任务级禁止事项；如与原决定冲突，请先补充授权或调整方案。$/, m => `The follow-up plan contains a specific change. Step “${m[1]}” will modify the target state. Review the confirmed decision: ${m[2]}. This approval authorizes only the displayed change and does not remove task-level restrictions; if it conflicts with the prior decision, update the authorization or revise the plan first.`],
    [/^当前阶段的 (\d+) 个步骤已成功完成，证据保持有效；整体目标尚未完成。当前结果和已有执行证据已保留，但后续方案暂未就绪。可以稍后重试生成。$/, m => `All ${m[1]} steps in the current phase completed successfully and their evidence remains valid, but the overall goal is not complete. Current results were preserved; you can retry follow-up planning later.`],
    [/^当前结果和已有执行证据已保留，但后续方案暂未就绪。可以稍后重试生成。未完成目标也已保留。$/, () => "Current results, execution evidence, and the unfinished goal were preserved, but the follow-up plan is not ready yet. You can retry planning later."],
    [/^Skill ID“(.+)”重复$/, m => `Duplicate Skill ID “${m[1]}”`],
    [/^Skill“(.+)”的配置不完整$/, m => `Skill “${m[1]}” has incomplete configuration`],
    [/^保存输入失败：([\s\S]*)$/, m => `Failed to save input: ${localizeCoreText(m[1], locale)}`],
    [/^安全保存失败：([\s\S]*)$/, m => `Failed to save securely: ${localizeCoreText(m[1], locale)}`],
  ];
  for (const [pattern, render] of patterns) {
    const match = value.match(pattern);
    if (match) return render(match);
  }
  return value;
}
