import type { ToolDefinition } from "./types";
import type { NginxConfigEvidence, NginxConfigTarget } from "../agent/nginxConfigEvidence";
import { validateSchemaValue } from "./toolParameterSchema";
import { fullSchemaPattern } from "./toolSchemaPatterns";
import { nginxLiteralReturn, NGINX_UNSUPPORTED_RETURN_CODES } from "../agent/nginxLiteralReturn";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", maxLength: 4096 };
const nonempty = { ...text, minLength: 1, pattern: fullSchemaPattern("[^\\u0000-\\u001f\\u007f]+") };
const path = { ...nonempty, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]*") };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const array = (items: unknown, maxItems: number) => ({ type: "array", items, maxItems });
const ids = { ...array(nonempty, 256), minItems: 1, uniqueItems: true };
const sha = { type: "string", pattern: fullSchemaPattern("sha256:[a-f0-9]{64}") };
const range = object({ path, startByte: integer(0, 262144), endByte: integer(0, 262144) });
const targetSchema = object({ address: nonempty, port: integer(1, 65535), serverName: text, uriPath: path });
export const nginxConfigInputSchema = object({ entryPath: path, prefix: path, target: targetSchema,
  sourceStepIds: { ...ids, maxItems: 64, description: "仅提交当前任务中已执行文件读取/目录清单的步骤ID；不能提交配置正文或伪造收据。" } });
// Observed unsupported directive spellings remain data in an unknown analysis.
const directive = object({ name: text, args: array(text, 128), source: range });
const location = object({ id: nonempty, modifier: { enum: ["", "=", "^~"] }, path, source: range, directives: array(directive, 4096) });
const header = object({ name: nonempty, value: text, expression: { oneOf: [object({ kind: { const: "literal" } }),
  object({ kind: { const: "nginx_variables" }, variables: { ...array({ enum: ["host", "http_host", "remote_addr", "proxy_add_x_forwarded_for", "scheme"] }, 5), minItems: 1, uniqueItems: true }, runtimeValueKnown: { const: false } })] } });
const terminalResponse = object({ kind: { const: "literal_return" }, statusCode: { ...integer(200, 599), not: { enum: NGINX_UNSUPPORTED_RETURN_CODES } },
  declaredText: { ...text, pattern: fullSchemaPattern("[^$\\u0000]*") }, context: { enum: ["server", "location"] }, source: range, terminatesRequest: { const: true } },
  ["kind", "statusCode", "context", "source", "terminatesRequest"]);
const selected = { ...object({ serverId: nonempty, locationId: nonempty, root: path, alias: path, proxyPass: text,
  proxySetHeaders: array(header, 4096), terminalResponse }, ["serverId", "proxySetHeaders"]),
  allOf: [{ if: { required: ["terminalResponse"] }, then: {
    not: { anyOf: [{ required: ["root"] }, { required: ["alias"] }, { required: ["proxyPass"] }] }, properties: { proxySetHeaders: { type: "array", maxItems: 0 } },
  } }] };
