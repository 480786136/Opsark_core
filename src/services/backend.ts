import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiGenerationSettings, FileEntry, Metrics, PlanStep, RequirementProcessingResult, ServerInfo, StepReview } from "@/types";
import { ensureStepValidator } from "@/services/validation";

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

export interface CommandOutputEvent {
  executionId: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export type CredentialKind = "server" | "model" | "secret";

export function normalizeSecretPlaceholders(value: string) {
  return value.replace(/\\+\$\{secret\.([A-Z0-9_]+)\}/g, "\${secret.$1}");
}

const pause = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function normalizePlanPreconditions(steps: PlanStep[], requirement = "") {
  const normalized = steps.map((step) => ({
    ...step,
    command: normalizeSecretPlaceholders(step.command),
    validation: normalizeSecretPlaceholders(step.validation),
  }));
  const userExplicitlyRequestedCleanup = /清理|删除|移除|卸载|清空|purge|remove|delete|uninstall/i
    .test(requirement);
  if (requirement && !userExplicitlyRequestedCleanup) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const step = normalized[index];
      const speculativeCleanup =
        /清理|残留|删除.*(?:安装|目录|文件)|cleanup|remove residual/i
          .test(`${step.title}\n${step.description}`)
        && /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i.test(step.command);
      if (speculativeCleanup) normalized.splice(index, 1);
    }
  }
  return normalized.map(ensureStepValidator);
}

function resultLines(step: PlanStep) {
  const mainOutput = (step.output ?? "").split("\n--- 独立校验 ---")[0];
  return mainOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith("$ ") &&
      !line.startsWith("[exit:") &&
      !line.includes("未发现匹配项"),
    );
}

export function buildExecutionSummary(requirement: string, steps: PlanStep[]) {
  const completed = steps.filter((step) => step.status === "completed");
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length) {
    const lastFailure = failed[failed.length - 1];
    const failureDetail =
      lastFailure.review?.summary
      ?? lastFailure.result?.failureReason
      ?? resultLines(lastFailure).slice(-3).join("；")
      ?? "最后执行步骤未达到预期";
    const verifiedResults = completed
      .slice(-3)
      .map((step) => {
        const output = resultLines(step).slice(-2).join("；");
        return output ? `${step.title}：${output}` : step.title;
      });
    return [
      `本轮任务未完成。共处理 ${completed.length + failed.length} 个步骤，失败步骤为“${lastFailure.title}”：${failureDetail}。`,
      verifiedResults.length ? `失败前已确认的结果：${verifiedResults.join("；")}。` : "",
      `用户目标“${requirement}”尚未由最终证据证明完成。`,
    ].filter(Boolean).join("\n");
  }
  const emptySteps = completed.filter((step) =>
    step.result?.observationStatus === "not_found"
    || step.output?.includes("未发现匹配项"),
  );
  const unhealthySteps = completed.filter((step) =>
    step.result?.observationStatus === "unhealthy"
    || step.result?.observationStatus === "warning",
  );
  if (unhealthySteps.length) {
    const details = unhealthySteps
      .map((step) => `${step.title}：${step.result?.warnings[0] ?? "观察到异常状态"}`)
      .join("；");
    return `本轮执行完成，共处理 ${completed.length} 个步骤，发现 ${unhealthySteps.length} 个需要关注的状态。${details}。`;
  }
  if (emptySteps.length) {
    return `本轮处理完成，共执行 ${completed.length} 个步骤。其中 ${emptySteps.length} 个查询正常完成但没有匹配数据或发现目标，其余步骤证据有效。`;
  }
  const finalResult = completed.length ? resultLines(completed[completed.length - 1]).slice(0, 5) : [];
  return finalResult.length
    ? `本轮处理完成，共执行 ${completed.length} 个步骤，程序证据均有效。最终结果：${finalResult.join("；")}。`
    : `本轮处理完成，共执行 ${completed.length} 个步骤，程序证据均有效。`;
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
    if (!isTauri()) return;
    await invoke("start_ssh_terminal", { terminalId, ...connection });
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
