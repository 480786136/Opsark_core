/** Native probe facts only. They describe collector capabilities, never business health. */
export const HOST_CAPABILITY_NAMES = [
  "python.runtime", "python.json", "posix.fd_scan", "systemctl", "systemctl.show.properties",
  "journalctl", "ss", "netstat", "curl", "jq",
] as const;
export type HostCapabilityName = typeof HOST_CAPABILITY_NAMES[number];
export interface HostCapabilityFact {
  name: HostCapabilityName;
  supported: boolean | null;
  version?: string;
  executable?: string;
}
export interface OperationsCapabilities {
  version: 1;
  observedAt: string | null;
  facts: HostCapabilityFact[];
}
export interface HostCapabilityIdentity {
  serverId: string;
  host: string;
  port: number;
  username: string;
  connectionGeneration: number;
}
export interface HostCapabilitySnapshot {
  identity: HostCapabilityIdentity;
  source: { kind: "native_operations_probe"; toolCallId: string; evidenceId?: string };
  observedAt: string | null;
  collectedAt: string;
  expiresAt: string;
  facts: HostCapabilityFact[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseOperationsCapabilities(output: string): OperationsCapabilities | undefined {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_CAPABILITIES "));
  if (!lines.length) return; // Older native collectors did not return capability facts.
  if (lines.length !== 1 || lines[0].length > 8192) throw new Error("主机能力没有返回唯一有界结果");
  const data: unknown = JSON.parse(lines[0].slice("OPSARK_CAPABILITIES ".length));
  if (!record(data) || data.version !== 1 || !Array.isArray(data.facts) || data.facts.length > HOST_CAPABILITY_NAMES.length
    || !(data.observedAt === null || typeof data.observedAt === "string" && Number.isFinite(Date.parse(data.observedAt)))) {
    throw new Error("主机能力结果格式无效");
  }
  const seen = new Set<string>();
  for (const fact of data.facts) {
    if (!record(fact) || !HOST_CAPABILITY_NAMES.includes(fact.name as HostCapabilityName)
      || seen.has(String(fact.name)) || !(fact.supported === null || typeof fact.supported === "boolean")
      || Object.keys(fact).some(key => !["name", "supported", "version", "executable"].includes(key))
      || fact.version !== undefined && (typeof fact.version !== "string" || !/^[A-Za-z0-9._+ -]{1,128}$/.test(fact.version))
      || fact.executable !== undefined && (typeof fact.executable !== "string" || fact.executable.length > 4096 || /[\u0000-\u001f\u007f]/.test(fact.executable))) {
      throw new Error("主机能力包含无效或重复事实");
    }
    seen.add(String(fact.name));
  }
  return structuredClone(data as unknown as OperationsCapabilities);
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const snapshots = new Map<string, HostCapabilitySnapshot>();
const epochs = new Map<string, number>();
export function hostCapabilityEpoch(serverId: string) { return epochs.get(serverId) ?? 0; }
function identityKey(identity: HostCapabilityIdentity) {
  if (!identity.serverId || !identity.host || !identity.username || !Number.isInteger(identity.port)
    || identity.port < 1 || identity.port > 65535 || !Number.isInteger(identity.connectionGeneration)
    || identity.connectionGeneration < 0) throw new Error("主机能力缺少有效的实际连接身份");
  return JSON.stringify([identity.serverId, identity.host, identity.port, identity.username, identity.connectionGeneration]);
}

export function recordHostCapabilities(
  identity: HostCapabilityIdentity,
  capabilities: OperationsCapabilities,
  source: { toolCallId: string; evidenceId?: string; epoch?: number },
  now = Date.now(),
): HostCapabilitySnapshot | undefined {
  if (!source.toolCallId.trim() || !Number.isFinite(now)) throw new Error("主机能力缺少实际采集来源");
  if (source.epoch !== undefined && source.epoch !== hostCapabilityEpoch(identity.serverId)) return;
  // Validate even callers that construct data rather than using the stdout parser.
  const checked = parseOperationsCapabilities("OPSARK_CAPABILITIES " + JSON.stringify(capabilities))!;
  const key = identityKey(identity);
  // A fresh connection replaces the older generation; host changes cannot reuse facts.
  for (const [oldKey, old] of snapshots) if (old.identity.serverId === identity.serverId) snapshots.delete(oldKey);
  const snapshot: HostCapabilitySnapshot = {
    identity: { ...identity }, source: { kind: "native_operations_probe", toolCallId: source.toolCallId, evidenceId: source.evidenceId },
    observedAt: checked.observedAt, collectedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(), facts: checked.facts,
  };
  snapshots.set(key, snapshot);
  return structuredClone(snapshot);
}

export function getHostCapabilities(identity: HostCapabilityIdentity, now = Date.now()): HostCapabilitySnapshot | undefined {
  const key = identityKey(identity), snapshot = snapshots.get(key);
  if (!snapshot) return;
  // TTL uses the controller clock, not an untrusted/out-of-sync remote clock.
  if (!Number.isFinite(now) || now < Date.parse(snapshot.collectedAt) || now >= Date.parse(snapshot.expiresAt)) {
    snapshots.delete(key); return;
  }
  return structuredClone(snapshot);
}

/** Call before any dispatched mutation, and on disconnect/reconnect/target changes. */
export function invalidateHostCapabilities(serverId: string) {
  epochs.set(serverId, hostCapabilityEpoch(serverId) + 1);
  for (const [key, snapshot] of snapshots) if (snapshot.identity.serverId === serverId) snapshots.delete(key);
}

/** Endpoint projection for model contexts; connectionStore invalidates lifecycle transitions. */
export function hostCapabilityContextForServer(server: { id: string; host: string; port: number; username: string }, now = Date.now()) {
  const candidates = [...snapshots.values()].filter(snapshot => snapshot.identity.serverId === server.id
    && snapshot.identity.host === server.host && snapshot.identity.port === server.port
    && snapshot.identity.username === server.username);
  if (candidates.length !== 1) return;
  return hostCapabilityContext(candidates[0].identity, now);
}

export function hostCapabilityContext(identity: HostCapabilityIdentity, now = Date.now()) {
  const snapshot = getHostCapabilities(identity, now);
  if (!snapshot) return;
  const supported = (name: HostCapabilityName) => snapshot.facts.find(fact => fact.name === name)?.supported;
  const alternatives: string[] = [];
  if (supported("systemctl") === true) alternatives.push("服务属性使用systemctl show的key=value格式或services.inspect status；不需要--value。未探测的选项支持状态为未知。");
  if (supported("ss") === false && supported("netstat") === true) alternatives.push("ss不可用，监听端口采集可使用已存在的netstat；services.inspect ports会自动选择该替代。");
  if (supported("jq") === false && supported("python.json") === true) alternatives.push("jq不可用，已验证当前Python标准库json可用；同授权JSON读取选择该解析能力，不重复jq、不安装新依赖。");
  if (supported("python.runtime") === false) alternatives.push("当前没有符合探针要求的Python运行时，探针结果不覆盖业务；仅在已有授权和可用命令得到证实时选择替代，不安装或升级系统Python。");
  return { ...snapshot, alternatives,
    instruction: "这些是实际连接上的本地探针能力事实，不是软件安装完成或业务健康证据。null表示未验证，不能推断支持。安装、升级、卸载、配置变更、连接或身份变化后失效；超时后重新采集。不得把模型声明写作能力事实。" };
}
