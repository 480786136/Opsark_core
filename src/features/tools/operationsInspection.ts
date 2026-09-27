import probe from "./operations_probe.py?raw";
import { operationsInputSchemas, operationsOutputSchemas } from "./operationsContracts";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";

export interface OperationsInspectionResult {
  request: Record<string, unknown>;
  status: "complete" | "no_match" | "partial" | "timeout" | "cancelled" | "permission_denied" | "unsupported" | "error";
  items: Array<Record<string, unknown>>;
  scannedEntries: number;
  matchedEntries: number;
  skippedCount: number;
  skipped: Array<{ path: string; reason: string }>;
  coverageComplete: boolean;
  truncated: boolean;
  elapsedMs: number;
  finishedAt: string;
}

export function normalizeOperationsRequest(toolId: string, value: Record<string, unknown>): Record<string, unknown> {
  const schema = operationsInputSchemas[toolId];
  if (!schema) throw new Error("未知运维检查工具");
  const request = fillToolDefaults(schema, value) as Record<string, unknown>;
  validateSchemaValue(schema, request, "运维检查参数", "");
  const normalizePath = (value: unknown) => {
    const path = String(value);
    if (path.split("/").includes("..")) throw new Error("检查路径不能包含 ..，请提供明确绝对路径");
    return "/" + path.split("/").filter(part => part && part !== ".").join("/");
  };
  if (request.path !== undefined) request.path = normalizePath(request.path);
  if (Array.isArray(request.excludePaths)) request.excludePaths = [...new Set(request.excludePaths.map(normalizePath))];
  if (request.url !== undefined) {
    const raw = String(request.url);
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("健康检查地址必须是有效的 HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash
      || /[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new Error("健康检查 URL 不能包含凭据、空白、反斜杠或片段");
    // Preserve the approved spelling. Never rewrite paths, queries or endpoints.
  }
  if (JSON.stringify(request).length > 8192) throw new Error("检查范围参数过长，请拆分为多个有界检查");
  return request;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function buildOperationsCommand(toolId: string, request: Record<string, unknown>): string {
  const normalized = normalizeOperationsRequest(toolId, request);
  const unavailable: OperationsInspectionResult = {
    request: normalized, status: "unsupported", items: [], scannedEntries: 0, matchedEntries: 0,
    skippedCount: 1, skipped: [{ path: "python3", reason: "unsupported" }],
    coverageComplete: false, truncated: true, elapsedMs: 0, finishedAt: "unavailable",
  };
  return `if command -v python3 >/dev/null 2>&1; then\npython3 -I -B -u -c ${quote(probe)} ${quote(JSON.stringify({ toolId, request: normalized }))}\nelse\nprintf '%s\\n' ${quote("OPSARK_RESULT " + JSON.stringify(unavailable))}\nfi`;
}

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
    : JSON.stringify(value);

export function operationsResultIssue(toolId: string, request: Record<string, unknown>, data: OperationsInspectionResult): string | undefined {
  const normalized = normalizeOperationsRequest(toolId, request);
  if (stable(data.request) !== stable(normalized)) return "检查结果与请求范围不一致";
  const kinds: Record<string, string> = { capacity: "filesystem", directory: "directory", deleted: "deleted_file", docker: "docker", status: "service", ports: "ports", logs: "logs", health: "health" };
  const kind = toolId === "files.find_large" ? "file" : kinds[String(normalized.check)];
  if (data.items.some(item => item.kind !== kind)) return "返回了未请求的检查类型";
  if (data.items.length > Number(request.maxResults ?? 200) || data.scannedEntries > Number(request.maxEntries ?? 100000)
    || data.skipped.length > data.skippedCount || data.matchedEntries < data.items.length) return "检查数量与预算不一致";
  const finished = ["complete", "no_match"].includes(data.status);
  if (data.coverageComplete !== finished || (!finished && !data.truncated)
    || (data.status === "no_match" && (data.items.length > 0 || data.matchedEntries > 0))
    || (data.matchedEntries > data.items.length && !data.truncated)) return "检查状态与完整性不一致";
  return undefined;
}

export function parseOperationsOutput(toolId: string, request: Record<string, unknown>, output: string): OperationsInspectionResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_RESULT "));
  if (lines.length !== 1 || lines[0].length > 131100) throw new Error("运维检查没有返回唯一有效的有界结果");
  let data: OperationsInspectionResult;
  try { data = JSON.parse(lines[0].slice("OPSARK_RESULT ".length)); }
  catch { throw new Error("运维检查结果不是有效 JSON"); }
  validateSchemaValue(operationsOutputSchemas[toolId], data, "运维检查结果", "");
  const issue = operationsResultIssue(toolId, request, data);
  if (issue) throw new Error(issue);
  return data;
}
