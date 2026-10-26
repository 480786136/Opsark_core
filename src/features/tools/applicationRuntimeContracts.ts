import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

export interface ApplicationRuntimeRequest {
  unit: string; listenAddress: string; listenPort: number; releasePath: string; entryPath: string;
  inspectOtherServices: boolean; maxProcesses: number; maxServices: number; maxEntryBytes: number; timeoutSeconds: number;
}
export interface ApplicationRuntimeFileIdentity {
  device: string; inode: string; mode: string; sizeBytes: number; mtimeNs: string; ctimeNs: string;
}
export interface ApplicationRuntimePath {
  path: string; resolvedPath: string; chain: Array<{ path: string; kind: "directory" | "file" | "symlink"; identity: ApplicationRuntimeFileIdentity; linkTarget: string | null }>;
}
export interface ApplicationRuntimeUnit {
  name: string; loadState: string; activeState: string; subState: string; serviceType: string; mainPid: number;
  controlGroup: string; execMainStartTimestampMonotonic: string; invocationId: string;
}
export interface ApplicationRuntimeProcess {
  bootId: string; pid: number; parentPid: number; startTicks: string; executable: string; cwd: string;
  entryBinding: { kind: "python_script" | "gunicorn_module" | "native_executable" | "unknown"; matchedEntryPath: string | null; complete: boolean };
}
export interface ApplicationRuntimeSocket {
  family: "ipv4" | "ipv6"; address: string; port: number; inode: string; holderPids: number[];
}
export interface ApplicationRuntimeSnapshot {
  bootId: string; unit: ApplicationRuntimeUnit; processes: ApplicationRuntimeProcess[]; sockets: ApplicationRuntimeSocket[];
  networkNamespace: string; mountNamespace: string; pidNamespace: string; localAddresses: string[]; coverageComplete: boolean;
}
export interface ApplicationRuntimeServiceIdentity {
  name: string; loadState: string; activeState: string; subState: string; mainPid: number;
  execMainStartTimestampMonotonic: string; invocationId: string;
}
export interface ApplicationRuntimeResult {
  request: ApplicationRuntimeRequest; status: "complete" | "partial" | "timeout" | "unsupported";
  coverageComplete: boolean; runtimeBindingComplete: boolean; unit: ApplicationRuntimeUnit | null;
  before: ApplicationRuntimeSnapshot | null; after: ApplicationRuntimeSnapshot | null;
  entry: { release: ApplicationRuntimePath; entry: ApplicationRuntimePath; diskSha256: string; identity: ApplicationRuntimeFileIdentity; stable: boolean; loadedCodeVerified: false } | null;
  otherServices: { scope: "all_loaded_services"; status: "complete" | "unknown" | "not_requested"; complete: boolean;
    before: ApplicationRuntimeServiceIdentity[]; after: ApplicationRuntimeServiceIdentity[]; stable: boolean; issues: string[] };
  issues: string[]; sampledAt: string | null; finishedAt: string | null; elapsedMs: number;
  consistency: "sampled_non_atomic"; limitations: string[]; observationsRedacted?: boolean;
}

const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", maxLength: 4096 };
const str = (maxLength: number) => ({ type: "string", maxLength });
const en = (...values: string[]) => ({ type: "string", enum: values });
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const bool = { type: "boolean" }, digits = { ...str(32), pattern: fullSchemaPattern("[0-9]+") };
const nullable = (value: unknown) => ({ anyOf: [value, { type: "null" }] });
const list = (items: unknown, maxItems: number) => ({ type: "array", items, maxItems });
const unitName = { ...str(255), pattern: fullSchemaPattern("[A-Za-z0-9_.@:-]+\\.service") };
export const APPLICATION_RUNTIME_OUTPUT_LIMIT = 1048576;
export const APPLICATION_RUNTIME_LIMITATIONS = ["sampled_non_atomic", "single_local_systemd_manager", "single_unambiguous_tcp_listener",
  "declared_entry_disk_hash_not_loaded_code", "process_argv_binding_not_memory_attestation", "no_business_http_probe", "inventory_sample_not_continuity_proof"] as const;
export const applicationRuntimeInputSchema = obj({
  unit: unitName, listenAddress: { ...str(45), minLength: 2 }, listenPort: int(1, 65535),
  releasePath: { ...text, minLength: 1 }, entryPath: { ...text, minLength: 1 },
  inspectOtherServices: { ...bool, default: false }, maxProcesses: int(1, 128, 64), maxServices: int(1, 512, 256),
  maxEntryBytes: int(1, 67108864, 16777216), timeoutSeconds: int(1, 120, 30),
}, ["unit", "listenAddress", "listenPort", "releasePath", "entryPath"]);
const identity = obj({ device: digits, inode: digits, mode: { ...str(4), pattern: fullSchemaPattern("[0-7]{4}") }, sizeBytes: int(),
  mtimeNs: { ...str(32), pattern: fullSchemaPattern("-?[0-9]+") }, ctimeNs: { ...str(32), pattern: fullSchemaPattern("-?[0-9]+") } });
