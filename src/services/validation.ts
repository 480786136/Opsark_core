import type {
  ExecutionEvidence,
  ObservationStatus,
  PlanStep,
  StepResult,
  ValidatorType,
} from "@/types";

export interface CommandSnapshot {
  output: string;
  success: boolean;
  exitCode?: number;
  emptyResult?: boolean;
}

export interface ValidationSnapshot {
  passed: boolean;
  detail: string;
  output?: string;
  exitCode?: number;
  emptyResult?: boolean;
}

const evidenceId = (source: string) =>
  `evidence-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function outputLines(output = "") {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !line.startsWith("$ ")
      && !line.startsWith("[exit:")
      && !line.startsWith("--- 独立校验 ---")
      && line !== "命令未产生输出"
      && !line.includes("未发现匹配项（命令正常完成）"),
    );
}

function mainOutput(output: string) {
  return output.split("\n--- 独立校验 ---")[0];
}

interface OutputSignals {
  status?: "warning" | "unhealthy";
  facts: Record<string, unknown>;
  warnings: string[];
  blocking: boolean;
}

function compareVersion(left: number[], right: number[]) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(value: string) {
  const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

function satisfiesNodeRequirement(currentValue: string, requirement: string) {
  if (!requirement || requirement === "unspecified" || requirement === "*") return true;
  const current = parseVersion(currentValue);
  if (!current) return false;
  return requirement.split("||").some((alternative) => {
    const conditions = alternative.trim().split(/\s+/).filter(Boolean);
    return conditions.every((condition) => {
      const required = parseVersion(condition);
      if (!required) return true;
      const comparison = compareVersion(current, required);
      if (condition.startsWith(">=")) return comparison >= 0;
      if (condition.startsWith(">")) return comparison > 0;
      if (condition.startsWith("<=")) return comparison <= 0;
      if (condition.startsWith("<")) return comparison < 0;
      if (condition.startsWith("^")) return current[0] === required[0] && comparison >= 0;
      if (condition.startsWith("~")) {
        return current[0] === required[0] && current[1] === required[1] && comparison >= 0;
      }
      return current[0] === required[0] && comparison >= 0;
    });
  });
}

function analyzeOutputSignals(output: string): OutputSignals {
  const lines = outputLines(output);
  const text = lines.join("\n");
  const platformCheckLine = lines.find((line) => line.startsWith("OPSARK_PLATFORM_CHECK "));
  let platformCheck: Record<string, unknown> | undefined;
  if (platformCheckLine) {
    try {
      platformCheck = JSON.parse(platformCheckLine.slice("OPSARK_PLATFORM_CHECK ".length));
    } catch {
      platformCheck = undefined;
    }
  }
  const runtimeCheckLine = lines.find((line) => line.startsWith("OPSARK_RUNTIME_CHECK "));
  let runtimeCheck: {
    currentNode?: string;
    requiredNode?: string;
    packageManager?: string;
    lockFiles?: string[];
  } | undefined;
  if (runtimeCheckLine) {
    try {
      runtimeCheck = JSON.parse(runtimeCheckLine.slice("OPSARK_RUNTIME_CHECK ".length));
    } catch {
      runtimeCheck = undefined;
    }
  }
  const structuredRuntimeIncompatible = Boolean(
    runtimeCheck?.currentNode
    && runtimeCheck.requiredNode
    && !satisfiesNodeRequirement(runtimeCheck.currentNode, runtimeCheck.requiredNode),
  );
  const engineLines = lines.filter((line) =>
    /TOO_OLD|EBADENGINE|unsupported engine|requires Node\.js version/i.test(line),
  );
  const warningLines = lines.filter((line) =>
    /\bWARN(?:ING)?\b|deprecated|vulnerabilit(?:y|ies)/i.test(line),
  );
  const benignWarningLines = warningLines.filter((line) =>
    /npm WARN config\b.*\bUse\s+`?--[^`\s]+`?\s+instead/i.test(line),
  );
  const actionableWarningLines = warningLines.filter((line) => !benignWarningLines.includes(line));
  const vulnerabilityMatch = text.match(/(\d+)\s+vulnerabilit(?:y|ies)/i);
  const nodeRequirement = text.match(
    /using Node\.js\s+([0-9][0-9A-Za-z.+-]*).*?requires Node\.js version\s+([^\n]+?)(?:\.\s+Please|$)/i,
  );
  const explicitTooOld = /TOO_OLD/i.test(text);
  const missingAbiSymbols = [...new Set(
    [...text.matchAll(/(?:version\s+[`']?)((?:GLIBCXX|GLIBC|CXXABI)_[0-9.]+)(?:['`]?\s+not found)/gi)]
      .map((match) => match[1]),
  )];
  const platformIncompatible = missingAbiSymbols.length > 0
    || /(?:wrong ELF class|Exec format error|cannot execute binary file)/i.test(text);
  const networkFailureLines = lines.filter((line) =>
    /curl:\s*\(\d+\)|connection reset|could not resolve host|connection timed out|network is unreachable|TLS handshake timeout/i
      .test(line),
  );
  const networkFailure = networkFailureLines.length > 0;
  const engineIncompatible = engineLines.length > 0 || structuredRuntimeIncompatible;
  const warnings: string[] = [];
  if (engineIncompatible) {
    warnings.push(
      nodeRequirement
        ? `当前 Node.js ${nodeRequirement[1]} 不满足构建工具要求 ${nodeRequirement[2].replace(/\.$/, "")}。`
        : runtimeCheck?.currentNode && runtimeCheck.requiredNode
          ? `当前 Node.js ${runtimeCheck.currentNode} 不满足项目或构建工具要求 ${runtimeCheck.requiredNode}。`
        : "当前运行时版本与项目依赖声明不兼容。",
    );
  }
  if (vulnerabilityMatch) warnings.push(`依赖审计报告 ${vulnerabilityMatch[1]} 个安全漏洞，需要单独评估。`);
  else if (actionableWarningLines.length && !engineIncompatible) {
    warnings.push("命令成功完成，但输出中包含需要关注的警告信息。");
  }
  if (platformIncompatible) {
    warnings.push(
      missingAbiSymbols.length
        ? `目标程序无法在当前平台运行，缺少 ABI 符号：${missingAbiSymbols.join("、")}。`
        : "目标程序与当前操作系统或处理器架构不兼容。",
    );
  }
  if (networkFailure) warnings.push("下载或网络连接失败，目标文件或安装脚本未可靠获取。");
  return {
    status: engineIncompatible || explicitTooOld || platformIncompatible || networkFailure
      ? "unhealthy"
      : actionableWarningLines.length
        ? "warning"
        : undefined,
    facts: {
      engineIncompatible,
      explicitTooOld,
      currentNodeVersion: nodeRequirement?.[1] ?? runtimeCheck?.currentNode,
      requiredNodeVersion: nodeRequirement?.[2]?.replace(/\.$/, "") ?? runtimeCheck?.requiredNode,
      runtimeCheck,
      platformCheck,
      category: platformIncompatible
        ? "platform_incompatible"
        : networkFailure
          ? "network_failure"
          : undefined,
      platformIncompatible,
      missingAbiSymbols,
      networkFailure,
      networkFailureSamples: networkFailureLines.slice(0, 5),
      warningCount: warningLines.length,
      actionableWarningCount: actionableWarningLines.length,
      benignWarningCount: benignWarningLines.length,
      vulnerabilityCount: vulnerabilityMatch ? Number(vulnerabilityMatch[1]) : undefined,
      warningSamples: [...new Set([...engineLines, ...actionableWarningLines])].slice(0, 8),
      benignWarningSamples: [...new Set(benignWarningLines)].slice(0, 5),
    },
    warnings,
    blocking: engineIncompatible || explicitTooOld || platformIncompatible || networkFailure,
  };
}

