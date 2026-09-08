import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { normalizeSoftwareCheckRequest } from "@/features/tools/softwareCheck";
import type {
  FileContentRequest,
  FileContentResult,
  FileStructureRequest,
  FileStructureResult,
  FileStructureScanResult,
  ServerFileTransferRequest,
  ServerFileTransferResult,
  ServerConnectionLookupRequest,
  ServerConnectionLookupResult,
  ServerConnectRequest,
  ServerConnectResult,
  SoftwareCheckRequest,
  SoftwareCheckResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UserInputField,
  UserInputRequest,
  UserInputResult,
} from "@/features/tools/types";

export interface ToolExecutionDependencies {
  readEvidence?(evidenceId: string, offset: number, limit: number): Promise<Record<string, unknown>>;
  expandPlanningContext?(skillId: string): Promise<{ skillId: string }>;
  getRemoteFileStructure(request: FileStructureRequest): Promise<FileStructureScanResult>;
  readRemoteFileContent?(request: FileContentRequest): Promise<FileContentResult>;
  checkSoftware?(request: SoftwareCheckRequest): Promise<SoftwareCheckResult>;
  transferFileBetweenServers?(request: ServerFileTransferRequest): Promise<ServerFileTransferResult>;
  requestUserInput?(request: UserInputRequest): Promise<UserInputResult>;
  connectServer?(request: ServerConnectRequest): Promise<ServerConnectResult>;
  resolveServerConnection?(request: ServerConnectionLookupRequest): Promise<ServerConnectionLookupResult>;
}

const TOOL_COMMAND_ATOMICITY_ERROR = "opsark-tool 命令必须是单行原子调用：只能包含一个工具调用和一个参数对象";

function parseFileContentArguments(value: Record<string, unknown>): FileContentRequest {
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const maxBytes = value.maxBytes === undefined ? 65_536 : Number(value.maxBytes);
  if (!path.startsWith("/")) throw new Error("path 必须是绝对路径");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262_144) {
    throw new Error("maxBytes 必须介于 1 到 262144");
  }
  return { path, maxBytes };
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

export function parseToolCommand(
  command: string,
  callId: string,
  tools: ToolDefinition[] = defaultToolCatalog,
): ToolCall | undefined {
  const trimmed = command.trim();
  if (!/^opsark-tool(?:\s|$)/i.test(trimmed)) return undefined;
  if (/[\r\n]/.test(command)) throw new Error(TOOL_COMMAND_ATOMICITY_ERROR);
  const match = trimmed.match(/^opsark-tool\s+([a-z0-9_.-]+)\s+([\s\S]+)$/i);
  if (!match) throw new Error("opsark-tool 命令必须包含唯一工具 ID 和参数对象");
  const argumentText = match[2].trim();
  if (hasUnquotedToolInvocation(argumentText)) throw new Error(TOOL_COMMAND_ATOMICITY_ERROR);
  let parsed: unknown;
  if (argumentText.startsWith("{") || argumentText.startsWith("[")
    || ((argumentText.startsWith("'") && argumentText.endsWith("'"))
      || (argumentText.startsWith('"') && argumentText.endsWith('"')))) {
    let jsonText = argumentText;
    if ((jsonText.startsWith("'") && jsonText.endsWith("'"))
      || (jsonText.startsWith('"') && jsonText.endsWith('"'))) {
      jsonText = jsonText.slice(1, -1);
    }
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      throw new Error("工具命令参数必须是单个 JSON 对象");
    }
  } else {
    parsed = parseCliToolArguments(argumentText);
  }
  if (!isRecord(parsed)) throw new Error("工具命令参数必须是 JSON 对象");
  // Older planners occasionally emitted `opsark-tool --files.get_structure ...`,
  // treating the tool id like an option. Accept that one recoverable typo while
  // keeping unknown tool ids and malformed arguments strict.
  const toolId = match[1].replace(/^--(?=[a-z0-9])/, "");
  const definition = tools.find((tool) => tool.id === toolId);
  if (!definition) throw new Error(`工具不存在或未注册：${toolId}`);
  validateToolArguments(definition, parsed);
  const argumentsValue = normalizeKnownToolArguments(toolId, parsed);
  validateToolArguments(definition, argumentsValue);
  return { id: callId, toolId, arguments: argumentsValue };
}

