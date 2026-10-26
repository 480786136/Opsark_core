import type { ToolDefinition } from "./types";
import { fullSchemaPattern } from "./toolSchemaPatterns";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback?: number) => ({ type: "integer", minimum, maximum, ...(fallback === undefined ? {} : { default: fallback }) });
const text = (maxLength: number, minLength = 0) => ({ type: "string", minLength, maxLength });
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const flag = { type: "boolean" };
const sha = { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") };
const path = { ...text(4096, 2), pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]+") };
const pointer = { ...text(256, 1), pattern: fullSchemaPattern("/(?:[^~\\u0000-\\u001f\\u007f]|~[01])*") };
export const httpDeliveryLimitations = ["single_get_no_redirect_or_retry", "observer_host_only", "content_encoded_entity_bytes",
  "same_host_declared_log_only", "log_source_not_authenticated", "non_atomic_log_window", "finite_window_not_permanent_absence"];
const backend = {
  ...object({ path, injection: { ...object({ kind: enumeration("query", "header"), name: { ...text(64, 1), pattern: fullSchemaPattern("[A-Za-z][A-Za-z0-9_.-]*") } }),
      allOf: [{ if: { properties: { kind: { const: "header" } } }, then: { properties: { name: enumeration("X-Request-ID", "X-Correlation-ID", "X-Opsark-Probe-ID") } } }] },
    probeIdPointer: pointer, requestTargetPointer: pointer, expectedRequestTarget: { ...text(4096, 1), pattern: "^/" },
    authorityPointer: pointer, expectedAuthority: text(255, 1), windowMs: integer(50, 10000, 250), maxLogBytes: integer(1024, 1048576, 65536),
  }, ["path", "injection", "probeIdPointer", "requestTargetPointer", "expectedRequestTarget"]),
  // Equivalent Draft-07 property dependencies using the strict-output compiler's
  // supported source vocabulary. The relation remains locally enforced after
  // optional-null wire decoding; projection does not relax the business schema.
  allOf: [
    { if: { required: ["authorityPointer"] }, then: { required: ["expectedAuthority"] } },
    { if: { required: ["expectedAuthority"] }, then: { required: ["authorityPointer"] } },
  ],
};
export const httpDeliveryInputSchema = object({
  url: { ...text(4096, 1), pattern: fullSchemaPattern("https?://[^\\s\\\\\\u0000-\\u001f\\u007f]+") },
  connectAddress: text(45, 1), bodyMode: { ...enumeration("none", "sha256", "utf8"), default: "sha256" },
  maxBodyBytes: integer(1, 131072, 65536), timeoutSeconds: integer(1, 60, 15), backendObservation: backend,
}, ["url"]);
export const httpDeliveryBindingSchema = object({ executionId: { ...text(160, 1), pattern: fullSchemaPattern("[A-Za-z0-9_.:-]+") },
  probeId: { type: "string", pattern: fullSchemaPattern("opsark-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}") }, requestDigest: sha });
const body = object({ mode: enumeration("none", "sha256", "utf8"), readBytes: integer(0, 131073), eof: flag, complete: flag,
  encoding: enumeration("not_requested", "identity", "unsupported", "invalid_utf8"), sha256: sha, text: text(131072), textRedacted: flag,
}, ["mode", "readBytes", "eof", "complete", "encoding"]);
const response = object({ httpStatus: integer(100, 599), headers: object({ "content-type": text(1024), "content-encoding": text(1024), "content-length": text(32) }, []),
  body, status: enumeration("complete", "partial"), reason: text(80, 1),
});
const correlation = object({ status: enumeration("matched", "not_observed", "unknown"), reason: text(80, 1), sourceVerified: { const: false },
  path, expectedRequestTarget: text(4200, 1), probeId: httpDeliveryBindingSchema.properties.probeId,
  windowMs: integer(50, 10000), observedMs: integer(0, 60000), coverageComplete: flag, matchedCount: integer(0, 8), parsedRecords: integer(0, 10000),
  startOffset: integer(), endOffset: integer(), readBytes: integer(0, 1048577), device: { ...text(32, 1), pattern: fullSchemaPattern("[0-9]+") },
  inode: { ...text(32, 1), pattern: fullSchemaPattern("[0-9]+") }, matchedOffsets: { type: "array", maxItems: 8, uniqueItems: true, items: integer() },
  consistency: { const: "inode_offset_and_bytes_rechecked" },
}, ["status", "reason", "sourceVerified", "path", "expectedRequestTarget", "probeId", "windowMs", "observedMs", "coverageComplete", "matchedCount", "parsedRecords", "readBytes", "matchedOffsets", "consistency"]);
export const httpDeliveryOutputSchema = object({
  request: { ...httpDeliveryInputSchema, required: ["url", "bodyMode", "maxBodyBytes", "timeoutSeconds"] }, binding: httpDeliveryBindingSchema,
  status: enumeration("complete", "partial", "timeout", "unsupported", "error", "cancelled"), coverageComplete: flag,
  target: object({ scheme: enumeration("http", "https"), hostname: text(255, 1), authority: text(280, 1), port: integer(1, 65535),
    connectAddress: text(255, 1), requestTarget: text(4200, 1), method: { const: "GET" }, tlsVerified: flag,
    tlsServerName: text(255, 1), peerAddress: text(45, 1), peerPort: integer(1, 65535),
  }, ["scheme", "hostname", "authority", "port", "connectAddress", "requestTarget", "method", "tlsVerified"]),
  response: { anyOf: [response, { type: "null" }] }, correlation: { anyOf: [correlation, { type: "null" }] },
  sampledAt: { type: ["string", "null"], maxLength: 40 }, finishedAt: { type: ["string", "null"], maxLength: 40 }, elapsedMs: integer(0, 60001),
  reason: text(80, 1), limitations: { type: "array", minItems: 7, maxItems: 7, uniqueItems: true, items: enumeration(...httpDeliveryLimitations) }, observationsRedacted: flag,
}, ["request", "binding", "status", "coverageComplete", "target", "response", "correlation", "sampledAt", "finishedAt", "elapsedMs", "reason", "limitations"]);

export interface HttpDeliveryRequest {
  url: string; connectAddress?: string; bodyMode: "none" | "sha256" | "utf8"; maxBodyBytes: number; timeoutSeconds: number;
  backendObservation?: { path: string; injection: { kind: "query" | "header"; name: string }; probeIdPointer: string; requestTargetPointer: string;
    expectedRequestTarget: string; authorityPointer?: string; expectedAuthority?: string; windowMs: number; maxLogBytes: number };
}
export interface HttpDeliveryBinding { executionId: string; probeId: string; requestDigest: string }
export interface HttpDeliveryResult {
  request: HttpDeliveryRequest; binding: HttpDeliveryBinding; status: string; coverageComplete: boolean;
  target: Record<string, any>; response: Record<string, any> | null; correlation: Record<string, any> | null;
  sampledAt: string | null; finishedAt: string | null; elapsedMs: number; reason: string; limitations: string[]; observationsRedacted?: boolean;
}
export const httpDeliveryTool: ToolDefinition = {
  id: "http.inspect_delivery", implementation: "inspectHttpDelivery", effect: "read", name: "HTTP 资源与请求到达采集",
  description: "对明确 URL 单次直连 GET，保留 URL Host/TLS 身份并采集有限二进制摘要或 UTF-8 正文；可关联同机明确 JSONL 日志中的本次探测记录。",
  usageInstructions: "先依据真实交接确定 URL、资源和后端日志字段。connectAddress 仅允许单一 IP，端口、Host、HTTPS SNI 和证书身份仍来自 URL，不接受凭据、环境代理、跳转、重试或 TLS 降级。正文默认最多64KiB，上限128KiB；只有读到EOF且编码受支持时返回完整摘要。后端关联只读同机精确 JSONL 路径，先记 inode/offset，再向入口注入 Core 独立生成且绑定执行的探测ID；expectedRequestTarget 必须是交接确认的后端原始路径及查询，含重复参数和原编码。不得模型填写探测ID或复用旧记录。日志路径来源仍需独立交接/服务证据认证；matched仅表示指定日志新增窗口有匹配行，不自动证明后端归属或整体部署成功。partial/unknown及有限未观察到不能冒充未到达或完成。",
  inputSchema: httpDeliveryInputSchema, outputSchema: httpDeliveryOutputSchema,
  outputDescription: "返回执行与请求绑定、实际 authority/peer/TLS、状态码、原始实体字节摘要/正文完整性及有限同机日志窗口匹配；不返回任意日志行或认证头。",
  planMode: "read_batch", completionMode: "refine", refinementScope: "active-skill", executionMode: "local", enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-12T00:00:00.000Z",
};
