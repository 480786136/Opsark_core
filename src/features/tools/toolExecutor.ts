import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";
import type {
  FileStructureRequest,
  FileStructureResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@/features/tools/types";

export interface ToolExecutionDependencies {
  getRemoteFileStructure(request: FileStructureRequest): Promise<FileStructureResult>;
}

export function parseToolCommand(command: string, callId: string): ToolCall | undefined {
  const match = command.trim().match(/^opsark-tool\s+([a-z0-9_.-]+)\s+([\s\S]+)$/i);
  if (!match) return undefined;
  let jsonText = match[2].trim();
  if ((jsonText.startsWith("'") && jsonText.endsWith("'"))
    || (jsonText.startsWith('"') && jsonText.endsWith('"'))) {
    jsonText = jsonText.slice(1, -1);
  }
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) throw new Error("工具命令参数必须是 JSON 对象");
  return { id: callId, toolId: match[1], arguments: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFileStructureArguments(argumentsValue: Record<string, unknown>): FileStructureRequest {
  const rootPath = argumentsValue.rootPath;
  if (typeof rootPath !== "string") throw new Error("rootPath 必须是字符串");
  const excludeDirectories = argumentsValue.excludeDirectories;
  if (excludeDirectories !== undefined && (
    !Array.isArray(excludeDirectories)
    || excludeDirectories.some((item) => typeof item !== "string")
  )) throw new Error("excludeDirectories 必须是字符串数组");
  const numericValue = (key: "maxDepth" | "maxNodes") => {
    const value = argumentsValue[key];
    if (value !== undefined && typeof value !== "number") throw new Error(`${key} 必须是数字`);
    return value as number | undefined;
  };
  if (argumentsValue.includeHidden !== undefined && typeof argumentsValue.includeHidden !== "boolean") {
    throw new Error("includeHidden 必须是布尔值");
  }
  return normalizeFileStructureRequest({
    rootPath,
    excludeDirectories: excludeDirectories as string[] | undefined,
    maxDepth: numericValue("maxDepth"),
    maxNodes: numericValue("maxNodes"),
    includeHidden: argumentsValue.includeHidden as boolean | undefined,
  });
}

export async function executeToolCall(
  call: ToolCall,
  tools: ToolDefinition[],
  dependencies: ToolExecutionDependencies,
): Promise<ToolResult> {
  const tool = tools.find((item) => item.id === call.toolId);
  if (!tool) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "TOOL_NOT_FOUND", message: "工具不存在" } };
  }
  if (!tool.enabled) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "TOOL_DISABLED", message: "工具未启用" } };
  }
  if (!isRecord(call.arguments)) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "INVALID_ARGUMENTS", message: "工具参数必须是对象" } };
  }

  try {
    if (tool.implementation === "getRemoteFileStructure") {
      const data = await dependencies.getRemoteFileStructure(parseFileStructureArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data, truncated: data.truncated };
    }
    return {
      callId: call.id,
      toolId: call.toolId,
      success: false,
      error: { code: "TOOL_NOT_EXTERNALLY_CALLABLE", message: "该工具由内部工作流调用" },
    };
  } catch (error) {
    return {
      callId: call.id,
      toolId: call.toolId,
      success: false,
      error: { code: "TOOL_EXECUTION_FAILED", message: String(error) },
    };
  }
}
