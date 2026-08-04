import { defineStore } from "pinia";
import { backend, buildExecutionSummary, normalizePlanPreconditions, normalizeSecretPlaceholders } from "@/services/backend";
import {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
  isReadOnlyStep,
} from "@/services/validation";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import type {
  AiGenerationSettings,
  AuditEvent,
  FileEntry,
  Metrics,
  ModelAvailability,
  ModelProfile,
  OpsTask,
  PermissionLevel,
  PlanStep,
  ServerProfile,
  SecretMetadata,
  TaskMessage,
} from "@/types";

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LONG_RUNNING_REVIEW_INTERVAL_MS = 30_000;
const isProgressFrame = (line: string) => /^\s*[#=*>.\-]*\s*\d{1,3}(?:\.\d+)?%\s*$/.test(line);
let persistTimer: number | undefined;
let credentialHydration: Promise<void> | undefined;

function isReadOnlyDiagnosticStep(step: PlanStep) {
  return isReadOnlyStep(step)
    && /检查|查看|查询|诊断|查找|确认|验证|复查|状态|日志|端口|进程|访问/.test(
      `${step.title} ${step.description}`,
    );
}

function requiresReadOnlyDiagnosis(requirement: string) {
  const asksForChange = /修复|解决|处理掉|重启|重新加载|启动|停止|部署|安装|卸载|升级|修改|配置|创建|删除|切换|执行|帮我.*(?:部署|安装|修复|重启)/.test(requirement);
  const reportsOrChecksSymptom = /检查|查看.*(?:状态|情况)|运行情况|空白|白屏|打不开|无法访问|访问失败|超时|报错|异常|为什么/.test(requirement);
  return reportsOrChecksSymptom && !asksForChange;
}

function trimEvidence(value: string | undefined, limit = 3200) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

function extractKnownExecutionFacts(task: OpsTask) {
  const steps = [
    ...(task.planHistory ?? []).flatMap((round) => round.plan),
    ...task.plan,
  ].filter((step) => step.status === "completed");
  const repositoryUrls = new Set<string>();
  const workingDirectories = new Set<string>();

  for (const step of steps) {
    const text = `${step.command}\n${step.output ?? ""}`;
    for (const match of text.matchAll(/https?:\/\/[^\s'"<>]+?\.git\b/gi)) {
      repositoryUrls.add(match[0]);
    }
    for (const match of step.command.matchAll(/\bgit\s+clone\b[^;&\n]*?\s+(\/[^\s;&'"\n]+)/gi)) {
      workingDirectories.add(match[1].replace(/[),]+$/, ""));
    }
    for (const match of step.command.matchAll(/(?:^|[;&]\s*)cd\s+(?:'([^']+)'|"([^"]+)"|(\/[^\s;&]+))/gi)) {
      const directory = match[1] ?? match[2] ?? match[3];
      if (directory?.startsWith("/")) workingDirectories.add(directory.replace(/[),]+$/, ""));
    }
    for (const match of text.matchAll(/\/(?:tmp|opt|home|srv|var\/www)\/[A-Za-z0-9._@%+~/-]+/g)) {
      workingDirectories.add(match[0].replace(/[),.]+$/, ""));
    }
  }

  return {
    repositoryUrls: [...repositoryUrls].slice(0, 8),
    workingDirectories: [...workingDirectories].slice(0, 16),
    completedSteps: steps.slice(-12).map((step) => ({
      title: step.title,
      command: step.command,
      result: step.result,
    })),
    instruction: "这些路径和仓库来自同一任务的已完成执行证据。后续需求必须优先复用，不得在无新证据时改猜其他目录。",
  };
}

function remainingPlanCanRepairPostcondition(remainingSteps: PlanStep[]) {
  return remainingSteps.some((item) =>
    /修复|解决|恢复|替代|调整|准备|应用|变更|重试|重新|安装|升级|创建|配置|设置|授权|启动|部署|加载/.test(
      `${item.title}\n${item.description}`,
    ),
  );
}

function remainingPlanResolvesBlockingSignal(_step: PlanStep, remainingSteps: PlanStep[]) {
  return remainingPlanCanRepairPostcondition(remainingSteps);
}

function postconditionHasHardBlocker(
  step: PlanStep,
  remainingSteps: PlanStep[],
  validationExitCode?: number,
) {
  if ([126, 127].includes(validationExitCode ?? -1)) {
    return "独立校验命令不可执行或不存在，不能由模型判定为成功。";
  }
  if (step.result?.facts.platformIncompatible) {
    return "程序已确认平台或 ABI 不兼容，模型不能覆盖该硬性事实。";
  }
  if (step.result?.facts.networkFailure) {
    return "程序已确认网络或下载失败，模型不能把未取得的目标结果判为成功。";
  }
  if (
    step.result?.facts.blockingSignal
    && !remainingPlanResolvesBlockingSignal(step, remainingSteps)
  ) {
    return "程序已确认阻断条件，且剩余计划没有对应修复步骤。";
  }
  return undefined;
}

function remainingPlanCanRecoverExecutionFailure(
  _category: unknown,
  remainingSteps: PlanStep[],
) {
  return remainingPlanCanRepairPostcondition(remainingSteps);
}

const emptyServerInfo = {
  os: "等待采集…",
  kernel: "—",
  cpu: "—",
  cores: 0,
  memoryGb: 0,
  diskGb: 0,
  uptime: "—",
};

const demoFiles: FileEntry[] = [
  { name: "etc", path: "/etc", kind: "directory", size: "—", modified: "今天 09:20" },
  { name: "home", path: "/home", kind: "directory", size: "—", modified: "昨天 18:42" },
  { name: "opt", path: "/opt", kind: "directory", size: "—", modified: "7月24日" },
  { name: "var", path: "/var", kind: "directory", size: "—", modified: "今天 11:04" },
  { name: "deploy.sh", path: "/deploy.sh", kind: "file", size: "2.4 KB", modified: "7月21日" },
];

const defaultModels: ModelProfile[] = [
  {
    id: "model-deepseek",
    name: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com",
    enabled: true,
    hasApiKey: false,
  },
];

const defaultAiGenerationSettings: AiGenerationSettings = {
  limitOutput: false,
  maxPlanSteps: 6,
  maxOutputTokens: 5000,
  maxTextChars: 200,
  maxCommandChars: 4000,
};

function normalizeAiGenerationSettings(settings: Partial<AiGenerationSettings>) {
  const positiveInteger = (value: unknown, fallback: number, minimum = 1) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.trunc(parsed)) : fallback;
  };
  return {
    limitOutput: settings.limitOutput === true,
    maxPlanSteps: positiveInteger(settings.maxPlanSteps, defaultAiGenerationSettings.maxPlanSteps),
    maxOutputTokens: positiveInteger(settings.maxOutputTokens, defaultAiGenerationSettings.maxOutputTokens, 256),
    maxTextChars: positiveInteger(settings.maxTextChars, defaultAiGenerationSettings.maxTextChars),
    maxCommandChars: positiveInteger(settings.maxCommandChars, defaultAiGenerationSettings.maxCommandChars),
  };
}

function initialAiGenerationSettings() {
  return normalizeAiGenerationSettings(
    readSaved<Partial<AiGenerationSettings>>("opsark.aiGenerationSettings", {}),
  );
}

function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function redactExecutionOutput(value: string, secretValues: Record<string, string>) {
  let output = Object.values(secretValues).reduce(
    (current, secret) => secret ? current.split(secret).join("••••••••") : current,
    value,
  );
  output = output.replace(
    /^(\s*[\w.-]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)[\w.-]*\s*[:=]\s*).+$/gim,
    "$1••••••••",
  );
  return output.replace(
    /([?&](?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)=)[^&\s]+/gi,
    "$1••••••••",
  );
}

function initialServers() {
  return readSaved<ServerProfile[]>("opsark.servers", []);
}

function initialModels() {
  const saved = readSaved<ModelProfile[]>("opsark.models", defaultModels)
    .filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
  return saved.length ? saved : defaultModels.map((model) => ({ ...model }));
}

function initialTasks() {
  return readSaved<OpsTask[]>("opsark.tasks", []).map((task) => {
    task.confirmedSecretKeys = [];
    task.plan = task.plan.map(ensureStepValidator);
    task.planHistory?.forEach((round) => {
      round.plan = round.plan.map(ensureStepValidator);
      if (round.status === "needs_adjustment" && round.summary) {
        round.pauseReason = round.summary;
        round.summary = undefined;
      }
    });
    if (task.status === "needs_adjustment" && task.summary) {
      task.pauseReason = task.summary;
      task.summary = undefined;
    }
    const latestRequirement = [...task.messages]
      .reverse()
      .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
    if (task.status === "completed" && /^本轮处理完成，共执行/.test(task.summary ?? "")) {
      task.summary = buildExecutionSummary(latestRequirement, task.plan);
    }
    task.planHistory?.forEach((round) => {
      if (round.status === "completed" && /^本轮处理完成，共执行/.test(round.summary ?? "")) {
        round.summary = buildExecutionSummary(round.requirement, round.plan);
      }
    });
    return task;
  });
}

