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
const SUCCESS_NOOP = /^(?:(?:\/[\w.+-]+)*\/)?true(?:\s|$)|^:(?:\s|$)|^exit\s+\+?0+(?:\s|$)/;

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
  if (unquotedDoublePipeOffsets(tail).some(offset => SUCCESS_NOOP.test(tail.slice(offset + 2).trim()))) {
    return issue(field, "EMPTY_SUCCESS_FALLBACK", "以成功空操作覆盖了前序失败状态", "|| true（或等价空操作）");
  }
  if (unquotedStatements(tail).length > 1 && SUCCESS_NOOP.test(unquotedStatements(tail).slice(-1)[0] ?? "")) {
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

function acceptanceCommand(statement: string) {
  const visible = shellOperatorsOnly(statement);
  const comment = visible.search(/(?:^|\s)#/);
  let command = (comment < 0 ? statement : statement.slice(0, comment)).trim();
  command = command.replace(/^(['"])([\w/.:+-]+)\1(?=\s|$)/, "$2");
  return command.replace(/^(?:(?:sudo|builtin|exec)\s+|[A-Za-z_]\w*=\S+\s+)*/, "");
}

/** Exit 0 from a printer/query is transport evidence, not a postcondition. */
function isAcceptancePredicate(statement: string) {
  const command = acceptanceCommand(statement).replace(/^(?:\/[\w.+-]+)*\//, "");
  if (/^(?:test\s+|\[\[?\s+)(?:![ \t]+)?-(?:[bcdefghkLprsSuwxOGN])\s+\S/.test(command)) return true;
  if (/^(?:test\s+|\[\[?\s+)/.test(command) && /\$/.test(command)
    && /(?:\s(?:=|==|!=|=~|-[a-z]{2})\s|\s-[nz]\s)/.test(command)) return true;
  return /^command\s+-v\s+\S/.test(command)
    || /^systemctl\s+(?:--[\w-]+\s+)*(?:is-active|is-enabled)\s+\S/.test(command)
    || /^(?:grep|rg|cmp|diff)\s+(?:-[\w-]*q[\w-]*|--quiet|--silent)\s+\S/.test(command)
    || /^(?:rpm\s+-q\s+|dpkg\s+-s\s+|dpkg-query\s+-W\s+)\S/.test(command)
    || /^git\s+(?:rev-parse\s+--verify|cat-file\s+-e)\s+\S/.test(command);
}

function andCommands(statement: string) {
  const visible = shellOperatorsOnly(statement);
  const offsets = [...visible.matchAll(/&&/g)].map(match => match.index!);
  let start = 0;
  return [...offsets, statement.length].map(offset => {
    const command = statement.slice(start, offset).trim();
    start = offset + 2;
    return command;
  });
}

/** Conservatively recognize explicit assertions whose failure reaches the caller. */
export function validationHasAcceptanceCheck(script: string) {
  if (!script.trim() || analyzeFailureMask(script, "validation")) return false;
  const statements = unquotedStatements(script).map(acceptanceCommand).filter(Boolean);
  let failFast = false;
  let assertion = false;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (/^set\s+-[a-z]*e(?:\s|$)/.test(statement) || /^set\s+-o\s+errexit$/.test(statement)) {
      failFast = true;
      continue;
    }
    if (/^set\s+-/.test(statement)) continue;
    const visible = shellOperatorsOnly(statement);
    const guarded = /\|\|\s*exit\s+[1-9]\d*\s*$/.test(visible);
    const core = guarded ? statement.slice(0, visible.lastIndexOf("||")).trim() : statement;
    if (/[|{}]/.test(shellOperatorsOnly(core).replace(/&&/g, ""))
      || /^(?:if|for|while|until|case|function|return|exit|source|eval|\.)(?:\s|$)/.test(core)) return false;
    const commands = andCommands(core);
    const predicates = commands.map(isAcceptancePredicate);
    if (predicates.some(Boolean)) {
      // A later printer in an && chain cannot hide failure, but a later
      // semicolon-separated command can unless errexit/explicit exit guards it.
      if (!guarded && index < statements.length - 1 && (!failFast || commands.length > 1)) return false;
      assertion = true;
    } else if (!/^\s*(?:echo|printf)(?:\s|$)/.test(core)
      && !/^[A-Za-z_]\w*=/.test(core) && !/^cd\s+/.test(core)) return false;
  }
  return assertion;
}

const RECOVERY_QUERY_MARKER = "# OPSARK_RECOVERY_ORIGINAL_QUERY_V1";
const RECOVERY_ASSERTION_MARKER = "# OPSARK_RECOVERY_REQUIRED_ASSERTIONS_V1";

/**
 * A bounded legacy upgrade: retain every original query byte and repeat only
 * predicates already present there. No new target, expected state or model-
 * authored predicate is admitted. Complex scripts require a real contract.
 */
export function supplementalRecoveryAcceptance(originalCommand: string) {
  const original = originalCommand.trim();
  if (!original || validationHasAcceptanceCheck(original)
    || original.includes(RECOVERY_QUERY_MARKER) || original.includes(RECOVERY_ASSERTION_MARKER)) return undefined;
  const assertions: string[] = [];
  let sawWeakFallback = false;
  let sawMaskedPrinter = false;
  for (let statement of unquotedStatements(original).map(acceptanceCommand).filter(Boolean)) {
    if (/^set\s+-[eu]+$/.test(statement)) continue;
    if (/^(?:echo|printf)(?:\s|$)/.test(statement)) {
      // The incident used printf 'KEY=%s\n' "$(probe || echo absent)".
      // Accept one simple substitution only; nested commands, additional
      // substitutions and variables require a richer acceptance contract.
      const printer = statement.match(/^(?:printf\s+(?:'[^']*'|"[^"$`]*")|echo)\s+"\$\(([^$`()\n]+)\)"$/);
      if (!printer) {
        if (/[$`]/.test(statement)) return undefined;
        continue;
      }
      sawMaskedPrinter = true;
      statement = printer[1].trim();
    }
    const visible = shellOperatorsOnly(statement);
    const offset = visible.indexOf("||");
    const core = (offset < 0 ? statement : statement.slice(0, offset)).trim();
    const fallback = offset < 0 ? "" : statement.slice(offset + 2).trim();
    if (fallback && !/^(?:echo|printf)(?:\s|$)/.test(fallback)) return undefined;
    if (fallback) sawWeakFallback = true;
    if (/[&|{}()]/.test(shellOperatorsOnly(core))) return undefined;
    if (isAcceptancePredicate(core)) assertions.push(core);
    else if (/^[\w./+-]+\s+(?:--version|-V|version)(?:\s|$)/.test(core)
      && !/[`$]/.test(core)) {
      // A version query must both succeed and return a value. Capture in a
      // shell variable so the check creates no temporary files.
      assertions.push(`__opsark_acceptance_output="$(${core})" && test -n "$__opsark_acceptance_output"`);
    } else return undefined;
  }
  if (!assertions.length || (!sawWeakFallback && !sawMaskedPrinter && assertions.length < 2)) return undefined;
  const assertionCommand = assertions.join(" &&\n");
  return {
    source: "original_read_only_predicates" as const,
    originalCommand: original,
    assertions,
    command: `${RECOVERY_QUERY_MARKER}\n(\n${original}\n)\n${RECOVERY_ASSERTION_MARKER}\n(\n${assertionCommand}\n)`,
  };
}

/** Recompute the program-authored projection; marker text alone proves nothing. */
export function recordedSupplementalAcceptance(command: string) {
  const prefix = `${RECOVERY_QUERY_MARKER}\n(\n`;
  const boundary = `\n)\n${RECOVERY_ASSERTION_MARKER}\n`;
  if (!command.startsWith(prefix)) return undefined;
  const end = command.indexOf(boundary, prefix.length);
  if (end < 0) return undefined;
  const supplemental = supplementalRecoveryAcceptance(command.slice(prefix.length, end));
  return supplemental?.command === command.trim() ? supplemental : undefined;
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
