import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentSessionContext, AgentSessionRef, AiGenerationSettings, ExecutionScope, FileEntry, Metrics, ModelDeveloperTrace, PlanStep, RequirementProcessingResult, ServerInfo, StepReview } from "@/types";
import type { ModelSkillDefinition } from "@/features/skills/types";
import {
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
} from "@/features/agent/planNormalizer";
import { buildExecutionSummary } from "@/features/agent/executionSummary";
import {
  normalizeFileStructureRequest,
} from "@/features/tools/fileStructure";
import type { FileStructureRequest, FileStructureScanResult } from "@/features/tools/types";
import {
  analyzePlanStepSafety as analyzePlanStepSafetyLocally,
} from "@/features/agent/planSafety";
import type { PlanStepSafetyAnalysis } from "@/features/agent/planSafety";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface RuntimeConnection {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RuntimeModel {
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

export type CredentialKind = "server" | "model" | "secret";

export {
  buildExecutionSummary,
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
};

function requireDesktopRuntime(operation: string): never {
  throw new Error(`${operation} 仅支持 Opsark 桌面端真实连接`);
}

export const backend = {
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
  }): Promise<AgentCommandResult> {
    if (!isTauri()) return requireDesktopRuntime("Agent 沙箱命令执行");
    let unlisten: (() => void) | undefined;
    if (input.onProgress) {
      unlisten = await listen<AgentTerminalOutputEvent>("agent-terminal-output", (event) => {
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
      try {
        const steps = await invoke<PlanStep[]>("generate_ai_plan", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          context: runtimeModel.context,
          generationSettings: runtimeModel.generationSettings,
        });
        return normalizePlanPreconditions(steps, requirement);
      } catch (error) {
        throw normalizeModelInvocationError(error);
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
      try {
        const result = await invoke<RequirementProcessingResult>("process_ai_requirement", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          context: runtimeModel.context,
          skillDefinitions,
          generationSettings: runtimeModel.generationSettings,
        });
        return { ...result, plan: normalizePlanPreconditions(result.plan, requirement) };
      } catch (error) {
        throw normalizeModelInvocationError(error);
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
      apiKey: runtimeModel.apiKey,
      endpoint: runtimeModel.endpoint,
      model: runtimeModel.model,
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
          executionContext: JSON.stringify(
            steps.map(({ title, command, expected, status, output, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output,
              result,
              evidence: evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
            })),
          ),
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
        reviewContext,
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
        reviewContext,
      });
      return { ...review, source: "model" };
    } catch {
      return fallback;
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
