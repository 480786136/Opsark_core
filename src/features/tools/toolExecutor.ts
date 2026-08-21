import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";
import type {
  FileStructureRequest,
  FileStructureResult,
  ServerFileTransferRequest,
  ServerFileTransferResult,
  ServerConnectionLookupRequest,
  ServerConnectionLookupResult,
  ServerConnectRequest,
  ServerConnectResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UserInputRequest,
  UserInputResult,
} from "@/features/tools/types";

export interface ToolExecutionDependencies {
  getRemoteFileStructure(request: FileStructureRequest): Promise<FileStructureResult>;
  transferFileBetweenServers?(request: ServerFileTransferRequest): Promise<ServerFileTransferResult>;
  requestUserInput?(request: UserInputRequest): Promise<UserInputResult>;
  connectServer?(request: ServerConnectRequest): Promise<ServerConnectResult>;
  resolveServerConnection?(request: ServerConnectionLookupRequest): Promise<ServerConnectionLookupResult>;
}

function parseConnectionTarget(value: Record<string, unknown>): ServerConnectionLookupRequest {
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const port = value.port === undefined ? 22 : Number(value.port);
  if (!host || /[\s/@]/.test(host)) throw new Error("host 必须是有效的 IP 地址或域名");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port 必须介于 1 到 65535");
  return { host, port };
}

function parseServerTransferArguments(value: Record<string, unknown>): ServerFileTransferRequest {
  const { sourcePath, targetServer, targetPath, overwrite } = value;
  if (typeof sourcePath !== "string" || !sourcePath.startsWith("/")) throw new Error("sourcePath 必须是绝对路径");
  if (typeof targetServer !== "string" || !targetServer.trim()) throw new Error("targetServer 必须是服务器 ID、名称或地址");
  if (typeof targetPath !== "string" || !targetPath.startsWith("/")) throw new Error("targetPath 必须是绝对路径");
  if (overwrite !== undefined && typeof overwrite !== "boolean") throw new Error("overwrite 必须是布尔值");
  return { sourcePath, targetServer: targetServer.trim(), targetPath, overwrite };
}

function parseServerConnectArguments(value: Record<string, unknown>): ServerConnectRequest {
  const { host, port } = parseConnectionTarget(value);
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const passwordSecretKey = typeof value.passwordSecretKey === "string" ? value.passwordSecretKey.trim().toUpperCase() : "";
  const credentialRef = typeof value.credentialRef === "string" ? value.credentialRef.trim() : "";
  if (username && /[\s@]/.test(username)) throw new Error("username 必须是有效的 SSH 用户名");
  if (passwordSecretKey && !/^[A-Z][A-Z0-9_]*$/.test(passwordSecretKey)) throw new Error("passwordSecretKey 必须引用已安全收集的密码参数");
  if (!credentialRef && (!username || !passwordSecretKey)) {
    throw new Error("必须提供 credentialRef，或同时提供 username 和 passwordSecretKey");
  }
  if (value.name !== undefined && typeof value.name !== "string") throw new Error("name 必须是字符串");
  if (value.group !== undefined && typeof value.group !== "string") throw new Error("group 必须是字符串");
  return {
    host,
    port,
    username: username || undefined,
    passwordSecretKey: passwordSecretKey || undefined,
    credentialRef: credentialRef || undefined,
    name: typeof value.name === "string" ? value.name.trim() || undefined : undefined,
    group: typeof value.group === "string" ? value.group.trim() || undefined : undefined,
  };
}

export function parseToolCommand(command: string, callId: string): ToolCall | undefined {
  const match = command.trim().match(/^opsark-tool\s+([a-z0-9_.-]+)\s+([\s\S]+)$/i);
  if (!match) return undefined;
  const argumentText = match[2].trim();
  let parsed: unknown;
  if (argumentText.startsWith("{") || argumentText.startsWith("[")
    || ((argumentText.startsWith("'") && argumentText.endsWith("'"))
      || (argumentText.startsWith('"') && argumentText.endsWith('"')))) {
    let jsonText = argumentText;
    if ((jsonText.startsWith("'") && jsonText.endsWith("'"))
      || (jsonText.startsWith('"') && jsonText.endsWith('"'))) {
      jsonText = jsonText.slice(1, -1);
    }
    parsed = JSON.parse(jsonText) as unknown;
  } else {
    parsed = parseCliToolArguments(argumentText);
  }
  if (!isRecord(parsed)) throw new Error("工具命令参数必须是 JSON 对象");
  return { id: callId, toolId: match[1], arguments: parsed };
}