export function analyzeCommandFailure(output: string) {
  const text = mainOutput(output);
  const missingAbiSymbols = [...new Set(
    [...text.matchAll(/(?:version\s+[`']?)((?:GLIBCXX|GLIBC|CXXABI)_[0-9.]+)(?:['`]?\s+not found)/gi)]
      .map((match) => match[1]),
  )];
  if (missingAbiSymbols.length || /wrong ELF class|Exec format error|cannot execute binary file/i.test(text)) {
    return {
      reason: missingAbiSymbols.length
        ? `目标程序与当前系统 ABI 不兼容，缺少 ${missingAbiSymbols.join("、")}`
        : "目标程序与当前操作系统或处理器架构不兼容",
      facts: {
        category: "platform_incompatible",
        platformIncompatible: true,
        missingAbiSymbols,
      },
    };
  }
  const nodeRequirement = text.match(
    /using Node\.js\s+([0-9][0-9A-Za-z.+-]*).*?requires Node\.js version\s+([^\n]+?)(?:\.\s+Please|$)/i,
  );
  if (nodeRequirement) {
    const required = nodeRequirement[2].replace(/\.$/, "");
    return {
      reason: `当前 Node.js ${nodeRequirement[1]} 不满足构建要求 ${required}`,
      facts: {
        category: "runtime_incompatible",
        runtime: "node",
        currentVersion: nodeRequirement[1],
        requiredVersion: required,
      },
    };
  }
  const engine = text.match(/EBADENGINE[\s\S]*?required:\s*\{\s*node:\s*'([^']+)'[\s\S]*?current:\s*\{\s*node:\s*'([^']+)'/i);
  if (engine) {
    return {
      reason: `当前 Node.js ${engine[2]} 不满足依赖要求 ${engine[1]}`,
      facts: {
        category: "runtime_incompatible",
        runtime: "node",
        currentVersion: engine[2],
        requiredVersion: engine[1],
      },
    };
  }
  if (/ENOSPC|no space left on device/i.test(text)) {
    return { reason: "服务器磁盘空间不足", facts: { category: "disk_full" } };
  }
  if (/permission denied|EACCES/i.test(text)) {
    return { reason: "当前用户没有完成该操作所需的权限", facts: { category: "permission_denied" } };
  }
  if (/command not found|not recognized as an internal/i.test(text)) {
    return { reason: "命令或必要工具未安装", facts: { category: "command_not_found" } };
  }
  const registry404 = text.match(/(?:404|E404)[^\n]*(https?:\/\/\S+)/i);
  if (registry404) {
    return {
      reason: "依赖下载地址返回 404，需要核对锁文件、包版本或镜像源",
      facts: { category: "registry_not_found", url: registry404[1] },
    };
  }
  return { reason: "命令执行未成功", facts: { category: "command_failed" } };
}

export function isMutatingStepCommand(command: string) {
  return /(?:^|[;&|]\s*|\bsudo\s+)(?:apt(?:-get)?|yum|dnf|rpm|dpkg|npm|pnpm|yarn|pip)\s+(?:install|remove|upgrade|update)|\b(?:nvm|fnm|volta|asdf)\s+(?:install|use|global|alias|default)\b|\bcurl\b[\s\S]*\|\s*(?:ba)?sh\b|\bmvn\b.*\b(?:install|deploy)\b|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)|\bservice\s+\S+\s+(?:start|stop|restart|reload)|\b(?:reboot|shutdown|kill|pkill|killall)\b|\b(?:rm|mv|cp|chmod|chown|ln)\s|\bsed\s+-i\b|\b(?:tee|truncate)\s|\bdocker\s+(?:run|start|stop|restart|rm|compose\s+up)|\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i
    .test(command);
}

