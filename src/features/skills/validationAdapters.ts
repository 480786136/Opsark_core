import type { ObservationStatus, PlanStep, ValidatorType } from "@/types";

export interface ValidationObservation {
  facts: Record<string, unknown>;
  status: ObservationStatus;
}

export interface SkillOutputSignals {
  status?: "warning" | "unhealthy";
  facts: Record<string, unknown>;
  warnings: string[];
  blocking: boolean;
}

const FAILURE_DIAGNOSTIC_SAMPLE_LIMIT = 360;

function commandOutputLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Failure causes normally occur at the tail. Preserve a small head for
  // connection/authentication errors without repeatedly scanning huge build logs.
  return lines.length > 2_400
    ? [...lines.slice(0, 200), ...lines.slice(-2_200)]
    : lines;
}

function diagnosticSample(line: string | undefined) {
  if (!line) return undefined;
  return line.length <= FAILURE_DIAGNOSTIC_SAMPLE_LIMIT
    ? line
    : `${line.slice(0, FAILURE_DIAGNOSTIC_SAMPLE_LIMIT)}…`;
}

function classifiedFailure(
  reason: string,
  category: string,
  line?: string,
  facts: Record<string, unknown> = {},
) {
  return {
    reason,
    facts: {
      category,
      ...facts,
      classification: {
        confidence: line ? "high" : "fallback",
        sample: diagnosticSample(line),
      },
    },
  };
}

function findDiagnosticLine(lines: string[], pattern: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[index])) return lines[index];
  }
  return undefined;
}

export function analyzeSkillOutputSignals(lines: string[], semantic = ""): SkillOutputSignals {
  const text = lines.join("\n");
  const warningLines = lines.filter((line) =>
    /\bWARN(?:ING)?\b|\bdeprecated\b|\bdeprecation\b|\bis not supported\b|\bchunks? (?:is|are) larger than\b/i.test(line),
  );
  const missingAbiSymbols = [...new Set(
    [...text.matchAll(/(?:version\s+[`']?)((?:GLIBCXX|GLIBC|CXXABI)_[0-9.]+)(?:['`]?\s+not found)/gi)]
      .map((match) => match[1]),
  )];
  const platformIncompatible = missingAbiSymbols.length > 0
    || /(?:wrong ELF class|Exec format error|cannot execute binary file)/i.test(text);
  const networkFailureLines = lines.filter((line) =>
    /curl:\s*\(\d+\)|connection reset|could not resolve host|connection timed out|network is unreachable|TLS handshake timeout/i.test(line),
  );
  const networkFailure = networkFailureLines.length > 0;
  const emptyRequiredFile = /(?:\.sql|backup|dump)/i.test(`${semantic}\n${text}`)
    && /完整|备份|backup|dump/i.test(semantic)
    && (/(?:^|\n)\s*0\s+\S+\.sql\s*$/im.test(text) || /\.sql:\s*empty\b/i.test(text));
  const warnings: string[] = [];
  if (warningLines.length) warnings.push("命令成功完成，但输出中包含需要关注的警告信息。");
  if (platformIncompatible) warnings.push(missingAbiSymbols.length
    ? `目标程序无法在当前平台运行，缺少 ABI 符号：${missingAbiSymbols.join("、")}。`
    : "目标程序与当前操作系统或处理器架构不兼容。");
  if (networkFailure) warnings.push("下载或网络连接失败，目标文件或安装脚本未可靠获取。");
  if (emptyRequiredFile) warnings.push("目标 SQL/备份文件为空，已经足以否定其内容完整性。");
  return {
    status: platformIncompatible || networkFailure || emptyRequiredFile ? "unhealthy" : warningLines.length ? "warning" : undefined,
    facts: {
      category: platformIncompatible ? "platform_incompatible" : networkFailure ? "network_failure" : undefined,
      platformIncompatible, missingAbiSymbols, networkFailure,
      networkFailureSamples: networkFailureLines.slice(0, 5), emptyRequiredFile,
      warningCount: warningLines.length, warningSamples: [...new Set(warningLines)].slice(0, 8),
    },
    warnings,
    blocking: platformIncompatible || networkFailure || emptyRequiredFile,
  };
}

