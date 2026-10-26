import probe from "./application_runtime_probe.py?raw";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { APPLICATION_RUNTIME_LIMITATIONS, APPLICATION_RUNTIME_OUTPUT_LIMIT, applicationRuntimeInputSchema, applicationRuntimeOutputSchema,
  type ApplicationRuntimeRequest, type ApplicationRuntimeResult, type ApplicationRuntimePath } from "./applicationRuntimeContracts";
export * from "./applicationRuntimeContracts";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const clean = (value: string) => !/[\u0000-\u001f\u007f]/.test(value) && !Array.from(value).some(c => c.length === 1 && /[\ud800-\udfff]/.test(c));
const exactPath = (value: string) => clean(value) && value.startsWith("/") && (value === "/" || value.slice(1).split("/").every(part => part && part !== "." && part !== ".."));
function ip(value: string): string {
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value) && value.split(".").every(part => Number(part) <= 255)) return value;
  if (!value.includes(":") || !/^[0-9a-fA-F:]+$/.test(value)) throw new Error("监听地址必须是具体本机 IPv4 或 IPv6，不接受主机名、端口和区域标识");
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { throw new Error("监听 IPv6 无效"); }
}
export function normalizeApplicationRuntimeRequest(value: Record<string, unknown> | ApplicationRuntimeRequest): ApplicationRuntimeRequest {
  const request = fillToolDefaults(applicationRuntimeInputSchema, value) as ApplicationRuntimeRequest;
  validateSchemaValue(applicationRuntimeInputSchema, request, "应用运行检查参数", "");
  request.listenAddress = ip(request.listenAddress);
  if (["0.0.0.0", "::"].includes(request.listenAddress) || request.listenAddress.includes(":") && /^ff/i.test(request.listenAddress)
    || !request.listenAddress.includes(":") && Number(request.listenAddress.split(".")[0]) >= 224) throw new Error("监听目标必须是具体单播本机地址");
  if (!exactPath(request.releasePath) || request.releasePath === "/" || !exactPath(request.entryPath)
    || !request.entryPath.startsWith(request.releasePath + "/")) throw new Error("发布目录和入口须为精确绝对路径，入口须位于声明目录内");
  return request;
}

export function buildApplicationRuntimeCommand(value: Record<string, unknown> | ApplicationRuntimeRequest): string {
  const request = normalizeApplicationRuntimeRequest(value);
  const unavailable: ApplicationRuntimeResult = { request, status: "unsupported", coverageComplete: false, runtimeBindingComplete: false, unit: null, before: null, after: null, entry: null,
    otherServices: { scope: "all_loaded_services", status: request.inspectOtherServices ? "unknown" : "not_requested", complete: false, before: [], after: [], stable: false, issues: request.inspectOtherServices ? ["linux_python36_unavailable"] : [] },
    issues: ["linux_python36_unavailable"], sampledAt: null, finishedAt: null, elapsedMs: 0, consistency: "sampled_non_atomic", limitations: [...APPLICATION_RUNTIME_LIMITATIONS] };
  return `opsark_runtime_python=''
for opsark_runtime_candidate in python3 python; do
  if command -v "$opsark_runtime_candidate" >/dev/null 2>&1 && "$opsark_runtime_candidate" -c 'import sys; sys.exit(0 if sys.platform.startswith("linux") and sys.version_info >= (3, 6) else 1)' 2>/dev/null; then
    opsark_runtime_python="$opsark_runtime_candidate"
    break
  fi
done
if [ -n "$opsark_runtime_python" ]; then
  "$opsark_runtime_python" -I -B -u -c ${quote(probe)} ${quote(JSON.stringify(request))}
else
  printf '%s\\n' ${quote("OPSARK_APPLICATION_RUNTIME " + JSON.stringify(unavailable))}
fi`;
}

function pathIssue(path: ApplicationRuntimePath, declared: string) {
  if (path.path !== declared || !exactPath(path.resolvedPath) || !path.chain.length || path.chain[0].path !== "/"
    || path.chain[0].kind !== "directory" || path.chain[path.chain.length - 1]?.path !== path.resolvedPath || path.chain[path.chain.length - 1]?.kind === "symlink") return true;
  return path.chain.some(item => !exactPath(item.path) || item.kind === "symlink" !== (item.linkTarget !== null)
    || item.linkTarget !== null && (!clean(item.linkTarget) || !item.linkTarget));
}

