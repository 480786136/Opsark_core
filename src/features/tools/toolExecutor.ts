import { normalizeOperationsRequest, type OperationsInspectionResult } from "./operationsInspection";
import { operationsInputSchemas } from "./operationsContracts";
import { enforceToolResult } from "./toolResultContract";
import { toolFailure, ToolExecutionError } from "./toolFailure";
import { ExecutionLedgerError } from "@/services/executionLedger";
import type { StepAction } from "@/types";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";
import { normalizeAuthenticationTarget } from "@/features/agent/authenticationTarget";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { effectiveOfficialTool, officialToolEnabled } from "@/features/support/officialContent";
import { normalizeSoftwareCheckRequest } from "@/features/tools/softwareCheck";
import { argumentPropertyPath, ToolArgumentValidationError } from "@/features/tools/toolArgumentProtocol";
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
  inspectOperations?(toolId: string, request: Record<string, unknown>): Promise<OperationsInspectionResult>;
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

/** Structured calls only. Shell text is never decoded into a tool invocation. */
export function parseToolAction(action: StepAction | undefined, callId: string, tools: ToolDefinition[] = defaultToolCatalog): ToolCall | undefined {
  if (!action || action.type === "shell") return undefined;
  if (action.type !== "tool" || Object.keys(action).some(key => !["type", "toolId", "arguments"].includes(key))
    || typeof action.toolId !== "string" || !isRecord(action.arguments)) throw new ToolArgumentValidationError("工具 action 必须包含 type、toolId 和 arguments 对象");
  const registered = tools.find(tool => tool.id === action.toolId);
  if (!registered) throw new ToolArgumentValidationError(`工具不存在或未注册：${action.toolId}`);
  return { id: callId, toolId: action.toolId, arguments: prepareToolArguments(effectiveOfficialTool(registered), action.arguments) };
}

function prepareToolArguments(tool: ToolDefinition, value: Record<string, unknown>, final = false) {
  const supplied = fillToolDefaults(tool.inputSchema, value) as Record<string, unknown>;
  validateToolArguments(tool, supplied);
  let normalized: Record<string, unknown>;
  try { normalized = normalizeKnownToolArguments(tool.id, supplied, final); }
  catch (error) {
    if (error instanceof ToolArgumentValidationError) throw error;
    throw new ToolArgumentValidationError(error instanceof Error ? error.message : String(error));
  }
  validateToolArguments(tool, normalized);
  return normalized;
}

function validateToolArguments(tool: ToolDefinition, value: Record<string, unknown>) {
  validateSchemaValue(tool.inputSchema, value, `工具 ${tool.id} 参数`, "");
}


/** Complete defaults and adapter normalization once, before approval. */
export function prepareFinalToolArguments(tool: ToolDefinition, value: Record<string, unknown>): Record<string, unknown> {
  // Serialization drops optional undefined values and prevents sharing mutable nested inputs.
  return JSON.parse(JSON.stringify(prepareToolArguments(tool, value, true)));
}

function canonicalArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArguments).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalArguments(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** A prepared dispatch can validate but must never change approved parameters. */
export function validatePreparedToolArguments(tool: ToolDefinition, value: Record<string, unknown>): void {
  validateToolArguments(tool, value);
  if (canonicalArguments(prepareFinalToolArguments(tool, value)) !== canonicalArguments(value)) {
    throw new ToolArgumentValidationError("工具参数不是已准备的最终参数，请重新准备并确认后执行");
  }
}

/** Validates built-in atomic tool contracts before a plan reaches execution. */
function normalizeKnownToolArguments(toolId: string, value: Record<string, unknown>, final = false) {
  if (operationsInputSchemas[toolId]) return normalizeOperationsRequest(toolId, value);
  if (toolId === "files.read_content") return { ...parseFileContentArguments(value) };
  if (toolId === "server.resolve_connection") return { ...parseConnectionTarget(value) };
  if (toolId === "files.transfer_between_servers") return { ...parseServerTransferArguments(value) };
  if (toolId === "software.check") return { ...normalizeSoftwareCheckRequest(value) };
  if (toolId === "server.connect") return { ...parseServerConnectArguments(value) };
  if (toolId === "files.get_structure") {
    // Keep the model-authored spelling in the plan, but reject semantic path
    // errors before the step reaches execution or opens an SSH/SFTP session.
    const request = parseFileStructureArguments(value);
    return final ? { ...request } : value;
  }
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

function assertUserInputProperties(value: Record<string, unknown>, allowed: string[], path: string, argumentPath?: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ToolArgumentValidationError(`${path} 不支持字段：${unknown}`, argumentPropertyPath(argumentPath, unknown));
}

export function parseUserInputArguments(value: Record<string, unknown>): UserInputRequest {
  if (!isRecord(value)) throw new Error("用户输入参数必须是对象");
  assertUserInputProperties(value, ["title", "description", "fields"], "用户输入参数", "");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : undefined;
  if (!title) throw new ToolArgumentValidationError("title 必须说明需要用户补充什么信息", "title");
  if (value.description !== undefined && typeof value.description !== "string") throw new ToolArgumentValidationError("表单 description 必须是字符串", "description");
  if (!Array.isArray(value.fields) || value.fields.length === 0) throw new ToolArgumentValidationError("fields 至少需要一个参数", "fields");
  if (value.fields.length > 8) throw new ToolArgumentValidationError("单次最多请求 8 个参数", "fields");
  const fields = value.fields.map((field, index) => {
    const fieldPath = `fields[${index}]`;
    if (!isRecord(field)) throw new ToolArgumentValidationError(`第 ${index + 1} 个参数定义无效`, fieldPath);
    assertUserInputProperties(field, ["key", "label", "description", "type", "placeholder", "options", "required", "credential"], `第 ${index + 1} 个参数`, fieldPath);
    const key = typeof field.key === "string" ? field.key.trim() : "";
    const label = typeof field.label === "string" ? field.label.trim() : "";
    const fieldDescription = typeof field.description === "string" ? field.description.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new ToolArgumentValidationError(`第 ${index + 1} 个参数 key 格式无效`, `${fieldPath}.key`);
    if (!label) throw new ToolArgumentValidationError(`参数 ${key} 缺少显示名称`, `${fieldPath}.label`);
    if (!fieldDescription) throw new ToolArgumentValidationError(`参数 ${key} 缺少用途说明`, `${fieldPath}.description`);
    if (typeof field.type !== "string" || !["text", "password", "number", "select"].includes(field.type)) throw new ToolArgumentValidationError(`参数 ${key} 的类型无效`, `${fieldPath}.type`);
    if (/(?:PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET|CREDENTIAL)$/i.test(key) && field.type !== "password") {
      throw new ToolArgumentValidationError(`敏感参数 ${key} 必须使用 password 类型`, `${fieldPath}.type`);
    }
    if (typeof field.required !== "boolean") throw new ToolArgumentValidationError(`参数 ${key} 必须明确是否必填`, `${fieldPath}.required`);
    if (field.placeholder !== undefined && typeof field.placeholder !== "string") throw new ToolArgumentValidationError(`参数 ${key} 的输入提示无效`, `${fieldPath}.placeholder`);
    let options: UserInputField["options"];
    if (field.type === "select") {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100) {
        throw new ToolArgumentValidationError(`参数 ${key} 的 options 必须包含 1 至 100 个候选`, `${fieldPath}.options`);
      }
      const seenValues = new Set<string>();
      options = Array.from(field.options, (option, optionIndex) => {
        const path = `参数 ${key} 的第 ${optionIndex + 1} 个候选`;
        const optionPath = `${fieldPath}.options[${optionIndex}]`;
        if (!isRecord(option)) throw new ToolArgumentValidationError(`${path} 必须是对象`, optionPath);
        assertUserInputProperties(option, ["value", "label"], path, optionPath);
        if (typeof option.value !== "string" || !option.value.trim()) throw new ToolArgumentValidationError(`${path} 的 value 必须是非空字符串`, `${optionPath}.value`);
        if (typeof option.label !== "string" || !option.label.trim()) throw new ToolArgumentValidationError(`${path} 的 label 必须是非空字符串`, `${optionPath}.label`);
        if (seenValues.has(option.value)) throw new ToolArgumentValidationError(`参数 ${key} 的 options.value 不能重复`, `${optionPath}.value`);
        seenValues.add(option.value);
        // Check blank strings without changing an option's exact identity.
        return { value: option.value, label: option.label };
      });
    } else if (Object.prototype.hasOwnProperty.call(field, "options")) {
      throw new ToolArgumentValidationError(`参数 ${key} 只有 select 类型允许 options`, `${fieldPath}.options`);
    }
    let credential: UserInputField["credential"];
    if (field.credential !== undefined) {
      if (field.type === "select") throw new ToolArgumentValidationError(`参数 ${key} 的 select 类型不允许 credential`, `${fieldPath}.credential`);
      if (!isRecord(field.credential)) throw new ToolArgumentValidationError(`参数 ${key} 的 credential 必须是对象`, `${fieldPath}.credential`);
      assertUserInputProperties(field.credential, ["group", "kind", "role", "target"], `参数 ${key} 的 credential`, `${fieldPath}.credential`);
      const group = typeof field.credential.group === "string" ? field.credential.group.trim() : "";
      const kind = String(field.credential.kind ?? "");
      const role = String(field.credential.role ?? "");
      let target = "";
      try {
        target = normalizeAuthenticationTarget(kind, typeof field.credential.target === "string" ? field.credential.target : "");
      } catch (error) {
        throw new ToolArgumentValidationError(`参数 ${key} 的 credential.target 无效：${String(error)}`, `${fieldPath}.credential.target`);
      }
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(group)) throw new ToolArgumentValidationError(`参数 ${key} 的 credential.group 格式无效`, `${fieldPath}.credential.group`);
      if (!["git-https", "ssh-password", "database", "service"].includes(kind)) {
        throw new ToolArgumentValidationError(`参数 ${key} 的 credential.kind 无效`, `${fieldPath}.credential.kind`);
      }
      if (!["username", "secret"].includes(role)) throw new ToolArgumentValidationError(`参数 ${key} 的 credential.role 无效`, `${fieldPath}.credential.role`);
      if (["git-https", "ssh-password"].includes(kind) && !isAuthenticationHost(target)) {
        throw new ToolArgumentValidationError(`参数 ${key} 的 credential.target 必须是精确主机名或 IP 地址`, `${fieldPath}.credential.target`);
      }
      if (field.type !== "password") throw new ToolArgumentValidationError(`凭据参数 ${key} 必须使用 password 类型`, `${fieldPath}.type`);
      if (field.required !== true) throw new ToolArgumentValidationError(`凭据参数 ${key} 必须设为必填`, `${fieldPath}.required`);
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
      type: field.type as UserInputField["type"],
      placeholder: field.placeholder as string | undefined,
      ...(options ? { options } : {}),
      required: field.required,
      ...(credential ? { credential } : {}),
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
  if (typeof rootPath !== "string") throw new ToolArgumentValidationError("rootPath 必须是字符串", "rootPath");
  const excludeDirectories = argumentsValue.excludeDirectories;
  if (excludeDirectories !== undefined && (
    !Array.isArray(excludeDirectories)
    || excludeDirectories.some((item) => typeof item !== "string")
  )) throw new ToolArgumentValidationError("excludeDirectories 必须是字符串数组", "excludeDirectories");
  const numericValue = (key: "maxDepth" | "maxNodes") => {
    const value = argumentsValue[key];
    if (value !== undefined && typeof value !== "number") throw new ToolArgumentValidationError(`${key} 必须是数字`, key);
    return value as number | undefined;
  };
  if (argumentsValue.includeHidden !== undefined && typeof argumentsValue.includeHidden !== "boolean") {
    throw new ToolArgumentValidationError("includeHidden 必须是布尔值", "includeHidden");
  }
  const maxDepth = numericValue("maxDepth");
  const maxNodes = numericValue("maxNodes");
  try {
    normalizeFileStructureRequest({ rootPath });
  } catch (error) {
    throw new ToolArgumentValidationError(error instanceof Error ? error.message : String(error), "rootPath");
  }
  try {
    return normalizeFileStructureRequest({
      rootPath,
      excludeDirectories: excludeDirectories as string[] | undefined,
      maxDepth,
      maxNodes,
      includeHidden: argumentsValue.includeHidden as boolean | undefined,
    });
  } catch (error) {
    throw new ToolArgumentValidationError(error instanceof Error ? error.message : String(error), "excludeDirectories");
  }
}

/** Validate each adapter result against the exact arguments used for dispatch. */
export async function executeToolCall(
  call: ToolCall,
  tools: ToolDefinition[],
  dependencies: ToolExecutionDependencies,
  options: { prepared?: boolean } = {},
): Promise<ToolResult> {
  const registered = tools.find((item) => item.id === call.toolId);
  if (!registered) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "TOOL_NOT_FOUND", category: "unavailable", dispatchState: "not_sent", message: "工具不存在" } };
  }
  const tool = effectiveOfficialTool(registered);
  if (!tool.enabled || !officialToolEnabled(tool.id)) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "TOOL_DISABLED", category: "permission", dispatchState: "not_sent", message: "工具未启用" } };
  }
  if (!isRecord(call.arguments)) {
    return { callId: call.id, toolId: call.toolId, success: false, error: { code: "INVALID_ARGUMENTS", category: "arguments", dispatchState: "not_sent", message: "工具参数必须是对象" } };
  }

  let started = false;
  try {
    if (options.prepared) validatePreparedToolArguments(tool, call.arguments);
    else call = { ...call, arguments: prepareToolArguments(tool, call.arguments) };
    // Adapters can trim strings, deduplicate lists or supply compiled fallback values.
    // Recheck their final request so those transformations cannot bypass a published constraint.
    const checked = <T extends object>(request: T): T => {
      validateSchemaValue(tool.inputSchema, request, `工具 ${tool.id} 参数`, "");
      if (options.prepared) {
        if (canonicalArguments(request) !== canonicalArguments(call.arguments)) {
          throw new ToolArgumentValidationError("工具派发参数与已确认快照不一致，请重新准备并确认");
        }
        return call.arguments as T;
      }
      return request;
    };
    if (tool.implementation === "expandPlanningContext") {
      validateToolArguments(tool, call.arguments);
      if (!dependencies.expandPlanningContext) throw new Error("当前上下文不支持展开 Skill");
      started = true;
      const data = await dependencies.expandPlanningContext(String(call.arguments.skillId));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "readEvidence") {
      validateToolArguments(tool, call.arguments);
      if (!dependencies.readEvidence) throw new Error("当前任务不能读取存档证据");
      const request = checked({ evidenceId: String(call.arguments.evidenceId), offset: Number(call.arguments.offset ?? 0), limit: Number(call.arguments.limit ?? 6000) });
      started = true;
      const data = await dependencies.readEvidence(request.evidenceId, request.offset, request.limit);
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "serverResolveConnection") {
      if (!dependencies.resolveServerConnection) throw new Error("当前执行环境不支持服务器连接资料查询");
      started = true;
      const data = await dependencies.resolveServerConnection(checked(parseConnectionTarget(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "serverConnect") {
      if (!dependencies.connectServer) throw new Error("当前执行环境不支持纳管 SSH 连接");
      started = true;
      const data = await dependencies.connectServer(checked(parseServerConnectArguments(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "userRequestInput") {
      if (!dependencies.requestUserInput) throw new Error("当前执行环境不支持用户输入交互");
      started = true;
      const data = await dependencies.requestUserInput(checked(parseUserInputArguments(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "getRemoteFileStructure") {
      const request = checked(parseFileStructureArguments(call.arguments));
      started = true;
      const data = await dependencies.getRemoteFileStructure(request);
      const modelData: FileStructureResult = {
        tree: data.tree, rootPath: request.rootPath, truncated: data.truncated, warnings: data.warnings,
        ...(data.pathStatus ? { pathStatus: data.pathStatus } : {}),
      };
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data: modelData, truncated: data.truncated });
    }
    if (tool.implementation === "readRemoteFileContent") {
      if (!dependencies.readRemoteFileContent) throw new Error("当前执行环境不支持远程文件内容读取");
      started = true;
      const data = await dependencies.readRemoteFileContent(checked(parseFileContentArguments(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data, truncated: data.truncated });
    }
    if (tool.implementation === "inspectOperations") {
      if (!dependencies.inspectOperations) throw new Error("当前执行环境不支持运维检查");
      const request = checked(normalizeOperationsRequest(call.toolId, call.arguments));
      started = true;
      const data = await dependencies.inspectOperations(call.toolId, request);
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data, truncated: data.truncated });
    }
    if (tool.implementation === "checkSoftware") {
      if (!dependencies.checkSoftware) throw new Error("当前执行环境不支持软件检查");
      started = true;
      const data = await dependencies.checkSoftware(checked(normalizeSoftwareCheckRequest(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    if (tool.implementation === "transferFileBetweenServers") {
      if (!dependencies.transferFileBetweenServers) throw new Error("当前执行环境不支持跨服务器文件传输");
      started = true;
      const data = await dependencies.transferFileBetweenServers(checked(parseServerTransferArguments(call.arguments)));
      return enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    }
    return {
      callId: call.id,
      toolId: call.toolId,
      success: false,
      error: { code: "TOOL_NOT_EXTERNALLY_CALLABLE", category: "permission", dispatchState: "not_sent", message: "该工具由内部工作流调用" },
    };
  } catch (error) {
    if (error instanceof ExecutionLedgerError) throw error;
    return {
      callId: call.id,
      toolId: call.toolId,
      success: false,
      error: toolFailure(error, started),
      ...(error instanceof ToolExecutionError && error.partialData ? { data: error.partialData } : {}),
    };
  }
}