export function isReadOnlyStep(step: PlanStep) {
  return !isMutatingStepCommand(step.command);
}

export function inferValidatorType(step: Pick<PlanStep, "title" | "description" | "command" | "validation">): ValidatorType {
  const semantic = `${step.title}\n${step.description}`.toLowerCase();
  const validation = step.validation.toLowerCase();
  const text = `${semantic}\n${step.command}\n${validation}`.toLowerCase();
  if (/opsark_platform_check|平台兼容|系统兼容|操作系统.*架构|glibc|glibcxx|cxxabi/.test(text)) return "platform";
  if (
    /运行时|runtime|node(?:\.js)?(?:\s*版本)?|java(?:\s*版本)?|python(?:\s*版本)?|golang|rustc/.test(semantic)
    || /\b(?:node\s+--?v(?:ersion)?|java\s+-version|python\d*\s+--version|go\s+version|rustc\s+--version)\b/.test(validation)
    || /opsark_runtime_check/.test(text)
  ) return "runtime";
  if (/\bmysql\b|\bpsql\b|\bsqlite3\b|show\s+(databases|tables)|information_schema/.test(text)) return "sql-query";
  if (
    /http状态|页面响应|首页|网页|接口响应/.test(semantic)
    || /\bcurl\b[^\n]*(?:https?:\/\/|%{http_code}|-i\b|-I\b|-f\b)/.test(validation)
    || /\bwget\b[^\n]*--spider/.test(validation)
  ) return "http";
  if (/\bss\s|\bnetstat\b|\blsof\b.*-i|监听端口|端口归属/.test(text)) return "port-owner";
  if (/\bsystemctl\b|\bservice\b|服务状态/.test(text)) return "service";
  if (/\bdocker\b|\bpodman\b|容器/.test(text)) return "docker";
  if (/\bjournalctl\b|\.log\b|日志|tail\s/.test(text)) return "log";
  if (/\bps\s|\bpgrep\b|\bpidof\b|进程/.test(text)) return "process";
  if (/\btest\s+-[efdLrwx]\b|\bstat\b|\bfind\b|\bls\s|文件|目录/.test(text)) return "file";
  return "command";
}

