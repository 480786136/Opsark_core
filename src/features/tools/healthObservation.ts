import type { ObservationRuntimeRecord } from "@/features/agent/observationRuntime";
import { observationRuntimeRecordValid } from "@/features/agent/observationRuntime";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { fullSchemaPattern } from "./toolSchemaPatterns";
import type { ToolDefinition } from "./types";

export interface HealthObservationRequest {
  url: string;
  windowSeconds: number;
  intervalSeconds: number;
  probeTimeoutSeconds: number;
  expectedStatus: number;
  absoluteDeadlineAt?: string;
}
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const duration = { type: "number", minimum: 0 };
const text = { type: "string", minLength: 1, maxLength: 256 };
const flag = { type: "boolean" };
export const healthObservationInputSchema = object({
  url: { type: "string", minLength: 1, maxLength: 2048, pattern: fullSchemaPattern("https?://[^\\s\\\\\\u0000-\\u001f\\u007f]+") },
  windowSeconds: { ...integer(1, 600), default: 60 },
  intervalSeconds: { ...integer(1, 60), default: 5 },
  probeTimeoutSeconds: { ...integer(1, 30), default: 5 },
  expectedStatus: { ...integer(100, 599), default: 200 },
  absoluteDeadlineAt: { type: "string", pattern: fullSchemaPattern("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})") },
}, ["url"]);

const sample = object({
  index: integer(0, 999), executionId: text,
  status: { type: "string", enum: ["valid", "unsupported", "invalid"] }, matched: flag,
  dispatchedAt: duration, probeStartedAt: duration, startedOffsetMs: duration, receivedAt: duration, late: flag,
  facts: object({ protocol: { const: "curl-status-v1" }, httpStatus: { anyOf: [integer(100, 599), { type: "null" }] },
    curlExitCode: integer(0, 255), remoteExitCode: integer(0, 255), reason: text,
    cancellationRequested: flag, cancellationRequestFailed: flag,
  }, []),
}, ["index", "executionId", "status", "matched", "dispatchedAt", "receivedAt", "late"]);
export const healthObservationOutputSchema = object({
  request: { ...healthObservationInputSchema, required: ["url", "windowSeconds", "intervalSeconds", "probeTimeoutSeconds", "expectedStatus"] },
  observation: object({
    version: { const: 1 },
    binding: object({ taskId: text, roundId: text, workflowEpoch: integer(), stepId: text, executionId: text }, ["taskId", "workflowEpoch", "stepId", "executionId"]),
    policy: object({ windowMs: integer(1000, 600000), intervalMs: integer(1000, 60000), probeTimeoutMs: integer(1000, 30000), absoluteDeadlineAt: integer() }, ["windowMs", "intervalMs", "probeTimeoutMs"]),
    preparationStartedAt: duration, startedAt: duration, firstValidProbeAt: duration, preparationElapsedMs: duration,
    observationElapsedMs: duration, maxSampleGapMs: duration, finishedAt: duration, interruptedAt: duration,
    state: { type: "string", enum: ["preparing", "observing", "matched", "window_elapsed", "absolute_deadline", "cancelled", "unsupported", "invalid", "probe_timeout", "interrupted"] },
    windowSatisfied: flag, samples: { type: "array", maxItems: 1000, items: sample }, persistenceError: text,
  }, ["version", "binding", "policy", "preparationStartedAt", "startedAt", "observationElapsedMs", "state", "windowSatisfied", "samples"]),
});
export interface HealthObservationResult { request: HealthObservationRequest; observation: ObservationRuntimeRecord }

