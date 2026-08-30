import type { PlanStep } from "@/types";

export type PlanSafetyField = "command" | "validation";

export interface PlanSafetyIssue {
  field: PlanSafetyField;
  ruleId:
    | "EMPTY_SUCCESS_FALLBACK"
    | "UNCONDITIONAL_SUCCESS_TAIL"
    | "SET_PLUS_E_STATUS_LOST"
    | "PIPELINE_STATUS_LOST"
    | "REMOTE_FAILURE_ECHOED"
    | "VALIDATION_FAILURE_ECHOED"
    | "FAILURE_BRANCH_EXIT_ZERO"
    | "SECRET_IN_URL"
    | "URL_EMBEDDED_CREDENTIAL"
    | "ASKPASS_CREDENTIAL_SCRIPT"
    | "SECRET_ENV_ASSIGNMENT"
    | "CREDENTIAL_PERSISTENCE"
    | "INSECURE_CREDENTIAL_HELPER"
    | "SAFETY_ANALYZER_UNAVAILABLE";
  reason: string;
  snippet: string;
  repairable: boolean;
}

export interface PlanStepSafetyAnalysis {
  safe: boolean;
  normalizedCommand: string;
  normalizedValidation: string;
  repairedFields: PlanSafetyField[];
  issues: PlanSafetyIssue[];
  /** @deprecated Prefer `issues`; retained while persisted tasks are migrated. */
  issue?: PlanSafetyIssue;
}

