import type { AgentSessionRef, ExecutionTargetRef, ServerProfile, StepAction } from "@/types";
import { effectiveOfficialTool } from "@/features/support/officialContent";
import type { ToolDefinition } from "./types";
import { prepareFinalToolArguments } from "./toolExecutor";
import { ToolArgumentValidationError } from "./toolArgumentProtocol";

export { prepareFinalToolArguments };

type ToolAction = Extract<StepAction, { type: "tool" }>;
type Endpoint = Pick<ServerProfile, "id" | "host" | "port" | "username" | "name">;
export interface PreparedToolTargetContext {
  server?: ServerProfile;
  servers: readonly ServerProfile[];
  connectionGeneration?: number;
  connectionGenerations?: Record<string, number>;
  agentSession?: AgentSessionRef;
  /** Non-secret identity metadata only. Never pass passwords or protected usernames. */
  credentialBindings?: Record<string, { host: string; port?: number; username?: string }>;
}

const schemaMaps = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);
const schemaChildren = new Set(["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const presentationKeywords = new Set(["title", "description", "examples", "$comment"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Remove schema annotations without deleting user properties named description/title. */
function semanticSchema(value: unknown): unknown {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !presentationKeywords.has(key)).map(([key, child]) => {
    if (schemaMaps.has(key) && object(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, semanticSchema(schema)]))];
    if (schemaChildren.has(key)) return [key, Array.isArray(child) ? child.map(semanticSchema) : semanticSchema(child)];
    if (schemaLists.has(key) && Array.isArray(child)) return [key, child.map(semanticSchema)];
    // const/enum/default are data, including objects with annotation-looking keys.
    return [key, child];
  }));
}

/** Execution semantics, not a release/documentation identity. */
export function effectiveToolSemanticContract(registered: ToolDefinition): Record<string, unknown> {
  const tool = effectiveOfficialTool(registered);
  return JSON.parse(JSON.stringify({
    id: tool.id, implementation: tool.implementation, implementationVersion: tool.version,
    enabled: tool.enabled, builtIn: tool.builtIn, effect: tool.effect,
    executionMode: tool.executionMode, modelExposure: tool.modelExposure ?? "planner",
    planMode: tool.planMode, completionMode: tool.completionMode, refinementScope: tool.refinementScope,
    inputSchema: semanticSchema(tool.inputSchema), outputSchema: semanticSchema(tool.outputSchema),
  }));
}

const hostIdentity = (host: string) => host.toLowerCase();
function unique(candidates: Endpoint[], label: string): Endpoint | undefined {
  if (candidates.length > 1) throw new ToolArgumentValidationError(`${label}匹配多个服务器，请使用明确的服务器 ID 或连接引用`);
  return candidates[0];
}

/** Exact IDs have stable identity; names/hosts are accepted only when unambiguous. */
export function resolveUniqueServer<T extends Endpoint>(servers: readonly T[], selector: string): T | undefined {
  const id = unique(servers.filter(server => server.id === selector), `服务器 ID“${selector}”`);
  if (id) return id as T;
  return unique(servers.filter(server => server.name === selector || hostIdentity(server.host) === hostIdentity(selector)), `服务器“${selector}”`) as T | undefined;
}

export function resolveUniqueServerEndpoint<T extends Endpoint>(servers: readonly T[], host: string, port: number, username?: string): T | undefined {
  return unique(servers.filter(server => hostIdentity(server.host) === hostIdentity(host) && server.port === port
    && (username === undefined || server.username === username)), `服务器 ${host}:${port}`) as T | undefined;
}

function targetFor(server: ServerProfile, role: ExecutionTargetRef["role"], context: PreparedToolTargetContext): ExecutionTargetRef {
  return {
    role, serverId: server.id, host: server.host, port: server.port, username: server.username,
    ...(context.connectionGenerations?.[server.id] !== undefined
      ? { connectionGeneration: context.connectionGenerations[server.id] }
      : context.server?.id === server.id && context.connectionGeneration !== undefined ? { connectionGeneration: context.connectionGeneration } : {}),
  };
}