export const healthObservationTool: ToolDefinition = {
  id: "services.observe", implementation: "observeService", effect: "read",
  name: "服务健康窗口观察", description: "以固定HTTP GET在明确时限内观察单个健康地址，区分准备时间、有效探测和到期未就绪。",
  usageInstructions: "用于等待健康接口恢复等只读观察。窗口由执行器从首次有效探测开始计时，不把提交时间加窗口写成绝对截止。只有用户明确要求固定截止时填写absoluteDeadlineAt。默认观察窗口60秒、最短采样间隔5秒、HTTP200即就绪；可按已知接口语义调整expectedStatus。使用远端主机直连，不使用环境代理；读取状态、不读取正文、不跟随跳转，不修改服务。连接失败和非期望HTTP状态是有效未就绪样本；unsupported/协议失败/取消/绝对截止提前结束不能算观察完窗口。windowSatisfied表示观察时长达到窗口且末尾间隔存在有效样本，实际间隙见maxSampleGapMs，不证明连续可用或不可用；需要正文业务断言时继续按原需求验收。",
  inputSchema: healthObservationInputSchema, outputDescription: "返回请求、准备/首次有效探测/结束时间、实际观察时长、原探针执行ID和逐次HTTP/连接结果；取消请求不等于远端退出。",
  planMode: "read_batch", completionMode: "refine", refinementScope: "active-skill", executionMode: "local",
  enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z",
};

export function normalizeHealthObservationRequest(value: Record<string, unknown>): HealthObservationRequest {
  const request = fillToolDefaults(healthObservationInputSchema, value) as HealthObservationRequest;
  validateSchemaValue(healthObservationInputSchema, request, "服务观察参数", "");
  let url: URL;
  try { url = new URL(request.url); } catch { throw new Error("健康地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("健康地址不能包含凭据或片段");
  }
  if (request.intervalSeconds > request.windowSeconds) throw new Error("采样间隔不能超过观察窗口");
  if (request.absoluteDeadlineAt !== undefined && !Number.isFinite(Date.parse(request.absoluteDeadlineAt))) throw new Error("绝对截止时间无效");
  return request;
}

export function healthObservationResultIssue(args: Record<string, unknown>, data: HealthObservationResult, executionId?: string): string | undefined {
  const request = normalizeHealthObservationRequest(args);
  if (Object.keys(request).length !== Object.keys(data.request).length
    || Object.keys(request).some(key => request[key as keyof HealthObservationRequest] !== data.request[key as keyof HealthObservationRequest])) return "健康观察结果与请求不一致";
  const { observation: r } = data;
  if (!observationRuntimeRecordValid(r, r.binding.taskId)
    || executionId !== undefined && r.binding.executionId !== executionId) return "观察归属或持久时间记录不一致";
  if (r.policy.windowMs !== request.windowSeconds * 1000 || r.policy.intervalMs !== request.intervalSeconds * 1000
    || r.policy.probeTimeoutMs !== request.probeTimeoutSeconds * 1000
    || r.policy.absoluteDeadlineAt !== (request.absoluteDeadlineAt === undefined ? undefined : Date.parse(request.absoluteDeadlineAt))) return "观察计时策略不一致";
  const valid = r.samples.filter(item => item.status === "valid" && !item.late);
  if (r.samples.some((item, index) => item.index !== index || (item.status === "valid" && (item.probeStartedAt === undefined
      || item.executionId !== `${r.binding.executionId}-p${index}`
      || item.facts?.protocol !== "curl-status-v1" || item.facts?.remoteExitCode !== 0
      || ![0, 6, 7, 28].includes(Number(item.facts?.curlExitCode))
      || item.facts?.curlExitCode === 0 && (typeof item.facts.httpStatus !== "number" || item.facts.httpStatus < 100 || item.facts.httpStatus > 599)))
    || (item.matched && (item.status !== "valid" || item.facts?.curlExitCode !== 0 || item.facts?.httpStatus !== request.expectedStatus)))) return "观察样本身份或就绪状态不一致";
  if (r.state === "matched" && !valid.some(item => item.matched)) return "没有实际就绪样本";
  if (r.windowSatisfied && (r.state !== "window_elapsed" || r.observationElapsedMs < r.policy.windowMs
    || !valid.length || (valid[valid.length - 1].startedOffsetMs ?? -Infinity) < r.policy.windowMs - r.policy.intervalMs)) return "有效采样未覆盖完整观察窗口";
  if (["preparing", "observing", "interrupted"].includes(r.state) || r.finishedAt === undefined) return "观察尚无明确结束记录";
  return undefined;
}
