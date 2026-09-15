import { parameterContext, validateRequestParameters } from "@/features/agent/modelParameters";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentSessionContext, AgentSessionRef, AiGenerationSettings, ExecutionScope, FileEntry, Metrics, ModelDeveloperTrace, NextStageDecision, PlanStep, RequirementProcessingResult, ServerInfo, StepReview } from "@/types";
import type { ModelSkillDefinition } from "@/features/skills/types";
import {
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
  normalizeToolCommandSyntax,
} from "@/features/agent/planNormalizer";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import { buildExecutionSummary } from "@/features/agent/executionSummary";
import {
  normalizeFileStructureRequest,
} from "@/features/tools/fileStructure";
import type { FileStructureRequest, FileStructureScanResult } from "@/features/tools/types";
import {
  analyzePlanStepSafety as analyzePlanStepSafetyLocally,
} from "@/features/agent/planSafety";
import type { PlanStepSafetyAnalysis } from "@/features/agent/planSafety";
import { isTerminalTransportFailure } from "@/features/agent/adjustmentIncident";
import { planCommandIdentity } from "@/features/agent/taskProgression";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface RuntimeConnection {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RuntimeModel {
  requestParameters?: import("@/types").ModelRequestParameters;
  timeoutSeconds?: number;
  logContext?: Record<string, unknown>;
  apiKey: string;
  endpoint: string;
  model: string;
  context: string;
  generationSettings?: AiGenerationSettings;
}

const MODEL_TRACE_ERROR_PREFIX = "OPSARK_MODEL_TRACE_V1:";

export class ModelInvocationError extends Error {
  developerTrace?: ModelDeveloperTrace;

  constructor(message: string, developerTrace?: ModelDeveloperTrace) {
    super(message);
    this.name = "ModelInvocationError";
    this.developerTrace = developerTrace;
  }
}

function normalizeModelInvocationError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.indexOf(MODEL_TRACE_ERROR_PREFIX);
  if (marker < 0) return error instanceof Error ? error : new Error(raw);
  try {
    const parsed = JSON.parse(raw.slice(marker + MODEL_TRACE_ERROR_PREFIX.length)) as {
      message?: string;
      developerTrace?: ModelDeveloperTrace;
    };
    return new ModelInvocationError(parsed.message || "模型调用失败", parsed.developerTrace);
  } catch {
    return new Error(raw);
  }
}