export function applicationRuntimeResultIssue(args: Record<string, unknown> | ApplicationRuntimeRequest, data: ApplicationRuntimeResult): string | undefined {
  const request = normalizeApplicationRuntimeRequest(args);
  try { validateSchemaValue(applicationRuntimeOutputSchema, data, "应用运行回执", ""); } catch { return "应用运行回执结构无效"; }
  if (canonical(request) !== canonical(data.request)) return "运行回执与原请求不一致";
  const entry = data.entry;
  if (entry && (pathIssue(entry.release, request.releasePath) || pathIssue(entry.entry, request.entryPath)
    || entry.release.chain[entry.release.chain.length - 1]?.kind !== "directory" || entry.entry.chain[entry.entry.chain.length - 1]?.kind !== "file"
    || !entry.entry.resolvedPath.startsWith(entry.release.resolvedPath.replace(/\/$/, "") + "/")
    || canonical(entry.identity) !== canonical(entry.entry.chain[entry.entry.chain.length - 1]?.identity) || entry.identity.sizeBytes > request.maxEntryBytes)) return "入口路径链、发布范围或磁盘文件身份无效";
  for (const sample of [data.before, data.after]) {
    if (!sample) continue;
    const unit = sample.unit;
    if (!sample.coverageComplete || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sample.bootId)
      || unit.name !== request.unit || unit.loadState !== "loaded" || unit.activeState !== "active" || unit.subState !== "running"
      || !["simple", "exec"].includes(unit.serviceType) || !exactPath(unit.controlGroup) || unit.controlGroup === "/"
      || !/^[0-9a-f]{32}$/.test(unit.invocationId) || unit.execMainStartTimestampMonotonic === "0"
      || !/^net:\[[0-9]+\]$/.test(sample.networkNamespace) || !/^mnt:\[[0-9]+\]$/.test(sample.mountNamespace) || !/^pid:\[[0-9]+\]$/.test(sample.pidNamespace)) return "运行快照缺少完整主进程、管理器或命名空间身份";
    const pids = new Set(sample.processes.map(process => process.pid));
    if (!pids.size || pids.size !== sample.processes.length || pids.size > request.maxProcesses || !pids.has(unit.mainPid)) return "运行进程集合缺失、重复或超过范围";
    for (const process of sample.processes) {
      if (process.bootId !== sample.bootId || process.startTicks === "0" || !exactPath(process.executable) || !exactPath(process.cwd)
        || process.executable.endsWith(" (deleted)") || process.cwd.endsWith(" (deleted)") || !process.entryBinding.complete
        || process.entryBinding.kind === "unknown" || !entry || process.entryBinding.matchedEntryPath !== entry.entry.resolvedPath) return "进程与声明入口未完整绑定";
    }
    let local: string[];
    try { local = sample.localAddresses.map(ip); } catch { return "本机地址证据无效"; }
    if (!local.includes(request.listenAddress) || new Set(local).size !== local.length) return "请求入口没有具体本机地址依据";
    if (sample.sockets.length !== 1) return "监听 socket 缺失或存在不可区分多重监听";
    const socket = sample.sockets[0];
    let actual: string;
    try { actual = ip(socket.address); } catch { return "监听地址无效"; }
    if (socket.port !== request.listenPort || socket.inode === "0" || socket.family !== (actual.includes(":") ? "ipv6" : "ipv4")
      || actual.includes(":") !== request.listenAddress.includes(":") || actual !== request.listenAddress && actual !== (socket.family === "ipv6" ? "::" : "0.0.0.0")
      || !socket.holderPids.length || socket.holderPids.length !== new Set(socket.holderPids).size || socket.holderPids.some(pid => !pids.has(pid))) return "socket inode、地址、端口与unit持有进程未闭合";
  }
  if (data.unit !== null && (!data.before || canonical(data.unit) !== canonical(data.before.unit))) return "服务身份与首个快照不一致";
  if (data.runtimeBindingComplete && (!data.unit || !data.before || !data.after || !entry?.stable || canonical(data.before) !== canonical(data.after) || data.issues.length || data.observationsRedacted)) return "运行绑定完成缺少稳定的前后完整证据";
  const services = data.otherServices;
  if (!request.inspectOtherServices) {
    if (services.status !== "not_requested" || services.complete || services.stable || services.before.length || services.after.length || services.issues.length) return "未请求服务全集不能返回保护基线";
  } else {
    if (services.status === "not_requested" || services.complete !== (services.status === "complete")
      || services.complete !== services.stable) return "服务全集覆盖状态矛盾";
    for (const rows of [services.before, services.after]) {
      if (rows.length > request.maxServices || new Set(rows.map(row => row.name)).size !== rows.length) return "服务全集成员重复或超限";
      for (const row of rows) {
        if (!row.name.endsWith(".service") || !clean(row.name) || row.loadState !== "loaded"
          || !row.activeState || !row.subState || !/^(?:[a-f0-9]{32})?$/.test(row.invocationId)
          || row.mainPid > 0 && (!row.invocationId || row.execMainStartTimestampMonotonic === "0")) return "服务全集缺少可比较状态或启动身份";
      }
    }
    if (services.complete && (!services.before.length || canonical(services.before) !== canonical(services.after) || services.issues.length || data.observationsRedacted)) return "服务全集完成缺少稳定前后清单";
  }
  if (data.coverageComplete !== (data.status === "complete") || data.coverageComplete !== (data.runtimeBindingComplete && (!request.inspectOtherServices || services.complete))) return "运行与保护范围完整性矛盾";
  if (data.status === "unsupported" && (data.before || data.after || data.unit || entry || data.runtimeBindingComplete || services.before.length || services.after.length || data.sampledAt || data.finishedAt || !data.issues.length)) return "未支持回执不能携带完成采样";
  if (data.status !== "unsupported" && (!data.sampledAt || !data.finishedAt || !Number.isFinite(Date.parse(data.sampledAt)) || !Number.isFinite(Date.parse(data.finishedAt)) || Date.parse(data.finishedAt) < Date.parse(data.sampledAt))) return "运行采样缺少有效时间";
  return undefined;
}

