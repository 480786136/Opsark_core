import { normalizePlanPreconditions } from "./planNormalizer";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { effectiveOfficialTool } from "@/features/support/officialContent";
import { bindPreparedToolTargets, effectiveToolSemanticContract, prepareFinalToolArguments } from "@/features/tools/toolPreparation";
import type { ToolDefinition } from "@/features/tools/types";
import type {
  AgentSessionRef, ExecutionConstraints, ExecutionInputBinding, ExecutionIntentSemantic,
  ExecutionIntentSnapshot, ExecutionTargetRef, PermissionLevel, PlanProposal, PlanStep,
  PreparedPlan, PreparedStep, ServerProfile,
} from "@/types";

export const EXECUTION_POLICY_VERSION = "core-execution-policy@1";
export interface PlanPreparationContext {
  taskId: string;
  permission: PermissionLevel;
  requirement?: string;
  executionConstraints?: ExecutionConstraints;
  server?: ServerProfile;
  servers: readonly ServerProfile[];
  connectionGeneration?: number;
  connectionGenerations?: Record<string, number>;
  agentSession?: AgentSessionRef;
  credentialBindings?: Record<string, { host: string; port?: number; username?: string; revision?: number }>;
  /** Only references and public versions; never credential values. */
  inputBindings?: ExecutionInputBinding[];
  previous?: PreparedPlan;
}

export class PlanPreparationError extends Error {
  readonly stage = "plan_admission";
  constructor(readonly code: string, message: string, readonly stepId?: string) {
    super(message); this.name = "PlanPreparationError";
  }
}

/** Versioned JSON semantics: sort object keys; preserve arrays, strings, null and scalar types. */
export function canonicalExecutionJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (typeof entry !== "object" || !entry) throw new PlanPreparationError("PREPARATION_VALUE_INVALID", "执行语义包含非 JSON 数据");
    if (seen.has(entry)) throw new PlanPreparationError("PREPARATION_VALUE_INVALID", "执行语义不能循环引用");
    seen.add(entry);
    let result: unknown;
    if (Array.isArray(entry)) result = entry.map(visit);
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(entry))) throw new PlanPreparationError("PREPARATION_VALUE_INVALID", "执行语义必须为普通 JSON 对象");
      result = Object.fromEntries(Object.keys(entry).sort().filter(key => (entry as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, visit((entry as Record<string, unknown>)[key])]));
    }
    seen.delete(entry);
    return result;
  };
  return JSON.stringify(visit(value));
}

// SHA-256 over UTF-8, kept synchronous so admission cannot race an async approval.
// It is an identity checksum, never an authentication token or credential hash.
export function sha256Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes); buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, z] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i]! + w[i]!) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      z = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, z].forEach((value, i) => { h[i] = (h[i]! + value) >>> 0; });
  }
  return h.map(value => value.toString(16).padStart(8, "0")).join("");
}

export function executionDigest(value: unknown): string {
  return `sha256:${sha256Utf8(canonicalExecutionJson(value))}`;
}

export function executionIntentMatches(left?: ExecutionIntentSnapshot, right?: ExecutionIntentSnapshot): boolean {
  return Boolean(left && right && left.version === "execution-intent@1" && right.version === left.version
    && left.algorithm === "sha256" && right.algorithm === left.algorithm
    && left.digest === right.digest && left.digest === executionDigest({ version: left.version, semantic: left.semantic })
    && right.digest === executionDigest({ version: right.version, semantic: right.semantic }));
}