export interface SshProbe {
  info: ServerInfo;
  environment: string[];
  hostname: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
  generation: number;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export interface TerminalStatusEvent {
  terminalId: string;
  generation: number;
  status: "connecting" | "connected" | "disconnected" | "error";
  reason?: string | null;
  retryable: boolean;
}

export interface SftpTransferProgressEvent {
  transferId: string;
  direction: "upload" | "download" | "server";
  transferredBytes: number;
  totalBytes: number;
  status: "running" | "completed";
}

export interface ServerTransferResult {
  sourcePath: string;
  targetPath: string;
  transferredBytes: number;
  sha256: string;
}

export interface CommandOutputEvent {
  executionId: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export interface AgentTerminalOutputEvent {
  sessionId: string;
  generation: number;
  executionId?: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "begin" | "end" | "error";
}

export interface AgentPromptCredential {
  kind: "password" | "git-https";
  secret: string;
  username?: string;
  target?: string;
}

export interface AgentCommandResult {
  output: string;
  success: boolean;
  simulated: false;
  exitCode: number;
  emptyResult: boolean;
  sessionId: string;
  generation: number;
  scope: ExecutionScope;
}

export interface AgentRuntimeProgress {
  active: boolean;
  processCount: number;
  cpuPercent: number;
  ioBytes: number;
}

export type CredentialKind = "server" | "model" | "secret" | "knowledge";

export {
  buildExecutionSummary,
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
};

function requireDesktopRuntime(operation: string): never {
  throw new Error(`${operation} 仅支持 Opsark 桌面端真实连接`);
}

export interface PlanNormalizationRepair {
  errorCode: "tool_schema_validation_failed" | "plan_normalization_failed";
  repairStrategy?:
    | { type: "field_local" }
    | { type: "plan_protocol" }
    | { type: "standalone_stage_split"; standaloneStepIndex: number; toolId: string };
  fieldPath?: string;
  expected?: string;
  validationError: string;
  previousModelOutput: PlanStep[];
  instruction: string;
}

export class PlanProtocolError extends Error {
  processed?: RequirementProcessingResult;
  constructor(public repair: PlanNormalizationRepair, public repairError: string) {
    super(`计划协议校验失败：${repair.validationError}\n协议修复失败：${repairError}。未执行该计划，原始计划已保留；仅允许修复协议，不得重规划业务。`);
    this.name = "PlanProtocolError";
  }
}

type StandaloneStageSplitStrategy = Extract<NonNullable<PlanNormalizationRepair["repairStrategy"]>, {
  type: "standalone_stage_split";
}>;
const STANDALONE_STAGE_SPLIT_EXPECTED = "当前执行阶段按原顺序确定性拆分：standalone 之前有步骤时只保留未改写的完整连续前缀；standalone 位于首步时只保留该原步骤；其余整体目标步骤延后到后续规划";

function standaloneStageSplitStrategy(validationError: string): StandaloneStageSplitStrategy | undefined {
  if (!validationError.includes("standalone 工具必须是唯一待执行步骤")) return undefined;
  const match = validationError.match(/第\s*(\d+)\s*个计划步骤调用 standalone 工具\s+([^\s；;]+)/);
  return match
    ? { type: "standalone_stage_split", standaloneStepIndex: Math.max(0, Number(match[1]) - 1), toolId: match[2] }
    : undefined;
}

function standaloneStageSplitInstruction(strategy: StandaloneStageSplitStrategy) {
  return `这是全局阶段协议修复，不是业务重规划。Core 将确定性缩小当前执行阶段：若第 ${strategy.standaloneStepIndex + 1} 步 ${strategy.toolId} standalone 之前存在步骤，本轮只保留原计划开头至该步之前的完整连续前缀；若该 standalone 位于首步，本轮只保留该原步骤。未进入本轮的原步骤只是延后到 completionMode=refine 的后续阶段，不是删除整体目标。保持整体目标和用户授权不变；不得新增、重排或改写任何返回步骤的字段、工具或命令。`;
}

/** Upgrades a persisted pre-strategy repair without changing its preserved model output. */
function normalizePlanRepairStrategy(repair: PlanNormalizationRepair): PlanNormalizationRepair {
  const strategy = repair.repairStrategy?.type === "standalone_stage_split"
    ? repair.repairStrategy
    : standaloneStageSplitStrategy(repair.validationError);
  if (!strategy) return repair;
  return {
    ...repair,
    repairStrategy: strategy,
    fieldPath: "steps",
    expected: STANDALONE_STAGE_SPLIT_EXPECTED,
    instruction: standaloneStageSplitInstruction(strategy),
  };
}

/** Builds the bounded, non-secret feedback used for one model protocol-repair attempt. */
export function buildPlanNormalizationRepair(error: unknown, steps: PlanStep[]): PlanNormalizationRepair {
  const validationError = String(error);
  const stepNumber = validationError.match(/第\s*(\d+)\s*个计划步骤/)?.[1];
  const credentialType = validationError.match(/凭据参数\s+([A-Za-z][A-Za-z0-9_]*)\s+必须使用 password 类型/);
  const credentialTarget = validationError.match(/参数\s+([A-Za-z][A-Za-z0-9_]*)\s+的 credential\.target/);
  const standaloneStrategy = standaloneStageSplitStrategy(validationError);
  const repairStrategy: NonNullable<PlanNormalizationRepair["repairStrategy"]> = standaloneStrategy
    ? standaloneStrategy
    : validationError.includes("工具参数无效")
      ? { type: "field_local" }
      : { type: "plan_protocol" };
  return {
    errorCode: validationError.includes("工具参数无效")
      ? "tool_schema_validation_failed"
      : "plan_normalization_failed",
    repairStrategy,
    fieldPath: standaloneStrategy
      ? "steps"
      : credentialType
        ? `steps[${Math.max(0, Number(stepNumber ?? 1) - 1)}].command.arguments.fields[key=${credentialType[1]}].type`
        : credentialTarget
          ? `steps[${Math.max(0, Number(stepNumber ?? 1) - 1)}].command.arguments.fields[key=${credentialTarget[1]}].credential.target`
          : stepNumber
            ? `steps[${Math.max(0, Number(stepNumber) - 1)}]`
            : undefined,
    expected: standaloneStrategy
      ? STANDALONE_STAGE_SPLIT_EXPECTED
      : credentialType ? "password" : credentialTarget ? "已确认的主机:端口或明确的 socket 绝对路径；遵守 credential.kind 对应目标规则" : undefined,
    validationError,
    previousModelOutput: steps,
    instruction: standaloneStrategy
      ? standaloneStageSplitInstruction(standaloneStrategy)
      : "只修复上述结构或工具参数错误；保持业务目的、步骤范围、风险和用户授权不变，不增加无关步骤。工具参数修复必须逐字保留每个步骤的 kind、title、description、risk、expected、validation 及步骤数量；只修改报错步骤 command 内的错误参数，不要润色描述或重写计划。",
  };
}

function contextWithPlanRepair(context: string, repair: PlanNormalizationRepair) {
  try {
    const parsed = JSON.parse(context) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, planGenerationRepair: repair });
    }
  } catch {
    // Preserve an opaque legacy context without attempting to reinterpret it.
  }
  return JSON.stringify({ originalContext: context, planGenerationRepair: repair });
}