function parseCliToolArguments(text: string): Record<string, unknown> {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && quote === '"' && index + 1 < text.length) token += text[++index];
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("工具命令参数包含未闭合的引号");
  if (token) tokens.push(token);

  const result: Record<string, unknown> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (!option.startsWith("--") || option.length === 2) {
      throw new Error(`工具命令参数必须使用 --key value 格式：${option}`);
    }
    const equalsIndex = option.indexOf("=");
    const rawKey = option.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
    const key = rawKey.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`工具命令参数名无效：${rawKey}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`工具命令参数重复：${rawKey}`);
    let rawValue: string | undefined = equalsIndex < 0 ? undefined : option.slice(equalsIndex + 1);
    if (rawValue === undefined && tokens[index + 1] && !tokens[index + 1].startsWith("--")) {
      rawValue = tokens[++index];
    }
    result[key] = rawValue === undefined ? true : coerceCliToolValue(rawValue);
  }
  return result;
}

function coerceCliToolValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("{") || value.startsWith("[")) return JSON.parse(value) as unknown;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUserInputArguments(value: Record<string, unknown>): UserInputRequest {
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : undefined;
  if (!title) throw new Error("title 必须说明需要用户补充什么信息");
  if (!Array.isArray(value.fields) || value.fields.length === 0) throw new Error("fields 至少需要一个参数");
  if (value.fields.length > 8) throw new Error("单次最多请求 8 个参数");
  const fields = value.fields.map((field, index) => {
    if (!isRecord(field)) throw new Error(`第 ${index + 1} 个参数定义无效`);
    const key = typeof field.key === "string" ? field.key.trim() : "";
    const label = typeof field.label === "string" ? field.label.trim() : "";
    const fieldDescription = typeof field.description === "string" ? field.description.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`第 ${index + 1} 个参数 key 格式无效`);
    if (!label) throw new Error(`参数 ${key} 缺少显示名称`);
    if (!fieldDescription) throw new Error(`参数 ${key} 缺少用途说明`);
    if (!["text", "password", "number"].includes(String(field.type))) throw new Error(`参数 ${key} 的类型无效`);
    if (typeof field.required !== "boolean") throw new Error(`参数 ${key} 必须明确是否必填`);
    if (field.placeholder !== undefined && typeof field.placeholder !== "string") throw new Error(`参数 ${key} 的输入提示无效`);
    return {
      key,
      label,
      description: fieldDescription,
      type: field.type as "text" | "password" | "number",
      placeholder: field.placeholder as string | undefined,
      required: field.required,
    };
  });
  if (new Set(fields.map((field) => field.key.toLowerCase())).size !== fields.length) throw new Error("参数 key 不能重复");
  return { title, description, fields };
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
    if (tool.implementation === "serverResolveConnection") {
      if (!dependencies.resolveServerConnection) throw new Error("当前执行环境不支持服务器连接资料查询");
      const data = await dependencies.resolveServerConnection(parseConnectionTarget(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data };
    }
    if (tool.implementation === "serverConnect") {
      if (!dependencies.connectServer) throw new Error("当前执行环境不支持纳管 SSH 连接");
      const data = await dependencies.connectServer(parseServerConnectArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data };
    }
    if (tool.implementation === "userRequestInput") {
      if (!dependencies.requestUserInput) throw new Error("当前执行环境不支持用户输入交互");
      const data = await dependencies.requestUserInput(parseUserInputArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data };
    }
    if (tool.implementation === "getRemoteFileStructure") {
      const data = await dependencies.getRemoteFileStructure(parseFileStructureArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data, truncated: data.truncated };
    }
    if (tool.implementation === "transferFileBetweenServers") {
      if (!dependencies.transferFileBetweenServers) throw new Error("当前执行环境不支持跨服务器文件传输");
      const data = await dependencies.transferFileBetweenServers(parseServerTransferArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data };
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