/** Pure catalog binding. No lookup performs SSH, credential retrieval, or mutation. */
export function bindPreparedToolTargets(action: ToolAction, context: PreparedToolTargetContext): { action: ToolAction; targets: ExecutionTargetRef[] } {
  const finalAction: ToolAction = JSON.parse(JSON.stringify(action));
  const args = finalAction.arguments;
  const targets: ExecutionTargetRef[] = [];
  if (context.server) {
    const current = context.servers.filter(server => server.id === context.server!.id);
    if (current.length !== 1 || current[0].host !== context.server.host || current[0].port !== context.server.port
      || current[0].username !== context.server.username) {
      throw new ToolArgumentValidationError("源服务器身份已变化，请重新准备当前阶段");
    }
    const source = targetFor(context.server, "source", context);
    if (["software.check", "server.connect"].includes(action.toolId) && context.agentSession) {
      if (context.agentSession.serverId !== context.server.id) throw new ToolArgumentValidationError("Agent 会话与当前服务器不匹配");
      source.agentSession = {
        id: context.agentSession.id, generation: context.agentSession.generation,
        contextRevision: context.agentSession.context.revision,
        cwd: context.agentSession.context.cwd, shell: context.agentSession.context.shell,
      };
    }
    const path = action.toolId === "files.transfer_between_servers" ? args.sourcePath
      : ["files.read_content", "disk.inspect", "files.find_large"].includes(action.toolId) ? args.path : action.toolId === "files.get_structure" ? args.rootPath : undefined;
    if (typeof path === "string") source.path = path;
    targets.push(source);
  }
  if (action.toolId === "files.transfer_between_servers") {
    if (!context.server) throw new ToolArgumentValidationError("文件传输缺少已绑定的源服务器");
    const target = resolveUniqueServer(context.servers, String(args.targetServer));
    if (!target) throw new ToolArgumentValidationError("文件传输目标尚未加入服务器管理", "targetServer");
    if (target.id === context.server.id) throw new ToolArgumentValidationError("源服务器和目标服务器不能相同", "targetServer");
    args.targetServer = target.id;
    targets.push({ ...targetFor(target, "target", context), path: String(args.targetPath), overwrite: args.overwrite === true });
  }
  if (["server.resolve_connection", "server.connect"].includes(action.toolId)) {
    const host = String(args.host), port = Number(args.port ?? 22);
    let username = typeof args.username === "string" ? args.username : undefined;
    const credentialRef = typeof args.credentialRef === "string" ? args.credentialRef : undefined;
    let target: ServerProfile | undefined;
    if (credentialRef) {
      if (args.username !== undefined || args.passwordSecretKey !== undefined) throw new ToolArgumentValidationError("credentialRef 与 username/passwordSecretKey 不能同时指定", "credentialRef");
      if (credentialRef.startsWith("managed-server:")) {
        target = resolveUniqueServer(context.servers, credentialRef.slice("managed-server:".length));
        // A credential ID can never fall back to a coincidentally matching name/host.
        if (!target || `managed-server:${target.id}` !== credentialRef || hostIdentity(target.host) !== hostIdentity(host) || target.port !== port) {
          throw new ToolArgumentValidationError("credentialRef 与目标服务器不匹配", "credentialRef");
        }
        username = target.username;
      } else if (credentialRef.startsWith("server-credential:")) {
        const binding = context.credentialBindings?.[credentialRef];
        if (!binding || hostIdentity(binding.host) !== hostIdentity(host) || (binding.port !== undefined && binding.port !== port)) {
          throw new ToolArgumentValidationError("credentialRef 缺少匹配的服务器凭据绑定", "credentialRef");
        }
        username = binding.username;
      } else throw new ToolArgumentValidationError("credentialRef 类型不受支持", "credentialRef");
    }
    target ??= resolveUniqueServerEndpoint(context.servers, host, port);
    // Direct username/password connects cannot silently reassign an existing server's account.
    if (target && !credentialRef && username !== undefined && target.username !== username) {
      throw new ToolArgumentValidationError("目标服务器已有不同 SSH 账户，请使用明确匹配的连接引用", "username");
    }
    targets.push({
      ...(target ? targetFor(target, action.toolId === "server.connect" ? "connection" : "lookup", context)
        : { role: action.toolId === "server.connect" ? "connection" : "lookup", host, port }),
      ...(username !== undefined ? { username } : {}),
      ...(credentialRef ? { credentialRef } : {}),
      ...(typeof args.passwordSecretKey === "string" ? { passwordSecretKey: args.passwordSecretKey } : {}),
    });
  }
  return { action: finalAction, targets };
}