function clone<T>(value: T): T { return JSON.parse(canonicalExecutionJson(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

const PREPARABLE = new Set<PlanStep["status"]>(["pending", "awaiting_approval", "awaiting_input"]);
const STEP_FIELDS = new Set(["action", "retryBasis", "retryAfterStepId", "failureDependencies", "recoveryRuleVersion", "recovery",
  "authenticationGate", "authenticationAttempt", "protocolReplanApproval", "id", "attemptContext", "kind", "title", "description",
  "command", "risk", "expected", "validation", "executionScope", "validationScope", "sessionContextChange", "runtimeClass", "validator",
  "status", "output", "review", "result", "evidence", "startedAt", "elapsedSeconds", "progressMessage", "safetyApprovalSnapshot",
  "approvedSafetySnapshot", "executionIntent", "planRevision", "stepRevision", "approvalGrant",
  "executionLedgerAttempts", "ledgerAppliedAttemptIds", "ledgerVerifiedAttemptIds", "executionPolicy"]);
function shellTargets(context: PlanPreparationContext, step: PlanStep): ExecutionTargetRef[] {
  const server = context.server;
  if (!server || !server.id || !server.host || !server.username || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    throw new PlanPreparationError("EXECUTION_TARGET_REQUIRED", "Shell 步骤尚未绑定明确的服务器身份", step.id);
  }
  const candidates = context.servers.filter(item => item.id === server.id);
  if (candidates.length !== 1 || candidates[0]!.host !== server.host || candidates[0]!.port !== server.port || candidates[0]!.username !== server.username) {
    throw new PlanPreparationError("EXECUTION_TARGET_CHANGED", "服务器身份已变化或不唯一，需要重新准备", step.id);
  }
  const session = context.agentSession;
  if (session && (session.serverId !== server.id || session.taskId !== context.taskId || session.state === "closed")) {
    throw new PlanPreparationError("EXECUTION_SESSION_MISMATCH", "Agent 会话不属于当前任务和目标", step.id);
  }
  return [{ role: "execution", serverId: server.id, host: server.host, port: server.port, username: server.username,
    connectionGeneration: context.connectionGenerations?.[server.id] ?? context.connectionGeneration,
    ...(step.executionScope === "agent_session" && session ? { agentSession: {
      id: session.id, generation: session.generation, contextRevision: session.context.revision,
      cwd: session.context.cwd, shell: session.context.shell,
    } } : {}),
  }];
}

function semanticProjection(step: PlanStep): unknown {
  return { action: step.action, command: step.command, kind: step.kind, risk: step.risk,
    expected: step.expected, validation: step.validation, validator: step.validator,
    executionScope: step.executionScope, validationScope: step.validationScope,
    runtimeClass: step.runtimeClass, sessionContextChange: step.sessionContextChange };
}

/** No I/O, no approval and no historical normalization occurs at this boundary. */
export function preparePlanForApproval(
  proposal: PlanProposal | PlanStep[],
  context: PlanPreparationContext,
  catalog: ToolDefinition[] = defaultToolCatalog,
): PreparedPlan {
  // Admission, approval and dispatch must consume the same effective catalog.
  catalog = catalog.map(effectiveOfficialTool);
  if (!context.taskId || !["observe", "safe", "managed"].includes(context.permission)) {
    throw new PlanPreparationError("PREPARATION_CONTEXT_INVALID", "准备计划需要任务身份和有效权限策略");
  }
  if (context.previous && context.previous.taskId !== context.taskId) {
    throw new PlanPreparationError("PREPARATION_TASK_MISMATCH", "不能复用其他任务的准备结果");
  }
  const original = clone(Array.isArray(proposal) ? proposal : proposal.steps);
  if (!Array.isArray(original) || original.some(step => !step || typeof step.id !== "string" || !step.id)
    || new Set(original.map(step => step.id)).size !== original.length) {
    throw new PlanPreparationError("PLAN_ID_INVALID", "计划步骤需要唯一的稳定 ID");
  }
  const pending = original.filter(step => PREPARABLE.has(step.status));
  const preflight = pending.map(step => {
    if (Object.keys(step).some(key => !STEP_FIELDS.has(key)) || !["low", "medium", "high"].includes(step.risk)
      || typeof step.title !== "string" || typeof step.description !== "string" || typeof step.expected !== "string"
      || (step.kind !== undefined && !["observe", "change"].includes(step.kind))) {
      throw new PlanPreparationError("PLAN_FIELDS_INVALID", "计划包含未声明字段或不合法的执行字段", step.id);
    }
    if (step.action && Object.keys(step.action).some(key => !(step.action!.type === "tool"
      ? ["type", "toolId", "arguments"] : ["type", "command"]).includes(key))) {
      throw new PlanPreparationError("ACTION_FIELDS_INVALID", "动作包含未声明字段", step.id);
    }
    // Approval and execution data are never accepted as model-owned authority.
    const copy = { ...step, status: "pending" as const, executionIntent: undefined, approvalGrant: undefined,
      planRevision: undefined, stepRevision: undefined, executionPolicy: undefined };
    if (copy.action?.type === "tool") {
      // Empty wire placeholders are the only admitted Shell compatibility fields.
      if ((copy.command !== undefined && copy.command !== "") || (copy.validation !== undefined && copy.validation !== "")
        || copy.validator !== undefined || copy.sessionContextChange != null) {
        throw new PlanPreparationError("TOOL_SHELL_FIELDS_FORBIDDEN", "工具提案夹带 Shell 字段，不能通过清理后执行", copy.id);
      }
      const definition = catalog.find(tool => copy.action?.type === "tool" && tool.id === copy.action.toolId);
      if (!definition || !definition.enabled) throw new PlanPreparationError("TOOL_UNAVAILABLE", "工具不存在或已禁用", copy.id);
      copy.action = { ...copy.action, arguments: prepareFinalToolArguments(definition, copy.action.arguments) };
      copy.command = ""; copy.validation = "";
    }
    return copy;
  });
  const normalized = normalizePlanPreconditions(preflight, context.requirement ?? "", catalog);
  const previousById = new Map(context.previous?.steps.map(step => [step.id, step]) ?? []);
  const changes: PreparedPlan["changes"] = [];
  const preparedSteps: PreparedStep[] = [];
  const normalizedById = new Map<string, PlanStep>();
  for (const step of normalized) {
    const originalStep = pending.find(item => item.id === step.id)!;
    let targets: ExecutionTargetRef[];
    let toolContract: Record<string, unknown> | undefined;
    let effect: ExecutionIntentSemantic["effect"];
    if (step.action?.type === "tool") {
      const definition = catalog.find(tool => tool.id === (step.action as Extract<NonNullable<PlanStep["action"]>, { type: "tool" }>).toolId)!;
      const bound = bindPreparedToolTargets(step.action, context);
      step.action = bound.action;
      targets = bound.targets;
      toolContract = effectiveToolSemanticContract(definition);
      effect = definition.effect ?? "change";
      step.kind = effect === "change" ? "change" : "observe";
      // Tool evidence comes only from its own result contract, never Shell scope/validators.
      delete step.validator; delete step.executionScope; delete step.validationScope; delete step.runtimeClass;
    } else {
      if (!step.action || step.action.type !== "shell") throw new PlanPreparationError("ACTION_REQUIRED", "准备后的步骤缺少可执行动作", step.id);
      targets = shellTargets(context, step); effect = step.kind === "observe" ? "read" : "change";
    }
    const position = original.findIndex(item => item.id === step.id);
    const semantic: ExecutionIntentSemantic = clone({
      taskId: context.taskId, stepId: step.id, action: step.action!, targets, kind: step.kind!, effect,
      risk: step.risk, expected: step.expected,
      ...(step.action.type === "shell" ? { executionScope: step.executionScope, validationScope: step.validationScope,
        validation: step.validation, validator: step.validator, runtimeClass: step.runtimeClass, sessionContextChange: step.sessionContextChange } : {}),
      dependencies: { precedingStepIds: original.slice(0, position).map(item => item.id), retryBasis: step.retryBasis,
        retryAfterStepId: step.retryAfterStepId, failureDependencies: step.failureDependencies, recovery: step.recovery,
        recoveryRuleVersion: step.recoveryRuleVersion, protocolReplanApproval: step.protocolReplanApproval },
      permission: context.permission, constraints: context.executionConstraints, policyVersion: EXECUTION_POLICY_VERSION,
      toolContract, inputBindings: context.inputBindings,
    });
    const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256",
      digest: executionDigest({ version: "execution-intent@1", semantic }), semantic };
    const previous = previousById.get(step.id);
    const stepRevision = previous ? previous.stepRevision + (executionIntentMatches(previous.intent, intent) ? 0 : 1) : 1;
    preparedSteps.push(step.action.type === "tool"
      ? { id: step.id, stepRevision, type: "tool", action: step.action, intent }
      : { id: step.id, stepRevision, type: "shell", action: step.action, validator: step.validator, intent });
    const before = semanticProjection(originalStep) as Record<string, unknown>;
    const after = semanticProjection(step) as Record<string, unknown>;
    const fields = Object.keys(after).filter(key => canonicalExecutionJson({ value: before[key] }) !== canonicalExecutionJson({ value: after[key] }));
    if (fields.length) changes.push({ stepId: step.id, fields });
    step.status = originalStep.status;
    step.executionIntent = intent; step.stepRevision = stepRevision;
    // Existing grants are retained only as records; callers verify them against this intent.
    step.approvalGrant = originalStep.approvalGrant;
    normalizedById.set(step.id, step);
  }
  // Completed members of this same stage retain their original frozen intent.
  // Merely recording a result must not revoke authorization of the next member.
  const preparedById = new Map(preparedSteps.map(step => [step.id, step]));
  const stageSteps = original.flatMap(step => {
    const current = preparedById.get(step.id);
    if (current) return [current];
    const historical = previousById.get(step.id);
    return historical ? [clone(historical)] : [];
  });
  const digest = executionDigest({ version: "prepared-plan@1", taskId: context.taskId,
    steps: stageSteps.map(step => ({ id: step.id, intent: step.intent.digest })) });
  const planRevision = context.previous ? context.previous.planRevision + (context.previous.executionDigest === digest ? 0 : 1) : 1;
  const compatibilitySteps = original.map(step => normalizedById.get(step.id) ?? step);
  compatibilitySteps.forEach(step => { if (normalizedById.has(step.id)) step.planRevision = planRevision; });
  return freeze({ version: "prepared-plan@1", taskId: context.taskId, planRevision, executionDigest: digest,
    displayDigest: executionDigest(compatibilitySteps.map(step => ({ id: step.id, title: step.title, description: step.description }))),
    steps: stageSteps, compatibilitySteps, changes });
}
