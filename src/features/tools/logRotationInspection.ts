import probe from "./log_rotation_probe.py?raw";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { fullSchemaPattern } from "./toolSchemaPatterns";
import type { ToolDefinition } from "./types";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const array = (items: Record<string, unknown>, maxItems: number) => ({ type: "array", items, maxItems });
const text = { type: "string", maxLength: 4096 };
const state = (...values: string[]) => ({ type: "string", enum: values });
const flag = { type: "boolean" };
const path = { type: "string", minLength: 2, maxLength: 4096, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]+") };
const sha = { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") };
const digits = { type: "string", pattern: fullSchemaPattern("[0-9]+"), maxLength: 32 };
const sequenceField = { type: "string", pattern: fullSchemaPattern("[A-Za-z_][A-Za-z0-9_]{0,63}") };
const sequenceRequest = object({ field: sequenceField, first: integer(), last: integer() });
export const logRotationLimitations = ["exact_paths_and_pids_only", "non_atomic_observation", "configuration_declarations_only", "schedule_not_verified", "reopen_support_not_inferred", "sequence_window_only", "not_rotation_authorization"];
export const logRotationInputSchema = object({
  activePaths: { ...array(path, 8), minItems: 1, uniqueItems: true },
  archivePaths: { ...array(path, 16), uniqueItems: true, default: [] },
  configPaths: { ...array(path, 4), uniqueItems: true, default: [] },
  writerPids: { ...array(integer(1, 2147483647), 8), uniqueItems: true, default: [] },
  maxBytesPerFile: integer(1024, 4194304, 262144), maxFdsPerProcess: integer(1, 1024, 256), timeoutSeconds: integer(1, 120, 30),
  sequenceCheck: sequenceRequest,
}, ["activePaths"]);
const normalizedKeys = ["activePaths", "archivePaths", "configPaths", "writerPids", "maxBytesPerFile", "maxFdsPerProcess", "timeoutSeconds"];
const fileMetadata = object({ device: digits, inode: digits, sizeBytes: integer(), mode: { type: "string", pattern: fullSchemaPattern("[0-7]{4}") },
  uid: integer(0, 4294967295), gid: integer(0, 4294967295), mtimeNs: { type: "string", pattern: fullSchemaPattern("-?[0-9]+"), maxLength: 32 }, ctimeNs: { type: "string", pattern: fullSchemaPattern("-?[0-9]+"), maxLength: 32 } });
const file = object({ path, role: state("active", "archive"), status: state("complete", "partial", "missing", "unsupported", "permission_denied", "changed", "limit_exceeded", "error"),
  kind: state("regular", "symlink", "directory", "other", "missing", "unknown"), compression: state("none", "gzip", "unavailable"),
  compressionValid: { type: ["boolean", "null"] }, readBytes: integer(), expandedBytes: integer(), lineCount: integer(), partialLastLine: flag,
  sampledAt: text, finishedAt: text, consistency: state("unverified", "prefix_rechecked", "metadata_rechecked"), reason: text,
  metadata: fileMetadata, appendObserved: flag, rawSha256: sha, contentSha256: sha,
}, ["path", "role", "status", "kind", "compression", "compressionValid", "readBytes", "expandedBytes", "lineCount", "partialLastLine", "sampledAt", "finishedAt", "consistency", "reason"]);
const directive = object({ name: text, value: text });
const script = object({ phase: state("postrotate", "prerotate", "firstaction", "lastaction", "preremove"), sha256: sha });
const config = object({ path, status: state("complete", "partial"), reason: text, sha256: sha,
  blocks: array(object({ targets: { ...array(path, 16), minItems: 1 }, directives: array(directive, 64), scripts: array(script, 16) }), 16),
  globalDirectives: array(directive, 64), includes: array(text, 16), scripts: array(script, 16), unparsedCount: integer(),
}, ["path", "status", "reason", "blocks", "globalDirectives", "includes", "scripts", "unparsedCount"]);
const writer = object({ pid: integer(1, 2147483647), status: state("complete", "unknown"), reason: text, scannedFds: integer(0, 1024), startTicks: digits, process: text,
  descriptors: array(object({ fd: integer(0, 2147483647), path, device: digits, inode: digits, append: flag }), 1024),
}, ["pid", "status", "reason", "scannedFds", "descriptors"]);
const sequence = object({ field: sequenceField, first: integer(), last: integer(), expectedCount: integer(1, 100000), observedUnique: integer(0, 100000),
  parsedRecords: integer(0, 100000), missingCount: integer(0, 100000), duplicateCount: integer(0, 100000), invalidRecords: integer(0, 100024),
  unscannedPaths: { ...array(path, 24), uniqueItems: true }, coverageComplete: flag, status: state("complete", "mismatch", "partial"),
  sampling: { const: "independent_file_prefixes" }, scope: { const: "requested_sequence_window" },
});
export const logRotationOutputSchema = object({
  request: { ...logRotationInputSchema, required: normalizedKeys }, status: state("complete", "partial", "timeout", "cancelled", "unsupported"), coverageComplete: flag,
  files: array(file, 24), configs: array(config, 4), writers: array(writer, 8), sequence: { anyOf: [sequence, { type: "null" }] },
  sampledAt: { type: ["string", "null"] }, finishedAt: { type: ["string", "null"] }, elapsedMs: integer(),
  limitations: { ...array({ type: "string", enum: logRotationLimitations }, 7), minItems: 7, uniqueItems: true }, observationsRedacted: flag,
  incompleteReason: { const: "output_limit" },
}, ["request", "status", "coverageComplete", "files", "configs", "writers", "sequence", "sampledAt", "finishedAt", "elapsedMs", "limitations"]);

export interface LogRotationRequest {
  activePaths: string[]; archivePaths: string[]; configPaths: string[]; writerPids: number[];
  maxBytesPerFile: number; maxFdsPerProcess: number; timeoutSeconds: number;
  sequenceCheck?: { field: string; first: number; last: number };
}
export interface LogRotationResult {
  request: LogRotationRequest; status: string; coverageComplete: boolean;
  files: Array<Record<string, any>>; configs: Array<Record<string, any>>; writers: Array<Record<string, any>>;
  sequence: Record<string, any> | null; sampledAt: string | null; finishedAt: string | null; elapsedMs: number;
  limitations: string[]; observationsRedacted?: boolean; incompleteReason?: "output_limit";
}
export const logRotationTool: ToolDefinition = {
  id: "logs.inspect_rotation", implementation: "inspectLogRotation", effect: "read", name: "日志轮转证据采集",
  description: "一次只读采集明确日志/压缩产物的身份和有限摘要、指定PID的可写描述符、轮转配置声明；可检查明确JSONL序号窗口，帮助规划与验收。",
  usageInstructions: "先读取应用交接确定日志精确路径、真实写入PID与重开机制；一次提供activePaths、已知archivePaths/configPaths及writerPids，复用已确认的软件版本。没有进程列表时只采已知文件，不能据此宣布无写入者。仅检查指定路径/PID，不展开通配符、不跟随路径链接，不执行logrotate/脚本/信号或修改状态。配置仅声明，不等于有效配置或定时任务。copytruncate存在复制后截断的丢记录窗口，不能承诺无损；SIGHUP支持必须来自应用证据，fd可写不证明支持重开。序号检查仅用于确实具有单调唯一整数JSON字段的日志及明确起止范围；文件、解压字节、单行65536字节、总记录100000条均有上限，变化/截断/错误是partial，不能当成丢记录或完整无损证据。即使sequence完整也只证明所列文件独立采样前缀内的请求窗口，持续写入/每日调度/七天保留仍须独立验证。轮转变更通过现有授权通道执行，产生真实产物后才验收。",
  inputSchema: logRotationInputSchema, outputSchema: logRotationOutputSchema,
  outputDescription: "返回请求绑定、文件身份/摘要/压缩完整性、PID startTicks及可写fd关联、配置声明与脚本摘要、有限序号窗口缺失/重复统计和覆盖限制；不返回原始日志正文。",
  planMode: "read_batch", completionMode: "refine", refinementScope: "active-skill", executionMode: "local", enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z",
};

export function normalizeLogRotationRequest(value: Record<string, unknown>): LogRotationRequest {
  const request = fillToolDefaults(logRotationInputSchema, value) as LogRotationRequest;
  validateSchemaValue(logRotationInputSchema, request, "日志轮转参数", "");
  const paths = [...request.activePaths, ...request.archivePaths, ...request.configPaths];
  if (new Set(paths).size !== paths.length || paths.some(value => value.slice(1).split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error("日志检查需要互不重复的精确绝对路径，不能含空路径段或点段");
  }
  if (request.sequenceCheck && (request.sequenceCheck.last < request.sequenceCheck.first || request.sequenceCheck.last - request.sequenceCheck.first >= 100000)) throw new Error("序号窗口必须有序且最多100000条");
  if (JSON.stringify(request).length > 16384) throw new Error("日志检查参数范围过长");
  return request;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function buildLogRotationCommand(value: Record<string, unknown>): string {
  const request = normalizeLogRotationRequest(value);
  const unsupported = { request, status: "unsupported", coverageComplete: false, files: [], configs: [], writers: [], sequence: null,
    sampledAt: null, finishedAt: null, elapsedMs: 0, limitations: logRotationLimitations };
  return `opsark_log_python=''
for opsark_log_candidate in python3 python; do
  if command -v "$opsark_log_candidate" >/dev/null 2>&1 && "$opsark_log_candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null; then
    opsark_log_python="$opsark_log_candidate"
    break
  fi
done
if [ -n "$opsark_log_python" ]; then
  "$opsark_log_python" -I -B -u -c ${quote(probe)} ${quote(JSON.stringify(request))}
else
  printf '%s\\n' ${quote("OPSARK_LOG_ROTATION " + JSON.stringify(unsupported))}
fi`;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function logRotationResultIssue(args: Record<string, unknown>, data: LogRotationResult): string | undefined {
  const request = normalizeLogRotationRequest(args);
  if (stable(request) !== stable(data.request)) return "日志观测与原请求不一致";
  if ((data.status === "complete") !== data.coverageComplete) return "日志采样状态与覆盖不一致";
  const expectedFiles = [...request.activePaths.map(path => ({ path, role: "active" })), ...request.archivePaths.map(path => ({ path, role: "archive" }))];
  if (data.files.some((file, index) => stable({ path: file.path, role: file.role }) !== stable(expectedFiles[index]))
    || data.configs.some((item, index) => item.path !== request.configPaths[index]) || data.writers.some((item, index) => item.pid !== request.writerPids[index])
    || data.coverageComplete && (data.files.length !== expectedFiles.length || data.configs.length !== request.configPaths.length || data.writers.length !== request.writerPids.length)) return "日志观测对象范围缺失或被替换";
  for (const file of data.files) {
    if (file.readBytes > request.maxBytesPerFile + 1 || file.expandedBytes > request.maxBytesPerFile + 1 || file.lineCount > file.expandedBytes) return "日志采样超过字节或记录上限";
    if (!Number.isFinite(Date.parse(file.sampledAt)) || !Number.isFinite(Date.parse(file.finishedAt))) return "日志采样缺少时间";
    if (file.status === "complete" && (file.kind !== "regular" || !file.metadata || file.readBytes !== file.metadata.sizeBytes || !file.rawSha256 || !file.contentSha256
      || file.readBytes > request.maxBytesPerFile || file.expandedBytes > request.maxBytesPerFile || file.lineCount > 100000 || file.partialLastLine
      || file.consistency !== (file.role === "active" ? "prefix_rechecked" : "metadata_rechecked")
      || file.compression === "unavailable" || file.compression === "gzip" && file.compressionValid !== true
      || file.compression === "none" && (file.compressionValid !== null || file.expandedBytes !== file.readBytes || file.rawSha256 !== file.contentSha256))) return "日志内容或压缩覆盖缺少真实证据";
  }
  for (const writer of data.writers) {
    if (writer.scannedFds > request.maxFdsPerProcess || writer.descriptors.length > writer.scannedFds || new Set(writer.descriptors.map((fd: any) => fd.fd)).size !== writer.descriptors.length
      || writer.status === "complete" && (!writer.startTicks || writer.process === undefined)
      || writer.descriptors.some((fd: any) => !data.files.some(file => file.path === fd.path && file.metadata?.device === fd.device && file.metadata?.inode === fd.inode))) return "写入进程或描述符身份不一致";
  }
  if (data.configs.some(item => item.status === "complete" && (!item.sha256 || item.unparsedCount || item.includes.length))) return "配置声明仍有未解析范围";
  const s = data.sequence, spec = request.sequenceCheck;
  if (s && (!spec || s.field !== spec.field || s.first !== spec.first || s.last !== spec.last || s.expectedCount !== spec.last - spec.first + 1
    || s.observedUnique + s.missingCount !== s.expectedCount || s.observedUnique + s.duplicateCount > s.parsedRecords
    || s.unscannedPaths.some((path: string) => !expectedFiles.some(file => file.path === path))
    || s.coverageComplete && (s.invalidRecords || s.unscannedPaths.length || data.files.length !== expectedFiles.length || data.files.some(file => file.status !== "complete" || file.partialLastLine)
      || s.parsedRecords !== data.files.reduce((count, file) => count + file.lineCount, 0))
    || s.status !== (s.coverageComplete ? s.missingCount || s.duplicateCount ? "mismatch" : "complete" : "partial"))) return "序号窗口或覆盖声明不一致";
  if (data.coverageComplete && (data.files.some(file => file.status !== "complete") || data.configs.some(item => item.status !== "complete")
    || data.writers.some(item => item.status !== "complete") || spec && (!s || !s.coverageComplete))) return "未完整观测不能宣称全覆盖";
  if (data.incompleteReason && (data.status !== "partial" || data.coverageComplete || data.files.length || data.configs.length || data.writers.length || data.sequence)) return "输出超限回执不能保留伪造完整证据";
  if (data.status !== "unsupported" && (!data.sampledAt || !data.finishedAt || !Number.isFinite(Date.parse(data.sampledAt)) || !Number.isFinite(Date.parse(data.finishedAt)))) return "日志采样缺少总时间";
  return undefined;
}

export function parseLogRotationOutput(args: Record<string, unknown>, output: string): LogRotationResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_LOG_ROTATION "));
  if (lines.length !== 1 || lines[0].length > 131100) throw new Error("日志轮转检查没有唯一有界回执");
  const data = JSON.parse(lines[0].slice("OPSARK_LOG_ROTATION ".length)) as LogRotationResult;
  validateSchemaValue(logRotationOutputSchema, data, "日志轮转回执", "");
  if (data.observationsRedacted !== undefined) throw new Error("远端不能声明Core脱敏标记");
  const issue = logRotationResultIssue(args, data);
  if (issue) throw new Error(issue);
  return data;
}

export function redactLogRotationObservations(data: LogRotationResult, redact: (value: string) => string) {
  let changed = false;
  const update = (object: Record<string, any>, key: string) => {
    if (typeof object[key] !== "string") return;
    const value = redact(object[key]);
    if (value !== object[key]) { object[key] = value; changed = true; }
  };
  for (const writer of data.writers) update(writer, "process");
  for (const config of data.configs) {
    for (const directive of [...config.globalDirectives, ...config.blocks.flatMap((block: any) => block.directives)]) update(directive, "value");
    config.includes = config.includes.map((value: string) => { const result = redact(value); changed ||= result !== value; return result; });
    for (const block of config.blocks) block.targets = block.targets.map((value: string) => { const result = redact(value); changed ||= result !== value; return result; });
  }
  if (changed) data.observationsRedacted = true;
  return data;
}

export function logRotationEvidenceFacts(data: LogRotationResult) {
  return { evidenceKind: "log_rotation", evidenceComplete: data.coverageComplete && data.observationsRedacted !== true,
    logPaths: data.request.activePaths, archivePaths: data.request.archivePaths, configPaths: data.request.configPaths,
    writerPids: data.request.writerPids, sequenceStatus: data.sequence?.status ?? "not_requested",
    sequenceCoverageComplete: data.sequence?.coverageComplete === true && data.observationsRedacted !== true,
    sampleFinishedAt: data.finishedAt, limitations: data.limitations,
    rotationPerformed: false, scheduleVerified: false, uninterruptedWritingVerified: false };
}