function defaultValidStates(type: ValidatorType): ObservationStatus[] {
  if (["http", "service", "runtime", "platform"].includes(type)) return ["healthy", "unhealthy", "warning", "unknown"];
  if (type === "log") return ["matched", "not_found", "warning", "unknown"];
  return ["matched", "not_found", "unknown"];
}

export function ensureStepValidator(step: PlanStep): PlanStep {
  if (step.validator) {
    return {
      ...step,
      validator: {
        ...step.validator,
        command: step.validation,
      },
    };
  }
  const type = inferValidatorType(step);
  return {
    ...step,
    validator: {
      type,
      command: step.validation,
      validStates: defaultValidStates(type),
    },
  };
}

function parseHttpFacts(lines: string[]) {
  const statuses = lines
    .flatMap((line) => [...line.matchAll(/HTTP\/\S+\s+(\d{3})/gi)].map((match) => Number(match[1])));
  if (!statuses.length) {
    const standalone = lines.find((line) => /^\d{3}$/.test(line));
    if (standalone) statuses.push(Number(standalone));
  }
  const status = statuses[statuses.length - 1];
  return {
    facts: {
      httpStatus: status,
      redirectCount: Math.max(0, statuses.length - 1),
      responseReceived: lines.length > 0,
    },
    status: status === undefined
      ? ("unknown" as const)
      : status >= 200 && status < 400
        ? ("healthy" as const)
        : ("unhealthy" as const),
  };
}

function parseProcessFacts(lines: string[], emptyResult: boolean) {
  const pids = new Set<number>();
  lines.forEach((line) => {
    const psMatch = line.match(/^\S+\s+(\d+)\s+/);
    const pgrepMatch = line.match(/^(\d+)(?:\s|$)/);
    const value = psMatch?.[1] ?? pgrepMatch?.[1];
    if (value) pids.add(Number(value));
  });
  const found = !emptyResult && lines.length > 0;
  return {
    facts: { processFound: found, processCount: found ? Math.max(pids.size, 1) : 0, pids: [...pids] },
    status: found ? ("matched" as const) : ("not_found" as const),
  };
}