const STATUS_VARIABLE = "__opsark_preserved_failure_status";
const SECRET_PLACEHOLDER = /\$\{secret\.[A-Z0-9_]+\}/i;
const URL_CANDIDATE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi;
const SENSITIVE_QUERY_PARAMETER = /[?&](?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)=[^&#\s]+/i;
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function urlCredentialIssue(script: string) {
  for (const match of script.matchAll(URL_CANDIDATE)) {
    const candidate = match[0];
    if (SECRET_PLACEHOLDER.test(candidate)) {
      return {
        ruleId: "SECRET_IN_URL" as const,
        reason: "敏感变量不得出现在 URL 中；解析后可能进入进程参数、日志和 Git remote 配置",
        snippet: "URL 中的 ${secret.NAME}",
      };
    }
    const scheme = candidate.slice(0, candidate.indexOf("://")).toLocaleLowerCase();
    const authority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
    const userInfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : "";
    if (userInfo.includes(":") || (userInfo && /^https?$/.test(scheme))) {
      return {
        ruleId: "URL_EMBEDDED_CREDENTIAL" as const,
        reason: "HTTPS URL userinfo 中包含用户名或凭据，可能泄露到进程参数、日志和持久化配置",
        snippet: "https://userinfo@host",
      };
    }
    if (SENSITIVE_QUERY_PARAMETER.test(candidate)) {
      return {
        ruleId: "URL_EMBEDDED_CREDENTIAL" as const,
        reason: "URL 查询参数中包含凭据字段，可能被日志、代理或历史记录持久化",
        snippet: "URL 中的 password/token/secret 参数",
      };
    }
  }
  return undefined;
}

function hasSensitiveEnvironmentAssignment(script: string) {
  if (/(?:^|[;\n]\s*|\b(?:export|env)\s+)(?:[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*_PWD)\s*=/i.test(script)) {
    return true;
  }
  for (const placeholder of script.matchAll(new RegExp(SECRET_PLACEHOLDER.source, "gi"))) {
    const before = script.slice(0, placeholder.index ?? 0);
    const equals = before.lastIndexOf("=");
    if (equals < 0 || !/^[\s'"\\]*$/.test(before.slice(equals + 1))) continue;
    const prefix = before.slice(0, equals).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] ?? "";
    if (SHELL_IDENTIFIER.test(prefix)) return true;
  }
  return false;
}

/** Detects credential transports that would expose or persist a secret before execution. */
export function analyzeCredentialTransport(
  script: string,
  field: PlanSafetyField,
): PlanSafetyIssue | undefined {
  const urlIssue = urlCredentialIssue(script);
  if (urlIssue) return issue(field, urlIssue.ruleId, urlIssue.reason, urlIssue.snippet);
  if (/\b(?:GIT|SSH)_ASKPASS\b|\bcore\.askpass\b/i.test(script)) {
    return issue(
      field,
      "ASKPASS_CREDENTIAL_SCRIPT",
      "禁止在远端命令中创建或配置 AskPass 凭据脚本；应使用执行器独立的 PTY 提示响应通道",
      "GIT_ASKPASS/SSH_ASKPASS/core.askpass",
    );
  }
  if (hasSensitiveEnvironmentAssignment(script)) {
    return issue(
      field,
      "SECRET_ENV_ASSIGNMENT",
      "禁止把敏感变量解析到 Shell 变量或环境变量；凭据可能被子进程、调试输出或进程环境读取",
      "NAME=${secret.NAME}",
    );
  }
  if (/\bsshpass\b|\b(?:python|python3|perl|ruby|expect)\b[^\n;]*(?:password|passwd|token|credential)[^\n;]*\$\{secret\./i.test(script)) {
    return issue(
      field,
      "INSECURE_CREDENTIAL_HELPER",
      "禁止通过 sshpass 或临时交互脚本传递凭据；应使用执行器独立的 PTY 提示响应通道",
      "sshpass/credential helper script",
    );
  }
  if (/credential\.helper(?:\s+|=)\s*['"]?store|(?:^|[\s'"/])(?:\.netrc|\.git-credentials)(?:[\s'"/]|$)/i.test(script)) {
    return issue(
      field,
      "CREDENTIAL_PERSISTENCE",
      "禁止把仓库凭据写入明文凭据存储或用户文件",
      "credential.helper store/.netrc/.git-credentials",
    );
  }
  return undefined;
}

function shellOperatorsOnly(script: string) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let output = "";
  // Iterate UTF-16 code units so every projection offset can safely be used
  // with String.slice even when a command contains Chinese or non-BMP text.
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (escaped) {
      escaped = false;
      output += " ";
      continue;
    }
    if (character === "\\" && !singleQuoted) {
      escaped = true;
      output += " ";
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      output += " ";
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      output += " ";
      continue;
    }
    output += singleQuoted || doubleQuoted ? " " : character;
  }
  return output;
}

function unquotedStatements(script: string) {
  const visible = shellOperatorsOnly(script);
  const statements: string[] = [];
  let start = 0;
  for (let index = 0; index <= visible.length; index += 1) {
    if (index < visible.length && ![";", "\n", "\r"].includes(visible[index])) continue;
    const statement = script.slice(start, index).trim();
    if (statement) statements.push(statement);
    start = index + 1;
  }
  return statements;
}

function unquotedDoublePipeOffsets(script: string) {
  const visible = shellOperatorsOnly(script);
  const offsets: number[] = [];
  for (let index = 0; index + 1 < visible.length; index += 1) {
    if (visible[index] === "|" && visible[index + 1] === "|") {
      offsets.push(index);
      index += 1;
    }
  }
  return offsets;
}

function matchingBrace(script: string, opening: number) {
  const visible = shellOperatorsOnly(script);
  if (visible[opening] !== "{") return -1;
  let depth = 0;
  for (let index = opening; index < visible.length; index += 1) {
    if (visible[index] === "{") depth += 1;
    if (visible[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function exitZeroStatement(inner: string) {
  const visible = shellOperatorsOnly(inner);
  let statementStart = 0;
  for (let index = 0; index <= visible.length; index += 1) {
    if (index < visible.length && ![";", "\n", "\r"].includes(visible[index])) continue;
    const statement = visible.slice(statementStart, index);
    const left = statement.length - statement.trimStart().length;
    if (statement.trim() === "exit 0") {
      const start = statementStart + left;
      return { start, end: start + "exit 0".length };
    }
    statementStart = index + 1;
  }
  return undefined;
}

function repairOneExplicitZeroExitBranch(script: string) {
  for (const operator of unquotedDoublePipeOffsets(script)) {
    let opening = operator + 2;
    while (/\s/.test(script[opening] ?? "")) opening += 1;
    if (script[opening] !== "{") continue;
    const closing = matchingBrace(script, opening);
    if (closing < 0) continue;
    const inner = script.slice(opening + 1, closing);
    const exit = exitZeroStatement(inner);
    if (!exit) continue;
    return [
      script.slice(0, opening + 1),
      ` ${STATUS_VARIABLE}=$?;`,
      inner.slice(0, exit.start),
      `exit "$${STATUS_VARIABLE}"`,
      inner.slice(exit.end),
      script.slice(closing),
    ].join("");
  }
  return undefined;
}

function failureBranchHasExplicitZeroExit(script: string) {
  const visible = shellOperatorsOnly(script);
  for (const operator of unquotedDoublePipeOffsets(script)) {
    let start = operator + 2;
    while (/\s/.test(visible[start] ?? "")) start += 1;
    if (visible[start] === "{") {
      const closing = matchingBrace(script, start);
      if (closing > start && exitZeroStatement(script.slice(start + 1, closing))) return true;
      continue;
    }
    const end = visible.slice(start).search(/[;\n\r]/);
    const branch = script.slice(start, end < 0 ? undefined : start + end).trim();
    if (branch === "exit 0") return true;
  }
  return false;
}

function failureBranchStartsWithEcho(script: string) {
  const visible = shellOperatorsOnly(script).toLowerCase();
  return unquotedDoublePipeOffsets(script).some((operator) => {
    const branch = visible.slice(operator + 2).trimStart();
    return /^echo(?:\s|$)/.test(branch);
  });
}

export function normalizeRecoverableFailureMasks(script: string) {
  let normalized = script;
  while (true) {
    const repaired = repairOneExplicitZeroExitBranch(normalized);
    if (!repaired) return normalized;
    normalized = repaired;
  }
}

function issue(
  field: PlanSafetyField,
  ruleId: PlanSafetyIssue["ruleId"],
  reason: string,
  snippet: string,
  repairable = false,
): PlanSafetyIssue {
  return { field, ruleId, reason, snippet, repairable };
}

export function analyzeFailureMask(script: string, field: PlanSafetyField): PlanSafetyIssue | undefined {
  const credentialIssue = analyzeCredentialTransport(script, field);
  if (credentialIssue) return credentialIssue;
  const visible = shellOperatorsOnly(script.trim()).toLowerCase();
  const tail = visible.replace(/[;\s]+$/g, "");
  if (/\|\|\s*(?:true|\/bin\/true|:)$/.test(tail)) {
    return issue(field, "EMPTY_SUCCESS_FALLBACK", "以成功空操作覆盖了前序失败状态", "|| true（或等价空操作）");
  }
  if (/(?:;|\n)\s*true$/.test(tail)) {
    return issue(field, "UNCONDITIONAL_SUCCESS_TAIL", "以无条件 true 覆盖了前序失败状态", "; true");
  }
  const statements = unquotedStatements(script);
  const finalStatement = statements[statements.length - 1] ?? "";
  const propagatesCapturedStatus = /^exit\s+(?:\$\{?[a-z_][a-z0-9_]*\}?|"\$\{?[a-z_][a-z0-9_]*\}?"|'\$\{?[a-z_][a-z0-9_]*\}?')$/i
    .test(finalStatement);
  if (/\bset\s+\+e\b/.test(visible) && !propagatesCapturedStatus) {
    return issue(field, "SET_PLUS_E_STATUS_LOST", "set +e 后没有传播显式保存的真实退出码", "set +e");
  }
  if (field === "validation" && failureBranchStartsWithEcho(script)) {
    return issue(field, "VALIDATION_FAILURE_ECHOED", "后置校验失败后仅输出提示，无法证明预期结果", "validation || echo");
  }
  const hasPipefail = /\bset\s+-[^\n;]*o\s+pipefail\b/.test(visible);
  if (!hasPipefail && visible.split(/\r?\n|;/).some((line) => (
    /\b(?:mysql|mariadb|psql|ssh|scp|rsync|dnf|yum|apt(?:-get)?|curl|wget|git|npm|pnpm|yarn|composer)\b/.test(line)
    && /\|\s*(?:head|tail)\b/.test(line)
  ))) {
    return issue(field, "PIPELINE_STATUS_LOST", "关键命令直接管道到 head/tail，主进程退出码会丢失", "关键命令 | head/tail");
  }
  if (/\b(?:ssh|scp|rsync)\b/.test(visible) && failureBranchStartsWithEcho(script)) {
    return issue(field, "REMOTE_FAILURE_ECHOED", "SSH/SCP/rsync 失败后仅输出提示，分支可能返回成功", "SSH/SCP/rsync || echo");
  }
  const repairable = normalizeRecoverableFailureMasks(script) !== script;
  if (repairable || failureBranchHasExplicitZeroExit(script)) {
    return issue(field, "FAILURE_BRANCH_EXIT_ZERO", "失败分支显式返回了成功退出码", "失败分支 exit 0", repairable);
  }
  return undefined;
}

export function analyzePlanStepSafety(
  command: string,
  validation: string,
  repair = false,
): PlanStepSafetyAnalysis {
  const normalizedCommand = repair ? normalizeRecoverableFailureMasks(command) : command;
  const normalizedValidation = repair ? normalizeRecoverableFailureMasks(validation) : validation;
  const repairedFields: PlanSafetyField[] = [];
  if (normalizedCommand !== command) repairedFields.push("command");
  if (normalizedValidation !== validation) repairedFields.push("validation");
  const issues = [
    analyzeFailureMask(normalizedCommand, "command"),
    analyzeFailureMask(normalizedValidation, "validation"),
  ].filter((finding): finding is PlanSafetyIssue => Boolean(finding));
  return {
    safe: issues.length === 0,
    normalizedCommand,
    normalizedValidation,
    repairedFields,
    issues,
    issue: issues[0],
  };
}

export function normalizePlanStepSafety(step: PlanStep) {
  const analysis = analyzePlanStepSafety(step.command, step.validation, true);
  const changed = analysis.repairedFields.length > 0;
  return {
    ...step,
    command: analysis.normalizedCommand,
    validation: analysis.normalizedValidation,
    validator: step.validator ? { ...step.validator, command: analysis.normalizedValidation } : undefined,
    safetyApprovalSnapshot: changed ? undefined : step.safetyApprovalSnapshot,
    approvedSafetySnapshot: changed ? undefined : step.approvedSafetySnapshot,
  };
}

export function formatPlanSafetyIssue(stepTitle: string, finding: PlanSafetyIssue) {
  const fieldLabel = finding.field === "command" ? "command（计划命令）" : "validation（独立后置校验）";
  return `执行前安全检查未通过，命令尚未发送到服务器。步骤：“${stepTitle}”；字段：${fieldLabel}；规则：${finding.ruleId}；原因：${finding.reason}；命中：${finding.snippet}。`;
}

export function formatPlanSafetyIssues(stepTitle: string, findings: PlanSafetyIssue[]) {
  if (findings.length <= 1) return formatPlanSafetyIssue(stepTitle, findings[0]);
  const details = findings.map((finding) => {
    const fieldLabel = finding.field === "command" ? "command" : "validation";
    return `${fieldLabel}/${finding.ruleId}：${finding.reason}`;
  }).join("；");
  return `执行前安全检查未通过，命令尚未发送到服务器。步骤：“${stepTitle}”；发现 ${findings.length} 项问题：${details}。`;
}