export function assertPlanRepairScope(repair: PlanNormalizationRepair, repaired: PlanStep[]) {
  repair = normalizePlanRepairStrategy(repair);
  if (repair.repairStrategy?.type === "standalone_stage_split") {
    const { standaloneStepIndex, toolId } = repair.repairStrategy;
    const originalStandalone = repair.previousModelOutput[standaloneStepIndex];
    let originalTool: string | undefined;
    try {
      originalTool = originalStandalone
        ? parseToolCommand(normalizeToolCommandSyntax(originalStandalone.command), "standalone-repair-context")?.toolId
        : undefined;
    } catch { /* The preserved plan is rejected below as inconsistent. */ }
    if (!originalStandalone || originalTool !== toolId) {
      throw new Error("standalone 阶段修复上下文与原计划不一致");
    }
    if (!repaired.length) throw new Error("standalone 阶段修复必须返回非空的原计划阶段子集");
    const authoredFields = [
      "kind", "title", "description", "command", "risk", "expected", "validation",
      "executionScope", "validationScope", "sessionContextChange", "runtimeClass", "status",
    ] as const;
    const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    const sameAuthoredStep = (previous: PlanStep, candidate: PlanStep) => authoredFields.every((field) => (
      stable(previous[field]) === stable(candidate[field])
    ));
    const standaloneOnly = repaired.length === 1 && sameAuthoredStep(originalStandalone, repaired[0]);
    const precedingPrefix = repaired.length <= standaloneStepIndex
      && repaired.every((candidate, index) => sameAuthoredStep(repair.previousModelOutput[index], candidate));
    const stillMixed = repaired.length > 1
      && repaired.some((candidate) => sameAuthoredStep(originalStandalone, candidate));
    if (stillMixed) {
      throw new Error("standalone 阶段修复后仍将 standalone 工具与其他待执行步骤混排");
    }
    if (!standaloneOnly && !precedingPrefix) {
      throw new Error("standalone 阶段修复只能返回原计划的连续前置阶段或未改写的 standalone 单步；不得新增、重排或改写字段、工具和命令");
    }
    return;
  }
  if (repair.errorCode !== "tool_schema_validation_failed") return;
  if (repair.previousModelOutput.length !== repaired.length) {
    throw new Error("工具参数格式修复不得改变计划步骤数量");
  }
  const immutable = ["kind", "title", "description", "risk", "expected", "validation"] as const;
  const errorStep = repair.fieldPath?.match(/^steps\[(\d+)\]/)?.[1];
  repair.previousModelOutput.forEach((previous, index) => {
    const changed = immutable.find((field) => previous[field] !== repaired[index]?.[field]);
    if (changed) throw new Error(`工具参数格式修复不得改写 steps[${index}].${changed}`);
    const originalTool = previous.command.match(/^opsark-tool\s+(\S+)/)?.[1];
    if (originalTool !== repaired[index]?.command.match(/^opsark-tool\s+(\S+)/)?.[1]) {
      throw new Error("工具参数修复不得替换工具或转成 Shell 命令");
    }
    if ((!originalTool || (errorStep !== undefined && index !== Number(errorStep))) && previous.command !== repaired[index].command) {
      throw new Error(`工具参数格式修复不得改写无关命令 steps[${index}].command`);
    }
    const localField = repair.fieldPath?.match(/fields\[key=([^\]]+)\]\.(type|credential\.target)$/);
    if (originalTool && localField && index === Number(errorStep)) {
      const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      const remainder = (command: string) => {
        const args = JSON.parse(command.replace(/^opsark-tool\s+\S+\s+/, ""));
        const field = args.fields?.find((item: { key?: string }) => item.key === localField[1]);
        if (!field) throw new Error("协议修复不得删除报错字段");
        if (localField[2] === "type") delete field.type;
        else if (field.credential) delete field.credential.target;
        return stable(args);
      };
      if (remainder(previous.command) !== remainder(repaired[index].command)) {
        throw new Error("协议修复只能修改报错字段，不能改写其他工具参数");
      }
    }
  });
}

function normalizeStandaloneRepairStage(
  repair: PlanNormalizationRepair,
  requirement: string,
  context: string,
): PlanStep[] | undefined {
  repair = normalizePlanRepairStrategy(repair);
  if (repair.repairStrategy?.type !== "standalone_stage_split") return undefined;
  const { standaloneStepIndex } = repair.repairStrategy;
  const originalStandalone = repair.previousModelOutput[standaloneStepIndex];
  const validationStage = standaloneStepIndex > 0
    ? repair.previousModelOutput.slice(0, standaloneStepIndex)
    : originalStandalone ? [originalStandalone] : [];
  assertPlanRepairScope(repair, validationStage);

  const completed = completedPlanEvidence(context);
  let firstRemaining = 0;
  while (firstRemaining < repair.previousModelOutput.length
    && completedPlanStep(repair.previousModelOutput[firstRemaining], completed)) {
    firstRemaining += 1;
  }
  if (firstRemaining >= repair.previousModelOutput.length) {
    throw new Error("standalone 阶段拆分后没有新的待执行步骤");
  }

  const remaining = repair.previousModelOutput.slice(firstRemaining);
  try {
    return normalizePlanPreconditions(remaining, requirement);
  } catch (error) {
    const remainingRepair = buildPlanNormalizationRepair(error, remaining);
    if (remainingRepair.repairStrategy?.type !== "standalone_stage_split") {
      throw new PlanProtocolError(
        remainingRepair,
        "确定性拆分后的剩余计划仍未通过协议校验",
      );
    }
    const nextStandaloneIndex = remainingRepair.repairStrategy.standaloneStepIndex;
    const nextStandalone = remaining[nextStandaloneIndex];
    const stage = nextStandaloneIndex > 0
      ? remaining.slice(0, nextStandaloneIndex)
      : nextStandalone ? [nextStandalone] : [];
    assertPlanRepairScope(remainingRepair, stage);
    try {
      return normalizePlanPreconditions(stage, requirement);
    } catch (stageError) {
      const stageRepair = buildPlanNormalizationRepair(stageError, stage);
      throw new PlanProtocolError(
        stageRepair,
        "确定性拆分出的当前阶段仍未通过协议校验",
      );
    }
  }
}

