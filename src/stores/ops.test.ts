// @ts-nocheck -- legacy shared-PTY fixtures below are retained temporarily as
// runtime migration coverage; production types intentionally removed that API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  backend,
  buildExecutionSummary,
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
} from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import type { PlanStep } from "@/types";
import { sanitizeTerminalOutput } from "@/utils/terminal";
import {
  analyzeCommandFailure,
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
} from "@/services/validation";
import { useTerminalSessionStore } from "@/features/terminal/terminalSessionStore";

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
  afterEach(() => vi.useRealTimers());

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
    localStorage.setItem("opsark.models", JSON.stringify([
      {
        id: "model-deepseek",
        name: "测试模型",
        provider: "Test",
        model: "test-model",
        endpoint: "https://model.example.invalid",
        enabled: true,
        hasApiKey: true,
      },
    ]));
    localStorage.setItem("opsark.secretMetadata", JSON.stringify([
      { key: "DB_PASSWORD", description: "测试数据库密码", scope: "server", serverId: "srv-tencent-test" },
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
    vi.spyOn(backend, "reviewGoal").mockResolvedValue({
      decision: "complete",
      reason: "整体目标已有完整验收证据",
      summary: "整体目标已完成。",
      source: "model",
    });
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "deleteCredential").mockResolvedValue();
    vi.spyOn(backend, "checkModel").mockResolvedValue({
      available: true,
      reason: "接口、鉴权和模型名称均可用",
    });
    vi.spyOn(backend, "getRemoteFileStructure").mockResolvedValue({
      tree: "/opt/app/\n└── package.json",
      truncated: false,
      warnings: [],
    });
    useOpsStore().modelApiKeys["model-deepseek"] = "test-model-api-key";
  });

  it("将审计事件归档到任务所属服务器并保留名称快照", () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.title = "检查 Web 服务";

    store.addLog({
      category: "task",
      level: "info",
      title: "任务事件",
      detail: "任务已创建",
      taskId: task.id,
    });

    expect(store.logs[0]).toMatchObject({
      serverId: "srv-production-01",
      serverName: "测试服务器",
      taskId: task.id,
      taskTitle: "检查 Web 服务",
    });
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

  it("Shell 启动文件的 fresh shell 验收失败后由执行器自动回滚", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "startup-transaction",
      kind: "change",
      title: "更新 bash 启动配置",
      command: 'tmp=$(mktemp "$HOME/.bashrc.opsark.XXXXXX"); printf "[-s invalid\\n" > "$tmp"; mv -- "$tmp" "$HOME/.bashrc"',
      expected: "新交互 Shell 可自动加载配置",
      validation: "type nvm",
      executionScope: "isolated_exec",
      validationScope: "fresh_interactive_shell",
      risk: "low",
    }];
    vi.mocked(backend.executeCommand)
      .mockResolvedValueOnce({ output: "OPSARK_STARTUP_SNAPSHOT", success: true, simulated: false, exitCode: 0 })
      .mockResolvedValueOnce({ output: "updated", success: true, simulated: false, exitCode: 0 })
      .mockResolvedValueOnce({ output: "OPSARK_STARTUP_ROLLBACK", success: true, simulated: false, exitCode: 0 });
    vi.mocked(backend.validateStep).mockResolvedValueOnce({
      passed: false,
      detail: "fresh interactive shell failed",
      output: "bash: [-s: command not found",
      exitCode: 2,
    });

    await store.runStep(task.id, "startup-transaction");

    const frameworkCommands = vi.mocked(backend.executeCommand).mock.calls.map(([command]) => command);
    expect(frameworkCommands[0]).toContain("OPSARK_STARTUP_SNAPSHOT");
    expect(frameworkCommands[1]).toBe(task.plan[0].command);
    expect(frameworkCommands[2]).toContain("OPSARK_STARTUP_ROLLBACK");
    expect(task.plan[0].result?.facts.shellStartupRollback).toBe("success");
    expect(task.plan[0].output).toContain("Shell 启动文件事务回滚");
  });

  it("将当前启用工具的模型可见说明写入需求上下文", async () => {
    const store = useOpsStore();
    const fileTool = store.tools.find((tool) => tool.id === "files.get_structure")!;
    fileTool.description = "读取项目目录结构用于部署分析";

    await store.submitRequirement("srv-production-01", "查看项目结构", "safe", "model-deepseek");

    const runtimeModel = vi.mocked(backend.processRequirement).mock.calls[0][1];
    const context = JSON.parse(runtimeModel.context);
    expect(context.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "files.get_structure",
        description: "读取项目目录结构用于部署分析",
      }),
    ]));
    expect(context.tools[0]).not.toHaveProperty("implementation");
  });

  it("完全托管模式会自动批准计划并连续执行低中风险步骤", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    terminalSessions.ensureWorkspace("srv-production-01");
    const firstTerminalId = terminalSessions.sessionsByServer["srv-production-01"][0].id;
    const initiatingTerminal = terminalSessions.addSession("srv-production-01")!;

    await store.submitRequirement("srv-production-01", "自动检查并重新加载 Nginx", "managed", "model-deepseek");

    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.plan.every((step) => step.status === "completed")).toBe(true);
    expect(store.activeTask?.messages.some((message) => message.content.includes("完全托管模式已自动批准计划"))).toBe(true);
    expect(terminalSessions.activeSessionByServer["srv-production-01"]).toBe(initiatingTerminal.id);
    expect(terminalSessions.sessionsByServer["srv-production-01"]
      .find(({ id }) => id === firstTerminalId)?.panes[0]).not.toHaveProperty("agentTaskId");
  });

  it.skip("继续提交既有任务时保持最初发起终端绑定", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    terminalSessions.ensureWorkspace("srv-production-01");
    const initiatingSession = terminalSessions.sessionsByServer["srv-production-01"][0];
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    const taskId = task.id;
    const initiatingPaneId = initiatingSession.panes[0].id;
    terminalSessions.bindAgentTask("srv-production-01", taskId);
    expect(terminalSessions.resolveTaskPaneId("srv-production-01", taskId)).toBe(initiatingPaneId);

    const otherSession = terminalSessions.addSession("srv-production-01")!;
    expect(terminalSessions.activeSessionByServer["srv-production-01"]).toBe(otherSession.id);
    await store.submitRequirement(
      "srv-production-01",
      "继续检查日志",
      "safe",
      "model-deepseek",
      "",
      taskId,
    );

    expect(terminalSessions.resolveTaskPaneId("srv-production-01", taskId)).toBe(initiatingPaneId);
    expect(otherSession.panes[0].agentTaskId).toBeUndefined();
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

  it.skip("远程输出到达时同步更新步骤详情和终端", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    terminalSessions.ensureWorkspace("srv-production-01");
    const firstSession = terminalSessions.sessionsByServer["srv-production-01"][0];
    const secondSession = terminalSessions.addSession("srv-production-01")!;
    terminalSessions.activateSession("srv-production-01", firstSession.id);
    vi.mocked(backend.executeCommand).mockImplementation(async (_command, _connection, _approved, options) => {
      options?.onProgress?.({ executionId: options.executionId, data: "download 42%\n", stream: "stdout" });
      terminalSessions.activateSession("srv-production-01", secondSession.id);
      options?.onProgress?.({ executionId: options.executionId, data: "download complete\n", stream: "stdout" });
      return { output: "$ download\ndownload 42%\n[exit: 0]", success: true, simulated: false, exitCode: 0 };
    });
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{ ...structuredClone(plan[0]), id: "stream-step" }];

    await store.runStep(task.id, "stream-step");

    expect(store.terminalLines).toContain("download 42%");
    expect(task.plan[0].output).toContain("download 42%");
    const agentPaneId = terminalSessions.resolveTaskPaneId("srv-production-01", task.id)!;
    expect(terminalSessions.agentOutputByPane[agentPaneId].map(({ data }) => data).join(""))
      .toContain("download complete");
    expect(agentPaneId).toBe(firstSession.activePaneId);
    expect(terminalSessions.agentOutputByPane[secondSession.activePaneId]).toBeUndefined();
  });

  it.skip("真实 SSH 会话的主命令和正式校验都通过绑定终端执行", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "pty-step",
      command: "echo running",
      validation: "test -n running",
    }];
    store.serverPasswords[task.serverId] = "test-password";
    store.connectedServerIds.push(task.serverId);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand")
      .mockImplementation(async (_paneId, _executionId, command, onProgress) => {
        onProgress?.(`${command}: ok\n`);
        return { output: `${command}: ok`, success: true, simulated: false, exitCode: 0, emptyResult: false };
      });

    await store.runStep(task.id, "pty-step");

    expect(executeInPty.mock.calls.map(([, , command]) => command))
      .toEqual(["echo running", "test -n running"]);
    expect(executeInPty.mock.calls[1][5]).toBe(30_000);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
    expect(task.messages.some(({ content }) => content.includes("正在执行独立后置校验"))).toBe(true);
    expect(task.plan[0].status).toBe("completed");
  });

  it.skip("绑定终端的长任务收到调整决定后有界收敛并隔离未释放的 PTY", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "pty-stalled-step",
      title: "检查运行环境",
      command: "java -version",
      validation: "java -version",
    }];
    store.serverPasswords[task.serverId] = "test-password";
    store.connectedServerIds.push(task.serverId);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    vi.mocked(backend.reviewStep).mockResolvedValueOnce({
      decision: "adjust",
      reason: "终端没有返回任何可观察进展",
      summary: "停止当前等待并调整执行方式。",
      source: "model",
    });
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([{
      ...structuredClone(plan[0]),
      id: "retry-version-check",
      title: "有界检查 Java 版本",
      command: "timeout 10 java -version",
      validation: "timeout 10 java -version",
      status: "pending",
    }]);

    const running = store.runStep(task.id, "pty-stalled-step");
    await vi.advanceTimersByTimeAsync(35_000);
    await running;

    expect(terminalSessions.agentInterruptByPane[paneId]).toBe(1);
    expect(terminalSessions.agentRecoveryByPane[paneId]).toBe(1);
    expect(terminalSessions.agentCommandByPane[paneId]).toBeDefined();
    expect(task.plan[0].result?.facts).toMatchObject({
      stoppedByPeriodicReview: true,
      category: "terminal_recovery",
      terminalReleased: false,
    });
    expect(task.status).toBe("needs_adjustment");
    expect(task.adjustmentCount).toBe(0);
    expect(task.adjustmentIncident?.kind).toBe("transport");
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.messages.filter(({ content }) => content.includes("仍在执行"))).toHaveLength(0);

    terminalSessions.releaseAgentPtyCommandAfterRecovery(paneId, terminalSessions.agentCommandByPane[paneId]!.id);
    await store.routeAutomaticAdjustment(task.id, { transportRecovery: true });
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].id).toBe("pty-stalled-step");
    expect(task.plan[0].result?.facts.category).toBe("periodic_review");
    expect(task.messages.some(({ content }) => content.includes("安全模式不会自动调用模型"))).toBe(true);
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it.skip("绑定终端后置校验 30 秒协议超时后进入终端恢复且不调用模型", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "validation-timeout-step",
      command: "echo ready",
      validation: "test -n ready",
    }];
    store.serverPasswords[task.serverId] = "test-password";
    store.connectedServerIds.push(task.serverId);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand")
      .mockImplementation(async (_paneId, _executionId, command, onProgress, _display, timeoutMs, kind) => {
        if (kind === "validation") {
          expect(timeoutMs).toBe(30_000);
          throw new Error("绑定终端在 30 秒内未返回命令结束标记");
        }
        onProgress?.(`${command}: ok\n`);
        return { output: `${command}: ok`, success: true, simulated: false, exitCode: 0, emptyResult: false };
      });

    await store.runStep(task.id, "validation-timeout-step");

    expect(executeInPty).toHaveBeenCalledTimes(2);
    expect(backend.reviewStep).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].result?.facts).toMatchObject({
      commandCompleted: true,
      validationCompleted: false,
      validationProtocolIncomplete: true,
    });
    expect(task.pauseReason).toContain("后置校验未取得真实退出码");
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.messages.some(({ content }) => content.includes("不会让模型改写业务计划"))).toBe(true);
  });

  it("执行前先机械修复 command，再精确拦截仍不安全的 validation，且终端零副作用", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "masked-step",
      command: "timeout 900 make download-toolchain || { echo failed; exit 0; }",
      validation: "find toolchain -name rustc | head -n 1; true",
    }];

    const terminalBefore = [...store.terminalLines];
    await store.advanceTask(task.id);

    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].command).toContain("__opsark_preserved_failure_status=$?");
    expect(task.plan[0].command).not.toContain("exit 0");
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "blocked",
      facts: {
        commandCompleted: false,
        validationCompleted: false,
        category: "plan_safety_rejection",
        field: "validation",
        ruleId: "UNCONDITIONAL_SUCCESS_TAIL",
      },
    });
    expect(task.pauseReason).toContain("命令尚未发送到服务器");
    expect(task.pauseReason).toContain("validation（独立后置校验）");
    expect(store.terminalLines).toEqual(terminalBefore);
    expect(task.messages.some(({ content }) => content.startsWith("执行 采集状态"))).toBe(false);
  });

  it("执行前拦截 set +e 后仅打印状态而未传播退出码的诊断命令", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "masked-database-diagnostic",
      command: "set +e; sudo -n mysql -e 'SHOW DATABASES;' 2>&1 | head -30; echo '---EXIT:'$?'---'",
      validation: "mysqladmin ping",
    }];

    await store.runStep(task.id, "masked-database-diagnostic");

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("命令尚未发送到服务器");
    expect(task.pauseReason).toContain("command（计划命令）");
    expect(task.pauseReason).toContain("SET_PLUS_E_STATUS_LOST");
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].output).toBeUndefined();
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "blocked",
      facts: {
        category: "plan_safety_rejection",
        field: "command",
        ruleId: "SET_PLUS_E_STATUS_LOST",
      },
    });
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
  });

  it("桌面端统一安全分析器不可用时关闭式拦截，不回退到另一套规则", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{ ...structuredClone(plan[0]), id: "analyzer-unavailable" }];
    vi.spyOn(backend, "analyzePlanStepSafety").mockRejectedValueOnce(new Error("IPC unavailable"));

    await store.runStep(task.id, "analyzer-unavailable");

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "blocked",
      facts: {
        category: "plan_safety_rejection",
        ruleId: "SAFETY_ANALYZER_UNAVAILABLE",
        commandCompleted: false,
      },
    });
    expect(task.pauseReason).toContain("命令尚未发送到服务器");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
  });

  it("数据库步骤不会复用同服务器已保存的 SSH 密码", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "database-secret-mismatch",
      title: "列出 MySQL 所有数据库",
      description: "使用数据库管理员凭据查询",
      command: "mysql -uroot -p'${secret.PASSWORD}' -e 'SHOW DATABASES'",
      validation: "mysqladmin ping",
    }];
    store.secretMetadata.push({
      key: "PASSWORD",
      description: "用于登录192.168.1.237的密码",
      scope: "server",
      serverId: task.serverId,
    });
    store.secretValues[`${task.serverId}::PASSWORD`] = "ssh-only";
    task.confirmedSecretKeys = ["PASSWORD"];

    await store.runStep(task.id, "database-secret-mismatch");

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("用途");
    expect(task.pauseReason).toContain("语义明确的新变量");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("模型工具命令由工具执行器处理，不发送到远端 shell", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    store.serverPasswords[task.serverId] = "test-password";
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "tool-step",
      title: "获取项目文件结构",
      command: 'opsark-tool files.get_structure {"rootPath":"/opt/app","excludeDirectories":["uploads"]}',
      validation: "true",
    }];

    await store.runStep(task.id, "tool-step");

    expect(backend.getRemoteFileStructure).toHaveBeenCalledWith(
      expect.objectContaining({ host: "example.invalid", username: "tester" }),
      expect.objectContaining({ rootPath: "/opt/app", excludeDirectories: expect.arrayContaining(["uploads"]) }),
    );
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].evidence?.[0].facts.toolId).toBe("files.get_structure");
    expect(task.status).toBe("completed");
  });

  it("用户输入工具展示参数用途，并在提交后以脱敏证据继续规划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    store.pushMessage(task, { role: "user", kind: "message", content: "部署应用" });
    task.status = "running";
    task.executionConstraints = {
      changePolicy: "requested_changes_only",
      environmentPolicy: "preserve",
      failurePolicy: "strict",
      prohibitedActions: [],
      requiredConditions: [],
      userDirectives: [],
    };
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "user-input-step",
      title: "获取部署参数",
      command: 'opsark-tool user.request_input {"title":"补充部署信息","description":"用于生成安全的部署计划","fields":[{"key":"port","label":"服务端口","description":"应用对外监听的 TCP 端口","type":"number","required":true},{"key":"deploy_token","label":"部署令牌","description":"访问私有制品库的鉴权令牌","type":"password","required":true}]}',
      validation: "true",
    }];

    await store.runStep(task.id, "user-input-step");
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingUserInputs[0].fields[0].description).toContain("TCP 端口");

    await store.provideUserInput(task.id, { port: "8080", deploy_token: "private-token" });

    expect(backend.saveCredential).toHaveBeenCalledWith("secret", `${task.serverId}::DEPLOY_TOKEN`, "private-token");
    expect(task.submittedInputs?.port).toMatchObject({
      value: 8080,
      label: "服务端口",
      type: "number",
      groupTitle: "补充部署信息",
    });
    expect(task.submittedInputs?.deploy_token).toBeUndefined();
    expect(task.submittedSecretBindings?.DEPLOY_TOKEN).toMatchObject({
      key: "DEPLOY_TOKEN",
      groupId: task.submittedInputs?.port.groupId,
      groupTitle: "补充部署信息",
    });
    expect(JSON.stringify(task.submittedSecretBindings)).not.toContain("private-token");
    expect(store.secretMetadata).toContainEqual(expect.objectContaining({
      key: "DEPLOY_TOKEN",
      serverId: task.serverId,
    }));
    expect(localStorage.getItem("opsark.secretMetadata")).toContain("DEPLOY_TOKEN");
    const persistedTask = (JSON.parse(localStorage.getItem("opsark.tasks") ?? "[]") as Array<{
      id: string;
      submittedInputs?: Record<string, unknown>;
      submittedSecretBindings?: Record<string, unknown>;
    }>).find(({ id }) => id === task.id);
    expect(persistedTask?.submittedInputs).toHaveProperty("port");
    expect(persistedTask?.submittedSecretBindings).toHaveProperty("DEPLOY_TOKEN");
    expect(JSON.stringify(persistedTask)).not.toContain("private-token");
    expect(task.plan[0].output).toContain("8080");
    expect(task.plan[0].output).not.toContain("private-token");
    expect(JSON.stringify(store.logs)).not.toContain("private-token");
    expect(task.discoveryRefined).toBe(true);
  });

  it("连接目标变更后将新凭据按实际执行服务器长期保存", async () => {
    const store = useOpsStore();
    const target = store.addServer({
      name: "target",
      host: "10.0.0.88",
      port: 22,
      username: "root",
      group: "test",
    });
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.executionTargetServerId = target.id;
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "target-secret-input",
      title: "获取目标服务器凭据",
      command: 'opsark-tool user.request_input {"title":"目标服务器令牌","fields":[{"key":"DEPLOY_TOKEN","label":"部署令牌","description":"仅供目标服务器使用","type":"password","required":true}]}',
      validation: "true",
    }];

    await store.runStep(task.id, "target-secret-input");
    await store.provideUserInput(task.id, { DEPLOY_TOKEN: "target-only-token" });

    expect(backend.saveCredential).toHaveBeenCalledWith(
      "secret",
      `${target.id}::DEPLOY_TOKEN`,
      "target-only-token",
    );
    expect(store.getServerSecretValues(target.id).DEPLOY_TOKEN).toBe("target-only-token");
    expect(store.getServerSecretValues(task.serverId).DEPLOY_TOKEN).toBeUndefined();
    expect(store.secretMetadata).toContainEqual(expect.objectContaining({
      key: "DEPLOY_TOKEN",
      serverId: target.id,
    }));
  });

  it.skip("用户名和令牌作为服务器凭据组持久化，新任务可直接复用", async () => {
    const store = useOpsStore();
    const inputTask = store.createTask("srv-production-01", "safe", "model-deepseek");
    inputTask.status = "running";
    inputTask.plan = [{
      ...structuredClone(plan[0]),
      id: "save-gitee-credential",
      title: "保存 Gitee 凭据",
      command: 'opsark-tool user.request_input {"title":"提供Gitee HTTPS认证凭据","fields":[{"key":"GIT_USERNAME","label":"Gitee用户名","description":"https://gitee.com 平台账号的登录用户名，用于本次克隆认证。","type":"password","required":true,"credential":{"group":"gitee_read","kind":"git-https","role":"username","target":"gitee.com"}},{"key":"GIT_HTTP_CREDENTIAL","label":"Gitee密码或个人访问令牌","description":"https://gitee.com 平台账号的密码，或具有该仓库读取权限的个人访问令牌。","type":"password","required":true,"credential":{"group":"gitee_read","kind":"git-https","role":"secret","target":"gitee.com"}}]}',
      validation: "true",
    }];
    await store.runStep(inputTask.id, "save-gitee-credential");
    await store.provideUserInput(inputTask.id, {
      GIT_USERNAME: "developer@example.com",
      GIT_HTTP_CREDENTIAL: "gitee-token",
    });

    const groupFields = store.secretMetadata.filter((item) => item.serverId === inputTask.serverId
      && item.credentialGroupId);
    expect(groupFields).toHaveLength(2);
    expect(groupFields.map(({ credentialRole }) => credentialRole).sort()).toEqual(["secret", "username"]);
    expect(new Set(groupFields.map(({ credentialGroupId }) => credentialGroupId)).size).toBe(1);
    expect(store.getServerSecretValues(inputTask.serverId)).toMatchObject({
      GIT_USERNAME: "developer@example.com",
      GIT_HTTP_CREDENTIAL: "gitee-token",
    });
    expect(backend.saveCredential).toHaveBeenCalledWith(
      "secret",
      `${inputTask.serverId}::GIT_USERNAME`,
      "developer@example.com",
    );
    expect(inputTask.submittedInputs?.GIT_USERNAME).toBeUndefined();
    expect(localStorage.getItem("opsark.secretMetadata")).not.toContain("developer@example.com");
    expect(localStorage.getItem("opsark.tasks")).not.toContain("developer@example.com");

    const terminalSessions = useTerminalSessionStore();
    const cloneTask = store.createTask(inputTask.serverId, "managed", "model-deepseek");
    cloneTask.status = "running";
    cloneTask.plan = [{
      ...structuredClone(plan[0]),
      id: "reuse-gitee-credential",
      title: "克隆 Gitee 私有仓库",
      description: "使用服务器已保存的 ${secret.GIT_HTTP_CREDENTIAL} 认证 gitee.com",
      command: "GIT_TERMINAL_PROMPT=1 git clone https://gitee.com/songpenley/ground_check.git /opt/ground_check",
      validation: "test -d /opt/ground_check/.git",
    }];
    store.serverPasswords[cloneTask.serverId] = "server-password";
    store.connectedServerIds.push(cloneTask.serverId);
    terminalSessions.ensureWorkspace(cloneTask.serverId);
    const paneId = terminalSessions.bindAgentTask(cloneTask.serverId, cloneTask.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand")
      .mockResolvedValue({ output: "ok", success: true, simulated: false, exitCode: 0, emptyResult: false });

    await store.runStep(cloneTask.id, "reuse-gitee-credential");

    expect(cloneTask.confirmedSecretKeys).toEqual([]);
    expect(executeInPty.mock.calls[0][7]).toEqual({
      kind: "git-https",
      username: "developer@example.com",
      secret: "gitee-token",
      target: "gitee.com",
    });
    expect(executeInPty.mock.calls[1][7]).toBeUndefined();
    expect(JSON.stringify(store.logs)).not.toContain("developer@example.com");
    expect(JSON.stringify(store.logs)).not.toContain("gitee-token");
  });

  it.skip("多个 Git 账号未显式选组时在启动 PTY 前关闭式阻断", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "ambiguous-gitee-credential",
      title: "克隆 Gitee 私有仓库",
      description: "使用服务器已保存的 Gitee 凭据认证",
      command: "GIT_TERMINAL_PROMPT=1 git clone https://gitee.com/team/app.git /opt/app",
      expected: "仓库获取完成",
      validation: "test -d /opt/app/.git",
    }];
    const addGroup = (suffix: string, groupId: string, username: string, secret: string) => {
      const usernameKey = `GIT_USERNAME${suffix}`;
      const secretKey = `GIT_HTTP_CREDENTIAL${suffix}`;
      store.secretMetadata.push({
        key: usernameKey,
        description: "用于 gitee.com 的 Git HTTPS 用户名",
        scope: "server",
        serverId: task.serverId,
        credentialGroupId: groupId,
        credentialKind: "git-https",
        credentialRole: "username",
        credentialTarget: "gitee.com",
      }, {
        key: secretKey,
        description: "用于 gitee.com 的 Git HTTPS 令牌",
        scope: "server",
        serverId: task.serverId,
        credentialGroupId: groupId,
        credentialKind: "git-https",
        credentialRole: "secret",
        credentialTarget: "gitee.com",
      });
      store.secretValues[`${task.serverId}::${usernameKey}`] = username;
      store.secretValues[`${task.serverId}::${secretKey}`] = secret;
    };
    addGroup("", "gitee-personal", "personal", "personal-token");
    addGroup("_2", "gitee-company", "company", "company-token");
    store.serverPasswords[task.serverId] = "server-password";
    store.connectedServerIds.push(task.serverId);
    const terminalSessions = useTerminalSessionStore();
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand");

    await store.runStep(task.id, "ambiguous-gitee-credential");

    expect(executeInPty).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "blocked",
      facts: {
        category: "interactive_credential_resolution",
        credentialResolutionCode: "credential-group-ambiguous",
        commandCompleted: false,
        ptyStarted: false,
      },
    });
    expect(task.pauseReason).toContain("多个可用账号");
    expect(task.pauseReason).toContain("启动交互终端前阻止");
  });

  it.skip("主命令凭据不会复用到另一主机的交互后置校验", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "cross-target-validation-credential",
      title: "克隆 Gitee 私有仓库",
      description: "使用 server-credential:gitee-main 认证 Gitee 仓库",
      command: "GIT_TERMINAL_PROMPT=1 git clone https://gitee.com/team/app.git /opt/app",
      expected: "仓库获取完成",
      validation: "ssh -o BatchMode=no root@192.0.2.88 test -d /opt/app/.git",
    }];
    store.secretMetadata.push({
      key: "GIT_USERNAME",
      description: "用于 gitee.com 的 Git HTTPS 用户名",
      scope: "server",
      serverId: task.serverId,
      credentialGroupId: "gitee-main",
      credentialKind: "git-https",
      credentialRole: "username",
      credentialTarget: "gitee.com",
    }, {
      key: "GIT_HTTP_CREDENTIAL",
      description: "用于 gitee.com 的 Git HTTPS 令牌",
      scope: "server",
      serverId: task.serverId,
      credentialGroupId: "gitee-main",
      credentialKind: "git-https",
      credentialRole: "secret",
      credentialTarget: "gitee.com",
    });
    store.secretValues[`${task.serverId}::GIT_USERNAME`] = "developer";
    store.secretValues[`${task.serverId}::GIT_HTTP_CREDENTIAL`] = "gitee-token";
    store.serverPasswords[task.serverId] = "server-password";
    store.connectedServerIds.push(task.serverId);
    const terminalSessions = useTerminalSessionStore();
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand");

    await store.runStep(task.id, "cross-target-validation-credential");

    expect(executeInPty).not.toHaveBeenCalled();
    expect(task.plan[0].result?.facts).toMatchObject({
      category: "interactive_credential_resolution",
      credentialResolutionCode: "credential-group-unresolved",
      ptyStarted: false,
    });
    expect(task.pauseReason).toContain("独立后置校验");
    expect(task.pauseReason).toContain("192.0.2.88");
  });

  it("同一服务器的不同 Git 用户名创建独立凭据组，同用户名则更新原组", async () => {
    const store = useOpsStore();
    const submit = async (username: string, token: string, index: number) => {
      const task = store.createTask("srv-production-01", "safe", "model-deepseek");
      task.status = "running";
      task.plan = [{
        ...structuredClone(plan[0]),
        id: `save-gitee-${index}`,
        command: 'opsark-tool user.request_input {"title":"Gitee HTTPS 凭据","fields":[{"key":"GIT_USERNAME","label":"Gitee 用户名","description":"用于 gitee.com Git 认证的用户名","type":"password","required":true},{"key":"GIT_HTTP_CREDENTIAL","label":"Gitee 令牌","description":"用于 gitee.com Git 认证的访问令牌","type":"password","required":true}]}',
        validation: "true",
      }];
      await store.runStep(task.id, `save-gitee-${index}`);
      await store.provideUserInput(task.id, { GIT_USERNAME: username, GIT_HTTP_CREDENTIAL: token });
    };

    await submit("personal-user", "personal-token", 1);
    await submit("company-user", "company-token", 2);
    expect(store.getServerSecretValues("srv-production-01")).toMatchObject({
      GIT_USERNAME: "personal-user",
      GIT_HTTP_CREDENTIAL: "personal-token",
      GIT_USERNAME_2: "company-user",
      GIT_HTTP_CREDENTIAL_2: "company-token",
    });
    expect(new Set(store.secretMetadata.filter(({ credentialGroupId }) => credentialGroupId)
      .map(({ credentialGroupId }) => credentialGroupId)).size).toBe(2);

    await submit("company-user", "rotated-company-token", 3);
    expect(store.secretMetadata.filter(({ credentialGroupId }) => credentialGroupId)).toHaveLength(4);
    expect(store.getServerSecretValues("srv-production-01")).toMatchObject({
      GIT_HTTP_CREDENTIAL: "personal-token",
      GIT_HTTP_CREDENTIAL_2: "rotated-company-token",
    });
    expect(store.getServerSecretValues("srv-production-01")).not.toHaveProperty("GIT_HTTP_CREDENTIAL_3");
  });

  it("兼容旧任务记录中缺失的输入凭据组字段", () => {
    localStorage.setItem("opsark.tasks", JSON.stringify([{
      id: "legacy-task",
      serverId: "srv-production-01",
      title: "旧任务",
      status: "draft",
      permission: "safe",
      modelId: "model-deepseek",
      messages: [],
      plan: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]));
    setActivePinia(createPinia());

    const store = useOpsStore();
    const legacy = store.tasks.find(({ id }) => id === "legacy-task");

    expect(legacy?.submittedInputs).toEqual({});
    expect(legacy?.submittedSecretBindings).toEqual({});
  });

  it("启动时修复已持久化旁问仍挂载上一轮计划的显示状态", () => {
    const previousPlan = structuredClone(plan).map((step) => ({ ...step, status: "completed" }));
    localStorage.setItem("opsark.tasks", JSON.stringify([{
      id: "legacy-side-question",
      serverId: "srv-production-01",
      title: "部署静态站点",
      status: "completed",
      permission: "safe",
      modelId: "model-deepseek",
      rootGoal: "部署静态站点",
      currentInstruction: "部署静态站点",
      lastRequirementRelation: "side_question",
      currentRoundId: "old-round",
      messages: [{
        id: "root-user",
        role: "user",
        kind: "message",
        content: "部署静态站点",
        createdAt: "2026-08-25T15:00:00.000Z",
      }, {
        id: "root-assistant",
        role: "assistant",
        kind: "message",
        content: "已生成 3 个执行步骤",
        createdAt: "2026-08-25T15:01:00.000Z",
      }, {
        id: "side-user",
        role: "user",
        kind: "message",
        content: "其他机器访问什么地址？",
        createdAt: "2026-08-25T15:15:00.000Z",
      }, {
        id: "side-assistant",
        role: "assistant",
        kind: "message",
        content: "访问 http://192.168.1.237:8080/",
        createdAt: "2026-08-25T15:16:00.000Z",
      }],
      plan: previousPlan,
      planHistory: [],
      phaseHistory: [],
      summary: "静态站点部署完成",
      createdAt: "2026-08-25T15:00:00.000Z",
      updatedAt: "2026-08-25T15:16:00.000Z",
    }]));
    setActivePinia(createPinia());

    const migrated = useOpsStore().tasks[0];

    expect(migrated.plan).toEqual([]);
    expect(migrated.summary).toBeUndefined();
    expect(migrated.currentInstruction).toBe("其他机器访问什么地址？");
    expect(migrated.planHistory).toHaveLength(1);
    expect(migrated.planHistory?.[0]).toMatchObject({
      requirement: "部署静态站点",
      summary: "静态站点部署完成",
    });
    expect(migrated.planHistory?.[0].plan).toHaveLength(3);
  });

  it("启动时将旧任务的 Git 用户名与服务器令牌迁移为长期凭据组", async () => {
    localStorage.setItem("opsark.secretMetadata", JSON.stringify([{
      key: "GIT_HTTP_CREDENTIAL",
      description: "用于 gitee.com 私有 Git 仓库的访问令牌",
      scope: "server",
      serverId: "srv-production-01",
    }]));
    localStorage.setItem("opsark.tasks", JSON.stringify([{
      id: "legacy-git-task",
      serverId: "srv-production-01",
      title: "克隆仓库",
      status: "needs_adjustment",
      permission: "safe",
      modelId: "model-deepseek",
      messages: [],
      plan: [],
      submittedInputs: {
        gitUsername: {
          value: "legacy@example.com",
          label: "Gitee 登录名",
          description: "用于 gitee.com Git 认证",
          type: "text",
          groupId: "legacy-input",
          groupTitle: "Gitee HTTPS 凭据",
          submittedAt: "2026-08-24T00:00:00.000Z",
        },
      },
      submittedSecretBindings: {
        GIT_HTTP_CREDENTIAL: {
          key: "GIT_HTTP_CREDENTIAL",
          label: "Gitee 令牌",
          description: "用于 gitee.com 私有 Git 仓库的访问令牌",
          groupId: "legacy-input",
          groupTitle: "Gitee HTTPS 凭据",
          submittedAt: "2026-08-24T00:00:00.000Z",
        },
      },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }]));
    setActivePinia(createPinia());
    vi.mocked(backend.loadCredential).mockImplementation(async (kind, id) => (
      kind === "secret" && id === "srv-production-01::GIT_HTTP_CREDENTIAL" ? "legacy-token" : null
    ));
    const store = useOpsStore();

    await store.hydrateCredentials();

    const group = store.secretMetadata.filter(({ credentialGroupId }) => credentialGroupId === "credential-legacy-input");
    expect(group).toHaveLength(2);
    expect(store.getServerSecretValues("srv-production-01")).toMatchObject({
      GIT_USERNAME: "legacy@example.com",
      GIT_HTTP_CREDENTIAL: "legacy-token",
    });
    expect(backend.saveCredential).toHaveBeenCalledWith(
      "secret",
      "srv-production-01::GIT_USERNAME",
      "legacy@example.com",
    );
    expect(store.tasks[0].submittedInputs?.gitUsername).toBeUndefined();
    expect(localStorage.getItem("opsark.tasks")).not.toContain("legacy@example.com");
  });

  it("启动时把旧版同一表单保存的两个孤立 password 项迁移为完整凭据组", async () => {
    localStorage.setItem("opsark.secretMetadata", JSON.stringify([{
      key: "GIT_USERNAME",
      description: "https://gitee.com 平台账号的登录用户名，用于本次克隆认证。",
      scope: "server",
      serverId: "srv-production-01",
    }, {
      key: "GIT_HTTP_CREDENTIAL",
      description: "https://gitee.com 平台账号的密码，或具有该仓库读取权限的个人访问令牌。",
      scope: "server",
      serverId: "srv-production-01",
    }]));
    localStorage.setItem("opsark.tasks", JSON.stringify([{
      id: "legacy-two-password-git-task",
      serverId: "srv-production-01",
      title: "克隆仓库",
      status: "needs_adjustment",
      permission: "safe",
      modelId: "model-deepseek",
      messages: [],
      plan: [],
      submittedSecretBindings: {
        GIT_USERNAME: {
          key: "GIT_USERNAME",
          label: "Gitee用户名",
          description: "https://gitee.com 平台账号的登录用户名，用于本次克隆认证。",
          groupId: "legacy-password-form",
          groupTitle: "提供Gitee HTTPS认证凭据",
          submittedAt: "2026-08-24T00:00:00.000Z",
        },
        GIT_HTTP_CREDENTIAL: {
          key: "GIT_HTTP_CREDENTIAL",
          label: "Gitee密码或个人访问令牌",
          description: "https://gitee.com 平台账号的密码，或具有该仓库读取权限的个人访问令牌。",
          groupId: "legacy-password-form",
          groupTitle: "提供Gitee HTTPS认证凭据",
          submittedAt: "2026-08-24T00:00:00.000Z",
        },
      },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }]));
    setActivePinia(createPinia());
    vi.mocked(backend.loadCredential).mockImplementation(async (kind, id) => {
      if (kind !== "secret") return null;
      if (id === "srv-production-01::GIT_USERNAME") return "480786136@qq.com";
      if (id === "srv-production-01::GIT_HTTP_CREDENTIAL") return "valid-password";
      return null;
    });
    const store = useOpsStore();

    await store.hydrateCredentials();

    const group = store.secretMetadata.filter(({ credentialGroupId }) => (
      credentialGroupId === "credential-legacy-password-form"
    ));
    expect(group).toHaveLength(2);
    expect(group.map(({ credentialRole }) => credentialRole).sort()).toEqual(["secret", "username"]);
    expect(group.every(({ credentialKind }) => credentialKind === "git-https")).toBe(true);
    expect(group.every(({ credentialTarget }) => credentialTarget === "gitee.com")).toBe(true);
    expect(localStorage.getItem("opsark.secretMetadata")).not.toContain("480786136@qq.com");
    expect(localStorage.getItem("opsark.tasks")).not.toContain("480786136@qq.com");
  });

  it("用户输入凭据写入钥匙串失败时保留输入卡且不生成虚假元数据", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "credential-input-step",
      title: "获取 Git 凭据",
      command: 'opsark-tool user.request_input {"title":"Gitee HTTPS 凭据","fields":[{"key":"gitUsername","label":"Gitee 登录名","description":"用于 gitee.com 的 HTTPS Git 认证","type":"text","required":true},{"key":"GIT_HTTP_CREDENTIAL","label":"Gitee 令牌","description":"用于 gitee.com 私有仓库的密码或访问令牌","type":"password","required":true}]}',
      validation: "true",
    }];
    await store.runStep(task.id, "credential-input-step");
    vi.mocked(backend.saveCredential)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("钥匙串已锁定"));

    const submitted = await store.provideUserInput(task.id, {
      gitUsername: "developer@example.com",
      GIT_HTTP_CREDENTIAL: "valid-token",
    });

    expect(submitted).toBe(false);
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingUserInputs).toHaveLength(1);
    expect(store.pendingUserInputs[0].error).toContain("钥匙串已锁定");
    expect(store.secretMetadata.some(({ key }) => key === "GIT_HTTP_CREDENTIAL")).toBe(false);
    expect(store.getServerSecretValues(task.serverId).GIT_HTTP_CREDENTIAL).toBeUndefined();
    expect(task.submittedInputs?.gitUsername).toBeUndefined();
    expect(task.submittedSecretBindings?.GIT_HTTP_CREDENTIAL).toBeUndefined();
    expect(backend.deleteCredential).toHaveBeenCalledWith(
      "secret",
      `${task.serverId}::GIT_USERNAME`,
    );
  });

  it.skip("通过当前可见终端执行 SSH 跳转，不创建后台连接", async () => {
    const store = useOpsStore();
    store.serverPasswords["srv-production-01"] = "source-password";
    store.setServerSecretValue("srv-production-01", "SSH_PASSWORD", "target-password");
    const terminalSessions = useTerminalSessionStore();
    const jump = vi.spyOn(terminalSessions, "requestAgentPtySshJump").mockResolvedValue({
      output: "SSH 登录成功",
      success: true,
      simulated: false,
      exitCode: 0,
      emptyResult: false,
    });

    const result = await store.executeToolCall("srv-production-01", {
      id: "native-connect",
      toolId: "server.connect",
      arguments: {
        host: "192.168.1.23",
        port: 22,
        username: "root",
        passwordSecretKey: "SSH_PASSWORD",
      },
    }, undefined, "pane-current");

    expect(result.success).toBe(true);
    const target = store.servers.find((server) => server.host === "192.168.1.23")!;
    expect(jump).toHaveBeenCalledWith("pane-current", "native-connect", {
      host: "192.168.1.23", port: 22, username: "root",
    }, "target-password");
    expect(store.connectedServerIds).not.toContain(target.id);
    expect(backend.executeCommand).not.toHaveBeenCalledWith(expect.stringContaining("sshpass"), expect.anything(), expect.anything());
    expect(JSON.stringify(result.data)).not.toContain("target-password");
    expect(JSON.stringify(store.logs)).not.toContain("target-password");
  });

  it.skip("按目标服务器作用域解析钥匙串凭据并通过引用完成终端跳转", async () => {
    const store = useOpsStore();
    store.serverPasswords["srv-production-01"] = "source-password";
    const target = store.addServer({
      name: "目标服务器",
      host: "10.0.0.23",
      port: 2222,
      username: "target-user",
      group: "测试",
    });
    store.serverPasswords[target.id] = "target-password";
    const terminalSessions = useTerminalSessionStore();
    const jump = vi.spyOn(terminalSessions, "requestAgentPtySshJump").mockResolvedValue({
      output: "SSH 登录成功", success: true, simulated: false, exitCode: 0, emptyResult: false,
    });

    const lookup = await store.executeToolCall("srv-production-01", {
      id: "lookup-target",
      toolId: "server.resolve_connection",
      arguments: { host: "10.0.0.23", port: 2222 },
    });
    expect(lookup.data).toMatchObject({
      username: "target-user",
      credentialAvailable: true,
      credentialRef: `managed-server:${target.id}`,
    });

    const connected = await store.executeToolCall("srv-production-01", {
      id: "connect-target-ref",
      toolId: "server.connect",
      arguments: { host: "10.0.0.23", port: 2222, credentialRef: `managed-server:${target.id}` },
    }, undefined, "pane-current");
    expect(connected.success).toBe(true);
    expect(jump).toHaveBeenCalledWith("pane-current", "connect-target-ref", {
      host: "10.0.0.23", port: 2222, username: "target-user",
    }, "target-password");
    expect(JSON.stringify({ lookup, connected })).not.toContain("target-password");
  });

  it.skip("新任务可通过服务器凭据组引用复用 SSH 用户名和密码", async () => {
    const store = useOpsStore();
    store.serverPasswords["srv-production-01"] = "source-password";
    const common = {
      scope: "server" as const,
      serverId: "srv-production-01",
      credentialGroupId: "ssh-jump-target",
      credentialKind: "ssh-password" as const,
      credentialTarget: "10.0.0.24",
      credentialLabel: "运维跳板目标",
    };
    store.secretMetadata.push(
      { ...common, key: "TARGET_SSH_USERNAME", description: "SSH 用户名", credentialRole: "username" },
      { ...common, key: "TARGET_SSH_PASSWORD", description: "SSH 密码", credentialRole: "secret" },
    );
    store.setServerSecretValue("srv-production-01", "TARGET_SSH_USERNAME", "deploy-user");
    store.setServerSecretValue("srv-production-01", "TARGET_SSH_PASSWORD", "target-password");
    const terminalSessions = useTerminalSessionStore();
    const jump = vi.spyOn(terminalSessions, "requestAgentPtySshJump").mockResolvedValue({
      output: "SSH 登录成功", success: true, simulated: false, exitCode: 0, emptyResult: false,
    });

    const lookup = await store.executeToolCall("srv-production-01", {
      id: "lookup-group-target",
      toolId: "server.resolve_connection",
      arguments: { host: "10.0.0.24", port: 22 },
    });
    expect(lookup.data).toMatchObject({
      found: true,
      credentialAvailable: true,
      credentialRef: "server-credential:ssh-jump-target",
    });
    expect((lookup.data as { username?: string }).username).toBeUndefined();

    const connected = await store.executeToolCall("srv-production-01", {
      id: "connect-group-target",
      toolId: "server.connect",
      arguments: { host: "10.0.0.24", port: 22, credentialRef: "server-credential:ssh-jump-target" },
    }, undefined, "pane-current");
    expect(connected.success).toBe(true);
    expect(jump).toHaveBeenCalledWith("pane-current", "connect-group-target", {
      host: "10.0.0.24", port: 22, username: "deploy-user",
    }, "target-password");
    expect(connected.data).toMatchObject({ username: "${secret.TARGET_SSH_USERNAME}" });
    expect(JSON.stringify({ lookup, connected })).not.toContain("deploy-user");
    expect(JSON.stringify({ lookup, connected })).not.toContain("target-password");
    expect(store.servers.some(({ username }) => username === "deploy-user")).toBe(false);
  });

  it("文件结构工具结果会作为真实证据生成后续部署计划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    store.serverPasswords[task.serverId] = "test-password";
    store.pushMessage(task, { role: "user", kind: "message", content: "部署 /opt/app 项目" });
    task.status = "running";
    task.executionConstraints = {
      changePolicy: "requested_changes_only",
      environmentPolicy: "preserve",
      failurePolicy: "strict",
      prohibitedActions: [],
      requiredConditions: [],
      userDirectives: [],
    };
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "discovery-tool-step",
      title: "获取项目文件结构",
      command: 'opsark-tool files.get_structure {"rootPath":"/opt/app"}',
      validation: "true",
    }];

    await store.runStep(task.id, "discovery-tool-step");

    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    const runtimeModel = vi.mocked(backend.generatePlan).mock.calls[0][1]!;
    const continuationContext = JSON.parse(runtimeModel.context);
    expect(JSON.stringify(continuationContext.completedDiscovery)).toContain("package.json");
    expect(continuationContext.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "files.get_structure" }),
    ]));
    expect(task.discoveryRefined).toBe(true);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan.length).toBeGreaterThan(1);
  });

  it("远程命令 30 秒进行模型复核但仍等待真实退出后才正式校验", async () => {
    vi.useFakeTimers();
    try {
      const store = useOpsStore();
      const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
      const cancelCommand = vi.spyOn(backend, "cancelCommand");

      const running = store.runStep(task.id, "long-running-service");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(backend.validateStep).not.toHaveBeenCalled();
      expect(backend.reviewStep).toHaveBeenCalledTimes(1);
      expect(cancelCommand).not.toHaveBeenCalled();
      expect(task.plan[0].progressMessage).toContain("完成后才会进行后置校验");
      expect(task.messages.some(({ content }) => content.includes("第 1 次长任务复核建议继续等待"))).toBe(true);

      finishExecution({
        output: "$ docker run\nservice ready\n[exit: 0]",
        success: true,
        simulated: false,
        exitCode: 0,
      });
      await vi.advanceTimersByTimeAsync(500);
      await running;

      expect(backend.validateStep).toHaveBeenCalledTimes(1);
      expect(backend.reviewStep).toHaveBeenCalledTimes(1);
      expect(cancelCommand).not.toHaveBeenCalled();
      expect(task.plan[0].status).toBe("completed");
      expect(task.status).toBe("completed");
      expect(task.currentExecutionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip("完全托管模式的普通命令连续无进展时自动生成调整计划", async () => {
    vi.useFakeTimers();
    try {
      const store = useOpsStore();
      const task = store.createTask("srv-production-01", "managed", "model-deepseek");
      store.serverPasswords[task.serverId] = "test-password";
      task.status = "running";
      task.plan = [{
        ...structuredClone(plan[0]),
        id: "stalled-read-only-check",
        title: "检查构建环境",
        command: "java -version; npm --version",
        validation: "true",
      }];
      let finishExecution!: (value: {
        output: string;
        success: boolean;
        simulated: boolean;
        exitCode: number;
      }) => void;
      vi.mocked(backend.executeCommand).mockImplementationOnce(() => new Promise((resolve) => {
        finishExecution = resolve;
      }));
      vi.spyOn(backend, "cancelCommand").mockImplementationOnce(async () => {
        finishExecution({
          output: "node v22\n[exit: 130]",
          success: false,
          simulated: false,
          exitCode: 130,
        });
      });
      vi.mocked(backend.generatePlan).mockResolvedValueOnce([{
        ...structuredClone(plan[0]),
        id: "bounded-version-check",
        title: "分别检查工具版本",
        command: "timeout 10 java -version",
        validation: "true",
        status: "pending",
      }]);

      const running = store.runStep(task.id, "stalled-read-only-check");
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await running;

      expect(backend.cancelCommand).toHaveBeenCalledOnce();
      expect(task.phaseHistory?.[0]?.plan[0]).toMatchObject({
        status: "failed",
        result: {
          executionStatus: "failed",
          observationStatus: "unknown",
          facts: { stoppedByPeriodicReview: true },
        },
      });
      expect(task.status).toBe("completed");
      expect(task.plan[0].id).toBe("bounded-version-check");
      expect(task.plan[0].status).toBe("completed");
      expect(task.messages.some(({ content }) => content.includes("当前命令疑似卡住"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["observe", "safe"] as const)(
    "%s 模式的长任务调整决定只暂停并等待用户生成方案",
    async (permission) => {
      vi.useFakeTimers();
      try {
        const store = useOpsStore();
        const task = store.createTask("srv-production-01", permission, "model-deepseek");
        store.serverPasswords[task.serverId] = "test-password";
        task.status = "running";
        task.plan = [{
          ...structuredClone(plan[0]),
          id: `stalled-${permission}`,
          title: "检查构建环境",
          command: "java -version; npm --version",
          validation: "true",
        }];
        let finishExecution!: (value: {
          output: string;
          success: boolean;
          simulated: boolean;
          exitCode: number;
        }) => void;
        vi.mocked(backend.executeCommand).mockImplementationOnce(() => new Promise((resolve) => {
          finishExecution = resolve;
        }));
        vi.spyOn(backend, "cancelCommand").mockImplementationOnce(async () => {
          finishExecution({
            output: "node v22\n[exit: 130]",
            success: false,
            simulated: false,
            exitCode: 130,
          });
        });

        if (permission === "observe") {
          task.status = "awaiting_step_approval";
          task.plan[0].status = "awaiting_approval";
        }
        const running = permission === "observe"
          ? store.approveStep(task.id, `stalled-${permission}`)
          : store.runStep(task.id, `stalled-${permission}`);
        await vi.advanceTimersByTimeAsync(60_000);
        await running;

        expect(backend.cancelCommand).toHaveBeenCalledOnce();
        expect(task.status).toBe("needs_adjustment");
        expect(task.plan[0].status).toBe("failed");
        expect(task.plan[0].result?.facts.stoppedByPeriodicReview).toBe(true);
        expect(backend.generatePlan).not.toHaveBeenCalled();
        expect(task.messages.some(({ content }) => content.includes("不会自动调用模型"))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("终止业务会取消当前执行并跳过活动步骤", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.currentExecutionId = "exec-running";
    task.plan = [{ ...structuredClone(plan[0]), status: "running" }];

    await store.terminateTask(task.id);

    expect(task.status).toBe("cancelled");
    expect(task.plan[0].status).toBe("skipped");
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "cancelled",
      facts: { cancelled: true },
      failureReason: "用户终止",
    });
    expect(task.summary).toContain("用户终止");
  });

  it.skip("终止绑定 PTY 时等待真实结束，超时则隔离且保留命令槽位", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.currentExecutionId = "exec-terminate-pty";
    task.plan = [{ ...structuredClone(plan[0]), status: "running" }];
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const cancelCommand = vi.spyOn(backend, "cancelCommand");
    const command = terminalSessions.requestAgentPtyCommand(
      paneId,
      task.currentExecutionId,
      "sleep 600",
    );

    const terminating = store.terminateTask(task.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await terminating;
    await expect(command).resolves.toMatchObject({ terminalReleased: false, interrupted: true });

    expect(task.status).toBe("cancelled");
    expect(terminalSessions.agentRecoveryByPane[paneId]).toBe(1);
    expect(terminalSessions.agentCommandByPane[paneId]?.id).toBe("exec-terminate-pty");
    await expect(terminalSessions.requestAgentPtyCommand(paneId, "exec-too-early", "echo unsafe"))
      .rejects.toThrow("当前终端已有智能命令在执行");
    expect(task.messages.some(({ content }) => content.includes("已隔离该 PTY"))).toBe(true);
    expect(cancelCommand).not.toHaveBeenCalled();

    terminalSessions.releaseAgentPtyCommandAfterRecovery(paneId, "exec-terminate-pty");
  });

  it("远程执行抛出异常时会清理执行 ID 并写入失败结果", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{ ...structuredClone(plan[0]), id: "execution-error" }];
    vi.mocked(backend.executeCommand).mockRejectedValueOnce(new Error("connection closed"));

    await store.runStep(task.id, "execution-error");

    expect(task.currentExecutionId).toBeUndefined();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].result?.facts.category).toBe("terminal_transport");
    expect(task.adjustmentCount).toBe(0);
    expect(task.adjustmentIncident?.kind).toBe("transport");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it.skip("同一终端 generation 连续出现相同 transport failure 时最多自动重放一次", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{ ...structuredClone(plan[0]), id: "repeat-transport" }];
    store.serverPasswords[task.serverId] = "test-password";
    store.connectedServerIds.push(task.serverId);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    const executeInPty = vi.spyOn(terminalSessions, "requestAgentPtyCommand")
      .mockRejectedValue(new Error("connection closed"));

    await store.runStep(task.id, "repeat-transport");

    expect(executeInPty).toHaveBeenCalledTimes(2);
    expect(terminalSessions.terminalGenerationByPane[paneId]).toBe(1);
    expect(task.transportRecovery).toMatchObject({ replayCount: 1 });
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("已自动重放过一次");
    expect(task.adjustmentCount).toBe(0);
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("终端恢复入口不会把业务失败交给模型自动重拟", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{
      ...structuredClone(plan[0]),
      status: "failed",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { category: "command_failed", commandCompleted: true },
        warnings: [],
        evidenceIds: [],
        failureReason: "业务命令返回非零退出码",
      },
    }];

    await store.routeAutomaticAdjustment(task.id, { transportRecovery: true });

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("终端恢复入口未检测到");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it.skip("终端状态不确定的恢复事件只收口一次且清理旧 incident", async () => {
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{
      ...structuredClone(plan[0]),
      status: "failed",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { category: "terminal_recovery", commandCompleted: true },
        warnings: [],
        evidenceIds: [],
        failureReason: "旧 PTY 未返回结束标记",
      },
    }];
    store.connectedServerIds.push(task.serverId);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");

    await Promise.all(Array.from({ length: 12 }, () => store.requestAdjustment(task.id, true)));

    expect(task.messages.filter(({ content }) => content.includes("无法确定原命令是否产生副作用")))
      .toHaveLength(1);
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.lastAdjustmentBlocker).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("相同阻塞事件无新证据时只生成一次调整计划", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    const failedPlan = [{
      ...structuredClone(plan[0]),
      status: "failed" as const,
      result: {
        executionStatus: "failed" as const,
        observationStatus: "unknown" as const,
        facts: { category: "command_failed", commandCompleted: false },
        warnings: [],
        evidenceIds: [],
        failureReason: "same blocker",
      },
    }];
    task.plan = structuredClone(failedPlan);

    await store.adjustTask(task.id);
    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    task.plan = structuredClone(failedPlan);
    task.status = "needs_adjustment";
    task.pauseReason = "same blocker after 60 seconds";
    await store.adjustTask(task.id);

    expect(task.status).toBe("failed");
    expect(task.summary).toContain("相同阻塞事件");
    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
  });

  it.skip("真实终端重连使 generation 单调递增并为相同业务阻塞开启新 incident", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const terminalSessions = useTerminalSessionStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    const failedPlan = [{
      ...structuredClone(plan[0]),
      status: "failed" as const,
      result: {
        executionStatus: "failed" as const,
        observationStatus: "unknown" as const,
        facts: { category: "command_failed", commandCompleted: false },
        warnings: [],
        evidenceIds: [],
        failureReason: "same business blocker",
      },
    }];
    task.status = "needs_adjustment";
    task.plan = structuredClone(failedPlan);
    terminalSessions.ensureWorkspace(task.serverId);
    const paneId = terminalSessions.bindAgentTask(task.serverId, task.id)!;
    terminalSessions.setPaneStatus(paneId, "connected");
    vi.mocked(backend.generatePlan)
      .mockResolvedValueOnce([{ ...structuredClone(plan[1]), id: "retry-generation-1", status: "pending" }])
      .mockResolvedValueOnce([{ ...structuredClone(plan[1]), id: "retry-generation-2", status: "pending" }]);

    await store.requestAdjustment(task.id, true);
    const firstFingerprint = task.adjustmentIncident?.fingerprint;
    expect(terminalSessions.terminalGenerationByPane[paneId]).toBe(1);

    const staleCommand = terminalSessions.requestAgentPtyCommand(paneId, "exec-recovery-generation", "sleep 600");
    const interrupted = terminalSessions.interruptAgentPtyCommandAndWait(paneId, "exec-recovery-generation", 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(interrupted).resolves.toMatchObject({ terminalReleased: false });
    await expect(staleCommand).resolves.toMatchObject({ terminalReleased: false });
    expect(terminalSessions.agentRecoveryByPane[paneId]).toBe(1);
    terminalSessions.setPaneStatus(paneId, "reconnecting");
    terminalSessions.setPaneStatus(paneId, "connected");
    terminalSessions.releaseAgentPtyCommandAfterRecovery(paneId, "exec-recovery-generation");
    expect(terminalSessions.agentRecoveryByPane[paneId]).toBeUndefined();

    task.status = "needs_adjustment";
    task.plan = structuredClone(failedPlan);
    task.pauseReason = "same business blocker";
    await store.requestAdjustment(task.id, true);

    expect(terminalSessions.terminalGenerationByPane[paneId]).toBe(2);
    expect(task.adjustmentIncident?.fingerprint).not.toBe(firstFingerprint);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(backend.generatePlan).toHaveBeenCalledTimes(2);
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
    expect(task.pauseReason).toContain("可生成调整方案");
    expect(task.plan[0].review?.summary).toContain("HTTP 虽返回 200");
  });

  it("已完成阶段的后续计划失败时不否定成功证据", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{ ...structuredClone(plan[0]), status: "completed" }];
    vi.mocked(backend.generatePlan).mockRejectedValueOnce(new Error("第 12 个计划步骤掩盖退出码"));

    await store.adjustTask(task.id);

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("completed");
    expect(task.pauseReason).toContain("已成功完成，证据保持有效");
    expect(task.pauseReason).toContain("整体目标尚未完成");
  });

  it("完全托管在五秒后自动发起调整", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{ ...structuredClone(plan[0]), status: "failed" }];
    const requestAdjustment = vi.spyOn(store, "requestAdjustment").mockResolvedValue();

    const countdown = store.queueManagedAdjustment(task.id, 5);
    expect(task.autoAdjustmentSeconds).toBe(5);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requestAdjustment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await countdown;

    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(requestAdjustment).toHaveBeenCalledWith(task.id, true);
  });

  it("完全托管在调整内部再次续接时复用同一调度器且不吞掉下一轮", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "awaiting_continuation";
    let rounds = 0;
    const requestAdjustment = vi.spyOn(store, "requestAdjustment").mockImplementation(async () => {
      rounds += 1;
      if (rounds === 1) {
        task.status = "awaiting_continuation";
        void store.queueManagedAdjustment(task.id, 1);
      } else {
        task.status = "completed";
      }
    });

    const scheduled = store.queueManagedAdjustment(task.id, 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await scheduled;

    expect(requestAdjustment).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("completed");
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(task.managedAdjustmentPhase).toBeUndefined();
  });

  it("完全托管倒计时结束后在凭据加载期间保持调整进行状态", async () => {
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{
      ...structuredClone(plan[0]),
      status: "failed",
      result: {
        executionStatus: "failed",
        observationStatus: "unknown",
        facts: { category: "command_failed", commandCompleted: true },
        warnings: [],
        evidenceIds: [],
        failureReason: "依赖安装失败",
      },
    }];
    let releaseCredentialLoad!: () => void;
    const credentialLoad = new Promise<null>((resolve) => {
      releaseCredentialLoad = () => resolve(null);
    });
    vi.mocked(backend.loadCredential).mockImplementation((kind) => (
      kind === "server" ? credentialLoad : Promise.resolve(null)
    ));
    vi.mocked(backend.generatePlan).mockRejectedValueOnce(new Error("测试结束调整生成"));

    const countdown = store.queueManagedAdjustment(task.id, 5);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(task.adjustmentInProgress).toBe(true);
    expect(task.status).toBe("needs_adjustment");

    releaseCredentialLoad();
    await countdown;

    expect(task.adjustmentInProgress).toBe(false);
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("调整计划生成失败");
  });

  it("完全托管自动批准调整计划，但在高风险步骤前暂停", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{ ...structuredClone(plan[0]), status: "failed" }];
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([{
      ...structuredClone(plan[1]),
      id: "adjusted-high-risk",
      title: "执行高风险调整",
      command: "systemctl restart production-app",
      risk: "high",
      status: "pending",
    }]);

    await store.adjustTask(task.id);

    expect(task.status).toBe("awaiting_step_approval");
    expect(task.plan.find((step) => step.id === "adjusted-high-risk")?.status).toBe("awaiting_approval");
    expect(task.messages.some((message) => message.content.includes("自动批准并继续"))).toBe(true);
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
    expect(task.messages.some((message) => message.content.includes("新的人工调整事件"))).toBe(true);
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
    store.pendingSecret = {
      taskId: removed.id,
      stepId: "step",
      key: "PASSWORD",
      label: "数据库登录密码",
      description: "用于连接数据库",
      unlockDescription: "提交后继续当前步骤",
    };

    expect(store.deleteTask(removed.id)).toBe(true);

    expect(store.tasks.map((item) => item.id)).toEqual([retained.id]);
    expect(store.activeTaskId).toBe(retained.id);
    expect(store.pendingSecret).toBeNull();
    expect(JSON.parse(localStorage.getItem("opsark.tasks") ?? "[]")).toHaveLength(1);
  });

  it("正在规划或执行的任务必须先终止，不能直接删除", () => {
    const store = useOpsStore();
    const running = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    expect(store.needsApproval("managed", highRisk)).toBe(true);
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

  it("完全托管模式对所有高风险步骤要求确认", () => {
    const store = useOpsStore();
    expect(store.needsApproval("managed", {
      ...plan[0],
      risk: "high",
      command: "cd /opt/O2OA && mvn clean install -DskipTests",
    })).toBe(true);
    expect(store.needsApproval("managed", {
      ...plan[0],
      risk: "high",
      command: "DROP DATABASE ffp",
    })).toBe(true);
  });

  it("高风险步骤只有单独批准后才携带后端放行标记", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.rootGoal = "删除 /tmp/explicit-target";
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

  it("高风险步骤先完成确定性修复，再展示最终命令等待单独批准", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "awaiting_plan_approval";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "repair-before-high-risk-approval",
      risk: "high",
      command: "deploy production || { echo failed; exit 0; }",
      validation: "test -f /tmp/deploy-result",
    }];

    await store.approvePlan(task.id, true);

    expect(task.status).toBe("awaiting_step_approval");
    expect(task.plan[0].status).toBe("awaiting_approval");
    expect(task.plan[0].command).toContain("__opsark_preserved_failure_status=$?");
    expect(task.plan[0].command).not.toContain("exit 0");
    expect(task.plan[0].safetyApprovalSnapshot).toEqual(expect.objectContaining({
      risk: "high",
      command: task.plan[0].command,
      validation: task.plan[0].validation,
    }));
    expect(task.plan[0].approvedSafetySnapshot).toBeUndefined();
    expect(backend.executeCommand).not.toHaveBeenCalled();

    await store.approveStep(task.id, task.plan[0].id);

    expect(backend.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("__opsark_preserved_failure_status=$?"),
      undefined,
      true,
      expect.objectContaining({ executionId: expect.any(String) }),
    );
  });

  it("高风险步骤批准后模板变化会立即使旧批准失效", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    const approvedCommand = "release-tool publish production";
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "stale-high-risk-approval",
      risk: "high",
      command: `${approvedCommand} --changed`,
      status: "awaiting_approval",
      safetyApprovalSnapshot: {
        risk: "high",
        command: approvedCommand,
        validation: plan[0].validation,
      },
      approvedSafetySnapshot: {
        risk: "high",
        command: approvedCommand,
        validation: plan[0].validation,
      },
    }];

    await store.runStep(task.id, task.plan[0].id);

    expect(task.status).toBe("awaiting_step_approval");
    expect(task.plan[0].status).toBe("awaiting_approval");
    expect(task.plan[0].safetyApprovalSnapshot).toBeUndefined();
    expect(task.plan[0].approvedSafetySnapshot).toBeUndefined();
    expect(task.messages.some(({ content }) => content.includes("原批准已失效"))).toBe(true);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
  });

  it("高风险步骤批准后可以等待敏感输入并恢复执行", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "awaiting_plan_approval";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "approved-secret-step",
      risk: "high",
      command: "deploy --token ${secret.DEPLOY_TOKEN}",
    }];

    await store.approvePlan(task.id);
    await store.approveStep(task.id, "approved-secret-step");

    expect(task.status).toBe("awaiting_input");
    expect(task.plan[0].status).toBe("awaiting_input");
    expect(store.pendingSecret?.key).toBe("DEPLOY_TOKEN");

    await store.provideSecret("temporary-deploy-token");

    expect(task.status).toBe("completed");
    expect(task.plan[0].status).toBe("completed");
    expect(backend.executeCommand).toHaveBeenCalledWith(
      "deploy --token temporary-deploy-token",
      undefined,
      true,
      expect.objectContaining({ executionId: expect.any(String) }),
    );
  });

  it("单变量敏感输入写入钥匙串失败时保留输入请求且不生成虚假凭据", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "secret-persistence-failure",
      command: "deploy --token ${secret.DEPLOY_TOKEN}",
    }];

    await store.runStep(task.id, "secret-persistence-failure");
    vi.mocked(backend.saveCredential).mockRejectedValueOnce(new Error("钥匙串已锁定"));

    const submitted = await store.provideSecret("temporary-deploy-token");

    expect(submitted).toBe(false);
    expect(task.status).toBe("awaiting_input");
    expect(task.plan[0].status).toBe("awaiting_input");
    expect(store.pendingSecret).toMatchObject({
      key: "DEPLOY_TOKEN",
      error: expect.stringContaining("钥匙串已锁定"),
    });
    expect(store.getServerSecretValues(task.serverId).DEPLOY_TOKEN).toBeUndefined();
    expect(store.secretMetadata.some(({ key, serverId }) => key === "DEPLOY_TOKEN" && serverId === task.serverId)).toBe(false);
    expect(task.confirmedSecretKeys).not.toContain("DEPLOY_TOKEN");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("工具命令解析失败时写入稳定失败结果", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "invalid-tool-step",
      command: "opsark-tool files.get_structure []",
    }];

    await store.runStep(task.id, "invalid-tool-step");

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].result).toMatchObject({
      executionStatus: "failed",
      facts: { category: "tool_command_parse" },
    });
    expect(task.pauseReason).toContain("工具命令解析失败");
  });

  it("敏感变量缺失时暂停输入，合并执行后对终端和日志脱敏", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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

  it("新任务直接复用当前服务器已持久化的用途匹配敏感变量", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "reuse-server-secret-step",
      title: "连接 MySQL 数据库",
      description: "使用已保存的 MySQL 管理员密码执行查询",
      command: "mysql -uroot -p${secret.MYSQL_ROOT_PASSWORD} -e 'select 1'",
      validation: "mysqladmin ping",
    }];
    store.secretMetadata.push({
      key: "MYSQL_ROOT_PASSWORD",
      description: "用于当前服务器 MySQL root 账号认证",
      scope: "server",
      serverId: task.serverId,
    });
    store.setServerSecretValue(task.serverId, "MYSQL_ROOT_PASSWORD", "saved-database-password");

    await store.runStep(task.id, "reuse-server-secret-step");

    expect(task.status).toBe("completed");
    expect(store.pendingSecret).toBeNull();
    expect(backend.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("saved-database-password"),
      undefined,
      false,
      expect.anything(),
    );
    expect(JSON.stringify(store.logs)).not.toContain("saved-database-password");
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
    expect(backend.saveCredential).toHaveBeenCalledWith(
      "secret",
      "srv-tencent-test::DB_PASSWORD",
      "remembered-db-password",
    );
  });

  it("凭据未完整加载时不标记恢复完成且禁止空值删除钥匙串数据", async () => {
    vi.mocked(backend.loadCredential).mockImplementation(async (kind, id) => {
      if (kind === "secret" && id === "srv-tencent-test::DB_PASSWORD") {
        throw new Error("钥匙串读取失败");
      }
      return null;
    });
    const store = useOpsStore();

    await store.hydrateCredentials();

    expect(store.credentialsHydrated).toBe(false);
    expect(store.credentialsLoading).toBe(false);
    expect(store.credentialError).toContain("钥匙串读取失败");

    await expect(store.saveSecretSettings()).rejects.toThrow("钥匙串读取失败");
    expect(backend.deleteCredential).not.toHaveBeenCalledWith(
      "secret",
      "srv-tencent-test::DB_PASSWORD",
    );
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
    store.setServerSecretValue("srv-tencent-test", "DB_PASSWORD", "current-real-value");

    await store.saveSecretSettings();
    expect(backend.saveCredential).toHaveBeenCalledWith("secret", "srv-tencent-test::DB_PASSWORD", "current-real-value");

    expect(await store.renameSecretMetadata("DB_PASSWORD", "MYSQL_ROOT_PASSWORD", "srv-tencent-test")).toBe(true);
    expect(store.secretMetadata.some((item) => item.key === "MYSQL_ROOT_PASSWORD")).toBe(true);
    expect(store.getServerSecretValues("srv-tencent-test").MYSQL_ROOT_PASSWORD).toBe("current-real-value");
    expect(store.getServerSecretValues("srv-tencent-test").DB_PASSWORD).toBeUndefined();
    expect(backend.saveCredential).toHaveBeenCalledWith("secret", "srv-tencent-test::MYSQL_ROOT_PASSWORD", "current-real-value");
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", "srv-tencent-test::DB_PASSWORD");

    await store.removeSecretMetadata("MYSQL_ROOT_PASSWORD", "srv-tencent-test");
    expect(store.secretMetadata.some((item) => item.key === "MYSQL_ROOT_PASSWORD")).toBe(false);
    expect(store.getServerSecretValues("srv-tencent-test").MYSQL_ROOT_PASSWORD).toBeUndefined();
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", "srv-tencent-test::MYSQL_ROOT_PASSWORD");
  });

  it("删除凭据组任一字段时会同时删除钥匙串中的用户名和令牌", async () => {
    const store = useOpsStore();
    const common = {
      scope: "server" as const,
      serverId: "srv-production-01",
      credentialGroupId: "gitee-delete",
      credentialKind: "git-https" as const,
      credentialTarget: "gitee.com",
      credentialLabel: "Gitee 凭据",
    };
    store.secretMetadata.push(
      { ...common, key: "GIT_USERNAME", description: "Gitee 用户名", credentialRole: "username" },
      { ...common, key: "GIT_HTTP_CREDENTIAL", description: "Gitee 令牌", credentialRole: "secret" },
    );
    store.setServerSecretValue(common.serverId, "GIT_USERNAME", "developer");
    store.setServerSecretValue(common.serverId, "GIT_HTTP_CREDENTIAL", "token");

    await store.removeSecretMetadata("GIT_HTTP_CREDENTIAL", common.serverId);

    expect(store.secretMetadata.some(({ credentialGroupId }) => credentialGroupId === "gitee-delete")).toBe(false);
    expect(store.getServerSecretValues(common.serverId).GIT_USERNAME).toBeUndefined();
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", `${common.serverId}::GIT_USERNAME`);
    expect(backend.deleteCredential).toHaveBeenCalledWith("secret", `${common.serverId}::GIT_HTTP_CREDENTIAL`);
  });

  it("同名敏感变量按服务器隔离", () => {
    const store = useOpsStore();
    store.addSecretMetadata("DEPLOY_TOKEN", "测试环境令牌", "test-token", "srv-tencent-test");
    store.addSecretMetadata("DEPLOY_TOKEN", "生产环境令牌", "prod-token", "srv-production-01");

    expect(store.getServerSecretValues("srv-tencent-test").DEPLOY_TOKEN).toBe("test-token");
    expect(store.getServerSecretValues("srv-production-01").DEPLOY_TOKEN).toBe("prod-token");
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
    expect(runtimeContext.knownExecutionFacts.completedSteps[0].result).toEqual(task.planHistory?.[0].plan[0].result);
    expect(runtimeContext.knownExecutionFacts.instruction).toContain("必须优先复用");
  });

  it("独立的新执行目标会创建新任务，不会覆盖原任务", async () => {
    const store = useOpsStore();
    const original = store.createTask("srv-production-01", "safe", "model-deepseek");
    original.rootGoal = "部署 office 项目";
    original.currentInstruction = original.rootGoal;
    original.title = original.rootGoal;
    original.status = "completed";
    original.plan = structuredClone(plan);
    store.pushMessage(original, { role: "user", kind: "message", content: original.rootGoal });
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      relation: "new_goal",
      plan: structuredClone(plan),
    });

    await store.submitRequirement(
      "srv-production-01",
      "检查 Redis 内存使用",
      "safe",
      "model-deepseek",
      "",
      original.id,
    );

    expect(store.tasks).toHaveLength(2);
    expect(original.rootGoal).toBe("部署 office 项目");
    expect(original.status).toBe("completed");
    expect(store.activeTask?.id).not.toBe(original.id);
    expect(store.activeTask?.rootGoal).toBe("检查 Redis 内存使用");
  });

  it("临时旁问只追加回答，不改变整体目标和原状态", async () => {
    const store = useOpsStore();
    const original = store.createTask("srv-production-01", "safe", "model-deepseek");
    original.rootGoal = "部署 office 项目";
    original.currentInstruction = original.rootGoal;
    original.status = "completed";
    original.plan = structuredClone(plan).map((step) => ({ ...step, status: "completed" }));
    original.summary = "office 项目部署完成";
    store.pushMessage(original, { role: "user", kind: "message", content: original.rootGoal });
    store.pushMessage(original, { role: "assistant", kind: "message", content: "已生成 3 个执行步骤" });
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "answer",
      relation: "side_question",
      answer: "Composer 是 PHP 的依赖管理工具。",
      plan: [],
    });

    await store.submitRequirement(
      "srv-production-01",
      "Composer 是做什么的？",
      "safe",
      "model-deepseek",
      "",
      original.id,
    );

    expect(store.tasks).toHaveLength(1);
    expect(original.status).toBe("completed");
    expect(original.rootGoal).toBe("部署 office 项目");
    expect(original.currentInstruction).toBe("Composer 是做什么的？");
    expect(original.plan).toEqual([]);
    expect(original.summary).toBeUndefined();
    expect(original.planHistory).toHaveLength(1);
    expect(original.planHistory?.[0]).toMatchObject({
      requirement: "部署 office 项目",
      summary: "office 项目部署完成",
    });
    expect(original.planHistory?.[0].plan).toHaveLength(3);
    expect(original.messages[original.messages.length - 1]?.content).toContain("PHP");
  });

  it("待调整任务的临时旁问保留待处理计划", async () => {
    const store = useOpsStore();
    const original = store.createTask("srv-production-01", "safe", "model-deepseek");
    original.rootGoal = "部署 office 项目";
    original.currentInstruction = original.rootGoal;
    original.status = "needs_adjustment";
    original.pauseReason = "构建步骤需要调整";
    original.plan = structuredClone(plan);
    store.pushMessage(original, { role: "user", kind: "message", content: original.rootGoal });
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "answer",
      relation: "side_question",
      answer: "8080 是当前计划准备使用的端口。",
      plan: [],
    });

    await store.submitRequirement(
      "srv-production-01",
      "计划准备使用哪个端口？",
      "safe",
      "model-deepseek",
      "",
      original.id,
    );

    expect(original.status).toBe("needs_adjustment");
    expect(original.plan).toHaveLength(3);
    expect(original.pauseReason).toBe("构建步骤需要调整");
    expect(original.planHistory).toHaveLength(0);
    expect(original.messages[original.messages.length - 1]?.content).toContain("8080");
  });

  it("当前计划完成但整体目标证据不足时不会错误标记任务完成", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      relation: "new_goal",
      plan: [structuredClone(plan[0])],
      selectedSkillIds: ["application-deployment"],
    });
    vi.mocked(backend.reviewGoal).mockResolvedValueOnce({
      decision: "adjust",
      reason: "只有源码检查证据",
      summary: "源码已就位，但运行配置、服务启动与端到端访问尚未验收。",
      source: "model",
    });

    await store.submitRequirement(
      "srv-production-01",
      "部署 office 项目",
      "managed",
      "model-deepseek",
    );

    expect(store.activeTask?.status).toBe("awaiting_continuation");
    expect(store.activeTask?.rootGoal).toBe("部署 office 项目");
    expect(store.activeTask?.summary).toBeUndefined();
    expect(store.activeTask?.pauseReason).toContain("端到端访问");
    store.rejectTask(store.activeTask!.id);
  });

  it("用户配置的 Skill 会持久化并进入模型可选目录", async () => {
    const store = useOpsStore();
    const skill = store.addSkill();
    skill.name = "内存专项分析";
    skill.description = "分析指定服务器的内存压力。";
    skill.matchRules = ["内存专项"];
    skill.instructions = "先采样内存指标，再定位进程，最后只输出基于证据的建议。";
    store.saveSkills();

    const persisted = JSON.parse(localStorage.getItem("opsark.skillConfiguration") ?? "{}");
    expect(persisted.customSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: skill.id, name: "内存专项分析" }),
    ]));

    await store.submitRequirement("srv-production-01", "执行内存专项检查", "safe", "model-deepseek");
    const runtimeContext = JSON.parse(vi.mocked(backend.processRequirement).mock.calls[0][1].context);
    expect(runtimeContext.skillDirectory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: skill.id, description: "分析指定服务器的内存压力。" }),
    ]));
    expect(runtimeContext.activeSkills).toEqual([]);
    expect(vi.mocked(backend.processRequirement).mock.calls[0][2]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: skill.id, instructions: expect.stringContaining("先采样内存指标") }),
    ]));
  });

  it("接受模型选择的多个 Skill 并联合激活", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      plan: structuredClone(plan),
      selectedSkillIds: ["project-source-acquisition", "project-build"],
    });

    await store.submitRequirement(
      "srv-production-01",
      "获取项目后进行构建",
      "safe",
      "model-deepseek",
    );

    expect(store.activeTask?.activeSkillIds).toEqual([
      "project-source-acquisition",
      "project-build",
    ]);
  });

  it("计划生成失败时保留模型已选 Skill 并记录具体错误", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      plan: [],
      selectedSkillIds: ["ssh-terminal-jump"],
      planError: "第 1 个计划步骤使用了无业务意义的 validation",
    });

    await store.submitRequirement(
      "srv-production-01",
      "ssh跳转到69.33.213.101",
      "safe",
      "model-deepseek",
    );

    expect(store.activeTask?.activeSkillIds).toEqual(["ssh-terminal-jump"]);
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.summary).toBeUndefined();
    expect(store.activeTask?.pauseReason).toContain("无业务意义的 validation");
    expect(store.activeTask?.pauseReason).toContain("整体目标");
    expect(store.activeTask?.autoAdjustmentSeconds).toBeUndefined();
    expect(store.activeTask?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "event",
        content: expect.stringContaining("已选择 Skill：终端 SSH 跳转"),
      }),
    ]));
    expect(store.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Skill 选择已保留，计划生成失败" }),
    ]));
  });

  it("同一目标重试时允许空选择清除上一轮误匹配的 Skill", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement)
      .mockResolvedValueOnce({
        intent: "execute",
        relation: "new_goal",
        plan: [],
        selectedSkillIds: ["ssh-terminal-jump"],
        planError: "validation 未通过安全检查",
      })
      .mockResolvedValueOnce({
        intent: "execute",
        relation: "continue",
        plan: [structuredClone(plan[0])],
        selectedSkillIds: [],
      });

    await store.submitRequirement(
      "srv-production-01",
      "检查为什么 VSCode 不能通过 40122 连接服务器",
      "safe",
      "model-deepseek",
    );
    const taskId = store.activeTask!.id;
    expect(store.activeTask?.activeSkillIds).toEqual(["ssh-terminal-jump"]);

    await store.submitRequirement(
      "srv-production-01",
      "继续检查这个连接问题",
      "safe",
      "model-deepseek",
      "",
      taskId,
    );

    const retryContext = JSON.parse(vi.mocked(backend.processRequirement).mock.calls[1][1].context);
    expect(retryContext.skillSelection.currentActiveSkillIds).toEqual(["ssh-terminal-jump"]);
    expect(store.activeTask?.id).toBe(taskId);
    expect(store.activeTask?.activeSkillIds).toEqual([]);
    expect(store.activeTask?.plan).toHaveLength(1);
    expect(store.activeTask?.planHistory?.[0].plan).toEqual([]);
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

  it("观察步骤直接使用主命令证据，不执行重复后置校验", async () => {
    const store = useOpsStore();
    vi.mocked(backend.processRequirement).mockResolvedValueOnce({
      intent: "execute",
      relation: "new_goal",
      operation: "inspect",
      effect: "read",
      selectedSkillIds: [],
      plan: [{
        id: "observe-service",
        kind: "observe",
        title: "检查服务状态",
        description: "只读获取当前状态",
        command: "systemctl status app.service --no-pager",
        expected: "获得当前服务状态",
        validation: "",
        risk: "low",
        status: "pending",
      }],
    });
    vi.mocked(backend.executeCommand).mockResolvedValueOnce({
      output: "active (running)",
      success: true,
      simulated: true,
      exitCode: 0,
    });

    await store.submitRequirement(
      "srv-production-01",
      "检查 app 服务是否运行",
      "managed",
      "model-deepseek",
    );

    expect(backend.validateStep).not.toHaveBeenCalled();
    expect(store.activeTask?.status).toBe("completed");
    expect(store.activeTask?.plan[0].evidence).toHaveLength(1);
    expect(store.activeTask?.plan[0].result?.facts.verificationMode).toBe("command_result");
    expect(store.activeTask?.messages.some((message) => message.content.includes("独立后置校验"))).toBe(false);
  });

  it("过滤 macOS shell integration 和 ANSI 控制序列", () => {
    const raw = "\u001b]1337;PreExecMarker;ps -ef\u0007\u001b[32mroot\u001b[0m\r\n";
    expect(sanitizeTerminalOutput(raw)).toBe("root\n");
  });

  it("校验命令会合并敏感变量，保存的输出仍保持脱敏", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [{
      ...structuredClone(plan[0]),
      id: "validation-secret-step",
      command: "mysql -p'${secret.DB_PASSWORD}' -e 'SELECT 1'",
      validation: "mysql -p'${secret.DB_PASSWORD}' -e 'SELECT 1' | grep -q 1",
    }];
    store.setServerSecretValue("srv-production-01", "DB_PASSWORD", "private-validation-value");
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
    expect(store.activeTask?.status).toBe("planning_failed");
    expect(store.activeTask?.plan).toHaveLength(0);
    expect(store.activeTask?.pauseReason).toContain("API Key 未恢复");
    expect(store.activeTask?.pauseReason).toContain("模型与设置");
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
      model: "test-model",
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

  it("会把误写成命令行选项的工具 ID 规范化为注册 ID", () => {
    const normalized = normalizePlanPreconditions([{
      ...structuredClone(plan[0]),
      command: 'opsark-tool --files.get_structure {"rootPath":"/opt/app"}',
      validation: "true",
    }]);

    expect(normalized[0].command).toBe('opsark-tool files.get_structure {"rootPath":"/opt/app"}');
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

  it("按工具 planMode 元数据保留独占步骤", () => {
    const connect = {
      ...structuredClone(plan[0]),
      id: "connect-target",
      command: 'opsark-tool server.connect {"host":"192.168.1.237","port":22,"username":"root","passwordSecretKey":"PASSWORD"}',
      validation: "true",
    };
    const sourceValidation = {
      ...structuredClone(plan[1]),
      id: "source-validation",
      command: "hostname && id && uptime",
      validation: "hostname",
    };

    expect(normalizePlanPreconditions([connect, sourceValidation])).toEqual([
      expect.objectContaining({ id: "connect-target" }),
    ]);
  });

  it("多阶段 Skill 续跑时保留已完成证据，只裁剪本轮待执行步骤", () => {
    const completedLookup = {
      ...structuredClone(plan[0]),
      id: "lookup-completed",
      status: "completed" as const,
      command: 'opsark-tool server.resolve_connection {"host":"192.168.1.237"}',
      validation: "true",
    };
    const connect = {
      ...structuredClone(plan[1]),
      id: "connect-pending",
      status: "pending" as const,
      command: 'opsark-tool server.connect {"host":"192.168.1.237","credentialRef":"managed-server:target"}',
      validation: "true",
    };
    const prematureValidation = { ...structuredClone(plan[2]), id: "validation-pending" };

    expect(normalizePlanPreconditions([completedLookup, connect, prematureValidation]).map((step) => step.id))
      .toEqual(["lookup-completed", "connect-pending"]);
  });

  it("包管理器命令保留实时输出和真实退出码", () => {
    expect(normalizeLongRunningCommandOutput("dnf install -y git 2>&1 | tail -20"))
      .toBe("dnf install -y git 2>&1");
    expect(normalizeLongRunningCommandOutput("sudo apt-get install -y git | tail -n 20"))
      .toBe("sudo apt-get install -y git");
    expect(normalizeLongRunningCommandOutput("journalctl -u app | tail -20"))
      .toBe("journalctl -u app | tail -20");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
      operation: "diagnose",
      effect: "read",
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
    task.status = "running";
    task.plan = [structuredClone(plan[0])];
    vi.mocked(backend.validateStep).mockResolvedValue({
      passed: false,
      exitCode: 1,
      detail: "独立校验未达到预期",
    });

    const running = store.runStep(task.id, task.plan[0].id);
    await vi.runAllTimersAsync();
    await running;

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(task.messages.some((message) =>
      message.content.includes("后置状态尚未稳定")
      && message.content.includes("有界窗口"),
    )).toBe(true);
    vi.useRealTimers();
  });

  it("后置校验失败且模型不可用时不会按兜底规则继续", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
      .mockResolvedValueOnce({ passed: false, exitCode: 1, detail: "nvm 状态尚未稳定" })
      .mockResolvedValueOnce({ passed: false, exitCode: 1, detail: "nvm 状态尚未稳定" })
      .mockResolvedValueOnce({ passed: false, exitCode: 1, detail: "nvm 状态尚未稳定" })
      .mockResolvedValueOnce({
        passed: true,
        exitCode: 0,
        detail: "nvm 已加载",
      });

    const running = store.runStep(task.id, "install-nvm");
    await vi.runAllTimersAsync();
    await running;

    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[1].status).toBe("completed");
    expect(task.status).toBe("completed");
    vi.useRealTimers();
  });

  it("模型不能覆盖后置校验中的确定性平台阻断", async () => {
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    vi.useFakeTimers();
    const store = useOpsStore();
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    vi.mocked(backend.validateStep).mockResolvedValue({
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

    const running = store.runStep(task.id, "network-probe");
    await vi.runAllTimersAsync();
    await running;

    expect(backend.validateStep).toHaveBeenCalledTimes(4);
    expect(backend.reviewStep).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].result?.executionStatus).toBe("success");
    expect(task.plan[0].result?.facts.evidenceConflict).toBe(true);
    expect(task.status).toBe("completed");
    expect(task.plan[0].output).toContain("首次未通过");
    expect(task.currentExecutionId).toBeUndefined();
    vi.useRealTimers();
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

  it("将空 SQL 备份识别为决定性不完整证据", () => {
    const step = ensureStepValidator({
      ...structuredClone(plan[0]),
      title: "检查 SQL 备份是否完整",
      description: "读取备份文件大小和内容状态",
      expected: "备份文件包含有效 SQL 内容",
      command: "wc -l ffp_backup.sql && file ffp_backup.sql",
      validation: "test -s ffp_backup.sql",
    });
    const classified = classifyStepResult(
      step,
      { success: true, exitCode: 0, output: "0 ffp_backup.sql\nffp_backup.sql: empty" },
      { passed: false, exitCode: 1, detail: "文件为空", output: "" },
    );

    expect(classified.result.observationStatus).toBe("unhealthy");
    expect(classified.result.facts.emptyRequiredFile).toBe(true);
    expect(classified.result.facts.blockingSignal).toBe(true);
    expect(classified.needsModelReview).toBe(true);
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
    const task = store.createTask("srv-production-01", "managed", "model-deepseek");
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
