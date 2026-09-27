import { operationsInputSchemas } from "./operationsContracts";
import { operationsResultIssue, type OperationsInspectionResult } from "./operationsInspection";
import { normalizeFileStructureRequest } from "./fileStructure";
import { compileToolSchema } from "./toolParameterSchema";
import { toolOutputSchemas, toolResultSchema } from "./toolOutputSchemas";
import type { ToolCall, ToolResult } from "./types";

const envelope = compileToolSchema(toolResultSchema);
function schemaIssue(schema: Record<string, unknown>, value: unknown): string | undefined {
  const validate = compileToolSchema(schema);
  if (validate(value)) return undefined;
  // Never include returned data or validator value excerpts in errors/logs.
  const first = validate.errors?.[0];
  return `${first?.instancePath || "/"} (${first?.keyword ?? "schema"})`;
}
function relationIssue(call: ToolCall, data: Record<string, any>): string | undefined {
  const args = call.arguments;
  if (operationsInputSchemas[call.toolId]) return operationsResultIssue(call.toolId, args, data as OperationsInspectionResult);
  if (call.toolId === "files.read_content") {
    if (data.path !== args.path || data.returnedBytes > data.totalBytes
      || data.returnedBytes > Number(args.maxBytes ?? 65536)
      || data.truncated !== (data.returnedBytes < data.totalBytes)) return "文件路径、字节数或截断状态不一致";
  } else if (call.toolId === "files.get_structure") {
    const requested = normalizeFileStructureRequest({ rootPath: String(args.rootPath) }).rootPath;
    if (data.rootPath !== requested) return "目录结果与请求路径不一致";
  } else if (call.toolId === "software.check") {
    const expected = new Set(Array.isArray(args.names) ? args.names : []);
    const actual = new Set(data.items.map((item: { name: string }) => item.name));
    if (actual.size !== data.items.length || actual.size !== expected.size
      || [...actual].some(name => !expected.has(name))) return "软件检查缺项、重复或返回了未请求的软件";
  } else if (call.toolId === "files.transfer_between_servers") {
    if (data.sourcePath !== args.sourcePath || data.targetPath !== args.targetPath) return "传输结果与请求路径不一致";
  } else if (["server.connect", "server.resolve_connection"].includes(call.toolId)) {
    if (data.host !== args.host || data.port !== Number(args.port ?? 22)) return "连接结果与请求目标不一致";
  } else if (call.toolId === "context.expand" && data.skillId !== args.skillId) return "展开结果与请求 Skill 不一致";
  else if (call.toolId === "evidence.read") {
    const end = data.offset + Array.from(data.text).length;
    if (data.evidenceId !== args.evidenceId || data.offset !== Number(args.offset ?? 0)
      || end > data.totalCharacters || Array.from(data.text).length > Number(args.limit ?? 6000)
      || data.nextOffset !== (end < data.totalCharacters ? end : null)
      || (data.nextOffset !== null && end <= data.offset)) return "证据分页范围或引用不一致";
  }
  return undefined;
}

/** Used before returning adapter results and before recording success evidence. */
export function enforceToolResult(call: ToolCall, value: unknown): ToolResult {
  let issue: string | undefined;
  try {
    // undefined object properties are omitted on JSON transport; all numeric
    // values must remain finite, including intentionally extensible metadata.
    const serialized = JSON.stringify(value, (_key, item) => {
      if (["function", "symbol", "bigint"].includes(typeof item)) throw new Error("non-json");
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("non-finite");
      return item;
    });
    value = JSON.parse(serialized);
    if (!envelope(value)) issue = "结果封装不符合契约";
    else {
      const result = value as ToolResult;
      if (result.callId !== call.id || result.toolId !== call.toolId) issue = "结果调用标识不匹配";
      else if (!result.success) return result;
      else {
        const schema = toolOutputSchemas[call.toolId];
        issue = schema ? schemaIssue(schema, result.data) : "工具未声明输出契约";
        if (!issue) issue = relationIssue(call, result.data as Record<string, unknown>);
        if (!issue && typeof (result.data as Record<string, unknown>).truncated === "boolean"
          && result.truncated !== undefined && result.truncated !== (result.data as Record<string, unknown>).truncated) issue = "结果截断标识不一致";
        if (!issue) return result;
      }
    }
  } catch { issue = "结果不是有效的 JSON 数据或不符合契约"; }
  return { callId: call.id, toolId: call.toolId, success: false,
    error: { code: "TOOL_OUTPUT_INVALID", category: "output", dispatchState: "unknown", message: `工具输出校验失败：${issue}` } };
}