function parsePortFacts(lines: string[], emptyResult: boolean) {
  const ports = new Set<number>();
  const pids = new Set<number>();
  lines.forEach((line) => {
    [...line.matchAll(/(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|\*|[0-9a-f:]+):(\d+)\b/gi)]
      .forEach((match) => ports.add(Number(match[1])));
    [...line.matchAll(/pid[=/](\d+)/gi)].forEach((match) => pids.add(Number(match[1])));
  });
  const found = !emptyResult && lines.length > 0;
  return {
    facts: {
      listenerFound: found,
      ports: [...ports],
      ownerPids: [...pids],
      ownershipConfirmed: pids.size > 0,
    },
    status: found ? ("matched" as const) : ("not_found" as const),
  };
}

function parseSqlFacts(lines: string[], command: string, emptyResult: boolean) {
  const values = lines.filter((line) => !/^mysql: \[warning\]/i.test(line));
  const isCount = /count\s*\(\s*\*\s*\)/i.test(command);
  if (isCount) {
    const countLine = [...values].reverse().find((line) => /^\d+$/.test(line));
    const count = countLine === undefined ? undefined : Number(countLine);
    return {
      facts: { count, exists: count === undefined ? undefined : count > 0, rows: values },
      status: count === undefined ? ("unknown" as const) : count > 0 ? ("matched" as const) : ("not_found" as const),
    };
  }
  const rows = values.filter((line) =>
    !/^(database|tables_in_.+|count\(\*\)|count)$/i.test(line),
  );
  const found = !emptyResult && rows.length > 0;
  return {
    facts: { rowCount: rows.length, rows },
    status: found ? ("matched" as const) : ("not_found" as const),
  };
}

function parseServiceFacts(lines: string[], emptyResult: boolean) {
  const text = lines.join("\n").toLowerCase();
  const active = /(^|\s)active(?:\s|$)|active:\s+active/.test(text);
  const unhealthy = /inactive|failed|dead|not-found|could not be found/.test(text);
  return {
    facts: { active, stateText: lines.slice(0, 6) },
    status: active
      ? ("healthy" as const)
      : unhealthy || emptyResult
        ? ("unhealthy" as const)
        : ("unknown" as const),
  };
}

function parseLogFacts(lines: string[], emptyResult: boolean) {
  const errorLines = lines.filter((line) => /\b(error|fatal|panic|exception|connection refused)\b/i.test(line));
  return {
    facts: { lineCount: lines.length, errorCount: errorLines.length, errorSamples: errorLines.slice(0, 5) },
    status: errorLines.length
      ? ("warning" as const)
      : emptyResult || !lines.length
        ? ("not_found" as const)
        : ("matched" as const),
  };
}

function parseGenericFacts(lines: string[], emptyResult: boolean) {
  const found = !emptyResult && lines.length > 0;
  return {
    facts: { lineCount: lines.length, outputPresent: found },
    status: emptyResult ? ("not_found" as const) : ("matched" as const),
  };
}

function parsePresenceFacts(lines: string[], emptyResult: boolean) {
  const found = !emptyResult && lines.length > 0;
  return {
    facts: { found, lineCount: lines.length },
    status: found ? ("matched" as const) : ("not_found" as const),
  };
}