export const useOpsStore = defineStore("ops", {
  state: () => ({
    servers: initialServers(),
    tasks: initialTasks(),
    models: initialModels(),
    aiGenerationSettings: initialAiGenerationSettings(),
    modelAvailability: {} as Record<string, ModelAvailability>,
    logs: readSaved<AuditEvent[]>("opsark.logs", []),
    files: demoFiles,
    filesLoading: false,
    remoteFilePath: "/",
    metrics: {
      cpu: 32,
      memory: 56,
      disk: 68,
      networkIn: 5.2,
      networkOut: 1.8,
      sampledAt: now(),
    } as Metrics,
    activeTaskId: null as string | null,
    serverPasswords: {} as Record<string, string>,
    modelApiKeys: {} as Record<string, string>,
    connectedServerIds: [] as string[],
    secretMetadata: readSaved<SecretMetadata[]>("opsark.secretMetadata", [
      { key: "DB_PASSWORD", description: "数据库密码", scope: "server", serverId: "srv-tencent-test" },
      { key: "GIT_TOKEN", description: "代码仓库访问令牌", scope: "global" },
    ]),
    secretValues: {} as Record<string, string>,
    pendingSecret: null as { taskId: string; stepId: string; key: string } | null,
    terminalLines: [
      "Opsark Secure Terminal",
      "连接服务器后可直接使用交互式 PTY；智能任务命令也会在此显示。",
    ],
    isCollecting: false,
    metricsLoading: false,
    credentialsHydrated: false,
    credentialsLoading: false,
    credentialError: "",
  }),

  getters: {
    activeTask(state): OpsTask | undefined {
      return state.tasks.find((task) => task.id === state.activeTaskId);
    },
    enabledModels(state) {
      return state.models.filter((model) => model.enabled);
    },
    availableModels(state) {
      return state.models.filter(
        (model) => model.enabled && state.modelAvailability[model.id]?.status === "available",
      );
    },
  },

  actions: {
    persist(immediate = false) {
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      const store = this;
      const write = () => {
        localStorage.setItem("opsark.servers", JSON.stringify(store.servers));
        localStorage.setItem("opsark.tasks", JSON.stringify(store.tasks));
        localStorage.setItem("opsark.models", JSON.stringify(store.models));
        localStorage.setItem("opsark.aiGenerationSettings", JSON.stringify(store.aiGenerationSettings));
        localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 500)));
        localStorage.setItem("opsark.secretMetadata", JSON.stringify(store.secretMetadata));
        persistTimer = undefined;
      };
      if (immediate) write();
      else persistTimer = window.setTimeout(write, 200);
    },

    async hydrateCredentials() {
      if (this.credentialsHydrated) return;
      if (credentialHydration) return credentialHydration;
      this.credentialsLoading = true;
      this.credentialError = "";
      credentialHydration = (async () => {
        const serverCredentials = await Promise.allSettled(
          this.servers.map(async (server) => ({
            id: server.id,
            value: await backend.loadCredential("server", server.id),
          })),
        );
        const modelCredentials = await Promise.allSettled(
          this.models
            .filter((model) => model.provider !== "Built-in")
            .map(async (model) => ({
              id: model.id,
              value: await backend.loadCredential("model", model.id),
            })),
        );
        const secretCredentials = await Promise.allSettled(
          this.secretMetadata.map(async (secret) => ({
            id: secret.key,
            value: await backend.loadCredential("secret", secret.key),
          })),
        );
        for (const result of serverCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.serverPasswords[result.value.id] = result.value.value;
          }
        }
        for (const result of modelCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.modelApiKeys[result.value.id] = result.value.value;
            const model = this.models.find((item) => item.id === result.value.id);
            if (model) model.hasApiKey = true;
          }
        }
        for (const result of secretCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.secretValues[result.value.id] = result.value.value;
          }
        }
        const rejected = [...serverCredentials, ...modelCredentials, ...secretCredentials]
          .find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") this.credentialError = String(rejected.reason);
        this.credentialsHydrated = true;
        this.credentialsLoading = false;
      })().finally(() => {
        credentialHydration = undefined;
      });
      return credentialHydration;
    },

    async ensureServerConnected(serverId: string) {
      await this.hydrateCredentials();
      if (this.connectedServerIds.includes(serverId)) return true;
      const password = this.serverPasswords[serverId];
      if (!password) return false;
      await this.connectServer(serverId, password, false);
      return this.connectedServerIds.includes(serverId);
    },

    addLog(event: Omit<AuditEvent, "id" | "createdAt">) {
      this.logs.unshift({ ...event, id: uid("log"), createdAt: now() });
      if (this.logs.length > 500) this.logs.length = 500;
      this.persist();
    },

    async refreshServer(serverId: string) {
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) return;
      this.isCollecting = true;
      server.status = "testing";
      try {
        const password = this.serverPasswords[serverId];
        if (password) {
          const probe = await backend.probeSsh({
            host: server.host,
            port: server.port,
            username: server.username,
            password,
          });
          server.info = probe.info;
          server.environment = probe.environment;
          if (!this.connectedServerIds.includes(serverId)) this.connectedServerIds.push(serverId);
          server.status = "online";
          void Promise.allSettled([
            this.loadRemoteFiles(serverId, "/"),
            this.refreshMetrics(serverId),
          ]);
        } else {
          server.info = await backend.collectServerInfo();
          server.status = "online";
        }
        this.addLog({
          category: "system",
          level: "success",
          title: "服务器信息已刷新",
          detail: `${server.name} 连接测试成功，基础信息采集完成`,
          serverId,
        });
      } catch (error) {
        server.status = "offline";
        this.addLog({
          category: "system",
          level: "error",
          title: "服务器连接失败",
          detail: String(error),
          serverId,
        });
      } finally {
        this.isCollecting = false;
        this.persist();
      }
    },

    async connectServer(serverId: string, password: string, remember = true) {
      this.serverPasswords[serverId] = password;
      await this.refreshServer(serverId);
      if (this.connectedServerIds.includes(serverId)) {
        if (remember) {
          try {
            await backend.saveCredential("server", serverId, password);
          } catch (error) {
            this.credentialError = String(error);
          }
        }
      } else {
        delete this.serverPasswords[serverId];
      }
    },

    disconnectServer(serverId: string) {
      delete this.serverPasswords[serverId];
      this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
      const server = this.servers.find((item) => item.id === serverId);
      if (server) server.status = "offline";
    },

    async refreshMetrics(serverId?: string) {
      if (this.metricsLoading) return;
      this.metricsLoading = true;
      try {
        const server = this.servers.find((item) => item.id === serverId);
        const password = serverId ? this.serverPasswords[serverId] : undefined;
        this.metrics = server && password
          ? await backend.getSshMetrics({ host: server.host, port: server.port, username: server.username, password })
          : await backend.getMetrics();
      } catch {
        // Keep the last valid sample when a remote collection fails.
      } finally {
        this.metricsLoading = false;
      }
    },

    async loadRemoteFiles(serverId: string, path = "/") {
      const server = this.servers.find((item) => item.id === serverId);
      const password = this.serverPasswords[serverId];
      if (!server || !password) return;
      this.filesLoading = true;
      try {
        this.files = await backend.listSftp(
          { host: server.host, port: server.port, username: server.username, password },
          path,
        );
        this.remoteFilePath = path;
      } catch (error) {
        this.addLog({
          category: "system",
          level: "error",
          title: "SFTP 目录读取失败",
          detail: String(error),
          serverId,
        });
      } finally {
        this.filesLoading = false;
      }
    },

    getRuntimeConnection(serverId: string) {
      const server = this.servers.find((item) => item.id === serverId);
      const password = this.serverPasswords[serverId];
      return server && password
        ? { host: server.host, port: server.port, username: server.username, password }
        : undefined;
    },

    async createRemoteDirectory(serverId: string, path: string) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      await backend.createSftpDirectory(connection, path);
      this.addLog({ category: "command", level: "success", title: "SFTP 创建目录", detail: path, serverId });
      await this.loadRemoteFiles(serverId, this.remoteFilePath);
    },

    async renameRemoteEntry(serverId: string, fromPath: string, toPath: string) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      await backend.renameSftpEntry(connection, fromPath, toPath);
      this.addLog({ category: "command", level: "success", title: "SFTP 重命名", detail: `${fromPath} → ${toPath}`, serverId });
      await this.loadRemoteFiles(serverId, this.remoteFilePath);
    },

    async deleteRemoteEntry(serverId: string, entry: FileEntry) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      await backend.deleteSftpEntry(connection, entry.path, entry.kind);
      this.addLog({ category: "command", level: "warning", title: "SFTP 删除", detail: entry.path, serverId });
      await this.loadRemoteFiles(serverId, this.remoteFilePath);
    },

    async uploadRemoteFile(serverId: string, path: string, data: Uint8Array) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      await backend.writeSftpFile(connection, path, data);
      this.addLog({ category: "command", level: "success", title: "SFTP 上传文件", detail: `${path} · ${data.byteLength} bytes`, serverId });
      await this.loadRemoteFiles(serverId, this.remoteFilePath);
    },

    async downloadRemoteFile(serverId: string, entry: FileEntry) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      const data = await backend.readSftpFile(connection, entry.path);
      this.addLog({ category: "command", level: "info", title: "SFTP 下载文件", detail: `${entry.path} · ${data.byteLength} bytes`, serverId });
      return data;
    },

    addServer(
      input: Pick<ServerProfile, "name" | "host" | "port" | "username" | "group">,
      password = "",
    ) {
      const server: ServerProfile = {
        ...input,
        id: uid("srv"),
        status: password ? "testing" : "offline",
        environment: [],
        info: { ...emptyServerInfo },
        createdAt: now(),
      };
      this.servers.push(server);
      this.persist(true);
      if (password) void this.connectServer(server.id, password);
      return server;
    },

    removeServer(serverId: string) {
      this.servers = this.servers.filter((server) => server.id !== serverId);
      delete this.serverPasswords[serverId];
      this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
      void backend.deleteCredential("server", serverId);
      this.persist(true);
    },

    createTask(serverId: string, permission: PermissionLevel, modelId: string) {
      const task: OpsTask = {
        id: uid("task"),
        serverId,
        title: "新任务",
        status: "draft",
        permission,
        modelId,
        messages: [],
        plan: [],
        planHistory: [],
        createdAt: now(),
        updatedAt: now(),
        adjustmentCount: 0,
        confirmedSecretKeys: [],
      };
      this.tasks.unshift(task);
      const reactiveTask = this.tasks[0];
      this.activeTaskId = reactiveTask.id;
      this.persist();
      return reactiveTask;
    },

    selectTask(taskId: string) {
      this.activeTaskId = taskId;
    },

    deleteTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return false;
      if (
        task.currentExecutionId
        || ["planning", "running", "validating"].includes(task.status)
      ) return false;

      const wasActive = this.activeTaskId === taskId;
      this.tasks = this.tasks.filter((item) => item.id !== taskId);
      if (this.pendingSecret?.taskId === taskId) this.pendingSecret = null;
      if (wasActive) {
        this.activeTaskId = this.tasks.find((item) => item.serverId === task.serverId)?.id ?? null;
      }
      this.addLog({
        category: "task",
        level: "info",
        title: "删除任务",
        detail: `已删除任务“${task.title}”及其本地对话、计划和执行记录。`,
        serverId: task.serverId,
      });
      this.persist(true);
      return true;
    },

    pushMessage(task: OpsTask, message: Omit<TaskMessage, "id" | "createdAt">) {
      const created = { ...message, id: uid("msg"), createdAt: now() } as TaskMessage;
      task.messages.push(created);
      task.updatedAt = now();
      return created;
    },

    async finalizeFailedTask(taskId: string, fallbackReason: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      task.status = "failed";
      task.pauseReason = fallbackReason;
      this.persist();
      const requirement = [...task.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
      const model = this.models.find((item) => item.id === task.modelId);
      const apiKey = this.modelApiKeys[task.modelId];
      const generated = await backend.generateSummary(
        requirement,
        task.plan,
        model && apiKey
          ? { apiKey, endpoint: model.endpoint, model: model.model, context: "" }
          : undefined,
      );
      task.summary = [
        `本轮任务未完成：${fallbackReason}`,
        generated,
      ].filter((value, index, values) =>
        value && (index === 0 || !values[0].includes(value)),
      ).join("\n\n");
      if (!task.messages.some((message) =>
        message.kind === "summary" && message.content === task.summary
      )) {
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      }
      this.addLog({
        category: "task",
        level: "error",
        title: "智能运维任务失败总结",
        detail: task.summary,
        serverId: task.serverId,
        taskId,
      });
      this.persist();
    },

    async submitRequirement(
      serverId: string,
      content: string,
      permission: PermissionLevel,
      modelId: string,
      terminalReference = "",
    ) {
      await this.hydrateCredentials();
      let task = this.activeTask;
      if (!task || task.serverId !== serverId) {
        task = this.createTask(serverId, permission, modelId);
      }
      const requestsCurrentRoundAdjustment =
        task.status === "needs_adjustment"
        && /^(?:请)?(?:进行|生成|重新)?(?:一次|一下)?(?:调整|调整计划|重试)(?:吧|。)?$/i.test(content);
      if (requestsCurrentRoundAdjustment) {
        this.pushMessage(task, {
          role: "user",
          kind: "event",
          content: `用户请求${content.replace(/[。！!]/g, "")}。`,
        });
        await this.requestAdjustment(task.id);
        return;
      }
      const priorConversation = task.messages
        .filter((message) => message.kind !== "event" || message.role !== "system")
        .slice(-24)
        .map(({ role, kind, content }) => ({ role, kind, content }));
      const previousRequirement = [...task.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message");
      const previousExecution = previousRequirement
        ? {
            requirement: previousRequirement.content,
            status: task.status,
            summary: task.summary,
            executionConstraints: task.executionConstraints,
            steps: task.plan.map(({ title, command, expected, status, output, review, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output: trimEvidence(output),
              review,
              result,
              evidence: evidence?.map(({ type, source, facts }) => ({ type, source, facts })),
            })),
          }
        : undefined;
      if (task.messages.some((message) => message.role === "user" && message.kind === "message")) {
        const previousRequirementIndex = task.messages
          .map((message, index) => ({ message, index }))
          .reverse()
          .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? -1;
        const previousRequirement = task.messages[previousRequirementIndex];
        task.planHistory ??= [];
        task.planHistory.push({
          id: uid("round"),
          requirement: previousRequirement?.content ?? task.title,
          status: task.status,
          plan: task.plan.map((step) => ({ ...step })),
          response: task.messages
            .slice(previousRequirementIndex + 1)
            .find((message) => message.role === "assistant" && message.kind === "message"),
          records: task.messages
            .slice(previousRequirementIndex + 1)
            .filter((message) => message.kind === "event")
            .map((message) => ({ ...message })),
          summary: task.summary,
          pauseReason: task.pauseReason,
          executionConstraints: task.executionConstraints,
          createdAt: previousRequirement?.createdAt ?? task.updatedAt,
          completedAt: now(),
        });
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: "开始处理本任务中的新一轮需求；上一轮执行记录已保留在对话与日志中。",
        });
      }
      task.permission = permission;
      task.modelId = modelId;
      task.title = task.title === "新任务" ? content.slice(0, 22) : task.title;
      task.status = "planning";
      task.plan = [];
      task.summary = undefined;
      task.pauseReason = undefined;
      task.executionConstraints = undefined;
      task.confirmedSecretKeys = [];
      task.adjustmentCount = 0;
      task.discoveryRefined = false;
      task.cancelRequested = false;
      task.currentExecutionId = undefined;
      this.activeTaskId = task.id;
      this.pushMessage(task, { role: "user", kind: "message", content });
      const understandingMessage = this.pushMessage(task, {
        role: "system",
        kind: "event",
        content: "正在理解需求并汇总服务器上下文…",
      });
      this.addLog({
        category: "model",
        level: "info",
        title: "提交需求理解与规划请求",
        detail: `需求：${content}`,
        serverId,
        taskId: task.id,
      });
      this.persist();

      try {
        const model = this.models.find((item) => item.id === modelId);
        const apiKey = this.modelApiKeys[modelId];
        if (!model) throw new Error("所选模型配置不存在，请重新选择模型");
        if (model.provider !== "Built-in" && !apiKey) {
          const keychainDetail = this.credentialError ? ` 系统凭据读取错误：${this.credentialError}` : "";
          throw new Error(`“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存一次。${keychainDetail}`);
        }
        const server = this.servers.find((item) => item.id === serverId);
        const context = JSON.stringify({
          server: server ? { name: server.name, host: server.host, info: server.info, environment: server.environment } : undefined,
          metrics: this.metrics,
          permission,
          terminalReference: terminalReference || undefined,
          conversationHistory: priorConversation,
          previousExecution,
          knownExecutionFacts: extractKnownExecutionFacts(task),
          tools: ["服务器基础信息", "实时指标", "安全命令执行", "敏感变量占位符"],
          secretVariables: this.secretMetadata
            .filter((item) => item.scope === "global" || item.serverId === serverId)
            .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` })),
        });
        const processed = await backend.processRequirement(
          content,
          {
            apiKey: apiKey!,
            endpoint: model.endpoint,
            model: model.model,
            context,
            generationSettings: this.aiGenerationSettings,
          },
        );
        if (processed.intent === "answer") {
          task.plan = [];
          task.status = "completed";
          task.messages = task.messages.filter((message) => message.id !== understandingMessage.id);
          this.addLog({
            category: "model",
            level: "success",
            title: "模型判断为咨询问题",
            detail: JSON.stringify({ requirement: content, answer: processed.answer }, null, 2),
            serverId,
            taskId: task.id,
          });
          this.pushMessage(task, {
            role: "assistant",
            kind: "message",
            content: processed.answer ?? "当前问题无需执行服务器操作。",
          });
          this.persist();
          return;
        }
        task.executionConstraints = processed.constraints;
        const requiresReadOnlyPlan =
          processed.constraints?.changePolicy === "read_only"
          || requiresReadOnlyDiagnosis(content);
        task.plan = requiresReadOnlyPlan
          ? processed.plan.filter((step) => !isMutatingStepCommand(step.command)).map(ensureStepValidator)
          : processed.plan.map(ensureStepValidator);
        if (!task.plan.length) {
          throw new Error("模型计划只包含未经用户请求的变更操作，已安全拦截；请明确要求修复，或重新生成只读诊断计划");
        }
        task.status = "awaiting_plan_approval";
        this.activeTaskId = task.id;
        this.addLog({
          category: "model",
          level: "success",
          title: "模型执行计划已返回",
          detail: JSON.stringify({
            requirement: content,
            constraints: task.executionConstraints,
            context: JSON.parse(context),
            plan: task.plan,
          }, null, 2),
          serverId,
          taskId: task.id,
        });
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: permission === "managed"
            ? `已生成 ${task.plan.length} 个执行步骤，完全托管模式已自动批准计划并开始运行。`
            : permission === "autonomous"
              ? `已生成 ${task.plan.length} 个执行步骤，自动执行模式已开始运行。`
            : `已生成 ${task.plan.length} 个执行步骤。请检查风险、命令和预期结果后确认计划。`,
        });
        this.persist();
        if (task.cancelRequested) {
          task.status = "cancelled";
          return;
        }
        if (["autonomous", "managed"].includes(permission)) {
          await this.approvePlan(task.id, true);
        }
      } catch (error) {
        if (task.cancelRequested) return;
        task.status = "failed";
        task.summary = `本轮计划生成失败：${String(error)}`;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        this.persist();
      }
    },

    async adjustTask(taskId: string) {
      await this.hydrateCredentials();
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "failed"].includes(task.status)) return;
      task.adjustmentCount ??= 0;
      if (task.adjustmentCount >= 1) {
        await this.finalizeFailedTask(
          task.id,
          "自动调整已达到 1 次上限。为避免反复重拟计划，本任务已停止。",
        );
        return;
      }
      task.adjustmentCount += 1;
      task.pauseReason = undefined;
      const failed = task.plan.find((step) => step.status === "failed");
      const originalRequirement = [...task.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
      const model = this.models.find((item) => item.id === task.modelId);
      const apiKey = this.modelApiKeys[task.modelId];
      if (!model) {
        await this.finalizeFailedTask(task.id, "调整计划失败：所选模型配置不存在。");
        return;
      }
      if (model.provider !== "Built-in" && !apiKey) {
        await this.finalizeFailedTask(
          task.id,
          `调整计划失败：“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存。`,
        );
        return;
      }
      const server = this.servers.find((item) => item.id === task.serverId);
      const context = JSON.stringify({
        server: server ? { name: server.name, host: server.host, info: server.info, environment: server.environment } : undefined,
        metrics: this.metrics,
        permission: task.permission,
        executionConstraints: task.executionConstraints,
        knownExecutionFacts: extractKnownExecutionFacts(task),
        previousPlan: task.plan,
        failedStep: failed,
        instruction: "仅根据已有证据和未完成目标生成最少必要的替代步骤。先确定上一步是执行失败、观察到有效异常，还是主命令与后置校验冲突。目标已被真实证据证明时不得再变更；未达成时必须更换有实质区别的方法，不得对已失败命令仅做表面改写后重复执行。发现步骤只验证证据可获得；可选信息缺失或目标不存在是有效观察。每步是独立非交互 Shell，必须在当步建立所需目录和环境。不得预设技术栈、工具、路径、端口或服务名，不得重复已完成步骤，并以对用户目标的独立验收结束。",
        secretVariables: this.secretMetadata
          .filter((item) => item.scope === "global" || item.serverId === task.serverId)
          .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` })),
      });
      task.status = "planning";
      this.pushMessage(task, { role: "system", kind: "event", content: "正在结合失败输出重新生成调整计划…" });
      this.persist();
      try {
        const replacement = await backend.generatePlan(
          `${originalRequirement}\n\n上次执行未达到预期，请生成安全的调整计划。`,
          model.provider !== "Built-in"
            ? {
                apiKey: apiKey!, endpoint: model.endpoint, model: model.model, context,
                generationSettings: this.aiGenerationSettings,
              }
            : undefined,
        );
        const completed = task.plan.filter((step) => step.status === "completed").slice(-4);
        task.plan = [...completed, ...replacement];
        task.status = "awaiting_plan_approval";
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: task.permission === "managed"
            ? `已根据失败结果生成 ${replacement.length} 个调整步骤，完全托管模式将自动批准并继续。`
            : `已根据失败结果生成 ${replacement.length} 个调整步骤，请重新审查并批准。`,
        });
        this.addLog({
          category: "model",
          level: "warning",
          title: "模型调整计划已返回",
          detail: JSON.stringify({ context: JSON.parse(context), replacement }, null, 2),
          serverId: task.serverId,
          taskId,
        });
      } catch (error) {
        const reason = `调整计划生成失败：${String(error)}`;
        this.pushMessage(task, { role: "system", kind: "event", content: reason });
        task.status = "needs_adjustment";
        task.pauseReason = `${reason}。原执行证据和未完成目标已保留，可再次生成解决方案。`;
        task.summary = undefined;
        this.addLog({
          category: "model",
          level: "warning",
          title: "调整计划格式异常，任务保持可恢复",
          detail: task.pauseReason,
          serverId: task.serverId,
          taskId,
        });
      }
      this.persist();
      if (task.status === "awaiting_plan_approval" && task.permission === "managed") {
        await this.approvePlan(task.id, true);
      }
    },

    async requestAdjustment(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "failed"].includes(task.status)) return;
      if ((task.adjustmentCount ?? 0) >= 1) {
        task.adjustmentCount = 0;
        task.status = "needs_adjustment";
        task.summary = undefined;
        this.pushMessage(task, {
          role: "user",
          kind: "event",
          content: "用户明确请求再次生成解决方案，开始新的人工调整周期。",
        });
      }
      await this.adjustTask(taskId);
    },

    async approvePlan(taskId: string, automatic = false) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "awaiting_plan_approval") return;
      task.plan = normalizePlanPreconditions(task.plan);
      task.status = "running";
      task.pauseReason = undefined;
      this.pushMessage(task, {
        role: automatic ? "system" : "user",
        kind: "event",
        content: automatic
          ? task.permission === "managed"
            ? "完全托管模式已自动批准计划，开始执行。"
            : "自动执行模式已批准计划，开始执行。"
          : "计划已批准，开始执行。",
      });
      this.addLog({
        category: "task",
        level: "info",
        title: "执行计划已批准",
        detail: `${task.plan.length} 个步骤进入执行队列`,
        serverId: task.serverId,
        taskId,
      });
      this.persist();
      await this.advanceTask(taskId);
    },

    rejectTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      task.status = "cancelled";
      const pending = task.plan.find((step) => step.status === "awaiting_approval");
      if (pending) pending.status = "skipped";
      this.pushMessage(task, { role: "user", kind: "event", content: "用户已停止本次执行。" });
      task.summary = task.pauseReason
        ? `本次任务已由用户结束。结束前的暂停原因：${task.pauseReason}`
        : "本次任务已由用户取消，未再执行后续步骤。";
      task.pauseReason = undefined;
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist();
    },

    async terminateTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      task.cancelRequested = true;
      this.pushMessage(task, { role: "user", kind: "event", content: "正在终止本次业务及其当前远程进程…" });
      const executionId = task.currentExecutionId;
      const server = this.servers.find((item) => item.id === task.serverId);
      const password = this.serverPasswords[task.serverId];
      if (executionId && server && password) {
        try {
          await backend.cancelCommand(
            { host: server.host, port: server.port, username: server.username, password },
            executionId,
          );
        } catch (error) {
          this.pushMessage(task, { role: "system", kind: "event", content: `远程终止请求返回：${String(error)}` });
        }
      }
      task.status = "cancelled";
      const active = task.plan.find((step) => ["running", "validating", "awaiting_approval", "awaiting_input"].includes(step.status));
      if (active) {
        active.status = "skipped";
        active.progressMessage = "已由用户终止";
        active.result = {
          executionStatus: "cancelled",
          observationStatus: "unknown",
          facts: {},
          warnings: [],
          evidenceIds: active.evidence?.map((item) => item.id) ?? [],
          failureReason: "用户终止",
        };
      }
      task.currentExecutionId = undefined;
      task.summary = "本次业务已由用户终止，后续步骤未再执行。";
      task.pauseReason = undefined;
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist(true);
    },

    needsApproval(permission: PermissionLevel, step: PlanStep) {
      const explicitlyDestructive = /(rm\s+-rf|mkfs|fdisk|parted|userdel|DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE|iptables\s+-F|shutdown|reboot)/i
        .test(step.command);
      if (explicitlyDestructive) return true;
      if (permission === "managed") return step.risk === "high";
      if (step.risk === "high") return permission !== "autonomous";
      if (permission === "observe") return true;
      return permission === "safe" && step.risk === "medium";
    },

    async advanceTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["running", "awaiting_step_approval"].includes(task.status)) return;
      const step = task.plan.find((item) => item.status === "pending");
      if (!step) {
        const discoveryOnly = task.plan.length > 0
          && task.plan.every((item) => item.status === "completed" && isReadOnlyDiagnosticStep(item));
        const changeStillExpected = ["requested_changes_only", "allow_necessary_changes"]
          .includes(task.executionConstraints?.changePolicy ?? "");
        if (discoveryOnly && changeStillExpected && !task.discoveryRefined) {
          task.discoveryRefined = true;
          task.status = "planning";
          const requirement = [...task.messages]
            .reverse()
            .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          if (!model || (model.provider !== "Built-in" && !apiKey)) {
            task.status = "needs_adjustment";
            task.pauseReason = "发现阶段已完成，但模型不可用，无法依据真实证据生成后续变更计划。";
            this.persist();
            return;
          }
          const server = this.servers.find((item) => item.id === task.serverId);
          const context = JSON.stringify({
            workflowPhase: "continue_after_discovery",
            server: server ? { name: server.name, host: server.host, info: server.info, environment: server.environment } : undefined,
            permission: task.permission,
            executionConstraints: task.executionConstraints,
            completedDiscovery: task.plan.map(({ title, description, command, expected, result, evidence, output }) => ({
              title,
              description,
              command,
              expected,
              result,
              evidence: evidence?.map(({ type, source, facts, rawOutput }) => ({
                type,
                source,
                facts,
                rawOutput: trimEvidence(rawOutput),
              })),
              output: trimEvidence(output),
            })),
            knownExecutionFacts: extractKnownExecutionFacts(task),
            instruction: "只使用本轮已完成发现的真实证据，生成完成用户剩余目标所需的最少变更和最终验收。不得重复发现步骤或猜测路径、工具、端口和服务名。",
            secretVariables: this.secretMetadata
              .filter((item) => item.scope === "global" || item.serverId === task.serverId)
              .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` })),
          });
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: "发现阶段已完成，正在依据真实证据生成一次后续变更与验收计划…",
          });
          this.persist();
          try {
            const continuation = await backend.generatePlan(
              `${requirement}\n\n发现阶段已完成，请仅规划尚未完成的变更与最终验收。`,
              model.provider !== "Built-in"
                ? {
                    apiKey: apiKey!, endpoint: model.endpoint, model: model.model, context,
                    generationSettings: this.aiGenerationSettings,
                  }
                : undefined,
            );
            const completedCommands = new Set(task.plan.map((item) => item.command));
            const pending = continuation.filter((item) => !completedCommands.has(item.command));
            if (!pending.length) throw new Error("模型未返回可执行的后续步骤");
            task.plan = [...task.plan, ...pending];
            task.status = "awaiting_plan_approval";
            this.pushMessage(task, {
              role: "assistant",
              kind: "message",
              content: task.permission === "managed"
                ? `已根据发现证据生成 ${pending.length} 个后续步骤，完全托管模式自动批准并继续。`
                : task.permission === "autonomous"
                  ? `已根据发现证据生成 ${pending.length} 个后续步骤，自动执行继续。`
                : `已根据发现证据生成 ${pending.length} 个后续步骤，请审批后继续。`,
            });
            this.persist();
            if (["autonomous", "managed"].includes(task.permission)) {
              await this.approvePlan(task.id, true);
            }
          } catch (error) {
            task.status = "needs_adjustment";
            task.pauseReason = `发现后续计划生成失败：${String(error)}`;
            this.pushMessage(task, { role: "assistant", kind: "event", content: task.pauseReason });
            this.persist();
          }
          return;
        }
        task.status = "validating";
        this.pushMessage(task, { role: "system", kind: "event", content: "执行步骤已完成，正在根据实际输出整理本轮结果…" });
        this.persist();
        const requirement = [...task.messages]
          .reverse()
          .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        if (model && apiKey) {
          this.addLog({
            category: "model",
            level: "info",
            title: "提交执行结果总结请求",
            detail: JSON.stringify({
              requirement,
              results: task.plan.map(({ title, command, expected, status, output }) => ({
                title,
                command,
                expected,
                status,
                output,
              })),
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });
        }
        task.summary = await backend.generateSummary(
          requirement,
          task.plan,
          model && apiKey
            ? { apiKey, endpoint: model.endpoint, model: model.model, context: "" }
            : undefined,
        );
        if (task.cancelRequested) return;
        task.status = "completed";
        task.pauseReason = undefined;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        if (model && apiKey) {
          this.addLog({
            category: "model",
            level: "success",
            title: "模型执行总结已返回",
            detail: task.summary,
            serverId: task.serverId,
            taskId,
          });
        }
        this.addLog({
          category: "task",
          level: "success",
          title: "智能运维任务完成",
          detail: task.summary,
          serverId: task.serverId,
          taskId,
        });
        this.persist();
        return;
      }

      const stepIndex = task.plan.indexOf(step);
      let blockerIndex = -1;
      for (let index = 0; index < stepIndex; index += 1) {
        const candidate = task.plan[index];
        if (
          candidate.status === "completed"
          && candidate.result?.facts.blockingSignal
        ) blockerIndex = index;
      }
      const blockerResolved = blockerIndex >= 0 && task.plan
        .slice(blockerIndex + 1, stepIndex)
        .some((candidate) =>
          candidate.status === "completed"
          && !isReadOnlyStep(candidate)
          && !candidate.result?.facts.blockingSignal
          && candidate.result?.executionStatus === "success",
        );
      if (blockerIndex >= 0 && !blockerResolved && isMutatingStepCommand(step.command)) {
        const requirement = [...task.messages]
          .reverse()
          .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        const blockerStep = task.plan[blockerIndex];
        const reviewContext = JSON.stringify({
          trigger: "已发现未解决的阻断条件，即将执行变更操作，需结合用户目标和已有证据决定继续还是调整",
          reviewPolicy: {
            preconditionGate: true,
            unresolvedBlockingSignal: true,
            userMayExplicitlyAuthorizeAttempt: true,
            failureFactsCannotBeRewritten: true,
          },
          userRequirement: requirement,
          executionConstraints: task.executionConstraints,
          blockingEvidence: {
            title: blockerStep.title,
            command: blockerStep.command,
            expected: blockerStep.expected,
            result: blockerStep.result,
            evidence: blockerStep.evidence?.map(({ type, source, facts, rawOutput }) => ({
              type,
              source,
              facts,
              rawOutput: trimEvidence(rawOutput),
            })),
          },
          executionHistory: task.plan
            .slice(0, stepIndex)
            .map(({ title, description, command, expected, status, result, output }) => ({
              title,
              description,
              command,
              expected,
              status,
              result,
              output: trimEvidence(output, 1800),
            })),
          currentPlannedStep: {
            title: step.title,
            description: step.description,
            command: step.command,
            expected: step.expected,
            validation: step.validation,
            risk: step.risk,
          },
          fullPlan: task.plan.map(({ title, description, command, expected, validation, risk, status }) => ({
            title,
            description,
            command,
            expected,
            validation,
            risk,
            status,
          })),
          remainingSteps: task.plan
            .slice(stepIndex)
            .map(({ title, description, command, expected, validation, risk }) => ({
              title,
              description,
              command,
              expected,
              validation,
              risk,
            })),
        });
        task.status = "validating";
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: "发现未解决的前置条件，正在结合用户需求、执行记录、完整计划和剩余步骤进行一次模型复核…",
        });
        this.persist();
        const modelDecision = await backend.reviewStep(
          requirement,
          reviewContext,
          true,
          model && apiKey
            ? { apiKey, endpoint: model.endpoint, model: model.model, context: "" }
            : undefined,
        );
        if (task.cancelRequested) return;
        const allowAfterReview =
          modelDecision.source === "model"
          && modelDecision.decision === "continue";
        step.review = allowAfterReview
          ? modelDecision
          : {
              decision: "adjust",
              reason: modelDecision.source !== "model"
                ? "前置条件尚未满足且模型复核不可用，不能自动继续变更操作。"
                : modelDecision.reason,
              summary: modelDecision.summary,
              source: modelDecision.source === "model" ? "model" : "rules",
            };
        this.addLog({
          category: "model",
          level: allowAfterReview ? "info" : "warning",
          title: `${step.title} · 前置条件异常复核`,
          detail: JSON.stringify({
            input: JSON.parse(reviewContext),
            modelDecision,
            finalDecision: step.review,
          }, null, 2),
          serverId: task.serverId,
          taskId,
        });
        if (!allowAfterReview) {
          task.status = "needs_adjustment";
          task.pauseReason = `前置条件复核建议调整：${step.review.reason}`;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `${step.review.summary}\n${task.pauseReason}`,
          });
          this.persist();
          return;
        }
        task.status = "running";
        task.pauseReason = undefined;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: `模型结合用户需求、执行约束、完整计划和执行记录复核后同意继续；当前风险将保留并由后续真实执行结果判断。${step.review.summary}`,
        });
        this.persist();
      }

      if (this.needsApproval(task.permission, step)) {
        step.status = "awaiting_approval";
        task.status = "awaiting_step_approval";
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: `步骤“${step.title}”为${step.risk === "high" ? "高" : step.risk === "medium" ? "中" : "低"}风险，需要单独确认。`,
        });
        this.persist();
        return;
      }
      await this.runStep(taskId, step.id);
    },

    async approveStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step || step.status !== "awaiting_approval") return;
      task.status = "running";
      await this.runStep(taskId, stepId);
    },

    async runStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const requiredKeys = [...step.command.matchAll(/\$\{secret\.([A-Z0-9_]+)\}/g)].map((match) => match[1]);
      const unconfirmedKey = requiredKeys.find((key) => !task.confirmedSecretKeys?.includes(key));
      if (unconfirmedKey) {
        step.status = "awaiting_input";
        task.status = "awaiting_input";
        this.pendingSecret = { taskId, stepId, key: unconfirmedKey };
        const metadata = this.secretMetadata.find((item) => item.key === unconfirmedKey);
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: `本轮执行需要确认敏感变量 ${unconfirmedKey}${metadata?.description ? `（${metadata.description}）` : ""}。请输入本轮应使用的值；不会发送给模型。`,
        });
        this.persist();
        return;
      }
      step.status = "running";
      step.startedAt = now();
      step.elapsedSeconds = 0;
      step.progressMessage = "正在建立远程执行通道…";
      task.status = "running";
      this.pushMessage(task, { role: "assistant", kind: "event", content: `执行 ${step.title}：${step.command}` });
      this.terminalLines.push(`[智能任务 · ${task.title}] $ ${step.command}`);
      this.persist();

      try {
        const server = this.servers.find((item) => item.id === task.serverId);
        const password = this.serverPasswords[task.serverId];
        const connection = server && password
          ? { host: server.host, port: server.port, username: server.username, password }
          : undefined;
        step.command = normalizeSecretPlaceholders(step.command);
        step.validation = normalizeSecretPlaceholders(step.validation);
        const resolvedCommand = step.command.replace(/\$\{secret\.([A-Z0-9_]+)\}/g, (_match, key: string) => this.secretValues[key] ?? "");
        const resolvedValidation = step.validation.replace(
          /\$\{secret\.([A-Z0-9_]+)\}/g,
          (_match, key: string) => this.secretValues[key] ?? "",
        );
        const executionId = uid("exec");
        task.currentExecutionId = executionId;
        let streamedOutput = "";
        let lastLongTaskNotice = 0;
        let executionFinished = false;
        let monitorBusy = false;
        let monitorRound = 0;
        let monitorValidationPassed = false;
        let monitorDecision: NonNullable<PlanStep["review"]> | undefined;
        const requirement = [...task.messages]
          .reverse()
          .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
        const runtimeModel = this.models.find((item) => item.id === task.modelId);
        const runtimeApiKey = this.modelApiKeys[task.modelId];
        const heartbeat = window.setInterval(() => {
          step.elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(step.startedAt!).getTime()) / 1000));
          step.progressMessage = step.elapsedSeconds >= 10
            ? `远程命令仍在运行（${step.elapsedSeconds} 秒），系统会每 ${LONG_RUNNING_REVIEW_INTERVAL_MS / 1000} 秒获取状态并复核`
            : "远程命令正在执行";
          if (step.elapsedSeconds >= 30 && step.elapsedSeconds - lastLongTaskNotice >= 60) {
            lastLongTaskNotice = step.elapsedSeconds;
            this.pushMessage(task!, {
              role: "system",
              kind: "event",
              content: `${step.title}仍在执行，已运行 ${step.elapsedSeconds} 秒；可继续等待或点击“终止业务”。`,
            });
          }
        }, 1000);
        const longRunningMonitor = connection && runtimeModel && runtimeApiKey
          ? window.setInterval(async () => {
              if (executionFinished || monitorBusy || task.cancelRequested) return;
              if (monitorDecision) {
                try {
                  await backend.cancelCommand(connection, executionId);
                } catch (error) {
                  this.addLog({
                    category: "system",
                    level: "warning",
                    title: `${step.title} · 重试停止长驻命令失败`,
                    detail: String(error),
                    serverId: task.serverId,
                    taskId,
                  });
                }
                return;
              }
              monitorBusy = true;
              monitorRound += 1;
              const elapsedSeconds = Math.max(
                0,
                Math.floor((Date.now() - new Date(step.startedAt!).getTime()) / 1000),
              );
              this.pushMessage(task, {
                role: "system",
                kind: "event",
                content: `${step.title}已持续运行 ${elapsedSeconds} 秒，正在获取最新状态并进行第 ${monitorRound} 次长任务复核…`,
              });
              this.persist();
              try {
                const observation = await backend.validateStep(
                  { ...step, validation: resolvedValidation },
                  connection,
                  { executionId: uid("long-observation") },
                );
                if (executionFinished || task.cancelRequested) return;
                let safeObservationOutput = observation.output ?? "";
                safeObservationOutput = redactExecutionOutput(safeObservationOutput, this.secretValues);
                const remainingSteps = task.plan
                  .filter((item) => item.status === "pending")
                  .map(({ title, description, command, expected, validation, risk }) => ({
                    title,
                    description,
                    command,
                    expected,
                    validation,
                    risk,
                  }));
                const reviewContext = JSON.stringify({
                  trigger: "远程命令长时间未返回，定期获取状态并判断继续等待、停止等待进入正式校验或调整计划",
                  reviewPolicy: {
                    periodicLongRunningReview: true,
                    decisionContinueMeansWait: true,
                    decisionCompleteRequiresValidationPassed: true,
                    decisionAdjustMeansStopAndPause: true,
                    actualExecutionFactsCannotBeRewritten: true,
                  },
                  reviewRound: monitorRound,
                  elapsedSeconds,
                  userRequirement: requirement,
                  executionConstraints: task.executionConstraints,
                  currentStep: {
                    title: step.title,
                    description: step.description,
                    command: step.command,
                    expected: step.expected,
                    validation: step.validation,
                    risk: step.risk,
                    streamedOutput: trimEvidence(step.output ?? streamedOutput, 5000),
                  },
                  periodicObservation: {
                    passed: observation.passed,
                    detail: observation.detail,
                    exitCode: observation.exitCode,
                    output: trimEvidence(safeObservationOutput, 3000),
                  },
                  executionHistory: task.plan
                    .filter((item) => item !== step && item.status !== "pending")
                    .map(({ title, description, command, expected, status, result, output }) => ({
                      title,
                      description,
                      command,
                      expected,
                      status,
                      result,
                      output: trimEvidence(output, 1200),
                    })),
                  fullPlan: task.plan.map(({ title, description, command, expected, validation, risk, status }) => ({
                    title,
                    description,
                    command,
                    expected,
                    validation,
                    risk,
                    status,
                  })),
                  remainingSteps,
                });
                const review = await backend.reviewStep(
                  requirement,
                  reviewContext,
                  remainingSteps.length > 0,
                  { apiKey: runtimeApiKey, endpoint: runtimeModel.endpoint, model: runtimeModel.model, context: "" },
                );
                if (executionFinished || task.cancelRequested) return;
                const acceptedDecision = review.source === "model"
                  && (
                    review.decision === "continue"
                    || review.decision === "adjust"
                    || (review.decision === "complete" && observation.passed)
                  );
                this.addLog({
                  category: "model",
                  level: review.decision === "adjust" ? "warning" : "info",
                  title: `${step.title} · 长任务定期复核 #${monitorRound}`,
                  detail: JSON.stringify({
                    input: JSON.parse(reviewContext),
                    modelDecision: review,
                    acceptedDecision,
                  }, null, 2),
                  serverId: task.serverId,
                  taskId,
                });
                if (!acceptedDecision || review.decision === "continue") {
                  this.pushMessage(task, {
                    role: "system",
                    kind: "event",
                    content: review.source !== "model"
                      ? `第 ${monitorRound} 次长任务复核时模型不可用，保持执行并继续等待。`
                      : review.decision === "complete" && !observation.passed
                        ? `模型建议停止等待，但程序校验尚未通过，本轮继续等待。`
                        : `第 ${monitorRound} 次复核建议继续等待：${review.summary}`,
                  });
                  this.persist();
                  return;
                }
                monitorDecision = review;
                monitorValidationPassed = observation.passed;
                this.pushMessage(task, {
                  role: "assistant",
                  kind: "event",
                  content: review.decision === "complete"
                    ? `定期校验已满足后置条件，模型建议停止持续等待并进入正式校验：${review.summary}`
                    : `长任务复核建议停止当前命令并调整：${review.summary}`,
                });
                this.persist();
                await backend.cancelCommand(connection, executionId);
              } catch (error) {
                if (!executionFinished) {
                  this.addLog({
                    category: "system",
                    level: "warning",
                    title: `${step.title} · 长任务状态获取失败`,
                    detail: String(error),
                    serverId: task.serverId,
                    taskId,
                  });
                }
              } finally {
                monitorBusy = false;
              }
            }, LONG_RUNNING_REVIEW_INTERVAL_MS)
          : undefined;
        let result;
        try {
          result = await backend.executeCommand(resolvedCommand, connection, step.risk === "high", {
            executionId,
            onProgress: ({ data }) => {
              const safeChunk = redactExecutionOutput(sanitizeTerminalOutput(data), this.secretValues);
              if (!safeChunk) return;
              streamedOutput = sanitizeTerminalOutput(streamedOutput + safeChunk);
              step.output = `$ ${step.command}\n${streamedOutput}`;
              const lines = safeChunk.split(/\r?\n/).filter(Boolean);
              lines.forEach((line) => {
                const lastIndex = this.terminalLines.length - 1;
                if (isProgressFrame(line) && lastIndex >= 0 && isProgressFrame(this.terminalLines[lastIndex])) {
                  this.terminalLines[lastIndex] = line;
                } else {
                  this.terminalLines.push(line);
                }
              });
              if (this.terminalLines.length > 2000) {
                this.terminalLines.splice(0, this.terminalLines.length - 2000);
              }
            },
          });
        } finally {
          executionFinished = true;
          window.clearInterval(heartbeat);
          if (longRunningMonitor !== undefined) window.clearInterval(longRunningMonitor);
          task.currentExecutionId = undefined;
        }
        if (task.cancelRequested) return;
        if (
          monitorDecision?.decision === "complete"
          && monitorValidationPassed
          && !result.success
          && result.exitCode === 130
        ) {
          result = {
            ...result,
            success: true,
            exitCode: 0,
            output: `${result.output}\n[长任务复核：定期校验已通过，已停止等待并进入正式校验]`,
          };
        }
        const safeOutput = redactExecutionOutput(sanitizeTerminalOutput(result.output), this.secretValues);
        step.output = safeOutput;
        if (!streamedOutput) {
          const terminalOutput = safeOutput.split("\n");
          if (terminalOutput[0]?.startsWith("$ ")) terminalOutput.shift();
          this.terminalLines.push(...terminalOutput);
        } else {
          const exitLine = [...safeOutput.split("\n")].reverse().find((line) => line.startsWith("[exit:"));
          if (exitLine) this.terminalLines.push(exitLine);
        }
        this.addLog({
          category: "command",
          level: result.success ? "success" : "error",
          title: step.title,
          detail: `${step.command}\n${safeOutput}`,
          serverId: task.serverId,
          taskId,
        });
        if (monitorDecision?.decision === "adjust") {
          step.status = "failed";
          step.review = monitorDecision;
          step.result = {
            executionStatus: "failed",
            observationStatus: "unknown",
            exitCode: result.exitCode,
            facts: {
              commandCompleted: false,
              stoppedByPeriodicReview: true,
              reviewRound: monitorRound,
            },
            warnings: [],
            evidenceIds: [],
            failureReason: monitorDecision.reason,
          };
          step.evidence = [{
            id: uid("evidence-long-review"),
            type: "command-output",
            source: "main",
            facts: {
              stoppedByPeriodicReview: true,
              elapsedSeconds: step.elapsedSeconds,
              validationPassed: monitorValidationPassed,
            },
            rawOutput: safeOutput,
            collectedAt: now(),
          }];
          step.result.evidenceIds = step.evidence.map((item) => item.id);
          task.status = "needs_adjustment";
          task.pauseReason = `长任务定期复核建议调整：${monitorDecision.reason}`;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `${monitorDecision.summary}\n${task.pauseReason}`,
          });
          this.persist();
          return;
        }
        if (!result.success) {
          if (result.exitCode === 130 || task.cancelRequested) return;
          const failure = analyzeCommandFailure(safeOutput);
          step.status = "failed";
          step.result = {
            executionStatus: "failed",
            observationStatus: "unknown",
            exitCode: result.exitCode,
            facts: { commandCompleted: false, ...failure.facts },
            warnings: [],
            evidenceIds: [],
            failureReason: failure.reason,
          };
          step.evidence = [{
            id: uid("evidence-main"),
            type: "command-output",
            source: "main",
            facts: { success: false, exitCode: result.exitCode, ...failure.facts },
            rawOutput: safeOutput,
            collectedAt: now(),
          }];
          step.result.evidenceIds = step.evidence.map((item) => item.id);
          const remainingSteps = task.plan.filter((item) => item.status === "pending");
          const requirement = [...task.messages]
            .reverse()
            .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          const reviewContext = JSON.stringify({
            trigger: "主命令执行失败，需要判断是否影响用户整体目标和剩余计划",
            reviewPolicy: {
              exceptionalReview: true,
              commandExecutionFailed: true,
              modelMayDecideWorkflow: true,
              modelCannotRewriteFailureAsSuccess: true,
              userConstraintsMustBePreserved: true,
            },
            userRequirement: requirement,
            executionConstraints: task.executionConstraints,
            task: {
              title: task.title,
              permission: task.permission,
              status: task.status,
            },
            currentStep: {
              title: step.title,
              description: step.description,
              command: step.command,
              expected: step.expected,
              validation: step.validation,
              risk: step.risk,
              result: step.result,
              evidence: step.evidence.map(({ type, source, facts, rawOutput }) => ({
                type,
                source,
                facts,
                rawOutput: trimEvidence(rawOutput),
              })),
            },
            executionHistory: task.plan
              .filter((item) => item !== step && item.status !== "pending")
              .map(({ title, description, command, expected, status, result, output }) => ({
                title,
                description,
                command,
                expected,
                status,
                result,
                output: trimEvidence(output, 1800),
              })),
            fullPlan: task.plan.map(({ title, description, command, expected, validation, risk, status }) => ({
              title,
              description,
              command,
              expected,
              validation,
              risk,
              status,
            })),
            remainingSteps: remainingSteps.map(({ title, description, command, expected, validation, risk }) => ({
              title,
              description,
              command,
              expected,
              validation,
              risk,
            })),
          });
          task.status = "validating";
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `${step.title}执行未成功，正在结合用户需求、完整计划和执行记录进行一次异常模型复核…`,
          });
          this.persist();
          step.review = await backend.reviewStep(
            requirement,
            reviewContext,
            remainingSteps.length > 0,
            model && apiKey
              ? { apiKey, endpoint: model.endpoint, model: model.model, context: "" }
              : undefined,
          );
          if (task.cancelRequested) return;
          const mutatingStep = isMutatingStepCommand(step.command);
          const diagnosticStep = isReadOnlyDiagnosticStep(step) && !mutatingStep;
          const hasRecoveryStep = remainingPlanCanRecoverExecutionFailure(
            failure.facts.category,
            remainingSteps,
          );
          const originalReview = step.review;
          if (step.review.source !== "model") {
            step.review = {
              decision: "adjust",
              reason: "主命令执行失败且模型复核不可用，程序不会使用兜底规则继续任务。",
              summary: "当前步骤执行失败，需要调整后再继续。",
              source: "rules",
            };
          } else if (step.review.decision === "complete" && !diagnosticStep) {
            step.review = {
              decision: "adjust",
              reason: "非诊断步骤执行失败，不能仅依据模型意见判定整个任务完成。",
              summary: "当前操作没有完成，需要修复执行失败。",
              source: "rules",
            };
          } else if (
              step.review.decision === "continue"
            && !diagnosticStep
            && !hasRecoveryStep
          ) {
            step.review = {
              decision: "adjust",
              reason: `${failure.reason}；剩余计划没有能够处理该失败原因的明确恢复步骤。`,
              summary: "当前计划无法从本次执行失败中安全恢复。",
              source: "rules",
            };
          }
          this.addLog({
            category: "model",
            level: step.review.decision === "adjust" ? "warning" : "info",
            title: `${step.title} · 主命令失败异常复核`,
            detail: JSON.stringify({
              input: JSON.parse(reviewContext),
              modelDecision: originalReview,
              diagnosticStep,
              mutatingStep,
              recoveryStepFound: hasRecoveryStep,
              finalDecision: step.review,
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });
          if (step.review.decision === "adjust") {
            task.status = "needs_adjustment";
            task.pauseReason = `执行异常复核建议调整：${step.review.reason}`;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `${step.review.summary}\n${task.pauseReason}`,
            });
            this.persist();
            return;
          }
          task.status = "running";
          if (step.review.decision === "complete") {
            remainingSteps.forEach((item) => {
              item.status = "skipped";
            });
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `步骤执行失败已如实保留；模型结合用户目标判定无需继续剩余 ${remainingSteps.length} 个步骤。${step.review.summary}`,
            });
          } else {
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `步骤执行失败已如实保留；模型确认剩余计划可以继续处理。${step.review.summary}`,
            });
          }
          this.persist();
          await wait(250);
          await this.advanceTask(taskId);
          return;
        }

        step.status = "validating";
        task.status = "validating";
        this.persist();
        const validationExecutionId = uid("validation");
        task.currentExecutionId = validationExecutionId;
        let validation = await backend.validateStep(
          { ...step, validation: resolvedValidation },
          connection,
          {
            executionId: validationExecutionId,
            onProgress: ({ data }) => {
              const safeChunk = redactExecutionOutput(sanitizeTerminalOutput(data), this.secretValues);
              if (safeChunk) this.terminalLines.push(...safeChunk.split(/\r?\n/).filter(Boolean));
            },
          },
        );
        task.currentExecutionId = undefined;
        if (task.cancelRequested) return;
        const retryReadOnlyHttpValidation =
          !validation.passed
          && isReadOnlyStep(step)
          && ensureStepValidator(step).validator?.type === "http";
        if (retryReadOnlyHttpValidation) {
          let firstValidationOutput = validation.output ?? "";
          firstValidationOutput = redactExecutionOutput(firstValidationOutput, this.secretValues);
          if (firstValidationOutput) {
            step.output = `${step.output}\n\n--- 独立校验（首次未通过） ---\n${firstValidationOutput}`;
          }
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: `${step.title}的独立网络校验与主结果不一致，正在自动重试一次…`,
          });
          const retryExecutionId = uid("validation-retry");
          task.currentExecutionId = retryExecutionId;
          validation = await backend.validateStep(
            { ...step, validation: resolvedValidation },
            connection,
            {
              executionId: retryExecutionId,
              onProgress: ({ data }) => {
                const safeChunk = redactExecutionOutput(sanitizeTerminalOutput(data), this.secretValues);
                if (safeChunk) this.terminalLines.push(...safeChunk.split(/\r?\n/).filter(Boolean));
              },
            },
          );
          task.currentExecutionId = undefined;
          if (task.cancelRequested) return;
        }
        let safeValidationOutput = validation.output ?? "";
        if (validation.output) {
          safeValidationOutput = redactExecutionOutput(validation.output, this.secretValues);
          step.output = `${step.output}\n\n--- 独立校验 ---\n${safeValidationOutput}`;
          this.terminalLines.push(`验证 › ${step.validation}`, ...safeValidationOutput.split("\n"));
        }
        const classified = classifyStepResult(
          step,
          { ...result, output: safeOutput },
          { ...validation, output: safeValidationOutput },
        );
        step.validator = ensureStepValidator(step).validator;
        step.result = classified.result;
        step.evidence = classified.evidence;
        this.addLog({
          category: "command",
          level: classified.accepted
            ? classified.result.observationStatus === "warning" || classified.result.observationStatus === "unhealthy"
              ? "warning"
              : "success"
            : "error",
          title: `${step.title} · 程序证据校验`,
          detail: JSON.stringify({
            validator: step.validator,
            result: step.result,
            validationCommand: step.validation,
            validationOutput: safeValidationOutput,
          }, null, 2),
          serverId: task.serverId,
          taskId,
        });
        const remainingSteps = task.plan.filter((item) => item.status === "pending");
        const postconditionReview = !classified.accepted
          && classified.result.executionStatus === "success";
        if (postconditionReview || classified.needsModelReview) {
          const requirement = [...task.messages]
            .reverse()
            .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          const reviewContext = JSON.stringify({
            trigger: postconditionReview
              ? "主命令执行成功，但独立后置校验未通过"
              : "程序发现证据不可解释或相互冲突",
            reviewPolicy: postconditionReview
              ? {
                  exceptionalReview: true,
                  mainExecutionSucceeded: true,
                  postconditionFailed: true,
                  modelMayExplainConflict: true,
                  hardFactsCannotBeOverridden: true,
                  mutationMayContinueOnlyWhenRemainingPlanRepairsPostcondition: true,
                }
              : undefined,
            userRequirement: requirement,
            executionConstraints: task.executionConstraints,
            task: {
              title: task.title,
              permission: task.permission,
              status: task.status,
            },
            currentStep: {
              title: step.title,
              description: step.description,
              command: step.command,
              expected: step.expected,
              validator: step.validator,
              result: step.result,
              evidence: step.evidence?.map(({ type, source, facts, rawOutput }) => ({
                type,
                source,
                facts,
                rawOutput,
              })),
            },
            completedSteps: task.plan
              .filter((item) => item.status === "completed")
              .map(({ title, description, command, expected, result, output }) => ({
                title,
                description,
                command,
                expected,
                result,
                output: trimEvidence(output, 1800),
              })),
            fullPlan: task.plan.map(({ title, description, command, expected, validation, risk, status }) => ({
              title,
              description,
              command,
              expected,
              validation,
              risk,
              status,
            })),
            remainingSteps: remainingSteps.map(({ title, description, command, expected, risk }) => ({
              title,
              description,
              command,
              expected,
              risk,
            })),
          });
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: postconditionReview
              ? `${step.title}的后置校验未通过，正在结合主命令输出进行一次异常模型复核…`
              : `${step.title}的证据需要解释，正在进行一次异常模型复核…`,
          });
          this.persist();
          step.review = await backend.reviewStep(
            requirement,
            reviewContext,
            remainingSteps.length > 0,
            model && apiKey
              ? { apiKey, endpoint: model.endpoint, model: model.model, context: "" }
              : undefined,
          );
          if (task.cancelRequested) return;
          this.addLog({
            category: "model",
            level: step.review.decision === "adjust" ? "warning" : "success",
            title: postconditionReview
              ? `${step.title} · 后置校验失败异常复核`
              : `${step.title} · 异常模型复核`,
            detail: JSON.stringify({
              reason: postconditionReview
                ? "主命令执行成功，但独立后置校验未通过"
                : "程序发现证据不可解释或相互冲突",
              input: JSON.parse(reviewContext),
              result: step.review,
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });

          if (postconditionReview) {
            const hardBlocker = postconditionHasHardBlocker(
              step,
              remainingSteps,
              validation.exitCode,
            );
            const mutatingStep = isMutatingStepCommand(step.command);
            const hasRepairStep = remainingPlanCanRepairPostcondition(remainingSteps);
            if (step.review.source !== "model") {
              step.review = {
                decision: "adjust",
                reason: "后置校验未通过且模型复核不可用，程序不会使用兜底规则把该步骤判为成功。",
                summary: "主命令已执行，但结果尚未得到可靠确认。",
                source: "rules",
              };
            } else if (hardBlocker) {
              step.review = {
                decision: "adjust",
                reason: hardBlocker,
                summary: "模型已完成复核，但程序安全门禁要求先处理确定性阻断。",
                source: "rules",
              };
            } else if (step.review.decision === "complete" && mutatingStep) {
              step.review = {
                decision: "adjust",
                reason: "变更步骤的后置条件尚未满足，不能仅依据模型意见直接判定整个任务完成。",
                summary: "变更命令已执行，但目标状态仍需修复或重新验证。",
                source: "rules",
              };
            } else if (
              step.review.decision === "continue"
              && mutatingStep
              && !hasRepairStep
            ) {
              step.review = {
                decision: "adjust",
                reason: "变更步骤的后置条件尚未满足，剩余计划也没有明确的修复步骤。",
                summary: "需要先调整计划以修复或重新验证目标状态。",
                source: "rules",
              };
            }
            this.addLog({
              category: "system",
              level: step.review.decision === "adjust" ? "warning" : "info",
              title: `${step.title} · 后置校验最终决策`,
              detail: JSON.stringify({
                validationPassed: false,
                validationExitCode: validation.exitCode,
                mutatingStep,
                remainingPlanCanRepair: hasRepairStep,
                finalDecision: step.review,
              }, null, 2),
              serverId: task.serverId,
              taskId,
            });
          }
        } else {
          step.review = {
            decision: remainingSteps.length ? "continue" : "complete",
            reason: "主命令和结构化程序证据一致，无需调用模型复核。",
            summary: step.result.warnings[0] ?? "程序证据校验通过。",
            source: "rules",
          };
          this.addLog({
            category: "system",
            level: "info",
            title: `${step.title} · 确定性规则复核`,
            detail: JSON.stringify({ result: step.result, modelReviewSkipped: true }, null, 2),
            serverId: task.serverId,
            taskId,
          });
        }

        if (step.result?.facts.blockingSignal && !postconditionReview) {
          const canResolve = remainingPlanResolvesBlockingSignal(step, remainingSteps);
          step.review = canResolve
            ? {
                decision: "continue",
                reason: "程序识别到运行时兼容性阻断，但剩余计划包含对应升级或切换步骤。",
                summary: "当前运行时不兼容，继续执行计划中的环境修复步骤。",
                source: "rules",
              }
            : {
                decision: "adjust",
                reason: "程序识别到运行时兼容性阻断，剩余计划没有升级或切换运行时的步骤，禁止继续安装或构建。",
                summary: "当前运行时版本不满足项目要求，计划必须先修复环境。",
                source: "rules",
              };
          this.addLog({
            category: "system",
            level: canResolve ? "info" : "warning",
            title: `${step.title} · 前置条件门禁`,
            detail: JSON.stringify({
              blockingFacts: step.result.facts,
              remainingPlanResolvesBlocker: canResolve,
              result: step.review,
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });
        }

        if (
          step.review?.decision === "adjust"
          && !postconditionReview
          && isReadOnlyDiagnosticStep(step)
          && remainingSteps[0]
          && isReadOnlyDiagnosticStep(remainingSteps[0])
        ) {
          step.review = {
            decision: "continue",
            reason: "异常模型建议调整，但当前与下一步骤均为只读诊断；继续收集证据后再判断。",
            summary: "继续完成剩余只读诊断。",
            source: "rules",
          };
        }

        if (step.review?.decision === "adjust") {
          step.status = "failed";
          task.status = "needs_adjustment";
          task.pauseReason = `模型复核建议调整：${step.review.reason}`;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `${step.review.summary}\n${task.pauseReason}`,
          });
          this.persist();
          return;
        }

        step.status = "completed";
        task.status = "running";
        if (
          (classified.needsModelReview || postconditionReview)
          && step.review?.decision === "complete"
        ) {
          remainingSteps.forEach((item) => {
            item.status = "skipped";
          });
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `✓ ${step.title}完成；复核判定整体目标已达成，已跳过 ${remainingSteps.length} 个无需继续的步骤。${step.review.summary}`,
          });
        } else {
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `✓ ${step.title}完成；${step.review?.summary ?? "程序证据校验通过。"}`,
          });
        }
        this.persist();
        await wait(250);
        await this.advanceTask(taskId);
      } catch (error) {
        step.status = "failed";
        task.status = "needs_adjustment";
        task.pauseReason = `步骤“${step.title}”执行异常：${String(error)}。任务已暂停，可生成调整计划后继续。`;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: task.pauseReason,
        });
        this.persist();
      }
    },

    async provideSecret(value: string) {
      const request = this.pendingSecret;
      if (!request || !value) return;
      this.secretValues[request.key] = value;
      if (!this.secretMetadata.some((item) => item.key === request.key)) {
        this.secretMetadata.push({ key: request.key, description: "任务执行时请求的敏感变量", scope: "global" });
      }
      this.pendingSecret = null;
      const task = this.tasks.find((item) => item.id === request.taskId);
      const step = task?.plan.find((item) => item.id === request.stepId);
      if (!task || !step) return;
      task.confirmedSecretKeys ??= [];
      if (!task.confirmedSecretKeys.includes(request.key)) task.confirmedSecretKeys.push(request.key);
      step.status = "pending";
      task.status = "running";
      this.pushMessage(task, { role: "user", kind: "event", content: `已安全提供变量 ${request.key}。` });
      this.persist();
      await this.runStep(request.taskId, request.stepId);
    },

    addSecretMetadata(key: string, description: string, value = "") {
      const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || this.secretMetadata.some((item) => item.key === normalized)) return;
      this.secretMetadata.push({ key: normalized, description: description.trim() || "敏感变量", scope: "global" });
      if (value) this.secretValues[normalized] = value;
      this.persist();
    },

    async renameSecretMetadata(oldKey: string, nextKey: string) {
      const normalized = nextKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || normalized === oldKey) return normalized === oldKey;
      if (this.secretMetadata.some((item) => item.key === normalized)) return false;
      const secret = this.secretMetadata.find((item) => item.key === oldKey);
      if (!secret) return false;
      const value = this.secretValues[oldKey] ?? "";
      if (value) await backend.saveCredential("secret", normalized, value);
      await backend.deleteCredential("secret", oldKey);
      secret.key = normalized;
      if (value) this.secretValues[normalized] = value;
      delete this.secretValues[oldKey];
      this.persist(true);
      return true;
    },

    async removeSecretMetadata(key: string) {
      await backend.deleteCredential("secret", key);
      this.secretMetadata = this.secretMetadata.filter((item) => item.key !== key);
      delete this.secretValues[key];
      this.persist(true);
    },

    async saveSecretSettings() {
      await Promise.all(this.secretMetadata.map((secret) => {
        const value = this.secretValues[secret.key] ?? "";
        return value
          ? backend.saveCredential("secret", secret.key, value)
          : backend.deleteCredential("secret", secret.key);
      }));
      this.persist(true);
    },

    async runTerminalCommand(command: string, serverId?: string) {
      if (!command.trim()) return;
      const activeServer = this.servers.find((item) => item.id === serverId);
      const prompt = activeServer ? `${activeServer.username}@${activeServer.host}:~$` : "local:~$";
      this.terminalLines.push(`${prompt} ${command}`);
      const server = this.servers.find((item) => item.id === serverId);
      const password = serverId ? this.serverPasswords[serverId] : undefined;
      const connection = server && password
        ? { host: server.host, port: server.port, username: server.username, password }
        : undefined;
      const result = await backend.executeCommand(command, connection);
      const terminalOutput = result.output.split("\n");
      if (terminalOutput[0]?.startsWith("$ ")) terminalOutput.shift();
      this.terminalLines.push(...terminalOutput);
      this.addLog({
        category: "command",
        level: result.success ? "success" : "error",
        title: "手动终端命令",
        detail: `${command}\n${result.output}`,
      });
    },

    async saveModels() {
      this.aiGenerationSettings = normalizeAiGenerationSettings(this.aiGenerationSettings);
      this.models = this.models.filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
      const credentials = this.models
        .filter((model) => this.modelApiKeys[model.id])
        .map(async (model) => {
          await backend.saveCredential("model", model.id, this.modelApiKeys[model.id]);
          model.hasApiKey = true;
        });
      try {
        await Promise.all(credentials);
        this.credentialError = "";
      } catch (error) {
        this.credentialError = String(error);
        throw error;
      } finally {
        this.persist(true);
      }
      await this.refreshModelAvailability();
    },

    async refreshModelAvailability() {
      await this.hydrateCredentials();
      await Promise.all(this.models.map(async (model) => {
        if (!model.enabled) {
          this.modelAvailability[model.id] = { status: "unavailable", reason: "模型已停用", checkedAt: now() };
          return;
        }
        const apiKey = this.modelApiKeys[model.id] ?? "";
        if (!apiKey) {
          this.modelAvailability[model.id] = { status: "unavailable", reason: "未配置 API Key", checkedAt: now() };
          return;
        }
        if (!model.endpoint.trim() || !model.model.trim()) {
          this.modelAvailability[model.id] = {
            status: "unavailable",
            reason: !model.endpoint.trim() ? "未配置接口地址" : "未配置模型名称",
            checkedAt: now(),
          };
          return;
        }
        this.modelAvailability[model.id] = { status: "checking", reason: "正在检查模型服务…" };
        try {
          const result = await backend.checkModel({
            apiKey,
            endpoint: model.endpoint,
            model: model.model,
          });
          this.modelAvailability[model.id] = {
            status: result.available ? "available" : "unavailable",
            reason: result.reason,
            checkedAt: now(),
          };
        } catch (error) {
          this.modelAvailability[model.id] = {
            status: "unavailable",
            reason: String(error),
            checkedAt: now(),
          };
        }
      }));
    },
  },
});
