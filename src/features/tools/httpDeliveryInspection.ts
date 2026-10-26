import probe from "./http_delivery_probe.py?raw";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { sha256Utf8 } from "../agent/planPreparation";
import { httpDeliveryBindingSchema, httpDeliveryInputSchema, httpDeliveryLimitations, httpDeliveryOutputSchema,
  type HttpDeliveryBinding, type HttpDeliveryRequest, type HttpDeliveryResult } from "./httpDeliveryContracts";
export * from "./httpDeliveryContracts";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
function address(value: string) {
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)
    && value.split(".").every(part => Number(part) <= 255)) return new URL(`http://${value}`).hostname;
  if (!value.includes(":") || !/^[0-9a-fA-F:]+$/.test(value)) throw new Error("连接地址必须是单一 IPv4 或 IPv6，不含端口或区域标识");
  try { return new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { throw new Error("IPv6 连接地址无效"); }
}
function cleanTarget(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || /[^\x21-\x7e]|[\\#]/.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) throw new Error("请求路径必须是保留原编码的单一 origin-form 路径及查询");
}
function inject(target: string, name: string, probeId: string) {
  const query = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
  if (query.split("&").some(part => decodeURIComponent(part.split("=")[0].split("+").join(" ")) === name)) throw new Error("不能覆盖已有探测参数");
  return `${target}${target.includes("?") ? "&" : "?"}${name}=${probeId}`;
}
export function httpDeliveryTarget(request: HttpDeliveryRequest, binding: HttpDeliveryBinding) {
  const match = /^(https?):\/\/([^/?#]+)(.*)$/.exec(request.url);
  if (!match || /[^\x21-\x7e]|[\\#]/.test(request.url) || /%(?![0-9a-fA-F]{2})/.test(request.url) || /[@%]/.test(match[2])) throw new Error("URL 不能含凭据、片段、空白或模糊编码");
  const authority = match[2].toLowerCase();
  const components = /^(\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(authority);
  if (!components) throw new Error("URL authority 无效");
  const host = components[1].startsWith("[") ? components[1].slice(1, -1) : components[1];
  if (host.includes(":")) address(host);
  else if (host.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error("URL hostname 无效");
  if (/^[0-9.]+$/.test(host)) address(host);
  // Reject URL-parser aliases such as hexadecimal/short IPv4, while preserving
  // the original path/query instead of URL.pathname's dot-segment rewriting.
  const parsed = new URL(request.url);
  if (!host.includes(":") && parsed.hostname.toLowerCase() !== host) throw new Error("不接受非规范化主机别名");
  const port = components[2] ? Number(components[2]) : match[1] === "https" ? 443 : 80;
  if (port > 65535 || host.length > 255) throw new Error("URL 端口或主机长度无效");
  let requestTarget = match[3] || "/";
  if (requestTarget.startsWith("?")) requestTarget = "/" + requestTarget;
  cleanTarget(requestTarget);
  if (request.backendObservation?.injection.kind === "query") requestTarget = inject(requestTarget, request.backendObservation.injection.name, binding.probeId);
  return { scheme: match[1], hostname: host, authority, port, connectAddress: request.connectAddress ?? host,
    requestTarget, method: "GET", tlsVerified: false };
}

export function normalizeHttpDeliveryRequest(value: Record<string, unknown>): HttpDeliveryRequest {
  const request = fillToolDefaults(httpDeliveryInputSchema, value) as HttpDeliveryRequest;
  validateSchemaValue(httpDeliveryInputSchema, request, "HTTP 交付参数", "");
  if (request.connectAddress) address(request.connectAddress);
  const spec = request.backendObservation;
  if (spec) {
    if (spec.path.slice(1).split("/").some(part => !part || part === "." || part === "..")) throw new Error("日志必须是精确绝对路径");
    cleanTarget(spec.expectedRequestTarget);
    if ([spec.probeIdPointer, spec.requestTargetPointer, ...(spec.authorityPointer ? [spec.authorityPointer] : [])].some(pointer => pointer.slice(1).split("/").length > 8)) throw new Error("日志字段映射深度最多 8 层");
    if (spec.injection.kind === "header" && !["x-request-id", "x-correlation-id", "x-opsark-probe-id"].includes(spec.injection.name.toLowerCase())) throw new Error("仅支持固定的请求关联头，不允许覆盖路由或认证头");
    if (spec.injection.kind === "query") inject(spec.expectedRequestTarget, spec.injection.name, "probe");
    if (spec.expectedAuthority && /[^\x21-\x7e]|[\\/#@]/.test(spec.expectedAuthority)) throw new Error("日志预期 authority 无效");
    if (spec.windowMs >= request.timeoutSeconds * 1000) throw new Error("后端观察窗口须小于总请求截止，保留连接及请求时间");
  }
  httpDeliveryTarget(request, { executionId: "validation", probeId: "probe", requestDigest: "" });
  if (new TextEncoder().encode(canonical(request)).length > 16384) throw new Error("HTTP 参数总字节超限");
  return request;
}

/** Call only inside the recorded dispatch callback, after execution identity is
 * assigned. The public model schema has no binding/probe/token fields. */
export async function createHttpDeliveryBinding(executionId: string, args: Record<string, unknown>): Promise<HttpDeliveryBinding> {
  const request = normalizeHttpDeliveryRequest(args);
  const binding = { executionId, probeId: "opsark-" + crypto.randomUUID(), requestDigest: sha256Utf8(canonical(request)) };
  validateSchemaValue(httpDeliveryBindingSchema, binding, "Core 私有 HTTP 绑定", "");
  return binding;
}

export function buildHttpDeliveryCommand(args: Record<string, unknown>, binding: HttpDeliveryBinding): string {
  const request = normalizeHttpDeliveryRequest(args);
  validateSchemaValue(httpDeliveryBindingSchema, binding, "Core 私有 HTTP 绑定", "");
  if (binding.requestDigest !== sha256Utf8(canonical(request))) throw new Error("私有 HTTP 绑定不属于当前规范化请求");
  const unsupported = { request, binding, target: httpDeliveryTarget(request, binding), response: null, correlation: null, status: "unsupported",
    coverageComplete: false, sampledAt: null, finishedAt: null, elapsedMs: 0, reason: "python_posix_unavailable", limitations: httpDeliveryLimitations };
  return `opsark_http_python=''
for opsark_http_candidate in python3 python; do
  if command -v "$opsark_http_candidate" >/dev/null 2>&1 && "$opsark_http_candidate" -c 'import sys, os; sys.exit(0 if sys.version_info >= (3, 8) and os.name == "posix" else 1)' 2>/dev/null; then
    opsark_http_python="$opsark_http_candidate"
    break
  fi
done
if [ -n "$opsark_http_python" ]; then
  "$opsark_http_python" -I -B -u -c ${quote(probe)} ${quote(JSON.stringify({ request, binding }))}
else
  printf '%s\\n' ${quote("OPSARK_HTTP_DELIVERY " + JSON.stringify(unsupported))}
fi`;
}

export function httpDeliveryResultIssue(args: Record<string, unknown>, data: HttpDeliveryResult, binding?: HttpDeliveryBinding): string | undefined {
  const request = normalizeHttpDeliveryRequest(args);
  if (canonical(request) !== canonical(data.request)) return "HTTP 结果与原请求不一致";
  if (data.binding.requestDigest !== sha256Utf8(canonical(request))) return "HTTP 请求摘要与原参数不一致";
  if (binding && canonical(binding) !== canonical(data.binding)) return "HTTP 原执行或私有探测绑定不一致";
  const target = httpDeliveryTarget(request, data.binding);
  if (Object.entries(target).some(([key, value]) => key !== "tlsVerified" && data.target[key] !== value)) return "HTTP 目标或 authority 被替换";
  if (data.target.tlsVerified && (target.scheme !== "https" || data.target.tlsServerName !== target.hostname)
    || data.response && target.scheme === "https" && (!data.target.tlsVerified || data.target.tlsServerName !== target.hostname)) return "HTTPS 响应缺少原主机证书验证";
  if (data.response && (!data.target.peerAddress || data.target.peerPort !== target.port)) return "HTTP 响应缺少实际连接身份";
  if (request.connectAddress && data.target.peerAddress && address(request.connectAddress) !== address(data.target.peerAddress)) return "实际连接与指定 IP 不一致";
  const response = data.response;
  if (response) {
    const b = response.body;
    if (b.mode !== request.bodyMode || b.readBytes > request.maxBodyBytes + 1 || b.sha256 && (!b.complete || !b.eof || b.encoding !== "identity")
      || b.mode === "none" && (b.readBytes || b.eof || b.sha256 || b.text !== undefined || b.encoding !== "not_requested" || !b.complete)
      || b.mode !== "none" && b.complete && (!b.eof || b.readBytes > request.maxBodyBytes || b.encoding !== "identity" || !b.sha256)
      || b.mode === "utf8" && b.complete && (typeof b.text !== "string" || !b.textRedacted && new TextEncoder().encode(b.text).length !== b.readBytes)
      || b.mode === "utf8" && b.complete && !b.textRedacted && b.sha256 !== sha256Utf8(b.text)
      || b.mode === "sha256" && b.text !== undefined || response.status === "complete" !== b.complete) return "HTTP 正文完整性或摘要依据不一致";
    if (b.complete && b.mode !== "none" && response.headers["content-encoding"] && response.headers["content-encoding"].trim().toLowerCase() !== "identity") return "编码实体不能冒充原始资源";
  }
  const correlation = data.correlation, spec = request.backendObservation;
  if (correlation) {
    if (!spec || correlation.path !== spec.path || correlation.probeId !== data.binding.probeId || correlation.windowMs !== spec.windowMs
      || correlation.expectedRequestTarget !== (spec.injection.kind === "query" ? inject(spec.expectedRequestTarget, spec.injection.name, data.binding.probeId) : spec.expectedRequestTarget)) return "后端窗口与原请求映射不一致";
    if (correlation.sourceVerified !== false || correlation.readBytes > spec.maxLogBytes || correlation.matchedCount !== correlation.matchedOffsets.length
      || correlation.matchedCount > correlation.parsedRecords || correlation.matchedOffsets.some((offset: number) => offset < correlation.startOffset || offset >= correlation.endOffset)
      || correlation.coverageComplete && (correlation.status === "unknown" || correlation.observedMs < spec.windowMs || !correlation.device || !correlation.inode
        || correlation.startOffset === undefined || correlation.endOffset - correlation.startOffset !== correlation.readBytes
        || correlation.status !== (correlation.matchedCount === 1 ? "matched" : correlation.matchedCount === 0 ? "not_observed" : "unknown"))
      || !correlation.coverageComplete && correlation.status !== "unknown") return "日志窗口覆盖或匹配依据不一致";
  }
  if (data.coverageComplete !== (data.status === "complete") || data.coverageComplete && (!response || response.status !== "complete" || spec && !correlation?.coverageComplete)) return "HTTP 请求范围未完整采集";
  if (data.status === "unsupported" && (response || correlation || data.coverageComplete)) return "不支持回执不能包含完成证据";
  if (data.status !== "unsupported" && (!data.sampledAt || !data.finishedAt || !Number.isFinite(Date.parse(data.sampledAt)) || !Number.isFinite(Date.parse(data.finishedAt)) || Date.parse(data.finishedAt) < Date.parse(data.sampledAt))) return "HTTP 采样时间无效";
  return undefined;
}

export function parseHttpDeliveryOutput(args: Record<string, unknown>, output: string, binding: HttpDeliveryBinding): HttpDeliveryResult {
  if (new TextEncoder().encode(output).length > 262144) throw new Error("HTTP 回执超过 256KiB");
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith("OPSARK_HTTP_DELIVERY ")) throw new Error("HTTP 检查没有唯一有界回执");
  const data = JSON.parse(lines[0].slice("OPSARK_HTTP_DELIVERY ".length)) as HttpDeliveryResult;
  validateSchemaValue(httpDeliveryOutputSchema, data, "HTTP 交付回执", "");
  if (data.observationsRedacted !== undefined || data.response?.body.textRedacted !== undefined) throw new Error("远端不能声明 Core 脱敏标记");
  const issue = httpDeliveryResultIssue(args, data, binding);
  if (issue) throw new Error(issue);
  return data;
}

export function redactHttpDeliveryObservations(data: HttpDeliveryResult, redact: (value: string) => string) {
  if (data.response) {
    for (const [key, value] of Object.entries(data.response.headers)) {
      const sanitized = redact(String(value));
      if (value !== sanitized) { data.response.headers[key] = sanitized; data.observationsRedacted = true; }
    }
    const b = data.response.body;
    if (typeof b.text === "string") {
      const sanitized = redact(b.text);
      if (sanitized !== b.text) { b.text = sanitized; b.textRedacted = true; data.observationsRedacted = true; }
    }
  }
  return data;
}

export function httpDeliveryEvidenceFacts(data: HttpDeliveryResult) {
  return { evidenceKind: "http_delivery", evidenceComplete: data.coverageComplete && !data.observationsRedacted,
    inspectionStatus: data.status, evidenceScope: "single_get_and_declared_local_log_window",
    url: data.request.url, authority: data.target.authority, connectAddress: data.target.connectAddress,
    httpStatus: data.response?.httpStatus, resourceSha256: data.response?.body.complete ? data.response.body.sha256 : undefined,
    bodyComplete: data.response?.body.complete === true, backendWindowStatus: data.correlation?.status ?? "not_requested",
    backendSourceVerified: false, sampleFinishedAt: data.finishedAt, limitations: data.limitations };
}