export function analyzeSkillCommandFailure(text: string) {
  const lines = commandOutputLines(text);
  const interactiveCredential = findDiagnosticLine(
    lines,
    /could not read Username.*terminal prompts disabled|terminal prompts disabled.*(?:username|password)/i,
  );
  if (interactiveCredential) return classifiedFailure(
    "Git HTTPS 需要交互认证，但当前命令禁用了凭据提示",
    "interactive_credential_required",
    interactiveCredential,
    { credentialRejected: false },
  );

  const rejectedCredential = findDiagnosticLine(
    lines,
    /authentication failed|invalid (?:username|password|credentials?)|incorrect (?:user(?:name)?|account)(?: or|\/)? password|http basic:\s*access denied|access denied.*(?:token|password|credential)|permission denied \(publickey[^)]*password|(?:用户名|账号|账户).{0,8}密码.{0,8}(?:错误|不正确)|仓库认证未通过.*再次请求/i,
  );
  if (rejectedCredential) return classifiedFailure(
    "仓库服务器拒绝了当前账户与密码/令牌组合",
    "credential_rejected",
    rejectedCredential,
    { credentialRejected: true },
  );

  const jdkToolingIncompatible = findDiagnosticLine(
    lines,
    /\b(?:NoSuchFieldError|NoSuchMethodError|IllegalAccessError)\b.*\b(?:com\.sun\.tools\.javac|jdk\.compiler)\b/i,
  );
  if (jdkToolingIncompatible) return classifiedFailure(
    "Java 编译器插件或注解处理器与当前 JDK 内部 API 不兼容",
    "jdk_tooling_incompatible",
    jdkToolingIncompatible,
  );

  const bytecodeIncompatible = findDiagnosticLine(
    lines,
    /\bUnsupportedClassVersionError\b|class file has wrong version|invalid target release|release version \d+ not supported/i,
  );
  if (bytecodeIncompatible) return classifiedFailure(
    "Java 字节码或编译目标版本与当前 JDK 不兼容",
    "jdk_version_incompatible",
    bytecodeIncompatible,
  );

  const missingAbiSymbols = [...new Set(
    [...text.matchAll(/(?:version\s+[`']?)((?:GLIBCXX|GLIBC|CXXABI)_[0-9.]+)(?:['`]?\s+not found)/gi)]
      .map((match) => match[1]),
  )];
  const platformLine = findDiagnosticLine(
    lines,
    /(?:version\s+[`']?)(?:GLIBCXX|GLIBC|CXXABI)_[0-9.]+(?:['`]?\s+not found)|wrong ELF class|Exec format error|cannot execute binary file/i,
  );
  if (missingAbiSymbols.length || platformLine) return classifiedFailure(
    missingAbiSymbols.length
      ? `目标程序与当前系统 ABI 不兼容，缺少 ${missingAbiSymbols.join("、")}`
      : "目标程序与当前操作系统或处理器架构不兼容",
    "platform_incompatible",
    platformLine,
    { platformIncompatible: true, missingAbiSymbols },
  );

  const diskFull = findDiagnosticLine(lines, /\bENOSPC\b|no space left on device|disk quota exceeded/i);
  if (diskFull) return classifiedFailure("服务器磁盘空间不足", "disk_full", diskFull);

  // EACCES must be a standalone errno in an error-shaped line. The previous
  // substring scan classified Maven's `failureaccess` artifact as EACCES.
  const permissionDenied = findDiagnosticLine(
    lines,
    /(?:(?:npm|pnpm|yarn)\s+(?:ERR!|error)\s+(?:code|errno)\s+(?:EACCES|EPERM)\b|^(?:error|errno|code):?\s+(?:EACCES|EPERM)\b|\b(?:EACCES|EPERM)\b\s*:\s*(?:permission denied|operation not permitted)|(?:^|:\s)(?:permission denied|operation not permitted)(?:$|[,:.(\s])|\[Errno\s+13\].*permission denied|\bAccessDeniedException\b)/i,
  );
  if (permissionDenied) return classifiedFailure(
    "当前用户没有完成该操作所需的权限",
    "permission_denied",
    permissionDenied,
  );

  const commandMissing = findDiagnosticLine(
    lines,
    /(?:^|:\s)(?:[^:]+:\s*)?command not found(?:$|\s)|not recognized as an internal or external command/i,
  );
  if (commandMissing) return classifiedFailure("命令或必要工具未安装", "command_not_found", commandMissing);

  const networkFailure = findDiagnosticLine(
    lines,
    /\bcurl:\s*\(\d+\)|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN)\b|could not resolve host|network is unreachable|connection timed out|TLS handshake timeout|connect(?:ion)?\b.*(?:refused|timed out)/i,
  );
  if (networkFailure) return classifiedFailure("网络连接或远程地址解析失败", "network_failure", networkFailure);

  const unavailableResourceLine = findDiagnosticLine(
    lines,
    /(?:HTTP\/\S+\s+404\b|curl:\s*\(22\).*\b404\b|(?:fatal|error).*repository.*not found|\b404\b.*https?:\/\/\S+)/i,
  );
  const unavailableResource = unavailableResourceLine?.match(/https?:\/\/\S+/i);
  if (unavailableResourceLine) return classifiedFailure(
    "请求的远程资源不存在或地址无效",
    "resource_not_found",
    unavailableResourceLine,
    { url: unavailableResource?.[0] },
  );

  const genericError = findDiagnosticLine(
    lines,
    /\[(?:ERROR|FATAL)\]|\b(?:error|fatal|failed|failure|exception)\b|错误|失败/i,
  ) ?? findDiagnosticLine(lines, /\b[A-Z][A-Za-z0-9_$]*(?:Error|Exception)\b/);
  return classifiedFailure("命令执行未成功", "command_failed", genericError);
}