interface CompletedPlanEvidence {
  fingerprints: Set<string>;
}

function completedPlanEvidence(context: string): CompletedPlanEvidence {
  const evidence: CompletedPlanEvidence = { fingerprints: new Set() };
  const record = (value: unknown): Record<string, unknown> | undefined => (
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  );
  const collect = (value: unknown, depth = 0) => {
    const root = record(value);
    if (!root || depth > 1) return;
    if (Array.isArray(root.completedCommandFingerprints)) {
      root.completedCommandFingerprints.forEach((fingerprint) => {
        if (typeof fingerprint === "string") evidence.fingerprints.add(fingerprint);
      });
    }
    if (typeof root.originalContext === "string") {
      try { collect(JSON.parse(root.originalContext), depth + 1); } catch { /* Opaque legacy context. */ }
    }
  };
  try { collect(JSON.parse(context || "{}")); } catch { /* Opaque legacy context. */ }
  return evidence;
}

function completedPlanStep(step: PlanStep, evidence: CompletedPlanEvidence) {
  return evidence.fingerprints.has(textFingerprint(planCommandIdentity(step.command)));
}

function planProtocolRepairRequirement(repair: PlanNormalizationRepair) {
  return `只修复 context.planGenerationRepair 中保留的原计划协议。不得改变业务、工具、步骤范围或授权。${repair.instruction}`;
}