function hasUnquotedToolInvocation(value: string) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ((index === 0 || /\s/.test(value[index - 1]))
      && value.slice(index, index + 11).toLowerCase() === "opsark-tool"
      && (index + 11 === value.length || /\s/.test(value[index + 11]))) {
      return true;
    }
  }
  return false;
}

function validateToolArguments(tool: ToolDefinition, value: Record<string, unknown>) {
  validateSchemaValue(tool.inputSchema, value, `工具 ${tool.id} 参数`);
}

function validateSchemaValue(schema: Record<string, unknown>, value: unknown, path: string) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  const type = schema.type;
  const validType = type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : type === "array" ? Array.isArray(value)
            : type === "object" ? isRecord(value)
              : true;
  if (!validType) throw new Error(`${path} 类型必须为 ${String(type)}`);
  if (isRecord(value) && schema.additionalProperties === false) {
    const unknown = Object.keys(value).find((key) => !(key in properties));
    if (unknown) throw new Error(`${path} 不支持字段：${unknown}`);
  }
  if (isRecord(value)) {
    const missing = required.find((key) => value[key] === undefined);
    if (missing) throw new Error(`${path} 缺少必填字段：${missing}`);
    for (const [key, rawRule] of Object.entries(properties)) {
      if (value[key] !== undefined && isRecord(rawRule)) validateSchemaValue(rawRule, value[key], `${path}.${key}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${path} 小于最小值`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${path} 超过最大值`);
  }
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    throw new Error(`${path} 格式无效`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} 数量不足`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} 数量过多`);
    const itemRule = isRecord(schema.items) ? schema.items : undefined;
    if (itemRule) value.forEach((item, index) => validateSchemaValue(itemRule, item, `${path}[${index}]`));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} 不在允许范围内`);
  }
}

