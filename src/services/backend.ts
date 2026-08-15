import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiGenerationSettings, FileEntry, Metrics, PlanStep, RequirementProcessingResult, ServerInfo, StepReview } from "@/types";
import {
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
} from "@/features/agent/planNormalizer";
import { buildExecutionSummary } from "@/features/agent/executionSummary";
import {
  buildDemoFileStructure,
  normalizeFileStructureRequest,
} from "@/features/tools/fileStructure";
import type { FileStructureRequest, FileStructureResult } from "@/features/tools/types";

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

export interface SshProbe {
  info: ServerInfo;
  environment: string[];
  hostname: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
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
  direction: "upload" | "download";
  transferredBytes: number;
  totalBytes: number;
  status: "running" | "completed";
}

export interface CommandOutputEvent {
  executionId: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export type CredentialKind = "server" | "model" | "secret";

export { buildExecutionSummary, normalizePlanPreconditions, normalizeSecretPlaceholders };

const pause = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));
const demoCancelledTransfers = new Set<string>();

const demoInfo: ServerInfo = {
  os: "Ubuntu 24.04 LTS",
  kernel: "6.8.0-44-generic",
  cpu: "Intel Xeon Gold 6338N",
  cores: 8,
  memoryGb: 16,
  diskGb: 160,
  uptime: "16 天 4 小时",
};

function riskFrom(command: string): "low" | "medium" | "high" {
  if (/(rm\s+-rf|mkfs|fdisk|userdel|iptables\s+-F|DROP\s+TABLE)/i.test(command)) return "high";
  if (/(install|restart|systemctl|chmod|chown|docker\s+(run|stop|rm)|apt)/i.test(command)) return "medium";
  return "low";
}