function parseObservation(
  step: PlanStep,
  execution: CommandSnapshot,
): { facts: Record<string, unknown>; status: ObservationStatus } {
  const validator = step.validator ?? ensureStepValidator(step).validator!;
  const output = mainOutput(execution.output);
  const lines = outputLines(output);
  const emptyResult = Boolean(execution.emptyResult || output.includes("未发现匹配项"));
  switch (validator.type) {
    case "http": return parseHttpFacts(lines);
    case "process": return parseProcessFacts(lines, emptyResult);
    case "port-owner": return parsePortFacts(lines, emptyResult);
    case "sql-query": return parseSqlFacts(lines, step.command, emptyResult);
    case "service": return parseServiceFacts(lines, emptyResult);
    case "log": return parseLogFacts(lines, emptyResult);
    case "file":
    case "docker":
      return parsePresenceFacts(lines, emptyResult);
    case "runtime":
    case "platform":
    case "command":
    default:
      return parseGenericFacts(lines, emptyResult);
  }
}

function expectedDiagnosticExit(type: ValidatorType, exitCode?: number) {
  if (exitCode === undefined) return false;
  if (exitCode === 0) return true;
  if (["process", "port-owner", "sql-query", "file", "log", "docker", "runtime"].includes(type)) return exitCode === 1;
  if (type === "service") return [1, 3, 4].includes(exitCode);
  if (type === "http") return [1, 22, 28].includes(exitCode);
  return false;
}