/** Validates built-in atomic tool contracts before a plan reaches execution. */
function normalizeKnownToolArguments(toolId: string, value: Record<string, unknown>) {
  if (toolId === "server.connect") return { ...parseServerConnectArguments(value) };
  if (toolId === "user.request_input") {
    // A declared credential username must use protected input/storage. This
    // local promotion changes neither the account nor its target or purpose.
    // Validate the complete credential pair afterwards; never infer metadata.
    const fields = Array.isArray(value.fields) ? value.fields.map(field => {
      if (isRecord(field) && field.type === "text" && isRecord(field.credential)
        && field.credential.role === "username") return { ...field, type: "password" };
      return field;
    }) : value.fields;
    return { ...parseUserInputArguments({ ...value, fields }) };
  }
  return value;
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

function isAuthenticationHost(value: string) {
  if (value === "localhost" || /^\[[0-9a-f:.]+\]$/i.test(value)) return true;
  if (!/^[a-z0-9.-]+$/i.test(value) || value.includes("..")) return false;
  return value.split(".").every((label) => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
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
    if (/(?:PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET|CREDENTIAL)$/i.test(key) && field.type !== "password") {
      throw new Error(`敏感参数 ${key} 必须使用 password 类型`);
    }
    if (typeof field.required !== "boolean") throw new Error(`参数 ${key} 必须明确是否必填`);
    if (field.placeholder !== undefined && typeof field.placeholder !== "string") throw new Error(`参数 ${key} 的输入提示无效`);
    let credential: UserInputField["credential"];
    if (field.credential !== undefined) {
      if (!isRecord(field.credential)) throw new Error(`参数 ${key} 的 credential 必须是对象`);
      const group = typeof field.credential.group === "string" ? field.credential.group.trim() : "";
      const kind = String(field.credential.kind ?? "");
      const role = String(field.credential.role ?? "");
      const target = typeof field.credential.target === "string"
        ? field.credential.target.trim().toLocaleLowerCase()
        : "";
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(group)) throw new Error(`参数 ${key} 的 credential.group 格式无效`);
      if (!["git-https", "ssh-password", "database", "service"].includes(kind)) {
        throw new Error(`参数 ${key} 的 credential.kind 无效`);
      }
      if (!["username", "secret"].includes(role)) throw new Error(`参数 ${key} 的 credential.role 无效`);
      if (!target || /[\s/@]/.test(target) || target.includes("://")) {
        throw new Error(`参数 ${key} 的 credential.target 必须是不含凭据的主机或服务标识`);
      }
      if (["git-https", "ssh-password"].includes(kind) && !isAuthenticationHost(target)) {
        throw new Error(`参数 ${key} 的 credential.target 必须是精确主机名或 IP 地址`);
      }
      if (field.type !== "password") throw new Error(`凭据参数 ${key} 必须使用 password 类型`);
      if (field.required !== true) throw new Error(`凭据参数 ${key} 必须设为必填`);
      credential = {
        group,
        kind: kind as NonNullable<UserInputField["credential"]>["kind"],
        role: role as NonNullable<UserInputField["credential"]>["role"],
        target,
      };
    }
    return {
      key,
      label,
      description: fieldDescription,
      type: field.type as "text" | "password" | "number",
      placeholder: field.placeholder as string | undefined,
      required: field.required,
      credential,
    };
  });
  if (new Set(fields.map((field) => field.key.toLowerCase())).size !== fields.length) throw new Error("参数 key 不能重复");
  const credentialGroups = new Map<string, typeof fields>();
  fields.filter((field) => field.credential).forEach((field) => {
    const group = credentialGroups.get(field.credential!.group) ?? [];
    group.push(field);
    credentialGroups.set(field.credential!.group, group);
  });
  if (credentialGroups.size > 1) throw new Error("一次 user.request_input 只能收集一个凭据组");
  for (const [group, groupedFields] of credentialGroups) {
    const descriptor = groupedFields[0].credential!;
    const roles = groupedFields.map((field) => field.credential!.role).sort();
    if (groupedFields.length !== 2 || roles.join(",") !== "secret,username") {
      throw new Error(`凭据组 ${group} 必须恰好包含一个 username 和一个 secret 字段`);
    }
    if (groupedFields.some((field) => field.credential!.kind !== descriptor.kind
      || field.credential!.target !== descriptor.target)) {
      throw new Error(`凭据组 ${group} 的 kind 和 target 必须完全一致`);
    }
  }
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
    if (tool.implementation === "expandPlanningContext") {
      validateToolArguments(tool, call.arguments);
      if (!dependencies.expandPlanningContext) throw new Error("当前上下文不支持展开 Skill");
      const data = await dependencies.expandPlanningContext(String(call.arguments.skillId));
      return { callId: call.id, toolId: call.toolId, success: true, data };
    }
    if (tool.implementation === "readEvidence") {
      validateToolArguments(tool, call.arguments);
      if (!dependencies.readEvidence) throw new Error("当前任务不能读取存档证据");
      const data = await dependencies.readEvidence(String(call.arguments.evidenceId), Number(call.arguments.offset ?? 0), Number(call.arguments.limit ?? 6000));
      return { callId: call.id, toolId: call.toolId, success: true, data };
    }
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
      const request = parseFileStructureArguments(call.arguments);
      const data = await dependencies.getRemoteFileStructure(request);
      const modelData: FileStructureResult = {
        tree: data.tree, rootPath: request.rootPath, truncated: data.truncated, warnings: data.warnings,
      };
      return { callId: call.id, toolId: call.toolId, success: true, data: modelData, truncated: data.truncated };
    }
    if (tool.implementation === "readRemoteFileContent") {
      if (!dependencies.readRemoteFileContent) throw new Error("当前执行环境不支持远程文件内容读取");
      const data = await dependencies.readRemoteFileContent(parseFileContentArguments(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data, truncated: data.truncated };
    }
    if (tool.implementation === "checkSoftware") {
      if (!dependencies.checkSoftware) throw new Error("当前执行环境不支持软件检查");
      const data = await dependencies.checkSoftware(normalizeSoftwareCheckRequest(call.arguments));
      return { callId: call.id, toolId: call.toolId, success: true, data };
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