export const backend = {
  async appendTaskLog(stream: "events" | "developer-events", event: unknown, context: unknown) {
    if (isTauri()) await invoke("append_task_log", { stream, event, context });
  },
  async saveTaskEvidence(taskId: string, record: Record<string, unknown>) {
    if (!isTauri()) throw new Error("证据持久化需要桌面存储");
    return invoke<string>("save_task_evidence", { taskId, record });
  },
  async readTaskEvidence(taskId: string, evidenceId: string, offset: number, limit: number) {
    return invoke<Record<string, unknown>>("read_task_evidence", { taskId, evidenceId, offset, limit });
  },
  async saveCredential(kind: CredentialKind, id: string, value: string) {
    if (!isTauri()) return;
    await invoke("save_credential", { kind, id, value });
  },

  async loadCredential(kind: CredentialKind, id: string): Promise<string | null> {
    if (!isTauri()) return null;
    return invoke<string | null>("load_credential", { kind, id });
  },

  async deleteCredential(kind: CredentialKind, id: string) {
    if (!isTauri()) return;
    await invoke("delete_credential", { kind, id });
  },

  async checkSshConnection(connection: RuntimeConnection, timeoutMs = 5000): Promise<void> {
    if (!isTauri()) return requireDesktopRuntime("SSH 连接确认");
    return invoke<void>("check_ssh_connection", { ...connection, timeoutMs });
  },

  async probeSsh(connection: RuntimeConnection): Promise<SshProbe> {
    if (!isTauri()) {
      return requireDesktopRuntime("SSH 连接");
    }
    return invoke("probe_ssh_server", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
  },

  async createAgentTerminal(
    serverId: string,
    taskId: string,
    connection: Omit<RuntimeConnection, "password">,
  ): Promise<AgentSessionRef> {
    if (!isTauri()) return requireDesktopRuntime("Agent 沙箱终端");
    return invoke<AgentSessionRef>("create_agent_terminal", { serverId, taskId, ...connection });
  },

  async updateAgentSessionContext(session: AgentSessionRef, context: AgentSessionContext) {
    if (!isTauri()) return requireDesktopRuntime("Agent 会话上下文");
    return invoke<AgentSessionRef>("update_agent_session_context", {
      sessionId: session.id,
      generation: session.generation,
      context,
    });
  },

  async executeAgentCommand(input: {
    connection: RuntimeConnection;
    session: Pick<AgentSessionRef, "id" | "generation">;
    executionId: string;
    command: string;
    scope: ExecutionScope;
    approvedHighRisk: boolean;
    promptCredential?: AgentPromptCredential;
    onProgress?(event: AgentTerminalOutputEvent): void;
    onSessionInvalidated?(generation?: number): void;
  }): Promise<AgentCommandResult> {
    if (!isTauri()) return requireDesktopRuntime("Agent 沙箱命令执行");
    let unlisten: (() => void) | undefined;
    if (input.onProgress || input.onSessionInvalidated) {
      unlisten = await listen<AgentTerminalOutputEvent>("agent-terminal-output", (event) => {
        if (event.payload.sessionId === input.session.id
          && event.payload.executionId === input.executionId
          && event.payload.stream === "error"
          && event.payload.generation > input.session.generation) {
          input.onSessionInvalidated?.(event.payload.generation);
          return;
        }
        if (
          event.payload.sessionId === input.session.id
          && event.payload.generation === input.session.generation
          && event.payload.executionId === input.executionId
        ) input.onProgress?.(event.payload);
      });
    }
    try {
      return await invoke<AgentCommandResult>("execute_agent_terminal_command", {
        ...input.connection,
        sessionId: input.session.id,
        generation: input.session.generation,
        executionId: input.executionId,
        command: input.command,
        scope: input.scope,
        approvedHighRisk: input.approvedHighRisk,
        promptCredential: input.promptCredential,
      });
    } catch (error) {
      if (isTerminalTransportFailure(error)) input.onSessionInvalidated?.();
      throw error;
    } finally {
      unlisten?.();
    }
  },

  async interruptAgentCommand(
    connection: RuntimeConnection,
    session: Pick<AgentSessionRef, "id" | "generation">,
    executionId: string,
  ) {
    if (!isTauri()) return false;
    return invoke<boolean>("interrupt_agent_terminal_command", {
      ...connection,
      sessionId: session.id,
      generation: session.generation,
      executionId,
    });
  },

  async sampleAgentExecutionProgress(
    connection: RuntimeConnection,
    session: Pick<AgentSessionRef, "id" | "generation">,
    executionId: string,
  ): Promise<AgentRuntimeProgress> {
    if (!isTauri()) return requireDesktopRuntime("Agent 运行态采样");
    return invoke<AgentRuntimeProgress>("sample_agent_terminal_progress", {
      ...connection,
      sessionId: session.id,
      generation: session.generation,
      executionId,
    });
  },

  async closeAgentTerminal(sessionId: string) {
    if (!isTauri()) return;
    await invoke("close_agent_terminal", { sessionId });
  },

  async startTerminal(terminalId: string, connection: RuntimeConnection, cols = 120, rows = 32) {
    if (!isTauri()) return requireDesktopRuntime("SSH 终端");
    return invoke<number>("start_ssh_terminal", { terminalId, ...connection, cols, rows });
  },

  async writeTerminal(terminalId: string, data: string) {
    if (!isTauri()) return;
    await invoke("write_ssh_terminal", { terminalId, data });
  },

  async resizeTerminal(terminalId: string, cols: number, rows: number) {
    if (!isTauri()) return;
    await invoke("resize_ssh_terminal", { terminalId, cols, rows });
  },

  async closeTerminal(terminalId: string) {
    if (!isTauri()) return;
    await invoke("close_ssh_terminal", { terminalId });
  },

  async onTerminalOutput(callback: (event: TerminalOutputEvent) => void) {
    if (!isTauri()) return () => {};
    return listen<TerminalOutputEvent>("terminal-output", (event) => callback(event.payload));
  },

  async onTerminalStatus(callback: (event: TerminalStatusEvent) => void) {
    if (!isTauri()) return () => {};
    return listen<TerminalStatusEvent>("terminal-status", (event) => callback(event.payload));
  },

  async getMetrics(): Promise<Metrics> {
    if (isTauri()) {
      const metrics = await invoke<Metrics>("get_realtime_metrics");
      return { ...metrics, sampledAt: new Date().toISOString() };
    }
    return requireDesktopRuntime("实时指标采集");
  },

  async getSshMetrics(connection: RuntimeConnection): Promise<Metrics> {
    if (!isTauri()) return requireDesktopRuntime("SSH 实时指标采集");
    const metrics = await invoke<Metrics>("get_ssh_metrics", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
    return { ...metrics, sampledAt: new Date().toISOString() };
  },

  async listSftp(connection: RuntimeConnection, path: string): Promise<FileEntry[]> {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 目录读取");
    }
    const entries = await invoke<FileEntry[]>("list_sftp_directory", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      path,
    });
    return entries.map((entry) => ({
      ...entry,
      modified: /^\d+$/.test(entry.modified)
        ? new Date(Number(entry.modified) * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric" })
        : entry.modified,
    }));
  },

  async getRemoteFileStructure(
    connection: RuntimeConnection,
    request: FileStructureRequest,
  ): Promise<FileStructureScanResult> {
    const normalized = normalizeFileStructureRequest(request);
    if (!isTauri()) {
      return requireDesktopRuntime("远程文件结构读取");
    }
    return invoke<FileStructureScanResult>("get_remote_file_structure", {
      ...connection,
      ...normalized,
    });
  },

  async createSftpDirectory(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 创建目录");
    await invoke("create_sftp_directory", { ...connection, path });
  },

  async renameSftpEntry(connection: RuntimeConnection, fromPath: string, toPath: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 重命名");
    await invoke("rename_sftp_entry", { ...connection, fromPath, toPath });
  },

  async deleteSftpEntry(connection: RuntimeConnection, path: string, kind: FileEntry["kind"]) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 删除");
    await invoke("delete_sftp_entry", { ...connection, path, kind });
  },

  async readSftpFile(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 文件读取");
    const bytes = await invoke<number[]>("read_sftp_file", { ...connection, path });
    return new Uint8Array(bytes);
  },

  async readSftpFilePrefix(connection: RuntimeConnection, path: string, maxBytes: number) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 有界文件读取");
    const result = await invoke<{ data: number[]; totalBytes: number }>("read_sftp_file_prefix", {
      ...connection,
      path,
      maxBytes,
    });
    return { data: new Uint8Array(result.data), totalBytes: result.totalBytes };
  },

  async writeSftpFile(connection: RuntimeConnection, path: string, data: Uint8Array) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 文件写入");
    await invoke("write_sftp_file", { ...connection, path, data: Array.from(data) });
  },

  async readLocalFileForUpload(path: string) {
    if (!isTauri()) return requireDesktopRuntime("读取拖放文件");
    const bytes = await invoke<number[]>("read_local_file_for_upload", { path });
    return new Uint8Array(bytes);
  },

  async uploadSftpTransfer(
    connection: RuntimeConnection,
    transferId: string,
    path: string,
    data: Uint8Array,
    onProgress: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 上传");
    }
    const unlisten = await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
      if (event.payload.transferId === transferId) onProgress(event.payload);
    });
    try {
      await invoke("upload_sftp_transfer", {
        ...connection,
        transferId,
        path,
        data: Array.from(data),
      });
    } finally {
      unlisten();
    }
  },

  async downloadSftpTransfer(
    connection: RuntimeConnection,
    transferId: string,
    path: string,
    onProgress: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 下载");
    }
    const unlisten = await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
      if (event.payload.transferId === transferId) onProgress(event.payload);
    });
    try {
      const bytes = await invoke<number[]>("download_sftp_transfer", { ...connection, transferId, path });
      return new Uint8Array(bytes);
    } finally {
      unlisten();
    }
  },

  async transferSftpBetweenServers(
    source: RuntimeConnection,
    target: RuntimeConnection,
    transferId: string,
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    onProgress?: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) return requireDesktopRuntime("跨服务器文件传输");
    const unlisten = onProgress
      ? await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
          if (event.payload.transferId === transferId) onProgress(event.payload);
        })
      : undefined;
    try {
      return await invoke<ServerTransferResult>("transfer_sftp_between_servers", {
        transferId,
        sourceHost: source.host,
        sourcePort: source.port,
        sourceUsername: source.username,
        sourcePassword: source.password,
        sourcePath,
        targetHost: target.host,
        targetPort: target.port,
        targetUsername: target.username,
        targetPassword: target.password,
        targetPath,
        overwrite,
      });
    } finally {
      unlisten?.();
    }
  },

  async cancelSftpTransfer(transferId: string) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 传输取消");
    }
    return invoke<boolean>("cancel_sftp_transfer", { transferId });
  },

  async generatePlan(requirement: string, runtimeModel?: RuntimeModel): Promise<PlanStep[]> {
    if (isTauri() && runtimeModel?.apiKey) {
      let pendingRepair: PlanNormalizationRepair | undefined;
      try { pendingRepair = JSON.parse(runtimeModel.context || "{}").planGenerationRepair; } catch { /* legacy context */ }
      if (pendingRepair) {
        pendingRepair = normalizePlanRepairStrategy(pendingRepair);
        try {
          const localStage = normalizeStandaloneRepairStage(pendingRepair, requirement, runtimeModel.context);
          if (localStage) return localStage;
        } catch (error) {
          if (error instanceof PlanProtocolError) throw error;
          throw new PlanProtocolError(pendingRepair, String(normalizeModelInvocationError(error)));
        }
        try {
          const repaired = await invoke<PlanStep[]>("generate_ai_plan", {
            apiKey: runtimeModel.apiKey, endpoint: runtimeModel.endpoint, model: runtimeModel.model,
            requirement: planProtocolRepairRequirement(pendingRepair),
            context: parameterContext(contextWithPlanRepair(runtimeModel.context, pendingRepair), runtimeModel.requestParameters),
            generationSettings: runtimeModel.generationSettings, timeoutSeconds: runtimeModel.timeoutSeconds,
          });
          assertPlanRepairScope(pendingRepair, repaired);
          return normalizePlanPreconditions(repaired, requirement);
        } catch (error) {
          throw new PlanProtocolError(pendingRepair, String(normalizeModelInvocationError(error)));
        }
      }
      let steps: PlanStep[];
      try {
        steps = await invoke<PlanStep[]>("generate_ai_plan", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          context: parameterContext(runtimeModel.context, runtimeModel.requestParameters),
          generationSettings: runtimeModel.generationSettings,
          timeoutSeconds: runtimeModel.timeoutSeconds,
        });
      } catch (error) {
        throw normalizeModelInvocationError(error);
      }
      try {
        return normalizePlanPreconditions(steps, requirement);
      } catch (firstError) {
        const repair = buildPlanNormalizationRepair(firstError, steps);
        try {
          const localStage = normalizeStandaloneRepairStage(repair, requirement, runtimeModel.context);
          if (localStage) return localStage;
        } catch (repairError) {
          if (repairError instanceof PlanProtocolError) throw repairError;
          throw new PlanProtocolError(repair, String(normalizeModelInvocationError(repairError)));
        }
        try {
          const repaired = await invoke<PlanStep[]>("generate_ai_plan", {
            apiKey: runtimeModel.apiKey,
            endpoint: runtimeModel.endpoint,
            model: runtimeModel.model,
            requirement: `${requirement}\n\n上次计划未通过本地协议校验。${planProtocolRepairRequirement(repair)}`,
            context: parameterContext(contextWithPlanRepair(runtimeModel.context, repair), runtimeModel.requestParameters),
            generationSettings: runtimeModel.generationSettings,
            timeoutSeconds: runtimeModel.timeoutSeconds,
          });
          assertPlanRepairScope(repair, repaired);
          return normalizePlanPreconditions(repaired, requirement);
        } catch (repairError) {
          throw new PlanProtocolError(repair, String(normalizeModelInvocationError(repairError)));
        }
      }
    }
    if (isTauri()) return Promise.reject(new Error("未配置真实大模型连接，拒绝生成预制计划"));
    return requireDesktopRuntime("智能计划生成");
  },

  async analyzePlanStepSafety(
    command: string,
    validation: string,
    repair = false,
  ): Promise<PlanStepSafetyAnalysis> {
    if (!isTauri()) return analyzePlanStepSafetyLocally(command, validation, repair);
    return invoke<PlanStepSafetyAnalysis>("analyze_plan_step_safety", {
      command,
      validation,
      repair,
    });
  },

  async processRequirement(
    requirement: string,
    runtimeModel: RuntimeModel,
    skillDefinitions: ModelSkillDefinition[] = [],
  ): Promise<RequirementProcessingResult> {
    if (isTauri()) {
      let result: RequirementProcessingResult;
      try {
        result = await invoke<RequirementProcessingResult>("process_ai_requirement", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          context: parameterContext(runtimeModel.context, runtimeModel.requestParameters),
          skillDefinitions,
          generationSettings: runtimeModel.generationSettings,
          timeoutSeconds: runtimeModel.timeoutSeconds,
        });
      } catch (error) {
        throw normalizeModelInvocationError(error);
      }
      try {
        return { ...result, plan: normalizePlanPreconditions(result.plan, requirement) };
      } catch (firstError) {
        const repair = buildPlanNormalizationRepair(firstError, result.plan);
        try {
          const repaired = await backend.generatePlan(requirement, {
            ...runtimeModel,
            context: contextWithPlanRepair(runtimeModel.context, repair),
          });
          return { ...result, plan: repaired };
        } catch (repairError) {
          const error = repairError instanceof PlanProtocolError ? repairError
            : new PlanProtocolError(repair, String(normalizeModelInvocationError(repairError)));
          error.processed = result;
          throw error;
        }
      }
    }
    return requireDesktopRuntime("智能需求处理");
  },

  async checkModel(runtimeModel: Omit<RuntimeModel, "context">): Promise<{ available: boolean; reason: string }> {
    if (!runtimeModel.apiKey) return { available: false, reason: "未配置 API Key" };
    if (!runtimeModel.endpoint.trim()) return { available: false, reason: "未配置接口地址" };
    if (!runtimeModel.model.trim()) return { available: false, reason: "未配置模型名称" };
    if (!isTauri()) return { available: false, reason: "需要在 Opsark 桌面端验证真实模型连接" };
    return invoke("check_ai_model", {
      requestParameters: validateRequestParameters(runtimeModel.requestParameters),
      apiKey: runtimeModel.apiKey,
      endpoint: runtimeModel.endpoint,
      model: runtimeModel.model,
      timeoutSeconds: runtimeModel.timeoutSeconds,
    });
  },

  async generateSummary(requirement: string, steps: PlanStep[], runtimeModel?: RuntimeModel) {
    const fallback = buildExecutionSummary(requirement, steps);
    if (isTauri() && runtimeModel?.apiKey) {
      try {
        return await invoke<string>("generate_ai_summary", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          executionContext: JSON.stringify({
            _log: runtimeModel.logContext,
            _requestParameters: validateRequestParameters(runtimeModel.requestParameters),
            steps: steps.map(({ title, command, expected, status, output, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output,
              result,
              evidence: evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
            })),
          }),
          timeoutSeconds: runtimeModel.timeoutSeconds,
        });
      } catch {
        return fallback;
      }
    }
    return fallback;
  },

  async reviewStep(
    requirement: string,
    reviewContext: string,
    hasRemainingSteps: boolean,
    runtimeModel?: RuntimeModel,
  ): Promise<StepReview> {
    const fallback: StepReview = {
      decision: hasRemainingSteps ? "continue" : "complete",
      reason: runtimeModel?.apiKey
        ? "模型复核暂不可用，已按程序校验结果继续"
        : "未配置远程模型，已按程序校验结果处理",
      summary: hasRemainingSteps ? "程序校验通过，继续执行后续步骤。" : "程序校验通过，已完成全部步骤。",
      source: "rules",
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const review = await invoke<Omit<StepReview, "source">>("review_ai_step", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        reviewContext: parameterContext(reviewContext, runtimeModel.requestParameters),
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      return { ...review, source: "model" };
    } catch {
      return fallback;
    }
  },

  async reviewGoal(
    requirement: string,
    reviewContext: string,
    runtimeModel?: RuntimeModel,
  ): Promise<StepReview> {
    const fallback: StepReview = {
      decision: runtimeModel?.apiKey ? "adjust" : "complete",
      reason: runtimeModel?.apiKey
        ? "整体目标复核暂不可用，不能仅因当前计划结束就判定整体任务完成"
        : "未配置远程模型，已按全部程序校验通过处理",
      summary: runtimeModel?.apiKey
        ? "当前阶段已经结束，但整体目标完成状态尚未得到可靠复核。"
        : "当前计划及其程序校验均已完成。",
      source: "rules",
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const review = await invoke<Omit<StepReview, "source">>("review_ai_step", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        reviewContext: parameterContext(reviewContext, runtimeModel.requestParameters),
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      return { ...review, source: "model" };
    } catch {
      return fallback;
    }
  },

  async decideNextStage(
    requirement: string,
    runtimeModel?: RuntimeModel,
  ): Promise<NextStageDecision> {
    const fallback: NextStageDecision = {
      decision: runtimeModel?.apiKey ? "adjust" : "complete",
      reason: runtimeModel?.apiKey
        ? "下一阶段联合决策暂不可用，必须回退到原整体复核流程"
        : "未配置远程模型，已按全部程序校验通过处理",
      summary: runtimeModel?.apiKey
        ? "当前阶段已经结束，联合决策未产生可执行计划。"
        : "当前计划及其程序校验均已完成。",
      source: "rules",
      steps: [],
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const decision = await invoke<Omit<NextStageDecision, "source">>("decide_ai_next_stage", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        context: parameterContext(runtimeModel.context, runtimeModel.requestParameters),
        generationSettings: runtimeModel.generationSettings,
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      try {
        return { ...decision, steps: normalizePlanPreconditions(decision.steps, requirement), source: "model" };
      } catch (error) {
        const repair = buildPlanNormalizationRepair(error, decision.steps);
        // Preserve the joint decision. Only the invalid plan protocol is retried.
        const steps = await backend.generatePlan(requirement, { ...runtimeModel,
          context: contextWithPlanRepair(runtimeModel.context, repair) });
        return { ...decision, steps, source: "model" };
      }
    } catch (error) {
      if (error instanceof PlanProtocolError) throw error;
      throw normalizeModelInvocationError(error);
    }
  },

  async executeCommand(
    command: string,
    connection?: RuntimeConnection,
    approvedHighRisk = false,
    options?: { executionId: string; onProgress?: (event: CommandOutputEvent) => void },
  ): Promise<{
    output: string;
    success: boolean;
    simulated: boolean;
    exitCode?: number;
    emptyResult?: boolean;
  }> {
    if (isTauri() && connection?.password) {
      let unlisten: (() => void) | undefined;
      if (options?.onProgress) {
        unlisten = await listen<CommandOutputEvent>("command-output", (event) => {
          if (event.payload.executionId === options.executionId) options.onProgress?.(event.payload);
        });
      }
      try {
        return await invoke("execute_ssh_command", {
          ...connection,
          command,
          approvedHighRisk,
          executionId: options?.executionId ?? `exec-${Date.now()}`,
        });
      } finally {
        unlisten?.();
      }
    }
    if (isTauri()) return Promise.reject(new Error("未提供真实 SSH 连接，拒绝执行命令"));
    return requireDesktopRuntime("SSH 命令执行");
  },

  async cancelCommand(connection: RuntimeConnection, executionId: string) {
    if (!isTauri()) return;
    await invoke("cancel_ssh_execution", { ...connection, executionId });
  },

  async validateStep(
    step: PlanStep,
    connection?: RuntimeConnection,
    options?: { executionId: string; onProgress?: (event: CommandOutputEvent) => void },
  ): Promise<{
    passed: boolean;
    detail: string;
    output?: string;
    exitCode?: number;
    emptyResult?: boolean;
  }> {
    if (isTauri() && connection) {
      const result = await this.executeCommand(step.validation, connection, false, options);
      const passed = result.exitCode === undefined ? result.success : result.exitCode === 0;
      return {
        passed,
        detail: passed ? `独立校验通过：${step.expected}` : "独立校验命令未达到预期",
        output: result.output,
        exitCode: result.exitCode,
        emptyResult: result.emptyResult,
      };
    }
    if (isTauri()) return Promise.reject(new Error("未提供真实 SSH 连接，拒绝执行校验"));
    return requireDesktopRuntime("SSH 独立校验");
  },
};