export const nginxConfigAnalysisSchema = object({ version: { const: 1 },
  binding: object({ taskId: nonempty, roundId: nonempty, workflowEpoch: integer(), serverId: nonempty, connectionGeneration: integer() }),
  target: targetSchema, entryPath: path, prefix: path, status: { enum: ["parsed", "unknown"] },
  reasons: array(object({ code: nonempty, source: range }, ["code"]), 129),
  sources: array(object({ path, stepId: nonempty, operationId: nonempty, attemptId: nonempty, executionId: nonempty, contentSha256: sha, bytes: integer(0, 262144), pathIdentity: { const: "requested_path_only" } }), 64),
  includes: array(object({ source: range, requested: text, resolvedPath: path, resolvedPaths: array(path, 4096), covered: { type: "boolean" },
    directoryCoverage: object({ beforeOperationId: nonempty, afterOperationId: nonempty, manifestSha256: { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") } }) }, ["source", "requested", "covered"]), 4096),
  servers: array(object({ id: nonempty, source: range, fingerprint: sha,
    listens: array(object({ address: nonempty, port: integer(1, 65535), defaultServer: { type: "boolean" }, tls: { type: "boolean" }, source: range }), 4096),
    serverNames: array(text, 4096), directives: array(directive, 4096), locations: array(location, 4096) }), 128),
  selected, globalFingerprint: sha, nonTargetFingerprint: sha, configurationLoaded: { const: false }, objectIdentityVerified: { const: false },
  limitations: { ...array({ enum: ["static_declarations_only", "not_nginx_syntax_or_load_acceptance", "requested_paths_not_inode_or_symlink_chain", "independent_reads_not_atomic_snapshot",
    "no_runtime_route_or_backend_delivery_proof", "header_expressions_are_not_observed_runtime_values", "return_text_is_declaration_not_observed_response"] }, 7), minItems: 5, uniqueItems: true },
}, ["version", "binding", "target", "entryPath", "prefix", "status", "reasons", "sources", "includes", "servers", "configurationLoaded", "objectIdentityVerified", "limitations"]);
export const nginxConfigOutputSchema = object({ request: nginxConfigInputSchema, analysis: nginxConfigAnalysisSchema, sourceEvidenceIds: { ...ids, minItems: 0 } });

export interface NginxConfigRequest { entryPath: string; prefix: string; target: NginxConfigTarget; sourceStepIds: string[] }
export interface NginxConfigResult { request: NginxConfigRequest; analysis: NginxConfigEvidence; sourceEvidenceIds: string[] }
const sameTarget = (a: NginxConfigTarget, b: NginxConfigTarget) => a.address === b.address && a.port === b.port && a.serverName === b.serverName && a.uriPath === b.uriPath;
const exactUnicode = (value: string) => new TextDecoder().decode(new TextEncoder().encode(value)) === value;
const canonicalPath = (value: string, allowRoot = false) => exactUnicode(value) && value.startsWith("/") && (allowRoot || value !== "/") && !value.includes("//")
  && !value.split("/").some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f\\$*?\[\]]/.test(value);
export function normalizeNginxConfigRequest(value: Record<string, unknown> | NginxConfigRequest): NginxConfigRequest {
  validateSchemaValue(nginxConfigInputSchema, value, "Nginx配置证据参数", "");
  const request = JSON.parse(JSON.stringify(value)) as NginxConfigRequest;
  if (!canonicalPath(request.entryPath) || !canonicalPath(request.prefix, true)) throw new Error("配置入口和运行prefix必须是明确绝对路径");
  const { address, serverName, uriPath } = request.target;
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split(".").every(part => Number(part) <= 255 && (part.length === 1 || !part.startsWith("0")));
  let ipv6 = false;
  if (/^[a-fA-F0-9:]+$/.test(address) && address.includes(":")) { try { ipv6 = new URL(`http://[${address}]`).hostname.startsWith("["); } catch { /* rejected below */ } }
  if (!ipv4 && !ipv6 || !exactUnicode(serverName) || /[*~$\s/:]/.test(serverName) || !canonicalPath(uriPath, true) || /[%?#\s]/.test(uriPath)) throw new Error("目标需要明确IP、端口、静态Host及已规范化路径");
  return request;
}
export function nginxConfigResultIssue(value: Record<string, unknown> | NginxConfigRequest, result: NginxConfigResult): string | undefined {
  try {
    const request = normalizeNginxConfigRequest(value);
    validateSchemaValue(nginxConfigOutputSchema, result, "Nginx配置证据结果", "");
    const evidence = result.analysis;
    if (evidence.status === "parsed" ? !result.sourceEvidenceIds.length : result.sourceEvidenceIds.length > 0) return "未知分析不能冒充有效底层证据，已解析声明必须关联原始证据";
    if (result.request.entryPath !== request.entryPath || result.request.prefix !== request.prefix || !sameTarget(result.request.target, request.target)
      || result.request.sourceStepIds.length !== request.sourceStepIds.length || result.request.sourceStepIds.some((id, i) => id !== request.sourceStepIds[i])
      || evidence.entryPath !== request.entryPath || evidence.prefix !== request.prefix || !sameTarget(evidence.target, request.target)) return "配置分析与请求身份不一致";
    const sourceByPath = new Map(evidence.sources.map(source => [source.path, source]));
    if (sourceByPath.size !== evidence.sources.length || evidence.sources.some(source => !request.sourceStepIds.includes(source.stepId))) return "配置来源重复或不属于指定步骤";
    const validRange = (range: { path: string; startByte: number; endByte: number }) => {
      const source = sourceByPath.get(range.path); return !!source && range.startByte <= range.endByte && range.endByte <= source.bytes;
    };
    if (evidence.reasons.some(reason => reason.source && !validRange(reason.source)) || evidence.includes.some(include => !validRange(include.source)
      || include.covered && (include.resolvedPath ? !sourceByPath.has(include.resolvedPath) : !include.resolvedPaths || !include.directoryCoverage
        || include.directoryCoverage.beforeOperationId === include.directoryCoverage.afterOperationId || include.resolvedPaths.some(path => !sourceByPath.has(path))))
      || evidence.servers.some(server => !validRange(server.source) || server.directives.some(node => !validRange(node.source)) || server.listens.some(node => !validRange(node.source))
        || server.locations.some(location => !validRange(location.source) || location.directives.some(node => !validRange(node.source))))) return "配置来源字节范围或include覆盖不完整";
    if (evidence.status === "unknown" ? !evidence.reasons.length || evidence.selected !== undefined
      : evidence.reasons.length > 0 || !evidence.selected || !evidence.globalFingerprint || !evidence.nonTargetFingerprint || !sourceByPath.has(request.entryPath) || evidence.includes.some(item => !item.covered)) return "配置未知状态不能伪装完整声明";
    if (evidence.selected) {
      const matches = evidence.servers.filter(server => server.id === evidence.selected!.serverId);
      if (matches.length !== 1 || evidence.selected.locationId && matches[0]!.locations.filter(location => location.id === evidence.selected!.locationId).length !== 1) return "目标配置块缺少唯一来源";
      if (evidence.selected.root && evidence.selected.alias) return "根目录与alias不能同时充当同一目标声明";
      const chosen = evidence.selected, server = matches[0]!;
      const serverReturn = server.directives.find(node => node.name === "return");
      const locationReturn = server.locations.find(item => item.id === chosen.locationId)?.directives.find(node => node.name === "return");
      const node = serverReturn ?? locationReturn, parsedReturn = node && nginxLiteralReturn(node.args);
      const terminal = chosen.terminalResponse;
      if (node ? !parsedReturn || !terminal : terminal !== undefined) return "终止响应与选中配置中的return声明不一致";
      if (terminal && (!node || !parsedReturn || terminal.statusCode !== parsedReturn.statusCode || terminal.declaredText !== parsedReturn.declaredText
        || terminal.context !== (serverReturn ? "server" : "location") || serverReturn && chosen.locationId !== undefined
        || !serverReturn && chosen.locationId === undefined || terminal.source.path !== node.source.path
        || terminal.source.startByte !== node.source.startByte || terminal.source.endByte !== node.source.endByte
        || !validRange(terminal.source) || chosen.proxyPass !== undefined || chosen.root !== undefined || chosen.alias !== undefined || chosen.proxySetHeaders.length
        || !evidence.limitations.includes("return_text_is_declaration_not_observed_response"))) return "return必须终止请求，不能冒充代理或文件交付声明";
    }
    const required = ["static_declarations_only", "not_nginx_syntax_or_load_acceptance", "requested_paths_not_inode_or_symlink_chain", "independent_reads_not_atomic_snapshot", "no_runtime_route_or_backend_delivery_proof"];
    if (required.some(limit => !evidence.limitations.includes(limit)) || evidence.selected?.proxySetHeaders.some(header => header.expression.kind === "nginx_variables")
      && !evidence.limitations.includes("header_expressions_are_not_observed_runtime_values")) return "配置声明缺少必要运行时限制";
    return undefined;
  } catch { return "Nginx配置证据参数或结果不符合有界契约"; }
}

export const nginxConfigTool: ToolDefinition = {
  id: "nginx.inspect_configuration", implementation: "inspectNginxConfiguration", effect: "read", executionMode: "local", planMode: "read_batch", completionMode: "continue",
  name: "Nginx已采集配置声明分析", description: "消费当前任务已落账文件读取及前后目录清单，解析有限静态站点声明、目标块和非目标保护指纹；不连接服务器或执行Nginx。",
  usageInstructions: "先确认主配置绝对路径、Nginx运行prefix、实际连接地址/端口及Host/URI，然后只提交已有files.read_content/files.inspect_manifest步骤ID。glob需要前后两次完整目录清单，命中配置文件读取位于其间且内容摘要一致；未核实链接仍未知。标准代理header变量仅保留表达式，不证明运行值。terminalResponse表示有限字面return在server或location阶段终止请求，不能视为proxy_pass；declaredText只是配置声明，不是实际响应正文。动态return、重定向和444等未支持形式仍为unknown。parsed不代表nginx -t成功、新配置已加载、HTTP正确或后端已到达；必须引用sourceEvidenceIds中的原始采样证据，后续变更会使旧配置证据失效。不能提交配置正文、伪造收据或将它当作新的远程检查。",
  inputSchema: nginxConfigInputSchema, outputSchema: nginxConfigOutputSchema, outputDescription: "请求及已绑定执行身份的静态配置分析、字节来源和保护指纹，或具体未知原因；关联底层证据ID，加载与对象身份始终未证明。",
  enabled: true, builtIn: true, version: 2, updatedAt: "2026-10-13T00:00:00.000Z",
};
