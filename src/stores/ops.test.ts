import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, buildExecutionSummary, normalizePlanPreconditions } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import type { PlanStep } from "@/types";
import { sanitizeTerminalOutput } from "@/utils/terminal";

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
    setActivePinia(createPinia());
    vi.spyOn(backend, "generatePlan").mockResolvedValue(structuredClone(plan));
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
    expect(store.activeTask?.summary).toContain("所有校验均通过");
    expect(store.logs.some((event) => event.category === "command")).toBe(true);
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

  it("任何授权等级都不会自动执行高风险步骤", () => {
    const store = useOpsStore();
    const highRisk = { ...plan[0], risk: "high" as const, command: "rm -rf /data" };

    expect(store.needsApproval("observe", highRisk)).toBe(true);
    expect(store.needsApproval("safe", highRisk)).toBe(true);
    expect(store.needsApproval("autonomous", highRisk)).toBe(true);
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

  it("启动时恢复服务器密码和模型 API Key，并按需自动连接", async () => {
    vi.mocked(backend.loadCredential).mockImplementation(async (kind, id) => {
      if (kind === "server" && id === "srv-tencent-test") return "remembered-ssh-password";
      if (kind === "model" && id === "model-deepseek") return "remembered-model-key";
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

  it("选中已有任务后可继续多轮需求，不会强制创建新任务", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "completed";
    task.plan = structuredClone(plan);
    task.plan.forEach((step) => { step.status = "completed"; });
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
  });

  it("查询无匹配项仍正常完成，并生成明确总结", async () => {
    const store = useOpsStore();
    vi.mocked(backend.generatePlan).mockResolvedValue([structuredClone(plan[0])]);
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
    vi.mocked(backend.validateStep).mockImplementation(async (step) => ({
      passed: true,
      detail: "独立校验通过",
      output: `$ ${step.validation}\n[exit: 0]`,
    }));

    await store.runStep(task.id, "validation-secret-step");

    expect(backend.validateStep).toHaveBeenCalledWith(
      expect.objectContaining({ validation: expect.stringContaining("private-validation-value") }),
      undefined,
    );
    expect(task.plan[0].output).not.toContain("private-validation-value");
    expect(store.logs.map((event) => event.detail).join("\n")).not.toContain("private-validation-value");
  });

  it("数据库查询总结会列出实际返回的数据库名称", () => {
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

    expect(buildExecutionSummary("MySQL 有哪些数据库", [databaseStep]))
      .toBe("查询完成，共找到 4 个数据库：information_schema、ffp、mysql、performance_schema。");
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
    expect(store.activeTask?.status).toBe("failed");
    expect(store.activeTask?.plan).toHaveLength(0);
    expect(store.activeTask?.summary).toContain("API Key 未恢复");
    expect(store.activeTask?.summary).toContain("模型与设置");
  });

  it("默认模型列表不再包含本地演示模型", () => {
    const store = useOpsStore();
    expect(store.models.some((model) => model.id === "model-local" || model.provider === "Built-in")).toBe(false);
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

  it("创建数据库前的状态检查允许已存在和不存在两种有效分支", () => {
    const steps: PlanStep[] = [
      {
        ...structuredClone(plan[0]),
        title: "检查数据库是否存在",
        command: "mysql -u root -p${secret.DB_PASSWORD} -e 'SHOW DATABASES;' 2>&1",
        expected: "输出包含应用配置中的数据库名称",
        validation: "mysql -u root -p${secret.DB_PASSWORD} -e 'SHOW DATABASES;' 2>&1 | grep -w 'ffp' && exit 0 || exit 1",
      },
      {
        ...structuredClone(plan[1]),
        title: "创建缺失的数据库并授权",
        command: "mysql -u root -p${secret.DB_PASSWORD} -e \"CREATE DATABASE IF NOT EXISTS ffp CHARACTER SET utf8mb4;\"",
      },
    ];

    const normalized = normalizePlanPreconditions(steps);

    expect(normalized[0].title).toBe("检查数据库 ffp 当前状态");
    expect(normalized[0].expected).toContain("0 为不存在，1 为已存在");
    expect(normalized[0].command).toContain("-Nse");
    expect(normalized[0].validation).toContain("information_schema.schemata");
    expect(normalized[0].validation).toContain("schema_name='ffp'");
    expect(normalized[0].validation).toMatch(/grep -Eq '\^\[01\]\$'$/);
    expect(normalized[1]).toEqual(steps[1]);
  });

  it("会修正模型直接用 grep 断言数据库不存在的前置命令", () => {
    const steps: PlanStep[] = [
      {
        ...structuredClone(plan[0]),
        title: "检查数据库 ffp 是否已存在",
        command: "mysql -u root -p${secret.DB_PASSWORD} -e \"SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'ffp';\" 2>/dev/null | grep -qx '0'",
        expected: "数据库不存在",
        validation: "mysql -u root -p${secret.DB_PASSWORD} -e \"SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'ffp';\" 2>/dev/null | grep -qx '0'",
      },
      {
        ...structuredClone(plan[1]),
        title: "创建数据库 ffp",
        command: "mysql -u root -p${secret.DB_PASSWORD} -e \"CREATE DATABASE IF NOT EXISTS ffp CHARACTER SET utf8mb4;\"",
      },
    ];

    const normalized = normalizePlanPreconditions(steps);

    expect(normalized[0].command).not.toContain("grep");
    expect(normalized[0].command).not.toContain("2>/dev/null");
    expect(normalized[0].validation).toContain("grep -Eq '^[01]$'");
  });

  it("程序校验通过后由模型复核决定暂停调整", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0]), structuredClone(plan[2])];
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "输出没有包含期望的文件系统列表",
      summary: "命令成功退出，但结果证据不足。",
      source: "model",
    });

    await store.runStep(task.id, task.plan[0].id);

    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].review?.decision).toBe("adjust");
    expect(task.plan[1].status).toBe("pending");
    expect(task.status).toBe("needs_adjustment");
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("模型确认整体目标已达成时跳过剩余步骤并完成任务", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0]), structuredClone(plan[2])];
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

  it("程序校验失败时不会调用模型复核", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "autonomous", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0])];
    vi.mocked(backend.validateStep).mockResolvedValueOnce({
      passed: false,
      detail: "独立校验未达到预期",
    });

    await store.runStep(task.id, task.plan[0].id);

    expect(task.status).toBe("needs_adjustment");
    expect(backend.reviewStep).not.toHaveBeenCalled();
  });
});
