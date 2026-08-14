import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, buildExecutionSummary, normalizePlanPreconditions } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import type { PlanStep } from "@/types";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
} from "@/services/validation";

const plan: PlanStep[] = [
  {
    id: "step-low-1",
    title: "采集状态",
    description: "只读诊断",
    command: "df -h",
    risk: "low",
    expected: "返回磁盘信息",
    validation: "输出文件系统列表",
    status: "pending",
  },
  {
    id: "step-medium",
    title: "重新加载服务",
    description: "应用配置",
    command: "sudo systemctl reload nginx",
    risk: "medium",
    expected: "服务正常",
    validation: "状态为 active",
    status: "pending",
  },
  {
    id: "step-low-2",
    title: "复查",
    description: "验证服务",
    command: "curl -I http://127.0.0.1",
    risk: "low",
    expected: "返回 HTTP 状态",
    validation: "包含状态行",
    status: "pending",
  },
];

describe("智能任务状态机", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem("opsark.servers", JSON.stringify([
      {
        id: "srv-production-01",
        name: "测试服务器",
        host: "example.invalid",
        port: 22,
        username: "tester",
        group: "测试",
        status: "offline",
        environment: [],
        info: { os: "Test OS", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "srv-tencent-test",
        name: "凭据恢复测试服务器",
        host: "example.invalid",
        port: 22,
        username: "tester",
        group: "测试",
        status: "offline",
        environment: [],
        info: { os: "Test OS", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]));
    setActivePinia(createPinia());
    vi.spyOn(backend, "generatePlan").mockResolvedValue(structuredClone(plan));
    vi.spyOn(backend, "processRequirement").mockResolvedValue({
      intent: "execute",
      plan: structuredClone(plan),
    });
    vi.spyOn(backend, "executeCommand").mockResolvedValue({
      output: "状态: success",
      success: true,
      simulated: true,
    });
    vi.spyOn(backend, "validateStep").mockResolvedValue({
      passed: true,
      detail: "校验通过",
    });
    vi.spyOn(backend, "reviewStep").mockResolvedValue({
      decision: "continue",
      reason: "输出与预期一致",
      summary: "当前步骤已达到预期。",
      source: "model",
    });
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "deleteCredential").mockResolvedValue();
    vi.spyOn(backend, "checkModel").mockResolvedValue({
      available: true,
      reason: "接口、鉴权和模型名称均可用",
    });
    useOpsStore().modelApiKeys["model-deepseek"] = "test-model-api-key";
  });

  it("安全模式自动执行低风险步骤，并在中风险步骤前暂停确认", async () => {
    const store = useOpsStore();
    await store.submitRequirement("srv-production-01", "检查并重新加载 Nginx", "safe", "model-deepseek");

    expect(store.activeTask?.status).toBe("awaiting_plan_approval");
    await store.approvePlan(store.activeTask!.id);

    expect(store.activeTask?.plan[0].status).toBe("completed");
    expect(store.activeTask?.plan[1].status).toBe("awaiting_approval");
    expect(store.activeTask?.status).toBe("awaiting_step_approval");

    await store.approveStep(store.activeTask!.id, "step-medium");

    expect(store.activeTask?.plan.every((step) => step.status === "completed")).toBe(true);
    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.summary).toContain("程序证据均有效");
    expect(store.logs.some((event) => event.category === "command")).toBe(true);
  });

  it("自动执行模式会自动批准计划并连续执行低中风险步骤", async () => {
    const store = useOpsStore();

    await store.submitRequirement("srv-production-01", "自动检查并重新加载 Nginx", "autonomous", "model-deepseek");

    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.plan.every((step) => step.status === "completed")).toBe(true);
    expect(store.activeTask?.messages.some((message) => message.content.includes("自动执行模式已批准计划"))).toBe(true);
  });

  it("完全托管模式自动批准计划和低中风险步骤，但高风险必须审批", async () => {
    const managedPlan: PlanStep[] = [
      { ...structuredClone(plan[0]), id: "managed-low", risk: "low" },
      { ...structuredClone(plan[1]), id: "managed-medium", risk: "medium" },
      {
        ...structuredClone(plan[2]),
        id: "managed-high",
        title: "发布生产版本",
        command: "release-tool publish production",
        risk: "high",
      },
    ];
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      plan: managedPlan,
    });
    const store = useOpsStore();

    await store.submitRequirement("srv-production-01", "托管发布生产版本", "managed", "model-deepseek");

    expect(store.activeTask?.status).toBe("awaiting_step_approval");
    expect(store.activeTask?.plan[0].status).toBe("completed");
    expect(store.activeTask?.plan[1].status).toBe("completed");
    expect(store.activeTask?.plan[2].status).toBe("awaiting_approval");
    expect(store.activeTask?.messages.some((message) => message.content.includes("完全托管模式已自动批准计划"))).toBe(true);
    expect(backend.executeCommand).toHaveBeenCalledTimes(2);

    await store.approveStep(store.activeTask!.id, "managed-high");
    expect(store.activeTask?.status).toBe("completed");
    expect(backend.executeCommand).toHaveBeenCalledTimes(3);
  });

  it("远程输出到达时同步更新步骤详情和终端", async () => {
    const store = useOpsStore();
    vi.mocked(backend.executeCommand).mockImplementation(async (_command, _connection, _approved, options) => {
      options?.onProgress?.({ executionId: options.executionId, data: "download 42%\n", stream: "stdout" });
      return { output: "$ download\ndownload 42%\n[exit: 0]", success: true, simulated: false, exitCode: 0 };
    });
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{ ...structuredClone(plan[0]), id: "stream-step" }];

    await store.runStep(task.id, "stream-step");

    expect(store.terminalLines).toContain("download 42%");
    expect(task.plan[0].output).toContain("download 42%");
  });

  it("远程命令长时间未返回时定期获取状态并交给模型复核", async () => {
    vi.useFakeTimers();
    try {
      const store = useOpsStore();
      const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
      store.serverPasswords[task.serverId] = "test-password";
      store.pushMessage(task, {
        role: "user",
        kind: "message",
        content: "启动服务并验证实际页面",
      });
      task.status = "running";
      task.plan = [ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "long-running-service",
        title: "启动容器服务",
        command: "docker run --name app image",
        validation: "docker ps --filter name=app --format '{{.Status}}' | grep -q Up",
      })];
      let finishExecution!: (value: {
        output: string;
        success: boolean;
        simulated: boolean;
        exitCode: number;
      }) => void;
      vi.mocked(backend.executeCommand).mockImplementationOnce((_command, _connection, _approved, options) => {
        options?.onProgress?.({
          executionId: options.executionId,
          data: "service ready\n",
          stream: "stdout",
        });
        return new Promise((resolve) => {
          finishExecution = resolve;
        });
      });
      vi.mocked(backend.validateStep).mockResolvedValue({
        passed: true,
        exitCode: 0,
        detail: "容器已运行",
        output: "$ docker ps\napp Up 30 seconds\n[exit: 0]",
      });
      vi.mocked(backend.reviewStep).mockResolvedValueOnce({
        decision: "complete",
        reason: "独立校验已证明服务运行，无需继续等待前台进程",
        summary: "停止等待并进入正式校验。",
        source: "model",
      });
      vi.spyOn(backend, "cancelCommand").mockImplementationOnce(async () => {
        finishExecution({
          output: "$ docker run\nservice ready\n[exit: 130]",
          success: false,
          simulated: false,
          exitCode: 130,
        });
      });

      const running = store.runStep(task.id, "long-running-service");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(500);
      await running;

      expect(backend.validateStep).toHaveBeenCalledTimes(2);
      expect(backend.reviewStep).toHaveBeenCalledTimes(1);
      const reviewContext = JSON.parse(vi.mocked(backend.reviewStep).mock.calls[0][1]);
      expect(reviewContext.reviewPolicy.periodicLongRunningReview).toBe(true);
      expect(reviewContext.periodicObservation.passed).toBe(true);
      expect(reviewContext.fullPlan).toHaveLength(1);
      expect(backend.cancelCommand).toHaveBeenCalledTimes(1);
      expect(task.plan[0].status).toBe("completed");
      expect(task.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("终止业务会取消当前执行并跳过活动步骤", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.currentExecutionId = "exec-running";
    task.plan = [{ ...structuredClone(plan[0]), status: "running" }];

    await store.terminateTask(task.id);

    expect(task.status).toBe("cancelled");
    expect(task.plan[0].status).toBe("skipped");
    expect(task.summary).toContain("用户终止");
  });

  it("调整计划最多生成一次，避免反复扩张", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.adjustmentCount = 1;
    task.plan = [{ ...structuredClone(plan[0]), status: "failed" }];

    await store.adjustTask(task.id);

    expect(task.status).toBe("failed");
    expect(task.summary).toContain("1 次上限");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("调整计划格式失败时保留证据并维持可恢复状态", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{
      ...structuredClone(plan[0]),
      status: "failed",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { category: "command_failed" },
        warnings: [],
        evidenceIds: [],
        failureReason: "最终页面缺少应用根节点",
      },
      review: {
        decision: "adjust",
        reason: "剩余计划无法修复站点配置",
        summary: "HTTP 虽返回 200，但页面不是目标应用。",
        source: "model",
      },
    }];
    vi.mocked(backend.generatePlan).mockRejectedValueOnce(new Error("模型计划结构解析失败"));

    await store.adjustTask(task.id);

    expect(task.status).toBe("needs_adjustment");
    expect(task.summary).toBeUndefined();
    expect(task.pauseReason).toContain("调整计划生成失败");
    expect(task.pauseReason).toContain("可再次生成解决方案");
    expect(task.plan[0].review?.summary).toContain("HTTP 虽返回 200");
  });

  it("达到自动调整上限后用户仍可明确发起新的人工调整周期", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.adjustmentCount = 1;
    task.plan = [{ ...structuredClone(plan[0]), status: "failed" }];
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([
      { ...structuredClone(plan[1]), id: "manual-retry", status: "pending" },
    ]);

    await store.requestAdjustment(task.id);

    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    expect(task.adjustmentCount).toBe(1);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan.some((step) => step.id === "manual-retry")).toBe(true);
    expect(task.messages.some((message) => message.content.includes("人工调整周期"))).toBe(true);
  });

  it("新建任务返回状态树中的响应式对象，异步计划返回后可立即刷新界面", () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");

    expect(task).toBe(store.tasks[0]);
    task.plan = structuredClone(plan);
    task.status = "awaiting_plan_approval";

    expect(store.activeTask?.plan).toHaveLength(3);
    expect(store.activeTask?.status).toBe("awaiting_plan_approval");
  });

  it("删除任务会清理本地记录并自动选择同服务器下一条任务", () => {
    const store = useOpsStore();
    const retained = store.createTask("srv-production-01", "safe", "model-deepseek");
    retained.title = "保留任务";
    const removed = store.createTask("srv-production-01", "safe", "model-deepseek");
    removed.title = "待删除任务";
    removed.status = "completed";
    store.pendingSecret = { taskId: removed.id, stepId: "step", key: "PASSWORD" };

    expect(store.deleteTask(removed.id)).toBe(true);

    expect(store.tasks.map((item) => item.id)).toEqual([retained.id]);
    expect(store.activeTaskId).toBe(retained.id);
    expect(store.pendingSecret).toBeNull();
    expect(JSON.parse(localStorage.getItem("opsark.tasks") ?? "[]")).toHaveLength(1);
  });

  it("正在规划或执行的任务必须先终止，不能直接删除", () => {
    const store = useOpsStore();
    const running = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    running.status = "running";
    running.currentExecutionId = "exec-live";

    expect(store.deleteTask(running.id)).toBe(false);
    expect(store.tasks.some((item) => item.id === running.id)).toBe(true);
    expect(store.activeTaskId).toBe(running.id);
  });

  it("任何授权等级都不会自动执行高风险步骤", () => {
    const store = useOpsStore();
    const highRisk = { ...plan[0], risk: "high" as const, command: "rm -rf /data" };

    expect(store.needsApproval("observe", highRisk)).toBe(true);
    expect(store.needsApproval("safe", highRisk)).toBe(true);
    expect(store.needsApproval("autonomous", highRisk)).toBe(true);
    expect(store.needsApproval("managed", highRisk)).toBe(true);
  });

  it("完全托管模式只对高风险步骤要求审批", () => {
    const store = useOpsStore();
    expect(store.needsApproval("managed", { ...plan[0], risk: "low" })).toBe(false);
    expect(store.needsApproval("managed", { ...plan[1], risk: "medium" })).toBe(false);
    expect(store.needsApproval("managed", {
      ...plan[2],
      risk: "high",
      command: "release-tool publish production",
    })).toBe(true);
  });

  it("自动执行模式不会因编译部署类高风险标签暂停，但破坏性命令仍需确认", () => {
    const store = useOpsStore();
    expect(store.needsApproval("autonomous", {
      ...plan[0],
      risk: "high",
      command: "cd /opt/O2OA && mvn clean install -DskipTests",
    })).toBe(false);
    expect(store.needsApproval("autonomous", {
      ...plan[0],
      risk: "high",
      command: "DROP DATABASE ffp",
    })).toBe(true);
  });

  it("高风险步骤只有单独批准后才携带后端放行标记", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "awaiting_plan_approval";
    task.plan = [{ ...structuredClone(plan[0]), risk: "high", command: "rm -rf /tmp/explicit-target" }];

    await store.approvePlan(task.id);
    expect(task.status).toBe("awaiting_step_approval");
    expect(backend.executeCommand).not.toHaveBeenCalled();

    await store.approveStep(task.id, task.plan[0].id);
    expect(backend.executeCommand).toHaveBeenCalledWith(
      "rm -rf /tmp/explicit-target",
      undefined,
      true,
      expect.objectContaining({
        executionId: expect.any(String),
        onProgress: expect.any(Function),
      }),
    );
  });

  it("敏感变量缺失时暂停输入，合并执行后对终端和日志脱敏", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...plan[0],
      id: "secret-step",
      command: "mysql -uroot -p${secret.DB_PASSWORD} -e 'select 1'",
    }];
    vi.mocked(backend.executeCommand).mockImplementation(async (command) => ({
      output: `$ ${command}\n状态: success`,
      success: true,
      simulated: true,
    }));

    await store.runStep(task.id, "secret-step");
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingSecret?.key).toBe("DB_PASSWORD");

    await store.provideSecret("test-secret-value");
    expect(task.status).toBe("completed");
    expect(task.plan[0].output).not.toContain("test-secret-value");
    expect(store.terminalLines.join("\n")).not.toContain("test-secret-value");
    expect(store.logs.map((event) => event.detail).join("\n")).not.toContain("test-secret-value");
  });

  it("新一轮任务不会静默复用上一轮敏感变量", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "reconfirm-secret-step",
      command: "tool --password ${secret.DB_PASSWORD}",
    }];
    store.secretValues.DB_PASSWORD = "previous-account-password";

    await store.runStep(task.id, "reconfirm-secret-step");

    expect(task.status).toBe("awaiting_input");
    expect(store.pendingSecret?.key).toBe("DB_PASSWORD");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("启动时恢复服务器密码和模型 API Key，并按需自动连接", async () => {
    vi.mocked(backend.loadCredential).mockImplementation(async (kind, id) => {
      if (kind === "server" && id === "srv-tencent-test") return "remembered-ssh-password";
      if (kind === "model" && id === "model-deepseek") return "remembered-model-key";
      if (kind === "secret" && id === "DB_PASSWORD") return "remembered-db-password";
      return null;
    });
    vi.spyOn(backend, "probeSsh").mockResolvedValue({
      info: {
        os: "CentOS 7",
        kernel: "3.10",
        cpu: "test",
        cores: 2,
        memoryGb: 4,
        diskGb: 59,
        uptime: "1 天",
      },
      environment: ["Nginx"],
      hostname: "test-server",
    });
    vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    vi.spyOn(backend, "getSshMetrics").mockResolvedValue({
      cpu: 10,
      memory: 20,
      disk: 30,
      networkIn: 1,
      networkOut: 1,
      sampledAt: new Date().toISOString(),
    });

    const store = useOpsStore();
    await store.hydrateCredentials();

    expect(store.serverPasswords["srv-tencent-test"]).toBe("remembered-ssh-password");
    expect(store.modelApiKeys["model-deepseek"]).toBe("remembered-model-key");
    expect(store.secretValues.DB_PASSWORD).toBe("remembered-db-password");
    expect(store.models.find((model) => model.id === "model-deepseek")?.hasApiKey).toBe(true);
    expect(await store.ensureServerConnected("srv-tencent-test")).toBe(true);
    expect(store.connectedServerIds).toContain("srv-tencent-test");
    expect(backend.saveCredential).not.toHaveBeenCalled();
  });

  it("保存模型设置时把 API Key 写入系统凭据存储", async () => {
    const store = useOpsStore();
    store.modelApiKeys["model-deepseek"] = "new-model-key";

    await store.saveModels();

    expect(backend.saveCredential).toHaveBeenCalledWith("model", "model-deepseek", "new-model-key");
    expect(localStorage.getItem("opsark.models")).toContain("model-deepseek");
  });

  it("大模型配置支持增加、修改、禁用和删除", async () => {
    const store = useOpsStore();
    const added = store.addModel();
    added.name = "自定义模型";
    added.provider = "Custom Provider";
    added.model = "custom-model-v1";
    added.endpoint = "https://model.example.invalid/v1";
    store.modelApiKeys[added.id] = "custom-api-key";
    store.modelAvailability[added.id] = { status: "available", reason: "可用" };

    expect(store.availableModels.some((model) => model.id === added.id)).toBe(true);
    added.enabled = false;
    expect(store.availableModels.some((model) => model.id === added.id)).toBe(false);

    await store.saveModels();
    expect(backend.saveCredential).toHaveBeenCalledWith("model", added.id, "custom-api-key");
    expect(localStorage.getItem("opsark.models")).toContain("custom-model-v1");

    await store.removeModel(added.id);
    expect(store.models.some((model) => model.id === added.id)).toBe(false);
    expect(store.modelApiKeys[added.id]).toBeUndefined();
    expect(store.modelAvailability[added.id]).toBeUndefined();
    expect(backend.deleteCredential).toHaveBeenCalledWith("model", added.id);
  });

  it("清空模型 API Key 后保存会删除钥匙串旧值", async () => {
    const store = useOpsStore();
    store.models[0].hasApiKey = true;
    store.modelApiKeys[store.models[0].id] = "";

    await store.saveModels();

    expect(backend.deleteCredential).toHaveBeenCalledWith("model", store.models[0].id);
    expect(store.models[0].hasApiKey).toBe(false);
  });

  it("敏感信息支持保存、重命名和直接删除", async () => {
    const store = useOpsStore();
    store.secretValues.DB_PASSWORD = "current-real-value";

    await store.saveSecretSettings();
    expect(backend.saveCredential).toHaveBeenCalledWith("secret", "DB_PASSWORD", "current-real-value");

    expect(await store.renameSecretMetadata("DB_PASSWORD", "MYSQL_ROOT_PASSWORD")).toBe(true);
    expect(store.secretMetadata.some((item) => item.key === "MYSQL_ROOT_PASSWORD")).toBe(true);
    expect(store.secretValues.MYSQL_ROOT_PASSWORD).toBe("current-real-value");
    expect(store.secretValues.DB_PASSWORD).toBeUndefined();
    expect(backend.saveCredential).toHaveBeenCalledWith("secret", "MYSQL_ROOT_PASSWORD", "current-real-value");
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", "DB_PASSWORD");

    await store.removeSecretMetadata("MYSQL_ROOT_PASSWORD");
    expect(store.secretMetadata.some((item) => item.key === "MYSQL_ROOT_PASSWORD")).toBe(false);
    expect(store.secretValues.MYSQL_ROOT_PASSWORD).toBeUndefined();
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", "MYSQL_ROOT_PASSWORD");
  });

  it("选中已有任务后可继续多轮需求，不会强制创建新任务", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "completed";
    task.plan = structuredClone(plan);
    task.plan.forEach((step) => { step.status = "completed"; });
    task.plan[0].output = "$ ps -ef | grep O2OA\nroot 5149 /opt/O2OA/o2server/start.sh\n[exit: 0]";
    task.summary = "O2OA 进程 PID 5149 正在运行。";
    task.adjustmentCount = 1;
    task.discoveryRefined = true;
    task.cancelRequested = true;
    store.pushMessage(task, { role: "user", kind: "message", content: "第一轮需求" });
    store.pushMessage(task, { role: "assistant", kind: "message", content: "已生成 3 个执行步骤" });
    store.pushMessage(task, { role: "assistant", kind: "summary", content: "第一轮已完成" });

    await store.submitRequirement("srv-production-01", "继续检查 Java 进程", "safe", "model-deepseek");

    expect(store.tasks).toHaveLength(1);
    expect(store.activeTaskId).toBe(task.id);
    expect(task.planHistory).toHaveLength(1);
    expect(task.planHistory?.[0].requirement).toBe("第一轮需求");
    expect(task.planHistory?.[0].plan).toHaveLength(3);
    expect(task.planHistory?.[0].response?.content).toBe("已生成 3 个执行步骤");
    expect(task.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(task.messages.some((message) => message.content.includes("上一轮执行记录已保留"))).toBe(true);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.adjustmentCount).toBe(0);
    expect(task.discoveryRefined).toBe(false);
    expect(task.cancelRequested).toBe(false);
    const runtimeContext = JSON.parse(vi.mocked(backend.processRequirement).mock.calls[0][1].context);
    expect(runtimeContext.previousExecution.requirement).toBe("第一轮需求");
    expect(runtimeContext.previousExecution.summary).toContain("PID 5149");
    expect(runtimeContext.previousExecution.steps[0].output).toContain("/opt/O2OA");
    expect(runtimeContext.knownExecutionFacts.workingDirectories).toContain("/opt/O2OA/o2server/start.sh");
    expect(runtimeContext.knownExecutionFacts.instruction).toContain("必须优先复用");
  });

  it("暂停后输入进行调整会直接触发本轮调整而不是交给模型当咨询", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    store.pushMessage(task, { role: "user", kind: "message", content: "部署应用" });
    task.status = "needs_adjustment";
    task.pauseReason = "后置条件未满足";
    task.plan = [{ ...structuredClone(plan[0]), status: "failed" }];
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([
      { ...structuredClone(plan[0]), id: "replacement", status: "pending" },
    ]);
    vi.mocked(backend.processRequirement).mockClear();

    await store.submitRequirement(
      "srv-production-01",
      "进行调整",
      "safe",
      "model-deepseek",
    );

    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    expect(task.adjustmentCount).toBe(1);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan.some((step) => step.id === "replacement")).toBe(true);
  });

  it("查询无匹配项仍正常完成，并生成明确总结", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValue({
      intent: "execute",
      plan: [structuredClone(plan[0])],
    });
    vi.mocked(backend.executeCommand).mockResolvedValue({
      output: "$ ps -ef | grep java\n未发现匹配项（命令正常完成）\n[exit: 1]",
      success: true,
      simulated: false,
      exitCode: 1,
      emptyResult: true,
    });

    await store.submitRequirement("srv-production-01", "查看 Java 服务", "safe", "model-deepseek");
    await store.approvePlan(store.activeTask!.id);

    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.summary).toContain("没有匹配数据");
    expect(store.activeTask?.messages[store.activeTask.messages.length - 1]?.kind).toBe("summary");
  });

  it("过滤 macOS shell integration 和 ANSI 控制序列", () => {
    const raw = "\u001b]1337;PreExecMarker;ps -ef\u0007\u001b[32mroot\u001b[0m\r\n";
    expect(sanitizeTerminalOutput(raw)).toBe("root\n");
  });

  it("校验命令会合并敏感变量，保存的输出仍保持脱敏", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "validation-secret-step",
      command: "mysql -p'${secret.DB_PASSWORD}' -e 'SELECT 1'",
      validation: "mysql -p'${secret.DB_PASSWORD}' -e 'SELECT 1' | grep -q 1",
    }];
    store.secretValues.DB_PASSWORD = "private-validation-value";
    task.confirmedSecretKeys = ["DB_PASSWORD"];
    vi.mocked(backend.validateStep).mockImplementation(async (step) => ({
      passed: true,
      detail: "独立校验通过",
      output: `$ ${step.validation}\npassword: legacy-password-from-file\n[exit: 0]`,
    }));

    await store.runStep(task.id, "validation-secret-step");

    expect(backend.validateStep).toHaveBeenCalledWith(
      expect.objectContaining({ validation: expect.stringContaining("private-validation-value") }),
      undefined,
      expect.objectContaining({
        executionId: expect.any(String),
        onProgress: expect.any(Function),
      }),
    );
    expect(task.plan[0].output).not.toContain("private-validation-value");
    expect(task.plan[0].output).not.toContain("legacy-password-from-file");
    expect(task.plan[0].output).toContain("password: ••••••••");
    expect(store.logs.map((event) => event.detail).join("\n")).not.toContain("private-validation-value");
  });

  it("无模型时的通用总结会展示最后步骤的真实输出", () => {
    const databaseStep: PlanStep = {
      ...structuredClone(plan[0]),
      title: "查询 MySQL 数据库列表",
      command: "mysql -uroot -e 'SHOW DATABASES;'",
      status: "completed",
      output: [
        "$ mysql -uroot -e 'SHOW DATABASES;'",
        "Database",
        "information_schema",
        "ffp",
        "mysql",
        "performance_schema",
        "[exit: 0]",
        "",
        "--- 独立校验 ---",
        "$ mysql -uroot -Nse 'SHOW DATABASES' | grep -q ffp",
        "[exit: 0]",
      ].join("\n"),
    };

    const summary = buildExecutionSummary("列出目标资源", [databaseStep]);
    expect(summary).toContain("最终结果");
    expect(summary).toContain("information_schema");
    expect(summary).toContain("performance_schema");
  });

  it("远程模型缺少 API Key 时明确失败，不静默生成本地通用计划", async () => {
    const store = useOpsStore();
    delete store.modelApiKeys["model-deepseek"];

    await store.submitRequirement(
      "srv-production-01",
      "帮我查询下 MySQL 的所有数据库",
      "safe",
      "model-deepseek",
    );

    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(store.activeTask?.status).toBe("failed");
    expect(store.activeTask?.plan).toHaveLength(0);
    expect(store.activeTask?.summary).toContain("API Key 未恢复");
    expect(store.activeTask?.summary).toContain("模型与设置");
  });

  it("默认模型列表不再包含本地演示模型", () => {
    const store = useOpsStore();
    expect(store.models.some((model) => model.id === "model-local" || model.provider === "Built-in")).toBe(false);
  });

  it("咨询类问题直接回答，不生成或审批执行计划", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "answer",
      answer: "删除数据库会永久移除其中的数据，应先确认备份和依赖关系。",
      plan: [],
    });

    await store.submitRequirement(
      "srv-production-01",
      "删除数据库有什么风险？",
      "safe",
      "model-deepseek",
    );

    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.plan).toHaveLength(0);
    const lastMessage = store.activeTask?.messages[store.activeTask.messages.length - 1];
    expect(lastMessage?.content).toContain("永久移除");
    expect(lastMessage?.kind).toBe("message");
    expect(store.activeTask?.messages.some((message) => message.kind === "event")).toBe(false);
  });

  it("需求理解模型返回的结构化执行约束会持久化到任务", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      constraints: {
        changePolicy: "requested_changes_only",
        environmentPolicy: "preserve",
        failurePolicy: "best_effort",
        prohibitedActions: ["升级宿主机运行时"],
        requiredConditions: ["保留当前系统环境"],
        userDirectives: ["在当前环境中尝试完成部署"],
      },
      plan: structuredClone(plan),
    });

    await store.submitRequirement(
      "srv-production-01",
      "在现有环境约束下尽力完成部署",
      "safe",
      "model-deepseek",
    );

    expect(store.activeTask?.executionConstraints).toEqual(expect.objectContaining({
      environmentPolicy: "preserve",
      failurePolicy: "best_effort",
    }));
    expect(store.logs.some((event) =>
      event.title === "模型执行计划已返回"
      && event.detail.includes("\"constraints\""),
    )).toBe(true);
  });

  it("刷新可用性后仅暴露实测可用且已启用的模型", async () => {
    const store = useOpsStore();
    await store.refreshModelAvailability();

    expect(backend.checkModel).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek-v4-flash",
    }));
    expect(store.modelAvailability["model-deepseek"]?.status).toBe("available");
    expect(store.availableModels.map((model) => model.id)).toEqual(["model-deepseek"]);

    vi.mocked(backend.checkModel).mockResolvedValueOnce({ available: false, reason: "模型不在可用列表中" });
    await store.refreshModelAvailability();
    expect(store.modelAvailability["model-deepseek"]?.status).toBe("unavailable");
    expect(store.availableModels).toHaveLength(0);
  });

  it("通用核心保留模型生成的业务语义，不按特定技术栈改写计划", () => {
    const steps: PlanStep[] = [{
      ...structuredClone(plan[0]),
      title: "检查目标状态",
      command: "custom-tool inspect target-a",
      expected: "返回目标的当前状态",
      validation: "custom-tool inspect target-a >/dev/null",
    }];

    const normalized = normalizePlanPreconditions(steps);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual(expect.objectContaining(steps[0]));
    expect(normalized[0].validator?.command).toBe(steps[0].validation);
  });

  it("会移除模型误加在敏感变量占位符前的反斜杠", () => {
    const normalized = normalizePlanPreconditions([{
      ...structuredClone(plan[0]),
      command: "sed -i 's/password:.*/password: \\${secret.DB_PASSWORD}/' application.yml",
      validation: "grep -F 'password: \\${secret.DB_PASSWORD}' application.yml",
    }]);

    expect(normalized[0].command).toContain("password: ${secret.DB_PASSWORD}");
    expect(normalized[0].validation).toContain("password: ${secret.DB_PASSWORD}");
    expect(normalized[0].command).not.toContain("\\${secret.DB_PASSWORD}");
    expect(normalized[0].validation).not.toContain("\\${secret.DB_PASSWORD}");
  });

  it("通用核心不自动注入任何技术栈的预检或替换原命令", () => {
    const steps = [
      { ...structuredClone(plan[0]), id: "discover", command: "custom-tool inspect", validation: "custom-tool inspect >/dev/null" },
      { ...structuredClone(plan[1]), id: "change", command: "custom-tool apply", validation: "custom-tool verify" },
    ];

    const normalized = normalizePlanPreconditions(steps);

    expect(normalized.map((step) => step.id)).toEqual(["discover", "change"]);
    expect(normalized.map((step) => step.command)).toEqual(steps.map((step) => step.command));
  });

  it("部署计划会移除用户未要求且没有证据支撑的破坏性残留清理", () => {
    const cleanup = {
      ...structuredClone(plan[0]),
      id: "cleanup-runtime",
      title: "清理失败的安装残留",
      description: "删除之前尝试安装的工具目录",
      command: "rm -rf /opt/tool-cache",
      risk: "high" as const,
    };

    expect(normalizePlanPreconditions(
      [cleanup, { ...structuredClone(plan[1]), command: "custom-tool --version" }],
      "使用当前环境尝试执行任务",
    ).some((step) => step.id === cleanup.id)).toBe(false);

    expect(normalizePlanPreconditions(
      [cleanup],
      "清理并删除失败的工具安装残留",
    ).some((step) => step.id === cleanup.id)).toBe(true);
  });

  it("核心执行流程不再因发现步骤自动重新生成计划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({ ...structuredClone(plan[0]), id: "discovery", status: "completed" }),
      ensureStepValidator({ ...structuredClone(plan[1]), id: "approved-change", status: "pending" }),
    ];

    await store.advanceTask(task.id);

    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("awaiting_step_approval");
    expect(task.plan.map((step) => step.id)).toEqual(["discovery", "approved-change"]);
  });

  it("变更目标的纯发现阶段完成后只生成一次证据化后续计划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.executionConstraints = {
      changePolicy: "allow_necessary_changes",
      environmentPolicy: "preserve",
      failurePolicy: "best_effort",
      prohibitedActions: [],
      requiredConditions: [],
      userDirectives: ["目标未达成时完成必要变更"],
    };
    task.plan = [ensureStepValidator({
      ...structuredClone(plan[0]),
      id: "completed-discovery",
      status: "completed",
      output: "$ custom-tool inspect\ntarget_path=/srv/target\n[exit: 0]",
    })];
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([ensureStepValidator({
      ...structuredClone(plan[1]),
      id: "evidence-based-change",
      title: "应用必要变更",
      command: "custom-tool apply /srv/target",
      validation: "custom-tool verify /srv/target",
      status: "pending",
    })]);

    await store.advanceTask(task.id);

    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    expect(task.discoveryRefined).toBe(true);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan.map((step) => step.id)).toEqual([
      "completed-discovery",
      "evidence-based-change",
    ]);
  });

  it("正常程序证据一致时跳过逐步骤模型复核", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0])];

    await store.runStep(task.id, task.plan[0].id);

    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].review).toEqual(expect.objectContaining({
      decision: "complete",
      source: "rules",
    }));
    expect(task.plan[0].result?.executionStatus).toBe("success");
    expect(backend.reviewStep).not.toHaveBeenCalled();
  });

  it("只读诊断发现异常线索时继续下一项诊断，不立即重拟计划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      {
        ...structuredClone(plan[0]),
        id: "check-port-owner",
        title: "检查 O2OA 端口归属",
        command: "ss -lntp",
      },
      {
        ...structuredClone(plan[2]),
        id: "check-o2oa-logs",
        title: "查找 O2OA 日志",
        command: "find /opt/O2OA -type f -name '*.log' -print",
      },
    ];
    await store.runStep(task.id, "check-port-owner");

    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].review).toEqual(expect.objectContaining({
      decision: "continue",
      source: "rules",
    }));
    expect(task.plan[1].status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(backend.reviewStep).not.toHaveBeenCalled();
    expect(store.logs.some((event) => event.title.includes("确定性规则复核"))).toBe(true);
  });

  it("仅报告页面空白时会拦截未经请求的重启步骤", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      plan: [
        {
          ...structuredClone(plan[0]),
          id: "inspect-http",
          title: "检查页面响应",
          command: "curl -sS -D- http://127.0.0.1:8080",
        },
        {
          ...structuredClone(plan[1]),
          id: "restart-o2oa",
          title: "重启 O2OA",
          command: "systemctl restart o2server",
        },
      ],
    });

    await store.submitRequirement(
      "srv-production-01",
      "打开 O2OA 页面后是空白的",
      "safe",
      "model-deepseek",
    );

    expect(store.activeTask?.plan.map((step) => step.id)).toEqual(["inspect-http"]);
    expect(store.activeTask?.plan.some((step) => step.command.includes("restart"))).toBe(false);
  });

  it("模型确认整体目标已达成时跳过剩余步骤并完成任务", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "ambiguous-http",
        title: "检查页面响应",
        command: "curl -sS http://127.0.0.1:8080",
        validation: "test -n response",
      }),
      structuredClone(plan[2]),
    ];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "complete",
      reason: "当前输出已经完整回答用户查询",
      summary: "目标结果已经获取。",
      source: "model",
    });

    await store.runStep(task.id, task.plan[0].id);

    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[1].status).toBe("skipped");
    expect(task.status).toBe("completed");
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("证据无法解析时才调用模型并允许暂停调整", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "unknown-http",
        title: "检查页面响应",
        command: "curl -sS http://127.0.0.1:8080",
        validation: "test -n response",
      }),
      structuredClone(plan[1]),
    ];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "HTTP 输出没有状态码，证据不足",
      summary: "需要补充带状态码的页面检查。",
      source: "model",
    });

    await store.runStep(task.id, "unknown-http");

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("failed");
    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
  });

  it("主命令成功但程序校验失败时会调用一次模型复核", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0])];
    vi.mocked(backend.validateStep).mockResolvedValueOnce({
      passed: false,
      detail: "独立校验未达到预期",
    });

    await store.runStep(task.id, task.plan[0].id);

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(task.messages.some((message) =>
      message.content.includes("后置校验未通过")
      && message.content.includes("异常模型复核"),
    )).toBe(true);
  });

  it("后置校验失败且模型不可用时不会按兜底规则继续", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0])];
    vi.mocked(backend.validateStep).mockResolvedValueOnce({
      passed: false,
      exitCode: 2,
      detail: "独立校验未达到预期",
    });
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "complete",
      reason: "兜底规则建议完成",
      summary: "程序校验通过。",
      source: "rules",
    });

    await store.runStep(task.id, task.plan[0].id);

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("failed");
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("模型复核不可用");
  });

  it("变更步骤后置校验失败时仅在剩余计划可修复的情况下允许继续", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      {
        ...structuredClone(plan[1]),
        id: "install-nvm",
        title: "安装 nvm",
        command: "curl -fsSL https://example.com/install.sh | bash",
        validation: "test -s ~/.nvm/nvm.sh",
      },
      {
        ...structuredClone(plan[1]),
        id: "load-nvm",
        title: "加载 nvm 环境",
        command: "source ~/.nvm/nvm.sh && nvm --version",
        validation: "source ~/.nvm/nvm.sh && command -v nvm",
      },
    ];
    vi.mocked(backend.validateStep)
      .mockResolvedValueOnce({
        passed: false,
        exitCode: 1,
        detail: "当前 shell 尚未加载 nvm",
      })
      .mockResolvedValueOnce({
        passed: true,
        exitCode: 0,
        detail: "nvm 已加载",
      });

    await store.runStep(task.id, "install-nvm");

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[1].status).toBe("completed");
    expect(task.status).toBe("completed");
  });

  it("模型不能覆盖后置校验中的确定性平台阻断", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[1]),
      id: "run-binary",
      title: "启动目标程序",
      command: "./target-program",
      validation: "test -f /tmp/target.ready",
    }];
    vi.mocked(backend.executeCommand).mockResolvedValueOnce({
      output: "$ ./target-program\nversion `GLIBCXX_3.4.26' not found\n[exit: 0]",
      success: true,
      simulated: false,
      exitCode: 0,
    });
    vi.mocked(backend.validateStep).mockResolvedValueOnce({
      passed: false,
      exitCode: 2,
      detail: "就绪文件不存在",
    });
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "continue",
      reason: "可以继续",
      summary: "继续后续步骤。",
      source: "model",
    });

    await store.runStep(task.id, "run-binary");

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("failed");
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("ABI 不兼容");
  });

  it("只读 HTTP 主结果明确时独立校验冲突会重试并进入复核而不直接失败", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [ensureStepValidator({
      ...structuredClone(plan[0]),
      id: "network-probe",
      title: "检查网络连通性",
      command: "curl -s -o /dev/null -w '%{http_code}' https://example.com",
      validation: "test \"$(curl -s -o /dev/null -w '%{http_code}' https://example.com)\" = 200",
    })];
    vi.mocked(backend.executeCommand).mockResolvedValueOnce({
      output: "$ curl\n200\n[exit: 0]",
      success: true,
      simulated: false,
      exitCode: 0,
    });
    vi.mocked(backend.validateStep)
      .mockResolvedValueOnce({
        passed: false,
        exitCode: 1,
        detail: "首次校验未达到预期",
        output: "$ test\n[exit: 1]",
      })
      .mockResolvedValueOnce({
        passed: false,
        exitCode: 1,
        detail: "重试校验未达到预期",
        output: "$ test\n[exit: 1]",
      });
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "complete",
      reason: "主命令已获得明确 HTTP 200，重复请求存在瞬时差异",
      summary: "网络主探测成功。",
      source: "model",
    });

    await store.runStep(task.id, "network-probe");

    expect(backend.validateStep).toHaveBeenCalledTimes(2);
    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].result?.executionStatus).toBe("success");
    expect(task.plan[0].result?.facts.evidenceConflict).toBe(true);
    expect(task.status).toBe("completed");
    expect(task.plan[0].output).toContain("首次未通过");
  });

  it("结构化校验器区分 SQL 不存在、HTTP 异常和进程无匹配", () => {
    const sqlStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      command: "mysql -Nse \"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='ffp';\"",
      validation: "mysql -Nse \"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='ffp';\" | grep -Eq '^[01]$'",
    });
    const sql = classifyStepResult(
      sqlStep,
      { success: true, exitCode: 0, output: "$ mysql\n0\n[exit: 0]" },
      { passed: true, exitCode: 0, detail: "通过", output: "$ mysql\n0\n[exit: 0]" },
    );
    expect(sql.result.observationStatus).toBe("not_found");
    expect(sql.result.facts.exists).toBe(false);

    const createSqlStep = ensureStepValidator({
      ...structuredClone(plan[1]),
      title: "创建 ffp 数据库",
      command: "mysql -e 'CREATE DATABASE IF NOT EXISTS ffp'",
      validation: "mysql -Nse \"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='ffp';\"",
    });
    const created = classifyStepResult(
      createSqlStep,
      { success: true, exitCode: 0, output: "$ mysql\n命令未产生输出\n[exit: 0]" },
      { passed: true, exitCode: 0, detail: "通过", output: "$ mysql\n1\n[exit: 0]" },
    );
    expect(created.result.observationStatus).toBe("matched");
    expect(created.needsModelReview).toBe(false);

    const httpStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查 HTTP 页面",
      command: "curl -sS -D- http://127.0.0.1",
      validation: "curl -fsS http://127.0.0.1 >/dev/null",
    });
    const http = classifyStepResult(
      httpStep,
      { success: true, exitCode: 0, output: "$ curl\nHTTP/1.1 500 Internal Server Error\n[exit: 0]" },
      { passed: false, exitCode: 22, detail: "非成功状态", output: "$ curl\n[exit: 22]" },
    );
    expect(http.accepted).toBe(true);
    expect(http.result.observationStatus).toBe("unhealthy");

    const processStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查 Java 进程",
      command: "pgrep -a java",
      validation: "pgrep java >/dev/null",
    });
    const process = classifyStepResult(
      processStep,
      { success: true, exitCode: 1, emptyResult: true, output: "$ pgrep\n未发现匹配项（命令正常完成）\n[exit: 1]" },
      { passed: false, exitCode: 1, emptyResult: true, detail: "无匹配是有效状态", output: "$ pgrep\n[exit: 1]" },
    );
    expect(process.result.observationStatus).toBe("not_found");

    const portStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查端口归属",
      command: "ss -lntp",
      validation: "ss -lntp",
    });
    const port = classifyStepResult(
      portStep,
      {
        success: true,
        exitCode: 0,
        output: "$ ss -lntp\nLISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:((\"java\",pid=5149,fd=7))\n[exit: 0]",
      },
      { passed: true, exitCode: 0, detail: "通过", output: "$ ss\nLISTEN 0 128 0.0.0.0:8080\n[exit: 0]" },
    );
    expect(port.result.facts.ports).toEqual([8080]);
    expect(port.result.facts.ownershipConfirmed).toBe(true);
  });

  it("通用核心不解释领域工具的私有错误标记", () => {
    const compatibilityStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "诊断 Node.js 环境兼容性",
      command: "node -v && node -e \"console.log('TOO_OLD')\"",
      validation: "test -f package.json",
    });
    const classified = classifyStepResult(
      compatibilityStep,
      {
        success: true,
        exitCode: 0,
        output: "$ node\nv16.20.2\nTOO_OLD\nnpm WARN EBADENGINE Unsupported engine\n[exit: 0]",
      },
      { passed: true, exitCode: 0, detail: "命令完成", output: "$ test\n[exit: 0]" },
    );

    expect(classified.accepted).toBe(true);
    expect(classified.result.observationStatus).toBe("warning");
    expect(classified.result.facts.blockingSignal).toBe(false);
    expect(classified.needsModelReview).toBe(false);
  });

  it("复合安装命令按运行时目标校验且 ABI 失败不改写主命令状态", () => {
    const runtimeStep = ensureStepValidator({
      ...structuredClone(plan[1]),
      title: "升级 Node.js 运行时",
      description: "安装并切换到项目要求的 Node.js",
      command: "curl -o- https://example.com/install.sh | bash && nvm install 22",
      validation: "node --version | grep -q '^v22'",
    });
    const classified = classifyStepResult(
      runtimeStep,
      {
        success: true,
        exitCode: 0,
        output: "$ install\nNow using node v22.23.2\n[exit: 0]",
      },
      {
        passed: false,
        exitCode: 1,
        detail: "独立校验未达到预期",
        output: [
          "$ node --version",
          "node: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.21' not found (required by node)",
          "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)",
          "[exit: 1]",
        ].join("\n"),
      },
    );

    expect(runtimeStep.validator?.type).toBe("runtime");
    expect(classified.accepted).toBe(false);
    expect(classified.result.executionStatus).toBe("success");
    expect(classified.result.observationStatus).toBe("unhealthy");
    expect(classified.result.facts.platformIncompatible).toBe(true);
    expect(classified.result.facts.missingAbiSymbols).toEqual(["GLIBCXX_3.4.21", "GLIBC_2.28"]);
    expect(classified.result.failureReason).toContain("ABI");
  });

  it("通用核心将工具警告保留为可复核证据", () => {
    const runtimeStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "确认当前 Node.js 版本可用",
      command: "node --version && npm --version",
      validation: "node --version | grep -q '^v16\\.'",
    });
    const classified = classifyStepResult(
      runtimeStep,
      {
        success: true,
        exitCode: 0,
        output: [
          "$ node --version && npm --version",
          "v16.20.2",
          "8.19.4",
          "npm WARN config init.module Use `--init-module` instead.",
          "[exit: 0]",
        ].join("\n"),
      },
      { passed: true, exitCode: 0, detail: "版本可用", output: "$ validate\n[exit: 0]" },
    );

    expect(classified.accepted).toBe(true);
    expect(classified.result.observationStatus).toBe("warning");
    expect(classified.result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(classified.result.facts.warningCount).toBe(1);
  });

  it("远程安装脚本属于变更操作且网络失败不能被管道退出码掩盖", () => {
    const installStep = ensureStepValidator({
      ...structuredClone(plan[1]),
      title: "确认环境与安装 nvm",
      command: "command -v nvm || curl -o- https://example.com/install.sh | bash",
      validation: "command -v nvm",
    });
    const classified = classifyStepResult(
      installStep,
      {
        success: true,
        exitCode: 0,
        output: "$ install\ncurl: (35) TCP connection reset by peer\n[exit: 0]",
      },
      {
        passed: false,
        exitCode: 1,
        emptyResult: true,
        detail: "未找到 nvm",
        output: "$ command -v nvm\n未发现匹配项（命令正常完成）\n[exit: 1]",
      },
    );

    expect(isMutatingStepCommand(installStep.command)).toBe(true);
    expect(classified.accepted).toBe(false);
    expect(classified.result.executionStatus).toBe("success");
    expect(classified.result.observationStatus).toBe("unhealthy");
    expect(classified.result.facts.networkFailure).toBe(true);
    expect(classified.result.failureReason).toContain("网络");
  });

  it("只读运行时探测版本不匹配时作为有效观察而不是执行失败", () => {
    const runtimeStep = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查 Node.js 版本",
      command: "node --version",
      validation: "node --version | grep -q '^v16\\.'",
    });
    const classified = classifyStepResult(
      runtimeStep,
      { success: true, exitCode: 0, output: "$ node --version\nv18.20.0\n[exit: 0]" },
      {
        passed: false,
        exitCode: 1,
        emptyResult: true,
        detail: "版本不匹配",
        output: "$ validate\n未发现匹配项（命令正常完成）\n[exit: 1]",
      },
    );

    expect(classified.accepted).toBe(true);
    expect(classified.result.executionStatus).toBe("success");
    expect(classified.needsModelReview).toBe(true);
  });

  it("压缩下载进度覆盖帧但保留最终进度和业务输出", () => {
    const raw = [
      "Downloading runtime...",
      ...Array.from({ length: 100 }, (_, index) => `#### ${index.toFixed(1)}%\r`),
      "Checksums matched!",
    ].join("");
    const cleaned = sanitizeTerminalOutput(raw);

    expect(cleaned).toContain("Downloading runtime...");
    expect(cleaned).toContain("99.0%");
    expect(cleaned).toContain("Checksums matched!");
    expect(cleaned.split("\n").length).toBeLessThan(8);
  });

  it("通用核心不再识别历史场景的专用结构化标记", () => {
    const preflight = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查前端项目运行时精确要求",
      command: "node -e 'console.log(\"OPSARK_RUNTIME_CHECK\")'",
      validation: "test -f package.json",
    });
    const classified = classifyStepResult(
      preflight,
      {
        success: true,
        exitCode: 0,
        output: [
          "$ node",
          'OPSARK_RUNTIME_CHECK {"currentNode":"v16.20.2","requiredNode":"^20.19.0 || >=22.12.0","packageManager":"npm@10","lockFiles":["package-lock.json"]}',
          "[exit: 0]",
        ].join("\n"),
      },
      { passed: true, exitCode: 0, detail: "通过", output: "$ test\n[exit: 0]" },
    );

    expect(classified.result.observationStatus).toBe("matched");
    expect(classified.result.facts).not.toHaveProperty("currentNodeVersion");
    expect(classified.result.facts.blockingSignal).toBe(false);
  });

  it("通用阻断证据未被剩余计划处理时停止后续变更", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "blocking-observation",
        title: "检查目标前置条件",
        command: "custom-tool inspect",
        validation: "custom-tool inspect >/dev/null",
        status: "completed",
        result: {
          executionStatus: "success",
          observationStatus: "unhealthy",
          facts: { blockingSignal: true },
          warnings: ["前置条件不满足"],
          evidenceIds: [],
        },
      }),
      {
        ...structuredClone(plan[1]),
        id: "unrelated-change",
        title: "重启目标服务",
        command: "systemctl restart target-service",
      },
    ];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "当前变更无法解决已知阻断",
      summary: "需要先调整计划。",
      source: "model",
    });

    await store.advanceTask(task.id);

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[1].status).toBe("pending");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.pauseReason).toContain("前置条件复核");
    expect(task.summary).toBeUndefined();
    expect(task.messages.some((message) => message.kind === "summary")).toBe(false);
  });

  it("只读发现可继续但进入依赖安装前会拦截尚未解决的运行时阻断", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "runtime-blocker",
        title: "检查前端项目运行时精确要求",
        command: "node -e 'console.log(\"OPSARK_RUNTIME_CHECK\")'",
        validation: "node --version",
        status: "completed",
        result: {
          executionStatus: "success",
          observationStatus: "unhealthy",
          facts: { blockingSignal: true, engineIncompatible: true },
          warnings: ["当前运行时不兼容"],
          evidenceIds: [],
        },
      }),
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "read-only-context",
        title: "读取系统信息",
        command: "uname -a",
        validation: "uname -a >/dev/null",
        status: "completed",
      }),
      ensureStepValidator({
        ...structuredClone(plan[1]),
        id: "install-before-fix",
        title: "安装项目依赖",
        command: "cd /tmp/app && npm ci",
        validation: "test -d /tmp/app/node_modules",
        status: "pending",
      }),
    ];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "当前运行时不兼容，执行约束没有授权继续",
      summary: "需要先修复运行时兼容性。",
      source: "model",
    });

    await store.advanceTask(task.id);

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[2].status).toBe("pending");
    expect(task.pauseReason).toContain("运行时不兼容");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("用户明确要求使用当前版本尝试时由模型复核后继续执行", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    store.pushMessage(task, {
      role: "user",
      kind: "message",
      content: "使用当前系统的版本进行尝试部署这个项目",
    });
    task.executionConstraints = {
      changePolicy: "requested_changes_only",
      environmentPolicy: "preserve",
      failurePolicy: "best_effort",
      prohibitedActions: ["升级或切换宿主机 Node.js"],
      requiredConditions: ["保留当前宿主运行时"],
      userDirectives: ["使用当前系统环境进行真实部署尝试"],
    };
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "runtime-blocker-attempt",
        title: "检查前端项目运行时精确要求",
        command: "node -e 'console.log(\"OPSARK_RUNTIME_CHECK\")'",
        validation: "node --version",
        status: "completed",
        result: {
          executionStatus: "success",
          observationStatus: "unhealthy",
          facts: {
            blockingSignal: true,
            engineIncompatible: true,
            currentNodeVersion: "v16.20.2",
            requiredNodeVersion: "^20.19.0 || >=22.12.0",
          },
          warnings: ["当前运行时不兼容"],
          evidenceIds: [],
        },
      }),
      ensureStepValidator({
        ...structuredClone(plan[1]),
        id: "attempt-install-current-runtime",
        title: "使用当前版本安装项目依赖",
        command: "cd /tmp/app && npm ci",
        validation: "test -d /tmp/app/node_modules",
        status: "pending",
      }),
    ];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "continue",
      reason: "用户明确授权使用当前版本进行一次真实尝试",
      summary: "保留兼容性风险并继续尝试安装依赖。",
      source: "model",
    });

    await store.advanceTask(task.id);

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    const reviewContext = JSON.parse(vi.mocked(backend.reviewStep).mock.calls[0][1]);
    expect(reviewContext.executionConstraints.failurePolicy).toBe("best_effort");
    expect(reviewContext.executionConstraints.environmentPolicy).toBe("preserve");
    expect(reviewContext.userRequirement).toContain("使用当前系统的版本");
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.plan[1].status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(task.messages.some((message) =>
      message.content.includes("模型结合用户需求、执行约束"),
    )).toBe(true);
  });

  it("运行时阻断有明确修复步骤时允许继续到环境修复审批", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [
      ensureStepValidator({
        ...structuredClone(plan[0]),
        id: "node-compatibility-with-fix",
        title: "诊断 Node.js 环境兼容性",
        command: "node -v && echo TOO_OLD",
        validation: "test -f /opt/app/package.json",
      }),
      {
        ...structuredClone(plan[1]),
        id: "upgrade-node",
        title: "升级 Node.js 到项目要求版本",
        command: "nvm install 22 && nvm use 22",
        risk: "medium",
      },
    ];
    vi.mocked(backend.executeCommand).mockResolvedValueOnce({
      output: "$ node -v\nv16.20.2\nTOO_OLD\n[exit: 0]",
      success: true,
      simulated: false,
      exitCode: 0,
    });
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "当前版本不兼容",
      summary: "需要升级 Node.js。",
      source: "model",
    });

    await store.runStep(task.id, "node-compatibility-with-fix");

    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].review?.decision).toBe("continue");
    expect(task.plan[1].status).toBe("awaiting_approval");
    expect(task.status).toBe("awaiting_step_approval");
  });

  it("未安装领域 Skill 时未知工具失败保留为通用失败", () => {
    const failure = analyzeCommandFailure("tool-specific compatibility error");

    expect(failure.reason).toBe("命令执行未成功");
    expect(failure.facts.category).toBe("command_failed");
  });

  it("单步构建失败只显示暂停原因，不提前生成本轮总结", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "failed-build",
      title: "构建项目",
      command: "cd /opt/app && npm run build",
      validation: "test -f /opt/app/dist/index.html",
    }];
    vi.mocked(backend.executeCommand).mockResolvedValueOnce({
      output: [
        "$ npm run build",
        "tool-specific compatibility error",
        "[exit: 1]",
      ].join("\n"),
      success: false,
      simulated: false,
      exitCode: 1,
    });

    await store.runStep(task.id, "failed-build");

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("命令执行未成功");
    expect(task.summary).toBeUndefined();
    expect(task.messages.some((message) => message.kind === "summary")).toBe(false);
    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    const reviewContext = JSON.parse(vi.mocked(backend.reviewStep).mock.calls[0][1]);
    expect(reviewContext.userRequirement).toBe(task.title);
    expect(reviewContext.fullPlan).toHaveLength(1);
    expect(reviewContext.currentStep.result.executionStatus).toBe("failed");
  });

  it("主命令失败后模型会结合用户约束和剩余恢复步骤决定继续", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    store.pushMessage(task, {
      role: "user",
      kind: "message",
      content: "使用当前系统版本尝试部署，不要升级系统运行时",
    });
    task.status = "running";
    task.plan = [
      {
        ...structuredClone(plan[0]),
        id: "failed-build-with-recovery",
        title: "尝试构建项目",
        command: "cd /opt/app && npm run build",
        validation: "test -f /opt/app/dist/index.html",
      },
      {
        ...structuredClone(plan[1]),
        id: "container-recovery",
        title: "使用兼容容器构建",
        command: "docker run --rm -v /opt/app:/app node:20 bash -lc 'cd /app && npm run build'",
        validation: "test -f /opt/app/dist/index.html",
      },
    ];
    vi.mocked(backend.executeCommand)
      .mockResolvedValueOnce({
        output: [
          "$ npm run build",
          "You are using Node.js 16.20.2. Vite requires Node.js version 20.19+ or 22.12+.",
          "[exit: 1]",
        ].join("\n"),
        success: false,
        simulated: false,
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        output: "$ docker run\nbuild completed\n[exit: 0]",
        success: true,
        simulated: false,
        exitCode: 0,
      });
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "continue",
      reason: "剩余计划使用隔离容器，不升级宿主机运行时且能处理构建失败",
      summary: "保留当前系统版本并继续使用兼容容器构建。",
      source: "model",
    });

    await store.runStep(task.id, "failed-build-with-recovery");

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    const reviewContext = JSON.parse(vi.mocked(backend.reviewStep).mock.calls[0][1]);
    expect(reviewContext.userRequirement).toContain("不要升级系统运行时");
    expect(reviewContext.fullPlan).toHaveLength(2);
    expect(reviewContext.remainingSteps[0].title).toBe("使用兼容容器构建");
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[1].status).toBe("completed");
    expect(task.status).toBe("completed");
  });
});
