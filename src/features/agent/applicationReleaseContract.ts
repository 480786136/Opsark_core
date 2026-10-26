import { validateSchemaValue } from "../tools/toolParameterSchema";
import { fullSchemaPattern } from "../tools/toolSchemaPatterns";

/** A release handover is task data, never permission to run commands. */
export interface ApplicationReleaseIntent {
  operation: "deploy" | "upgrade" | "rollback";
  runtimeKind: "systemd" | "compose" | "unknown";
  projectPath: string | null;
  requestedVersion: string | null;
  preserveConfiguration: boolean;
  preserveCurrentData: boolean;
  retainPreviousRelease: boolean;
  protectOtherServices: boolean;
  requiresBusinessWrite: boolean;
  requiresRecoveryExercise: boolean;
}
export interface ApplicationReleaseHandover {
  version: 1;
  operation: ApplicationReleaseIntent["operation"];
  runtimeKind: "systemd";
  projectPath: string;
  artifact: { path: string; source: "directory" | "tar" | "tar_gzip"; entryPrefix: string };
  releasePath: string;
  entryPath: string;
  unit: string;
  listenAddress: string;
  listenPort: number;
  checks: Array<{ url: string; method: "GET"; effect: "read"; expectedStatus: number;
    equals: Array<{ pointer: string; value: string | number | boolean | null }> }>;
  protection: {
    scopeComplete: true;
    configuration: Array<{ path: string; kind: "file" | "directory" }>;
    data: Array<{ path: string; kind: "file" | "directory" }>;
    dataPolicy: "quiescent_files" | "concurrent" | "migration";
    otherUnits: string[];
    previousReleasePath: string | null;
  };
}
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", minLength: 1, maxLength: 4096 };
const path = { ...text, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f\\\\]*") };
const unit = { type: "string", minLength: 1, maxLength: 255, pattern: fullSchemaPattern("[A-Za-z0-9_.@:-]+\\.service") };
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const protectedPath = object({ path, kind: { enum: ["file", "directory"] } });
export const applicationReleaseHandoverSchema = object({
  version: { const: 1 }, operation: { enum: ["deploy", "upgrade", "rollback"] }, runtimeKind: { const: "systemd" }, projectPath: path,
  artifact: object({ path, source: { enum: ["directory", "tar", "tar_gzip"] }, entryPrefix: { type: "string", maxLength: 4096 } }),
  releasePath: path, entryPath: path, unit,
  listenAddress: text, listenPort: { type: "integer", minimum: 1, maximum: 65535 },
  checks: array(object({ url: text, method: { const: "GET" }, effect: { const: "read" }, expectedStatus: { type: "integer", minimum: 200, maximum: 299 },
    equals: array(object({ pointer: { ...text, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]*") },
      value: { anyOf: [{ type: "string", maxLength: 4096 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } }), 32, 1) }), 16, 1),
  protection: object({ scopeComplete: { const: true }, configuration: array(protectedPath, 32), data: array(protectedPath, 32),
    dataPolicy: { enum: ["quiescent_files", "concurrent", "migration"] }, otherUnits: { ...array(unit, 32), uniqueItems: true },
    previousReleasePath: { anyOf: [path, { type: "null" }] } }),
});
export const releasePathIsCanonical = (value: string) => value.startsWith("/") && value !== "/" && !value.endsWith("/")
  && !value.includes("//") && !/[\\\u0000-\u001f\u007f$*?\[\]]/.test(value) && !value.split("/").some(p => p === "." || p === "..");
export const releasePathOverlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

export function normalizeApplicationReleaseHandover(value: unknown): ApplicationReleaseHandover {
  validateSchemaValue(applicationReleaseHandoverSchema, value, "应用发布交接", "");
  const result = JSON.parse(JSON.stringify(value)) as ApplicationReleaseHandover;
  const paths = [result.projectPath, result.artifact.path, result.releasePath, result.entryPath,
    ...result.protection.configuration.map(p => p.path), ...result.protection.data.map(p => p.path),
    ...(result.protection.previousReleasePath ? [result.protection.previousReleasePath] : [])];
  if (paths.some(p => !releasePathIsCanonical(p))) throw new Error("发布路径必须为规范的精确绝对路径");
  if (!result.entryPath.startsWith(result.releasePath + "/") || !releasePathOverlaps(result.projectPath, result.releasePath)
    || result.releasePath !== result.projectPath && !result.releasePath.startsWith(result.projectPath + "/")) throw new Error("运行入口及发布目录必须属于声明项目");
  if (result.artifact.entryPrefix && (result.artifact.entryPrefix.startsWith("/") || result.artifact.entryPrefix.endsWith("/")
    || !releasePathIsCanonical("/" + result.artifact.entryPrefix))) throw new Error("归档成员前缀必须为规范相对目录");
  const protectedPaths = [...result.protection.configuration, ...result.protection.data];
  if (new Set(protectedPaths.map(p => p.path)).size !== protectedPaths.length
    || protectedPaths.some(p => !p.path.startsWith(result.projectPath + "/") || releasePathOverlaps(p.path, result.entryPath))) throw new Error("配置和数据须完整单列在项目内，不能与程序入口重叠");
  if (result.protection.otherUnits.includes(result.unit)) throw new Error("受保护单元不能同时是操作目标");
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(result.listenAddress)
    || result.listenAddress.split(".").some(n => Number(n) > 255 || n.length > 1 && n.startsWith("0"))) throw new Error("首批仅支持明确IPv4监听");
  const urls = new Set<string>();
  for (const check of result.checks) {
    const u = new URL(check.url);
    if (u.protocol !== "http:" || u.username || u.password || u.hash || u.search || !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
      || Number(u.port || 80) !== result.listenPort || result.listenAddress !== "0.0.0.0" && u.hostname !== result.listenAddress
      || urls.has(u.href) || new Set(check.equals.map(e => e.pointer)).size !== check.equals.length) throw new Error("业务检查必须为声明端口的唯一明确只读HTTP入口");
    urls.add(u.href); check.url = u.href;
    for (const item of check.equals) if (/~(?![01])/.test(item.pointer)) throw new Error("JSON指针转义不合法");
  }
  return result;
}

export function applicationIntentIssue(intent: ApplicationReleaseIntent, contract: ApplicationReleaseHandover): string | undefined {
  if (intent.operation !== contract.operation || intent.runtimeKind !== "unknown" && intent.runtimeKind !== contract.runtimeKind) return "交接操作/运行方式与已冻结用户意图不符";
  if (intent.projectPath && intent.projectPath !== contract.projectPath) return "交接项目与用户声明目标不符";
  if (intent.requestedVersion && !contract.checks.some(c => c.equals.some(p => /\/(?:version|release_version)$/.test(p.pointer) && p.value === intent.requestedVersion))) return "交接没有声明用户要求的目标运行版本";
  if (intent.preserveConfiguration && !contract.protection.configuration.length || intent.preserveCurrentData && !contract.protection.data.length) return "用户要求保配置/数据，但交接未给完整保护范围";
  // protectOtherServices is enforced using the manager's complete inventory;
  // this optional explicit list cannot narrow that protection to a few units.
  if (intent.retainPreviousRelease && !contract.protection.previousReleasePath) return "保留旧版要求缺少完整旧发布目录";
  return undefined;
}