export function parseApplicationRuntimeOutput(args: Record<string, unknown> | ApplicationRuntimeRequest, output: string): ApplicationRuntimeResult {
  if (new TextEncoder().encode(output).length > APPLICATION_RUNTIME_OUTPUT_LIMIT) throw new Error("应用运行回执超过1MiB");
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith("OPSARK_APPLICATION_RUNTIME ")) throw new Error("应用运行检查缺少唯一有界回执");
  const data = JSON.parse(lines[0].slice("OPSARK_APPLICATION_RUNTIME ".length)) as ApplicationRuntimeResult;
  if (data.observationsRedacted !== undefined) throw new Error("远端不能声明Core脱敏标记");
  const issue = applicationRuntimeResultIssue(args, data);
  if (issue) throw new Error(issue);
  return data;
}

export function redactApplicationRuntimeObservations(data: ApplicationRuntimeResult, redact: (value: string) => string): ApplicationRuntimeResult {
  // Identity cannot be rewritten into a different apparently valid target.
  // If an observed path/name needs redaction, remove that evidence projection.
  const changed = (value: unknown) => {
    let sensitive = false;
    JSON.stringify(value, (_key, item) => { if (typeof item === "string" && redact(item) !== item) sensitive = true; return item; });
    return sensitive;
  };
  if (changed({ unit: data.unit, before: data.before, after: data.after, entry: data.entry })) {
    data.unit = null; data.before = null; data.after = null; data.entry = null;
    data.runtimeBindingComplete = false; data.observationsRedacted = true;
    if (!data.issues.includes("observations_redacted")) data.issues.push("observations_redacted");
  }
  if (changed(data.otherServices)) {
    data.otherServices = { scope: "all_loaded_services", status: data.request.inspectOtherServices ? "unknown" : "not_requested", complete: false, before: [], after: [], stable: false,
      issues: data.request.inspectOtherServices ? ["observations_redacted"] : [] };
    data.observationsRedacted = true;
  }
  if (data.observationsRedacted) { data.coverageComplete = false; data.runtimeBindingComplete = false; data.status = "partial"; }
  return data;
}

export function applicationRuntimeEvidenceFacts(data: ApplicationRuntimeResult) {
  return { evidenceKind: "application_runtime", inspectionStatus: data.status, evidenceScope: data.request.unit,
    evidenceComplete: data.coverageComplete && !data.observationsRedacted, runtimeBindingComplete: data.runtimeBindingComplete && !data.observationsRedacted,
    unit: data.request.unit, listenAddress: data.request.listenAddress, listenPort: data.request.listenPort,
    releasePath: data.request.releasePath, entryPath: data.request.entryPath, diskSha256: data.entry?.diskSha256,
    loadedCodeVerified: false, processCount: data.after?.processes.length ?? 0, otherServicesComplete: data.otherServices.complete && !data.observationsRedacted,
    otherServicesScope: data.otherServices.scope, sampleFinishedAt: data.finishedAt, consistency: data.consistency, limitations: data.limitations };
}