export function classifyStepResult(
  rawStep: PlanStep,
  execution: CommandSnapshot,
  validation: ValidationSnapshot,
): { result: StepResult; evidence: ExecutionEvidence[]; accepted: boolean; needsModelReview: boolean } {
  const step = ensureStepValidator(rawStep);
  const validator = step.validator!;
  const mainParsed = parseObservation(step, execution);
  const mainSignals = analyzeOutputSignals(mainOutput(execution.output));
  const validationSignals = analyzeOutputSignals(validation.output ?? "");
  const outputSignals: OutputSignals = {
    status: mainSignals.status === "unhealthy" || validationSignals.status === "unhealthy"
      ? "unhealthy"
      : mainSignals.status ?? validationSignals.status,
    facts: {
      ...validationSignals.facts,
      ...mainSignals.facts,
      engineIncompatible: Boolean(mainSignals.facts.engineIncompatible || validationSignals.facts.engineIncompatible),
      explicitTooOld: Boolean(mainSignals.facts.explicitTooOld || validationSignals.facts.explicitTooOld),
      platformIncompatible: Boolean(mainSignals.facts.platformIncompatible || validationSignals.facts.platformIncompatible),
      networkFailure: Boolean(mainSignals.facts.networkFailure || validationSignals.facts.networkFailure),
      missingAbiSymbols: [...new Set([
        ...((mainSignals.facts.missingAbiSymbols as string[] | undefined) ?? []),
        ...((validationSignals.facts.missingAbiSymbols as string[] | undefined) ?? []),
      ])],
      category: mainSignals.facts.category ?? validationSignals.facts.category,
      runtimeCheck: mainSignals.facts.runtimeCheck ?? validationSignals.facts.runtimeCheck,
      platformCheck: mainSignals.facts.platformCheck ?? validationSignals.facts.platformCheck,
    },
    warnings: [...new Set([...mainSignals.warnings, ...validationSignals.warnings])],
    blocking: mainSignals.blocking || validationSignals.blocking,
  };
  const validationLines = outputLines(validation.output ?? "");
  let validationParsed = validation.output
    ? parseObservation(step, {
        output: validation.output,
        success: validation.passed,
        exitCode: validation.exitCode,
        emptyResult: validation.emptyResult,
      })
    : undefined;
  if (validationParsed && validationLines.length === 0) {
    validationParsed = {
      facts: validationParsed.facts,
      status: validation.passed
        ? validator.type === "http" || validator.type === "service" ? "healthy" : "matched"
        : ["http", "service"].includes(validator.type) ? "unhealthy" : "not_found",
    };
  }
  const readOnly = isReadOnlyStep(step);
  let parsed = !readOnly && validationParsed
    ? validationParsed
    : mainParsed.status === "unknown" && validationParsed && validationParsed.status !== "unknown"
      ? validationParsed
      : mainParsed;
  if (
    outputSignals.status
    || outputSignals.facts.platformCheck
    || outputSignals.facts.runtimeCheck
    || Number(outputSignals.facts.warningCount ?? 0) > 0
  ) {
    parsed = {
      status: outputSignals.status ?? parsed.status,
      facts: {
        ...parsed.facts,
        ...outputSignals.facts,
      },
    };
  }
  const validationAccepted = validation.passed
    || (readOnly && expectedDiagnosticExit(validator.type, validation.exitCode));
  const diagnosticFailureConsistent =
    !validation.passed
    && (
      parsed.status === "not_found"
      || parsed.status === "unhealthy"
      || parsed.status === "warning"
    );
  const semanticConflict = Boolean(
    readOnly
    &&
    validationParsed
    && (
      (mainParsed.status === "matched" && validationParsed.status === "not_found")
      || (mainParsed.status === "not_found" && validationParsed.status === "matched")
      || (mainParsed.status === "healthy" && validationParsed.status === "unhealthy")
      || (mainParsed.status === "unhealthy" && validationParsed.status === "healthy")
    ),
  );
  const evidenceConflict =
    (!validation.passed && validationAccepted && !diagnosticFailureConsistent)
    || semanticConflict;
  const accepted = execution.success && validationAccepted;
  const warnings = [
    ...outputSignals.warnings,
    ...(parsed.status === "warning" ? ["发现异常线索，需结合后续证据确认影响范围。"] : []),
    ...(parsed.status === "unhealthy" ? ["观察到非健康状态，但诊断命令已正常完成。"] : []),
    ...(evidenceConflict ? ["主命令输出与独立校验结果存在冲突。"] : []),
  ];
  const collectedAt = new Date().toISOString();
  const mainEvidence: ExecutionEvidence = {
    id: evidenceId("main"),
    type: validator.type,
    source: "main",
    facts: parsed.facts,
    rawOutput: execution.output,
    collectedAt,
  };
  const validationEvidence: ExecutionEvidence = {
    id: evidenceId("validation"),
    type: validator.type,
    source: "validation",
    facts: {
      passed: validation.passed,
      exitCode: validation.exitCode,
      acceptedDiagnosticState: validationAccepted && !validation.passed,
      detail: validation.detail,
      observationStatus: validationParsed?.status,
      observationFacts: validationParsed?.facts,
    },
    rawOutput: validation.output ?? "",
    collectedAt,
  };
  return {
    accepted,
    needsModelReview: accepted && (parsed.status === "unknown" || evidenceConflict || outputSignals.blocking),
    evidence: [mainEvidence, validationEvidence],
    result: {
      executionStatus: execution.success ? "success" : "failed",
      observationStatus: parsed.status,
      exitCode: execution.exitCode,
      facts: {
        ...parsed.facts,
        mainObservationStatus: mainParsed.status,
        validationObservationStatus: validationParsed?.status,
        validatorType: validator.type,
        validationPassed: validation.passed,
        evidenceConflict,
        blockingSignal: outputSignals.blocking,
      },
      warnings,
      evidenceIds: [mainEvidence.id, validationEvidence.id],
      failureReason: accepted
        ? undefined
        : outputSignals.facts.platformIncompatible
          ? outputSignals.warnings.find((warning) => warning.includes("ABI") || warning.includes("平台"))
          : outputSignals.facts.networkFailure
            ? outputSignals.warnings.find((warning) => warning.includes("网络") || warning.includes("下载"))
            : validation.detail,
    },
  };
}

export function observationText(status?: ObservationStatus) {
  const labels: Record<ObservationStatus, string> = {
    matched: "已获得结果",
    not_found: "未发现目标",
    healthy: "状态正常",
    unhealthy: "状态异常",
    warning: "发现异常线索",
    unknown: "证据待解释",
  };
  return status ? labels[status] : "尚未观察";
}