function buildDemoPlan(requirement: string): PlanStep[] {
  const steps: Omit<PlanStep, "id" | "status" | "risk">[] = [
    {
      title: "采集目标相关状态",
      description: `根据用户需求读取执行前事实：${requirement}`,
      command: "uname -a && pwd",
      expected: "获得可用于后续判断的基础事实",
      validation: "uname -a >/dev/null && pwd >/dev/null",
    },
  ];

  return steps.map((step, index) => ({
    ...step,
    id: `step-${Date.now()}-${index}`,
    risk: riskFrom(step.command),
    status: "pending",
  }));
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

  async collectServerInfo(): Promise<ServerInfo> {
    if (isTauri()) return invoke("collect_server_info");
    await pause();
    return demoInfo;
  },

  async probeSsh(connection: RuntimeConnection): Promise<SshProbe> {
    if (!isTauri()) {
      await pause();
      return { info: demoInfo, environment: [], hostname: connection.host };
    }
    return invoke("probe_ssh_server", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
  },

  async startTerminal(terminalId: string, connection: RuntimeConnection) {
    if (!isTauri()) return 0;
    return invoke<number>("start_ssh_terminal", { terminalId, ...connection });
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
    await pause(100);
    const tick = Date.now() / 3000;
    return {
      cpu: Math.round(20 + Math.abs(Math.sin(tick)) * 28),
      memory: Math.round(48 + Math.abs(Math.cos(tick / 2)) * 12),
      disk: 68,
      networkIn: Math.round(2.4 + Math.abs(Math.sin(tick / 3)) * 8.2),
      networkOut: Math.round(0.8 + Math.abs(Math.cos(tick / 4)) * 3.6),
      sampledAt: new Date().toISOString(),
    };
  },

  async getSshMetrics(connection: RuntimeConnection): Promise<Metrics> {
    if (!isTauri()) return this.getMetrics();
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
      await pause(250);
      return [];
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
  ): Promise<FileStructureResult> {
    const normalized = normalizeFileStructureRequest(request);
    if (!isTauri()) {
      await pause(180);
      return buildDemoFileStructure(normalized);
    }
    return invoke<FileStructureResult>("get_remote_file_structure", {
      ...connection,
      ...normalized,
    });
  },

  async createSftpDirectory(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return;
    await invoke("create_sftp_directory", { ...connection, path });
  },

  async renameSftpEntry(connection: RuntimeConnection, fromPath: string, toPath: string) {
    if (!isTauri()) return;
    await invoke("rename_sftp_entry", { ...connection, fromPath, toPath });
  },

  async deleteSftpEntry(connection: RuntimeConnection, path: string, kind: FileEntry["kind"]) {
    if (!isTauri()) return;
    await invoke("delete_sftp_entry", { ...connection, path, kind });
  },

  async readSftpFile(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return new Uint8Array();
    const bytes = await invoke<number[]>("read_sftp_file", { ...connection, path });
    return new Uint8Array(bytes);
  },

  async writeSftpFile(connection: RuntimeConnection, path: string, data: Uint8Array) {
    if (!isTauri()) return;
    await invoke("write_sftp_file", { ...connection, path, data: Array.from(data) });
  },

  async uploadSftpTransfer(
    connection: RuntimeConnection,
    transferId: string,
    path: string,
    data: Uint8Array,
    onProgress: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) {
      demoCancelledTransfers.delete(transferId);
      const totalBytes = data.byteLength;
      for (let transferredBytes = 0; transferredBytes < totalBytes; transferredBytes += 64 * 1024) {
        await pause(8);
        if (demoCancelledTransfers.has(transferId)) throw new Error("SFTP_TRANSFER_CANCELLED");
        onProgress({
          transferId,
          direction: "upload",
          transferredBytes: Math.min(totalBytes, transferredBytes + 64 * 1024),
          totalBytes,
          status: transferredBytes + 64 * 1024 >= totalBytes ? "completed" : "running",
        });
      }
      return;
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
      demoCancelledTransfers.delete(transferId);
      await pause(40);
      if (demoCancelledTransfers.has(transferId)) throw new Error("SFTP_TRANSFER_CANCELLED");
      onProgress({ transferId, direction: "download", transferredBytes: 0, totalBytes: 0, status: "completed" });
      return new Uint8Array();
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

  async cancelSftpTransfer(transferId: string) {
    if (!isTauri()) {
      demoCancelledTransfers.add(transferId);
      return true;
    }
    return invoke<boolean>("cancel_sftp_transfer", { transferId });
  },

  async generatePlan(requirement: string, runtimeModel?: RuntimeModel): Promise<PlanStep[]> {
    if (isTauri() && runtimeModel?.apiKey) {
      const steps = await invoke<PlanStep[]>("generate_ai_plan", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        context: runtimeModel.context,
        generationSettings: runtimeModel.generationSettings,
      });
      return normalizePlanPreconditions(steps, requirement);
    }
    if (isTauri()) return normalizePlanPreconditions(await invoke<PlanStep[]>("generate_plan", { requirement }), requirement);
    await pause(900);
    return normalizePlanPreconditions(buildDemoPlan(requirement), requirement);
  },

  async processRequirement(
    requirement: string,
    runtimeModel: RuntimeModel,
  ): Promise<RequirementProcessingResult> {
    if (isTauri()) {
      const result = await invoke<RequirementProcessingResult>("process_ai_requirement", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        context: runtimeModel.context,
        generationSettings: runtimeModel.generationSettings,
      });
      return { ...result, plan: normalizePlanPreconditions(result.plan, requirement) };
    }
    await pause(300);
    const inquiry = /(什么是|为什么|有什么风险|有何风险|区别|原理|如何理解|是否建议|能否解释)/i.test(requirement)
      && !/(当前|服务器|查看|查询|列出|检查|创建|删除|修改|启动|停止|重启|部署)/i.test(requirement);
    return inquiry
      ? { intent: "answer", answer: "这是一个咨询类问题，应直接提供说明而不执行服务器操作。", plan: [] }
      : { intent: "execute", plan: normalizePlanPreconditions(buildDemoPlan(requirement), requirement) };
  },

  async checkModel(runtimeModel: Omit<RuntimeModel, "context">): Promise<{ available: boolean; reason: string }> {
    if (!runtimeModel.apiKey) return { available: false, reason: "未配置 API Key" };
    if (!runtimeModel.endpoint.trim()) return { available: false, reason: "未配置接口地址" };
    if (!runtimeModel.model.trim()) return { available: false, reason: "未配置模型名称" };
    if (!isTauri()) return { available: true, reason: "模型配置完整" };
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
              evidence: evidence?.map(({ type, source, facts }) => ({ type, source, facts })),
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
    if (isTauri()) return invoke("execute_command", { command, approvedHighRisk });
    await pause(700);
    return {
      output: `$ ${command}\n[演示执行器] 命令已安全执行\n状态: success\n耗时: 0.42s`,
      success: true,
      simulated: true,
    };
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
    if (isTauri()) return invoke("validate_step", { expected: step.expected, output: step.output ?? "" });
    await pause(500);
    return { passed: true, detail: `校验通过：${step.expected}` };
  },
};