interface ValidationAdapter {
  type: ValidatorType;
  matches(step: Pick<PlanStep, "title" | "description" | "command" | "validation">): boolean;
  validStates: ObservationStatus[];
  expectedExitCodes: number[];
  parse(lines: string[], emptyResult: boolean, step: PlanStep): ValidationObservation;
}

const found = (lines: string[], emptyResult: boolean) => !emptyResult && lines.length > 0;
const stepText = (step: Pick<PlanStep, "title" | "description" | "command" | "validation">) =>
  `${step.title}\n${step.description}\n${step.command}\n${step.validation}`;
const presence = (lines: string[], emptyResult: boolean): ValidationObservation => ({
  facts: { found: found(lines, emptyResult), lineCount: lines.length },
  status: found(lines, emptyResult) ? "matched" : "not_found",
});
const generic = (lines: string[], emptyResult: boolean): ValidationObservation => ({
  facts: { lineCount: lines.length, outputPresent: found(lines, emptyResult) },
  status: emptyResult ? "not_found" : "matched",
});

export const validationAdapters: ValidationAdapter[] = [
  {
    type: "platform",
    matches: (step) => /平台兼容|系统兼容|操作系统.*架构|abi 兼容/i.test(stepText(step)),
    validStates: ["healthy", "unhealthy", "warning", "unknown"], expectedExitCodes: [], parse: generic,
  },
  {
    type: "runtime",
    matches: (step) => /运行时|runtime|版本兼容|可执行文件版本/i.test(`${step.title}\n${step.description}`)
      || /(?:^|[;&|]\s*)\S+\s+(?:--version|-version|-V)(?:\s|$)/.test(step.validation),
    validStates: ["healthy", "unhealthy", "warning", "unknown"], expectedExitCodes: [1], parse: generic,
  },
  {
    type: "sql-query",
    matches: (step) => /\bmysql\b|\bpsql\b|\bsqlite3\b|show\s+(databases|tables)|information_schema/i.test(stepText(step)),
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [1],
    parse(lines, emptyResult, step) {
      const values = lines.filter((line) => !/^mysql: \[warning\]/i.test(line));
      if (/count\s*\(\s*\*\s*\)/i.test(step.command)) {
        const countLine = [...values].reverse().find((line) => /^\d+$/.test(line));
        const count = countLine === undefined ? undefined : Number(countLine);
        return {
          facts: { count, exists: count === undefined ? undefined : count > 0, rows: values },
          status: count === undefined ? "unknown" : count > 0 ? "matched" : "not_found",
        };
      }
      const rows = values.filter((line) => !/^(database|tables_in_.+|count\(\*\)|count)$/i.test(line));
      return { facts: { rowCount: rows.length, rows }, status: found(rows, emptyResult) ? "matched" : "not_found" };
    },
  },
  {
    type: "http",
    matches: (step) => /http状态|页面响应|首页|网页|接口响应/i.test(`${step.title}\n${step.description}`)
      || /\bcurl\b[^\n]*(?:https?:\/\/|%\{http_code}|-i\b|-I\b|-f\b)|\bwget\b[^\n]*--spider/i.test(step.validation),
    validStates: ["healthy", "unhealthy", "warning", "unknown"], expectedExitCodes: [1, 22, 28],
    parse(lines) {
      const statuses = lines.flatMap((line) => [...line.matchAll(/HTTP\/\S+\s+(\d{3})/gi)].map((match) => Number(match[1])));
      const standalone = lines.find((line) => /^\d{3}$/.test(line));
      if (!statuses.length && standalone) statuses.push(Number(standalone));
      const status = statuses[statuses.length - 1];
      return {
        facts: { httpStatus: status, redirectCount: Math.max(0, statuses.length - 1), responseReceived: lines.length > 0 },
        status: status === undefined ? "unknown" : status >= 200 && status < 400 ? "healthy" : "unhealthy",
      };
    },
  },
  {
    type: "port-owner",
    matches: (step) => /\bss\s|\bnetstat\b|\blsof\b.*-i|监听端口|端口归属/i.test(stepText(step)),
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [1],
    parse(lines, emptyResult) {
      const ports = new Set<number>(); const pids = new Set<number>();
      lines.forEach((line) => {
        [...line.matchAll(/(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|\*|[0-9a-f:]+):(\d+)\b/gi)].forEach((match) => ports.add(Number(match[1])));
        [...line.matchAll(/pid[=/](\d+)/gi)].forEach((match) => pids.add(Number(match[1])));
      });
      return { facts: { listenerFound: found(lines, emptyResult), ports: [...ports], ownerPids: [...pids], ownershipConfirmed: pids.size > 0 }, status: found(lines, emptyResult) ? "matched" : "not_found" };
    },
  },
  {
    type: "service",
    matches: (step) => /\bsystemctl\b|\bservice\b|服务状态/i.test(stepText(step)),
    validStates: ["healthy", "unhealthy", "warning", "unknown"], expectedExitCodes: [1, 3, 4],
    parse(lines, emptyResult) {
      const text = lines.join("\n").toLowerCase(); const active = /(^|\s)active(?:\s|$)|active:\s+active/.test(text);
      const unhealthy = /inactive|failed|dead|not-found|could not be found/.test(text);
      return { facts: { active, stateText: lines.slice(0, 6) }, status: active ? "healthy" : unhealthy || emptyResult ? "unhealthy" : "unknown" };
    },
  },
  {
    type: "docker",
    matches: (step) => /\bdocker\b|\bpodman\b|容器/i.test(stepText(step)),
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [1], parse: presence,
  },
  {
    type: "log",
    matches: (step) => /\bjournalctl\b|\.log\b|日志|tail\s/i.test(stepText(step)),
    validStates: ["matched", "not_found", "warning", "unknown"], expectedExitCodes: [1],
    parse(lines, emptyResult) {
      const errors = lines.filter((line) => /\b(error|fatal|panic|exception|connection refused)\b/i.test(line));
      return { facts: { lineCount: lines.length, errorCount: errors.length, errorSamples: errors.slice(0, 5) }, status: errors.length ? "warning" : emptyResult || !lines.length ? "not_found" : "matched" };
    },
  },
  {
    type: "process",
    matches: (step) => /\bps\s|\bpgrep\b|\bpidof\b|进程/i.test(stepText(step)),
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [1],
<<<<<<< HEAD
    parse(lines, emptyResult) {
=======
    parse(lines, emptyResult, step) {
      const inspectedCommand = step.command.trim().replace(/\s+/g, " ");
      const selfMatches = lines.filter(line => /\b(?:bash|sh|dash|zsh)\s+-[a-z]*c[a-z]*\s/.test(line)
        && (line.includes("/tmp/opsark-exec-") || (inspectedCommand.length > 12
          && line.replace(/\s+/g, " ").includes(inspectedCommand))));
      if (selfMatches.length) {
        return { facts: { selfInspectionMatches: selfMatches.length,
          processEvidenceAmbiguous: true,
          reason: "进程输出包含本次检查自身的 Shell 包装进程；须按真实可执行文件身份重新检查，不能据此断定目标进程存在或不存在。" }, status: "unknown" };
      }
>>>>>>> origin/master
      const pids = new Set<number>();
      lines.forEach((line) => { const value = line.match(/^\S+\s+(\d+)\s+/)?.[1] ?? line.match(/^(\d+)(?:\s|$)/)?.[1]; if (value) pids.add(Number(value)); });
      return { facts: { processFound: found(lines, emptyResult), processCount: found(lines, emptyResult) ? Math.max(pids.size, 1) : 0, pids: [...pids] }, status: found(lines, emptyResult) ? "matched" : "not_found" };
    },
  },
  {
    type: "file",
    matches: (step) => /\btest\s+-[efdLrwx]\b|\bstat\b|\bfind\b|\bls\s|文件|目录/i.test(stepText(step)),
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [1], parse: presence,
  },
  {
    type: "command", matches: () => true,
    validStates: ["matched", "not_found", "unknown"], expectedExitCodes: [], parse: generic,
  },
];

export function inferSkillValidator(step: Pick<PlanStep, "title" | "description" | "command" | "validation">) {
  return validationAdapters.find((adapter) => adapter.matches(step)) ?? validationAdapters[validationAdapters.length - 1];
}

export function parseSkillObservation(type: ValidatorType, lines: string[], emptyResult: boolean, step: PlanStep) {
  return (validationAdapters.find((adapter) => adapter.type === type) ?? validationAdapters[validationAdapters.length - 1])
    .parse(lines, emptyResult, step);
}

export function validStatesForSkillValidator(type: ValidatorType) {
  return (validationAdapters.find((adapter) => adapter.type === type) ?? validationAdapters[validationAdapters.length - 1]).validStates;
}

export function expectedSkillDiagnosticExit(type: ValidatorType, exitCode?: number) {
  if (exitCode === undefined) return false;
  if (exitCode === 0) return true;
  return (validationAdapters.find((adapter) => adapter.type === type)?.expectedExitCodes ?? []).includes(exitCode);
}
