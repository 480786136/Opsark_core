import { defineStore } from "pinia";
import { backend, buildExecutionSummary, normalizePlanPreconditions } from "@/services/backend";
import type {
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
let persistTimer: number | undefined;
let credentialHydration: Promise<void> | undefined;

const demoServer: ServerProfile = {
  id: "srv-production-01",
  name: "生产环境 · Web-01",
  host: "10.24.8.16",
  port: 22,
  username: "ops",
  group: "生产环境",
  status: "online",
  environment: ["Docker 26.1", "Nginx 1.24", "Node.js 22", "PostgreSQL 16"],
  info: {
    os: "Ubuntu 24.04 LTS",
    kernel: "6.8.0-44-generic",
    cpu: "Intel Xeon Gold 6338N",
    cores: 8,
    memoryGb: 16,
    diskGb: 160,
    uptime: "16 天 4 小时",
  },
  createdAt: now(),
};

const testServer: ServerProfile = {
  id: "srv-tencent-test",
  name: "腾讯云测试服务器",
  host: "111.231.1.58",
  port: 22,
  username: "root",
  group: "测试环境",
  status: "offline",
  environment: ["Docker 26.1.4", "Node.js 16.20.2", "Python 3.9.12", "MySQL 8.0.44", "Nginx"],
  info: {
    os: "CentOS Linux 7 (Core)",
    kernel: "Linux 3.10.0-1160.119.1.el7.x86_64",
    cpu: "远程服务器 CPU",
    cores: 2,
    memoryGb: 4,
    diskGb: 59,
    uptime: "4 周 6 天",
  },
  createdAt: now(),
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

function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function initialServers() {
  const saved = readSaved<ServerProfile[]>("opsark.servers", [demoServer, testServer]);
  return saved.some((server) => server.host === testServer.host) ? saved : [...saved, testServer];
}

function initialModels() {
  const saved = readSaved<ModelProfile[]>("opsark.models", defaultModels)
    .filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
  return saved.length ? saved : defaultModels.map((model) => ({ ...model }));
}

function initialTasks() {
  return readSaved<OpsTask[]>("opsark.tasks", []).map((task) => {
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
        const rejected = [...serverCredentials, ...modelCredentials].find((result) => result.status === "rejected");
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
        info: { ...demoServer.info, os: "等待采集…", uptime: "—" },
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

    pushMessage(task: OpsTask, message: Omit<TaskMessage, "id" | "createdAt">) {
      task.messages.push({ ...message, id: uid("msg"), createdAt: now() });
      task.updatedAt = now();
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
      const priorConversation = task.messages
        .filter((message) => message.kind !== "event" || message.role !== "system")
        .slice(-24)
        .map(({ role, kind, content }) => ({ role, kind, content }));
      if (task.plan.length) {
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
      this.activeTaskId = task.id;
      this.pushMessage(task, { role: "user", kind: "message", content });
      this.pushMessage(task, { role: "system", kind: "event", content: "正在汇总服务器上下文并生成执行计划…" });
      this.addLog({
        category: "model",
        level: "info",
        title: "提交模型规划请求",
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
          tools: ["服务器基础信息", "实时指标", "安全命令执行", "敏感变量占位符"],
          secretVariables: this.secretMetadata
            .filter((item) => item.scope === "global" || item.serverId === serverId)
            .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` })),
        });
        task.plan = await backend.generatePlan(
          content,
          model.provider !== "Built-in"
            ? { apiKey: apiKey!, endpoint: model.endpoint, model: model.model, context }
            : undefined,
        );
        task.status = "awaiting_plan_approval";
        this.activeTaskId = task.id;
        this.addLog({
          category: "model",
          level: "success",
          title: "模型执行计划已返回",
          detail: JSON.stringify({ requirement: content, context: JSON.parse(context), plan: task.plan }, null, 2),
          serverId,
          taskId: task.id,
        });
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: `已生成 ${task.plan.length} 个执行步骤。请检查风险、命令和预期结果后确认计划。`,
        });
        this.persist();
      } catch (error) {
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
      const failed = task.plan.find((step) => step.status === "failed");
      const originalRequirement = [...task.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
      const model = this.models.find((item) => item.id === task.modelId);
      const apiKey = this.modelApiKeys[task.modelId];
      if (!model) {
        task.status = "failed";
        task.summary = "调整计划失败：所选模型配置不存在。";
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        this.persist();
        return;
      }
      if (model.provider !== "Built-in" && !apiKey) {
        task.status = "failed";
        task.summary = `调整计划失败：“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存。`;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        this.persist();
        return;
      }
      const server = this.servers.find((item) => item.id === task.serverId);
      const context = JSON.stringify({
        server: server ? { name: server.name, host: server.host, info: server.info, environment: server.environment } : undefined,
        metrics: this.metrics,
        permission: task.permission,
        previousPlan: task.plan,
        failedStep: failed,
        instruction: "基于失败输出重新诊断。不要重复已完成步骤，提供替代步骤并以复查结束。",
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
            ? { apiKey: apiKey!, endpoint: model.endpoint, model: model.model, context }
            : undefined,
        );
        task.plan = [...task.plan.filter((step) => step.status === "completed"), ...replacement];
        task.status = "awaiting_plan_approval";
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: `已根据失败结果生成 ${replacement.length} 个调整步骤，请重新审查并批准。`,
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
        task.status = "failed";
        this.pushMessage(task, { role: "system", kind: "event", content: `调整计划生成失败：${String(error)}` });
      }
      this.persist();
    },

    async approvePlan(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "awaiting_plan_approval") return;
      task.plan = normalizePlanPreconditions(task.plan);
      task.status = "running";
      this.pushMessage(task, { role: "user", kind: "event", content: "计划已批准，开始执行。" });
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
      this.persist();
    },

    needsApproval(permission: PermissionLevel, step: PlanStep) {
      if (step.risk === "high") return true;
      if (permission === "observe") return true;
      return permission === "safe" && step.risk === "medium";
    },

    async advanceTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["running", "awaiting_step_approval"].includes(task.status)) return;
      const step = task.plan.find((item) => item.status === "pending");
      if (!step) {
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
        task.status = "completed";
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
      const missingKey = requiredKeys.find((key) => !this.secretValues[key]);
      if (missingKey) {
        step.status = "awaiting_input";
        task.status = "awaiting_input";
        this.pendingSecret = { taskId, stepId, key: missingKey };
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: `执行需要敏感变量 ${missingKey}。请输入后由后端合并，变量值不会发送给模型。`,
        });
        this.persist();
        return;
      }
      step.status = "running";
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
        const resolvedCommand = step.command.replace(/\$\{secret\.([A-Z0-9_]+)\}/g, (_match, key: string) => this.secretValues[key] ?? "");
        const result = await backend.executeCommand(resolvedCommand, connection, step.risk === "high");
        const safeOutput = Object.values(this.secretValues).reduce(
          (output, secret) => secret ? output.split(secret).join("••••••••") : output,
          result.output,
        );
        step.output = safeOutput;
        const terminalOutput = safeOutput.split("\n");
        if (terminalOutput[0]?.startsWith("$ ")) terminalOutput.shift();
        this.terminalLines.push(...terminalOutput);
        this.addLog({
          category: "command",
          level: result.success ? "success" : "error",
          title: step.title,
          detail: `${step.command}\n${safeOutput}`,
          serverId: task.serverId,
          taskId,
        });
        if (!result.success) {
          step.status = "failed";
          task.status = "needs_adjustment";
          const failureSummary = `步骤“${step.title}”执行未成功，退出码 ${result.exitCode ?? "未知"}。任务已暂停，可根据输出生成调整计划。`;
          task.summary = failureSummary;
          this.pushMessage(task, { role: "assistant", kind: "summary", content: failureSummary });
          this.persist();
          return;
        }

        step.status = "validating";
        task.status = "validating";
        this.persist();
        const resolvedValidation = step.validation.replace(
          /\$\{secret\.([A-Z0-9_]+)\}/g,
          (_match, key: string) => this.secretValues[key] ?? "",
        );
        const validation = await backend.validateStep({ ...step, validation: resolvedValidation }, connection);
        if (validation.output) {
          const safeValidationOutput = Object.values(this.secretValues).reduce(
            (output, secret) => secret ? output.split(secret).join("••••••••") : output,
            validation.output,
          );
          step.output = `${step.output}\n\n--- 独立校验 ---\n${safeValidationOutput}`;
          this.terminalLines.push(`验证 › ${step.validation}`, ...safeValidationOutput.split("\n"));
          this.addLog({
            category: "command",
            level: validation.passed ? "success" : "error",
            title: `${step.title} · 独立校验`,
            detail: `${step.validation}\n${safeValidationOutput}`,
            serverId: task.serverId,
            taskId,
          });
        }
        if (!validation.passed) {
          step.status = "failed";
          task.status = "needs_adjustment";
          this.pushMessage(task, { role: "assistant", kind: "event", content: `校验未通过：${validation.detail}。计划已暂停。` });
          this.persist();
          return;
        }

        const requirement = [...task.messages]
          .reverse()
          .find((message) => message.role === "user" && message.kind === "message")?.content ?? task.title;
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        const remainingSteps = task.plan.filter((item) => item.status === "pending");
        const reviewContext = JSON.stringify({
          currentStep: {
            title: step.title,
            description: step.description,
            command: step.command,
            expected: step.expected,
            validation: step.validation,
            executionAndValidationOutput: step.output ?? "",
            programValidation: validation.detail,
          },
          completedSteps: task.plan
            .filter((item) => item.status === "completed")
            .map(({ title, expected, output }) => ({ title, expected, output })),
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
          content: `${step.title}程序校验通过，正在结合主命令与校验输出进行模型复核…`,
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
        this.addLog({
          category: "model",
          level: step.review.decision === "adjust" ? "warning" : "success",
          title: `${step.title} · ${step.review.source === "model" ? "模型结果复核" : "规则结果复核"}`,
          detail: JSON.stringify({
            input: JSON.parse(reviewContext),
            result: step.review,
          }, null, 2),
          serverId: task.serverId,
          taskId,
        });

        if (step.review.decision === "adjust") {
          step.status = "failed";
          task.status = "needs_adjustment";
          task.summary = `模型复核建议调整：${step.review.reason}`;
          this.pushMessage(task, {
            role: "assistant",
            kind: "summary",
            content: `${step.review.summary}\n${task.summary}`,
          });
          this.persist();
          return;
        }

        step.status = "completed";
        task.status = "running";
        if (step.review.decision === "complete") {
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
            content: `✓ ${step.title}完成；程序校验与${step.review.source === "model" ? "模型" : "规则"}复核通过。${step.review.summary}`,
          });
        }
        this.persist();
        await wait(250);
        await this.advanceTask(taskId);
      } catch (error) {
        step.status = "failed";
        task.status = "needs_adjustment";
        task.summary = `步骤“${step.title}”执行异常：${String(error)}。任务已暂停，可生成调整计划后继续。`;
        this.pushMessage(task, {
          role: "assistant",
          kind: "summary",
          content: task.summary,
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
      step.status = "pending";
      task.status = "running";
      this.pushMessage(task, { role: "user", kind: "event", content: `已安全提供变量 ${request.key}。` });
      this.persist();
      await this.runStep(request.taskId, request.stepId);
    },

    addSecretMetadata(key: string, description: string) {
      const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || this.secretMetadata.some((item) => item.key === normalized)) return;
      this.secretMetadata.push({ key: normalized, description: description.trim() || "敏感变量", scope: "global" });
      this.persist();
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
