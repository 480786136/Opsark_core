import { fullSchemaPattern } from "./toolSchemaPatterns";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = (minimum: number, maximum: number, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const text = { type: "string", maxLength: 4096 };
const array = (items: Record<string, unknown>, maxItems: number) => ({ type: "array", items, maxItems });
const state = (...values: string[]) => ({ type: "string", enum: values });
const nullableBoolean = { type: ["boolean", "null"] };
const names = { type: "string", minLength: 1, maxLength: 128, pattern: fullSchemaPattern("[A-Za-z0-9][A-Za-z0-9+_.:-]*") };
export const packageInspectionInputSchema = object({
  packages: { ...array(names, 8), minItems: 1, uniqueItems: true, description: "明确的软件包名，不接受通配符、选项、URL或Shell表达式；命令名与包名不一定相同。" },
  timeoutSeconds: integer(1, 120, 30),
  waitSeconds: { ...integer(0, 30, 0), description: "默认不等待；只对实际锁或活动事务每秒重采样，最多30秒。未知状态、缺源/版本或权限失败不等待。" },
}, ["packages"]);

export const packageInspectionItemSchema = object({
  kind: { const: "package_environment" }, subject: { const: "server:package-management" },
  family: state("debian", "rpm", "unsupported", "ambiguous"),
  managers: array(object({ name: text, executable: text }), 8),
  packages: array(object({ name: names, installedStatus: state("installed", "absent", "unknown"),
    installedVersions: array(text, 16), candidateStatus: state("available", "not_found", "unknown"),
    candidateSelection: state("apt_policy", "unranked_cache", "none"),
    candidateVersions: array(object({ version: text, architecture: text, source: text }), 32),
  }), 8),
  sourcesStatus: state("complete", "partial", "unavailable"),
  sources: array(object({ id: text, file: text, enabled: nullableBoolean, origins: array(text, 8), signatureCheck: nullableBoolean }), 64),
  locks: array(object({ path: text, state: state("held", "clear", "missing", "unknown"),
    holders: array(object({ pid: integer(-1, 2147483647), mode: state("READ", "WRITE"), kind: state("POSIX", "FLOCK", "OFDLCK"),
      start: text, end: text }), 32),
  }), 8),
  pidFiles: array(object({ path: text, state: state("active", "stale", "missing", "unknown"), pid: integer(1, 2147483647),
    process: text, startTicks: text }, ["path", "state"]), 4),
  packageKit: object({ state: state("idle", "active", "absent", "unknown"), locked: nullableBoolean, transactions: array(text, 64) }),
  decision: state("clear", "blocked", "unknown"),
  transactionCoverageComplete: { type: "boolean" },
  nextAction: state("continue_installation_planning", "wait_or_report", "resolve_evidence_gap"),
  waitOutcome: state("not_requested", "not_needed", "cleared", "exhausted", "not_waited_unknown", "not_waited_incomplete", "sample_timeout"),
  sampleCount: integer(1, 31), waitedMs: integer(0, Number.MAX_SAFE_INTEGER), observedAt: text,
  limitations: { ...array(state("point_in_time", "standard_paths_only", "visible_pid_namespace", "cached_metadata_only", "not_install_authorization"), 5), minItems: 5, uniqueItems: true },
  observationsRedacted: { type: "boolean" },
}, ["kind", "subject", "family", "managers", "packages", "sourcesStatus", "sources", "locks", "pidFiles", "packageKit", "decision", "transactionCoverageComplete", "nextAction", "waitOutcome", "sampleCount", "waitedMs", "observedAt", "limitations"]);

export const packageInspectionDescription = "一次有限只读采集软件包管理能力、已安装版本、本地源配置和缓存候选版本，并按真实锁文件身份及 PackageKit 活动事务判断阻塞；进程存在不等于阻塞。可对已证实动态阻塞有界等待，不安装软件、不刷新缓存、不启停守护进程。";
export const packageInspectionUsage = "软件安装前优先在一次 packages.inspect 中传入明确包名；已有完整且新鲜证据应复用。clear 仅表示采样时在可见的标准锁路径与事务接口没有阻塞，不是安装授权、源可达、签名可信或安装成功。APT候选来自本地policy；RPM缓存版本未排序、不证明最新或可安装。源/版本未知时只解决具体缺口，不能再次拆成进程、fd、D-Bus等重复全量检查。packagekitd驻留、锁文件存在、过期PID文件均不能单独判定活动事务。只有 decision=blocked 才可请求有限等待，unknown或静态失败不能等待；达到上限后报告现有阻塞，不强杀、不删锁、不自动重复等待。实际安装须另走现有变更授权、等待主命令真实退出，再独立验证版本、服务与用户目标；不得静默安装系统Python以运行本探针。";
