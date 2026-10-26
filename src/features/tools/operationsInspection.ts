import probe from "./operations_probe.py?opsark-probe";
import packageProbe from "./package_probe.py?opsark-probe";
import { buildProbeDecoder } from "./probeDelivery";
import { operationsInputSchemas, operationsOutputSchemas, servicePropertyKeys } from "./operationsContracts";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
export { parseOperationsCapabilities } from "./hostCapabilities";

export interface OperationsInspectionResult {
  request: Record<string, unknown>;
  status: "complete" | "no_match" | "partial" | "timeout" | "cancelled" | "permission_denied" | "unsupported" | "error";
  items: Array<Record<string, unknown>>;
  scannedEntries: number;
  matchedEntries: number;
  skippedCount: number;
  skipped: Array<{ path: string; reason: string }>;
  coverageComplete: boolean;
  truncated: boolean;
  elapsedMs: number;
  finishedAt: string;
}

export function normalizeOperationsRequest(toolId: string, value: Record<string, unknown>): Record<string, unknown> {
  const schema = operationsInputSchemas[toolId];
  if (!schema) throw new Error("未知运维检查工具");
  const request = fillToolDefaults(schema, value) as Record<string, unknown>;
  validateSchemaValue(schema, request, "运维检查参数", "");
  const normalizePath = (value: unknown) => {
    const path = String(value);
    if (path.split("/").includes("..")) throw new Error("检查路径不能包含 ..，请提供明确绝对路径");
    return "/" + path.split("/").filter(part => part && part !== ".").join("/");
  };
  if (request.path !== undefined) request.path = normalizePath(request.path);
  if (Array.isArray(request.excludePaths)) request.excludePaths = [...new Set(request.excludePaths.map(normalizePath))];
  if (toolId === "packages.inspect" && Number(request.waitSeconds) >= Number(request.timeoutSeconds)) {
    throw new Error("包管理等待时间必须小于整体采集时限，留出实际检查时间");
  }
  if (request.url !== undefined) {
    const raw = String(request.url);
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("健康检查地址必须是有效的 HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash
      || /[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new Error("健康检查 URL 不能包含凭据、空白、反斜杠或片段");
    // Preserve the approved spelling. Never rewrite paths, queries or endpoints.
  }
  if (JSON.stringify(request).length > 8192) throw new Error("检查范围参数过长，请拆分为多个有界检查");
  return request;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function buildOperationsCommand(toolId: string, request: Record<string, unknown>): string {
  const normalized = normalizeOperationsRequest(toolId, request);
  const unavailable: OperationsInspectionResult = {
    request: normalized, status: "unsupported", items: [], scannedEntries: 0, matchedEntries: 0,
    skippedCount: 1, skipped: [{ path: "python>=3.6", reason: "unsupported" }],
    coverageComplete: false, truncated: true, elapsedMs: 0, finishedAt: "unavailable",
  };
  return `opsark_probe_python=''
opsark_probe_version=''
for opsark_candidate in python3 python; do
  if command -v "$opsark_candidate" >/dev/null 2>&1; then
    if opsark_probe_version=$("$opsark_candidate" -c 'import sys; print(".".join(map(str, sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null); then
      opsark_probe_python="$opsark_candidate"
      break
    fi
  fi
done
if [ -n "$opsark_probe_python" ]; then
"$opsark_probe_python" -I -B -u -c ${quote(buildProbeDecoder(toolId === "packages.inspect" ? packageProbe : probe))} ${quote(JSON.stringify({ toolId, request: normalized }))}
else
printf '%s' 'OPSARK_CAPABILITIES {"version":1,"observedAt":null,"facts":[{"name":"python.runtime","supported":false'
case "$opsark_probe_version" in
  ''|*[!0-9.]*) ;;
  *) printf ',"version":"%s"' "$opsark_probe_version" ;;
esac
printf '%s' '}'
for opsark_capability in systemctl journalctl ss netstat curl jq; do
  if command -v "$opsark_capability" >/dev/null 2>&1; then
    printf ',{"name":"%s","supported":true}' "$opsark_capability"
  else
    printf ',{"name":"%s","supported":false}' "$opsark_capability"
  fi
done
printf '%s\\n' ']}'
printf '%s\\n' ${quote("OPSARK_RESULT " + JSON.stringify(unavailable))}
fi`;
}

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
    : JSON.stringify(value);

export function operationsResultIssue(toolId: string, request: Record<string, unknown>, data: OperationsInspectionResult): string | undefined {
  const normalized = normalizeOperationsRequest(toolId, request);
  if (stable(data.request) !== stable(normalized)) return "检查结果与请求范围不一致";
  const kinds: Record<string, string> = { capacity: "filesystem", directory: "directory", deleted: "deleted_file", docker: "docker", status: "service", ports: "ports", logs: "logs", health: "health" };
  const kind = toolId === "packages.inspect" ? "package_environment" : toolId === "files.inspect" ? "file_metadata" : toolId === "files.find_large" ? "file" : kinds[String(normalized.check)];
  if (data.items.some(item => item.kind !== kind)) return "返回了未请求的检查类型";
  if (data.items.length > Number(request.maxResults ?? 200) || data.scannedEntries > Number(request.maxEntries ?? 100000)
    || data.skipped.length > data.skippedCount || data.matchedEntries < data.items.length) return "检查数量与预算不一致";
  const finished = ["complete", "no_match"].includes(data.status);
  if (data.coverageComplete !== finished || (!finished && !data.truncated)
    || (data.status === "no_match" && (data.items.length > 0 || data.matchedEntries > 0))
    || (data.matchedEntries > data.items.length && !data.truncated)) return "检查状态与完整性不一致";
  if (finished && data.skipped.some(item => !["excluded", "filesystem", "symlink"].includes(item.reason))) {
    return "存在未覆盖范围，不能报告检查完整";
  }
  const direct = toolId === "packages.inspect" || toolId === "files.inspect" || toolId === "services.inspect" || normalized.check === "capacity" || normalized.check === "docker";
  if (finished && direct && (data.status !== "complete" || data.items.length !== 1)) return "直接检查缺少唯一观测结果";
  const subjects: Record<string, unknown> = { service: normalized.service, logs: normalized.service,
    health: normalized.url, ports: "server:listening", filesystem: normalized.path, file_metadata: normalized.path, docker: "docker:local-default-socket", package_environment: "server:package-management" };
  if (kind in subjects && data.items.some(item => item.subject !== subjects[kind])) return "观测对象与请求目标不一致";
  if (["file", "directory"].includes(kind)) {
    const root = String(normalized.path);
    if (data.items.some(item => typeof item.subject !== "string" || (item.subject !== root
      && !item.subject.startsWith(root === "/" ? "/" : root + "/")) || item.subject.split("/").includes(".."))) return "文件观测超出请求目录";
  }
  if (kind === "file_metadata") {
    if (data.items.length > 1 || data.scannedEntries > 1 || data.matchedEntries !== data.items.length) return "精确路径检查只能返回一个对象";
    for (const item of data.items) {
      const metadata = item.metadata as Record<string, unknown> | undefined;
      const regularHash = normalized.hash === true && item.fileType === "regular";
      const limitations = item.limitations as string[];
      if (!Number.isFinite(Date.parse(String(item.sampleStartedAt))) || !Number.isFinite(Date.parse(String(item.sampleFinishedAt)))
        || !limitations.includes("non_atomic_sample")
        || (item.fileType === "directory" && !limitations.includes("self_metadata_only"))
        || (item.fileType === "symlink" && !limitations.includes("target_not_followed"))
        || (item.fileType === "missing" && (!limitations.includes("absence_at_sample") || item.consistency !== "single_observation"))
        || (item.fileType !== "missing" && item.consistency !== (item.stability === "stable" ? "metadata_checked" : "unverified"))) return "文件采样时间或一致性边界不明确";
      if (Number(item.hashedBytes) > Number(normalized.maxHashBytes) || (!regularHash && (item.hashedBytes !== 0 || item.verifiedReadPasses !== 0))
        || (finished && item.stability !== "stable")) return "文件摘要预算或稳定性不一致";
      const expected = item.fileType === "missing" ? "not_applicable" : !normalized.hash ? "not_requested"
        : item.fileType !== "regular" ? "not_applicable" : undefined;
      if ((expected && item.hashStatus !== expected) || (regularHash && !["complete", "limit_exceeded", "changed", "unavailable"].includes(String(item.hashStatus)))
        || (finished && regularHash && item.hashStatus !== "complete")
        || (item.hashStatus === "complete" && (item.hashedBytes !== metadata?.sizeBytes || item.stability !== "stable" || item.verifiedReadPasses !== 2))
        || (item.hashStatus === "changed" && item.stability !== "changed")) return "文件摘要状态与请求或身份不一致";
      if (item.fileType === "symlink" && item.linkTargetRedacted !== true
        && new TextEncoder().encode(String(item.linkTarget)).length !== metadata?.sizeBytes) return "链接文本与链接身份长度不一致";
    }
  }
  if (kind === "package_environment") {
    if (data.items.length > 1 || data.scannedEntries > 1 || data.matchedEntries !== data.items.length) return "包管理检查只能返回一个采样范围";
    for (const item of data.items) {
      const packages = item.packages as Array<Record<string, any>>;
      const locks = item.locks as Array<Record<string, any>>;
      const pidFiles = item.pidFiles as Array<Record<string, any>>;
      const kit = item.packageKit as Record<string, any>;
      const requiredLocks = item.family === "debian" ? ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"]
        : item.family === "rpm" ? ["/var/lib/rpm/.rpm.lock", "/usr/lib/sysimage/rpm/.rpm.lock"] : undefined;
      if ((finished || item.transactionCoverageComplete || item.decision === "clear") && (!requiredLocks || stable(locks.map(lock => lock.path)) !== stable(requiredLocks)
        || stable(pidFiles.map(file => file.path)) !== stable(item.family === "rpm" ? ["/run/yum.pid", "/run/dnf.pid"] : []))) return "包管理锁范围缺失，不能报告完整或无阻塞";
      if (packages.some((entry, index) => entry.name !== (normalized.packages as string[])[index])
        || new Set(packages.map(entry => entry.name)).size !== packages.length
        || packages.length > (normalized.packages as string[]).length || (finished && packages.length !== (normalized.packages as string[]).length)) return "软件包观测与请求不一致";
      const blocked = locks.some(lock => lock.state === "held") || pidFiles.some(file => file.state === "active") || kit.state === "active";
      const unknown = locks.some(lock => lock.state === "unknown") || pidFiles.some(file => file.state === "unknown") || kit.state === "unknown";
      if (item.transactionCoverageComplete !== !unknown) return "事务覆盖范围不能被已知阻塞覆盖";
      if (item.decision !== (blocked ? "blocked" : unknown ? "unknown" : "clear")
        || locks.some(lock => (lock.state === "held") !== (lock.holders.length > 0))
        || (kit.state === "idle" && (kit.locked !== false || kit.transactions.length))
        || (kit.state === "absent" && (kit.locked !== false || kit.transactions.length))
        || (kit.state === "active" && kit.locked !== true && !kit.transactions.length)) return "包管理阻塞结论缺少真实锁或事务证据";
      if (packages.some(entry => (entry.candidateSelection === "apt_policy" && item.family !== "debian")
        || (entry.candidateSelection === "unranked_cache" && item.family !== "rpm"))) return "候选版本来源与包管理器不一致";
      if (packages.some(entry => (entry.installedStatus === "installed") !== (entry.installedVersions.length > 0 && entry.installedStatus !== "unknown")
        || (entry.candidateStatus === "available") !== (entry.candidateVersions.length > 0)
        || (entry.candidateStatus === "available" && entry.candidateSelection === "none"))) return "软件包版本状态不一致";
      if (!Number.isFinite(Date.parse(String(item.observedAt))) || (finished && Number(item.waitedMs) > Math.min(Number(normalized.waitSeconds), Number(normalized.timeoutSeconds)) * 1000)
        || (!normalized.waitSeconds && (item.waitOutcome !== "not_requested" || item.sampleCount !== 1 || item.waitedMs !== 0))
        || (item.waitOutcome === "cleared" && item.decision !== "clear")
        || (item.waitOutcome === "exhausted" && item.decision !== "blocked")
        || (item.waitOutcome === "sample_timeout" && (item.transactionCoverageComplete || item.decision !== "unknown" || finished))
        || (item.nextAction === "wait_or_report" && (item.decision !== "blocked" || !item.transactionCoverageComplete || item.sourcesStatus !== "complete" || packages.some(entry => entry.installedStatus === "unknown" || entry.candidateStatus === "unknown")))
        || (finished && item.waitOutcome === "not_waited_incomplete")
        || (finished && (item.sourcesStatus !== "complete" || !item.transactionCoverageComplete || packages.some(entry => entry.installedStatus === "unknown" || entry.candidateStatus === "unknown")))
        || (item.nextAction === "continue_installation_planning" && (!finished || item.decision !== "clear"))) return "包管理等待、下一步或覆盖范围不一致";
    }
  }
  if (kind === "health") {
    const limit = Number(normalized.maxResponseBytes ?? 0);
    for (const item of data.items) {
      const hasBody = typeof item.body === "string";
      if ((!limit && hasBody) || (limit > 0 && finished && !hasBody)) return "健康检查正文与请求范围不一致";
      if (hasBody) {
        const bytes = new TextEncoder().encode(String(item.body)).length;
        if (Number(item.returnedBytes) > limit || (item.bodyRedacted !== true && (item.returnedBytes !== bytes || bytes > limit))
          || (item.bodyTruncated && (!data.truncated || data.coverageComplete))
          || (item.bodyEncoding === "unavailable" && (bytes !== 0 || !item.bodyTruncated))
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(String(item.body))) return "健康检查正文字节、编码或完整性不一致";
      }
    }
  }
  if (kind === "service") {
    for (const item of data.items) {
      const properties: Record<string, string> = {};
      for (const line of String(item.text ?? "").split(/\r?\n/)) {
        const at = line.indexOf("="), key = line.slice(0, at);
        if (at < 0 || !(servicePropertyKeys as readonly string[]).includes(key)) continue;
        if (Object.prototype.hasOwnProperty.call(properties, key)) return "服务属性重复，不能确定唯一状态";
        properties[key] = line.slice(at + 1);
      }
      if (finished && !["Id", "LoadState", "ActiveState", "SubState"].every(key => properties[key]?.trim())) {
        return "服务状态缺少实际属性，不能视为完整检查";
      }
      if (item.properties !== undefined && stable(properties) !== stable(item.properties)) return "结构化服务属性与原始观测不一致";
      if (item.compatibilityAttempt && (finished || data.coverageComplete || !data.truncated
        || data.status !== "partial" && data.status !== "error" && data.status !== "timeout" && data.status !== "cancelled")) {
        return "服务基础属性兼容回退不能冒充完整扩展属性覆盖";
      }
      const identity = item.processIdentity as Record<string, unknown> | undefined;
      if (!identity) continue; // Legacy status receipts never imply a verified process identity.
      const start = Date.parse(String(identity.sampleStartedAt)), end = Date.parse(String(identity.sampleFinishedAt));
      if (identity.service !== normalized.service || !Number.isFinite(start) || !Number.isFinite(end) || end < start
        || end > Date.parse(data.finishedAt)) return "服务身份的目标或采样时间不一致";
      if (identity.pid !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(properties.MainPID ?? "")
        || Number(properties.MainPID) !== identity.pid)) return "服务进程身份与 MainPID 不一致";
      if (["stable", "not_running"].includes(String(identity.status))
        && (!item.properties || item.exitCode !== 0 || identity.verificationExitCode !== 0)) return "服务进程身份缺少两次成功属性观测";
    }
  }
  if (finished && data.items.some(item => "exitCode" in item && item.exitCode !== 0)) return "命令退出失败，不能视为完整检查";
  return undefined;
}

export function parseOperationsOutput(toolId: string, request: Record<string, unknown>, output: string): OperationsInspectionResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_RESULT "));
  if (lines.length !== 1 || lines[0].length > 131100) throw new Error("运维检查没有返回唯一有效的有界结果");
  let data: OperationsInspectionResult;
  try { data = JSON.parse(lines[0].slice("OPSARK_RESULT ".length)); }
  catch { throw new Error("运维检查结果不是有效 JSON"); }
  validateSchemaValue(operationsOutputSchemas[toolId], data, "运维检查结果", "");
  if (data.items.some(item => item.bodyRedacted === true || item.linkTargetRedacted === true || item.observationsRedacted === true)) throw new Error("远端采集不能声明 Core 已对观测脱敏");
  const issue = operationsResultIssue(toolId, request, data);
  if (issue) throw new Error(issue);
  return data;
}

/** Returned bytes describe the remote sample, not the replacement marker length. */
export function redactOperationsBodies(data: OperationsInspectionResult, redact: (value: string) => string): void {
  for (const item of data.items) {
    if (typeof item.body !== "string") continue;
    const redacted = redact(item.body);
    if (redacted !== item.body) item.bodyRedacted = true;
    item.body = redacted;
  }
}

/** Request identities are already exposed in data.request and stay byte-exact. */
export function redactOperationsObservations(data: OperationsInspectionResult, redact: (value: string) => string): void {
  const request = data.request;
  const known = new Set([request.path, request.service, request.url, "server:listening", "docker:local-default-socket", "server:package-management"]
    .filter((value): value is string => typeof value === "string"));
  const scoped = (value: string) => {
    if (known.has(value)) return value;
    const root = typeof request.path === "string" ? request.path : undefined;
    const prefix = root === "/" ? "/" : root ? root + "/" : undefined;
    return prefix && value.startsWith(prefix) ? prefix + redact(value.slice(prefix.length)) : redact(value);
  };
  for (const item of data.items) {
    if (item.kind === "package_environment") {
      const redactTree = (value: unknown, key: string): unknown => {
        if (Array.isArray(value)) return value.map(entry => redactTree(entry, key));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redactTree(entry, name)]));
        if (typeof value !== "string" || !["file", "id", "origins", "version", "architecture", "source", "installedVersions", "executable", "process"].includes(key)) return value;
        const next = redact(value);
        if (next !== value) item.observationsRedacted = true;
        return next;
      };
      for (const key of ["sources", "packages", "managers", "pidFiles"]) item[key] = redactTree(item[key], key);
    }
    if (typeof item.text === "string") {
      const next = redact(item.text);
      if (next !== item.text && item.kind === "service") item.observationsRedacted = true;
      item.text = next;
    }
    if (item.kind === "service" && item.properties && typeof item.properties === "object") {
      for (const [key, value] of Object.entries(item.properties)) {
        if (typeof value !== "string") continue;
        const next = redact(value);
        if (next !== value) item.observationsRedacted = true;
        (item.properties as Record<string, unknown>)[key] = next;
      }
    }
    if (typeof item.subject === "string") item.subject = scoped(item.subject);
    if (typeof item.linkTarget === "string") {
      const redacted = redact(item.linkTarget);
      if (redacted !== item.linkTarget) item.linkTargetRedacted = true;
      item.linkTarget = redacted;
    }
  }
  for (const item of data.skipped) item.path = scoped(item.path);
  redactOperationsBodies(data, redact);
}