const path = obj({ path: text, resolvedPath: text, chain: list(obj({ path: text, kind: en("directory", "file", "symlink"), identity, linkTarget: nullable(text) }), 256) });
const unitProperties = { name: str(255), loadState: str(64), activeState: str(64), subState: str(64), mainPid: int(0, 4194304), execMainStartTimestampMonotonic: digits, invocationId: str(32) };
const unit = obj({ ...unitProperties, serviceType: str(64), controlGroup: text });
const process = obj({ bootId: str(36), pid: int(1, 4194304), parentPid: int(0, 4194304), startTicks: digits, executable: text, cwd: text,
  entryBinding: obj({ kind: en("python_script", "gunicorn_module", "native_executable", "unknown"), matchedEntryPath: nullable(text), complete: bool }) });
const snapshot = obj({ bootId: str(36), unit, processes: list(process, 128), sockets: list(obj({ family: en("ipv4", "ipv6"), address: str(45), port: int(1, 65535), inode: digits, holderPids: list(int(1, 4194304), 128) }), 128),
  networkNamespace: str(64), mountNamespace: str(64), pidNamespace: str(64), localAddresses: list(str(45), 512), coverageComplete: bool });
export const applicationRuntimeOutputSchema = obj({
  request: { ...applicationRuntimeInputSchema, required: Object.keys(applicationRuntimeInputSchema.properties) },
  status: en("complete", "partial", "timeout", "unsupported"), coverageComplete: bool, runtimeBindingComplete: bool, unit: nullable(unit),
  before: nullable(snapshot), after: nullable(snapshot), entry: nullable(obj({ release: path, entry: path, diskSha256: { ...str(64), pattern: fullSchemaPattern("[a-f0-9]{64}") }, identity, stable: bool, loadedCodeVerified: { const: false } })),
  otherServices: obj({ scope: { const: "all_loaded_services" }, status: en("complete", "unknown", "not_requested"), complete: bool,
    before: list(obj(unitProperties), 512), after: list(obj(unitProperties), 512), stable: bool, issues: list(str(128), 64) }),
  issues: list(str(128), 128), sampledAt: nullable(str(64)), finishedAt: nullable(str(64)), elapsedMs: int(), consistency: { const: "sampled_non_atomic" },
  limitations: { ...list(en(...APPLICATION_RUNTIME_LIMITATIONS), APPLICATION_RUNTIME_LIMITATIONS.length), minItems: APPLICATION_RUNTIME_LIMITATIONS.length, uniqueItems: true },
  observationsRedacted: bool,
}, ["request", "status", "coverageComplete", "runtimeBindingComplete", "unit", "before", "after", "entry", "otherServices", "issues", "sampledAt", "finishedAt", "elapsedMs", "consistency", "limitations"]);

export const applicationRuntimeTool: ToolDefinition = {
  id: "applications.inspect_runtime", implementation: "inspectApplicationRuntime", effect: "read", executionMode: "local", planMode: "read_batch", completionMode: "continue",
  name: "应用受管运行身份检查", description: "只读绑定单一本机systemd服务、稳定主进程和worker、声明TCP入口与发布文件；可独立枚举同管理器全部已加载服务保护基线。",
  usageInstructions: "先从真实交接确定unit、具体本机IP与端口、发布目录和入口精确绝对路径。支持simple/exec及固定Python/Gunicorn入口，进程、namespace、socket所有者或路径变化保持partial。实际通配监听仅在请求IP已证实属于本机时匹配；多个不可分监听不算完整。只读取已声明入口的磁盘SHA，不证明内存代码，也不代替HTTP业务验收或获批激活。inspectOtherServices=true才采全部已加载service，清单独立完整性、启动身份和前后集合必须核对；有限采样不能证明期间从未中断。不会安装、启动、重启、修改文件或回传完整命令行和环境。1MiB完整回执应保存在原证据附件中，模型仅用摘要/引用。",
  inputSchema: applicationRuntimeInputSchema, outputSchema: applicationRuntimeOutputSchema,
  outputDescription: "原请求、systemd身份、前后boot/PID/startTicks/cgroup成员及唯一socket-inode持有者、必要exe/cwd/入口映射、稳定磁盘摘要和路径链；服务全集单独给覆盖状态及限制。",
  enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-13T00:00:00.000Z",
};
