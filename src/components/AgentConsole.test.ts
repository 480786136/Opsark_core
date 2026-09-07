// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useOpsStore } from "@/stores/ops";

vi.mock("@/components/ModelSettingsModal.vue", () => ({
  default: defineComponent(() => () => h("div")),
}));

import AgentConsole from "./AgentConsole.vue";

describe("AgentConsole 服务器工作区隔离", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  it("在当前任务中连续展示同一会话的 Java 与 MySQL 记录", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const java = ops.createTask("server-a", "safe", "model-deepseek");
    java.createdAt = "2026-09-06T01:00:00Z";
    java.status = "completed";
    java.messages = [{ id: "java-question", role: "user", kind: "message", content: "现在有哪些java服务在运行", createdAt: java.createdAt }];
    java.summary = "Java 服务：orders.jar";
    const mysql = ops.createTask("server-a", "safe", "model-deepseek");
    mysql.conversationId = java.id;
    mysql.createdAt = "2026-09-06T02:00:00Z";
    mysql.messages = [{ id: "mysql-question", role: "user", kind: "message", content: "现在mysql数据库有哪些库", createdAt: mysql.createdAt }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: mysql.id, automationEnabled: true });
    const app = createApp(AgentConsole, { serverId: "server-a" });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    expect(host.textContent).toContain("现在有哪些java服务在运行");
    expect(host.textContent).toContain("orders.jar");
    expect(host.textContent).toContain("现在mysql数据库有哪些库");
    expect(mysql.plan).toHaveLength(0);
    app.unmount();
  });

  it("分别恢复每台服务器的活动任务和输入草稿", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const taskA = ops.createTask("server-a", "safe", "model-deepseek");
    taskA.title = "Alpha Nginx";
    const taskB = ops.createTask("server-b", "observe", "model-deepseek");
    taskB.title = "Beta Disk";
    const workspaces = useAgentWorkspaceStore(pinia);
    workspaces.updateServer("server-a", {
      activeTaskId: taskA.id,
      automationEnabled: true,
      draft: "继续检查 Alpha",
    });
    workspaces.updateServer("server-b", {
      activeTaskId: taskB.id,
      automationEnabled: true,
      draft: "继续检查 Beta",
    });
    const Wrapper = defineComponent(() => () => h("div", [
      h(AgentConsole, { serverId: "server-a" }),
      h(AgentConsole, { serverId: "server-b" }),
    ]));
    const app = createApp(Wrapper).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    const panels = host.querySelectorAll<HTMLElement>(".agent-panel");
    expect(panels[0].textContent).toContain("Alpha Nginx");
    expect(panels[0].textContent).not.toContain("Beta Disk");
    expect(panels[1].textContent).toContain("Beta Disk");
    expect(panels[1].textContent).not.toContain("Alpha Nginx");
    expect(panels[0].querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("继续检查 Alpha");
    expect(panels[1].querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("继续检查 Beta");
    app.unmount();
  });

  it("任务已暂停调整时不再显示终止业务", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const paused = ops.createTask("server-a", "safe", "model-deepseek");
    paused.status = "needs_adjustment";
    paused.pauseReason = "独立校验未通过";
    paused.plan = [{
      id: "step-1",
      title: "验收仓库",
      description: "验收仓库",
      command: "git -C /root/app rev-parse HEAD",
      expected: "返回提交哈希",
      validation: "git -C /root/app rev-parse --verify HEAD",
      risk: "low",
      status: "failed",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: paused.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".terminate-business")).toBeNull();
    expect(host.textContent).toContain("生成调整方案");
    app.unmount();
  });

  it("安全拦截单独统计，不误计为已处理成功", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const paused = ops.createTask("server-a", "safe", "model-deepseek");
    paused.status = "needs_adjustment";
    paused.pauseReason = "执行前安全检查未通过";
    const base = {
      description: "诊断",
      expected: "获得结果",
      risk: "low" as const,
    };
    paused.plan = [{
      ...base,
      id: "completed",
      title: "前置检查",
      command: "pwd",
      validation: "test -d .",
      status: "completed",
    }, {
      ...base,
      id: "blocked",
      title: "安全拦截",
      command: "deploy || true",
      validation: "test -f result",
      status: "failed",
      result: {
        executionStatus: "blocked",
        observationStatus: "unknown",
        facts: { category: "plan_safety_rejection", field: "command", ruleId: "EMPTY_SUCCESS_FALLBACK" },
        warnings: [],
        evidenceIds: [],
      },
    }, {
      ...base,
      id: "pending",
      title: "后续验收",
      command: "curl -f http://127.0.0.1",
      validation: "curl -f http://127.0.0.1",
      status: "pending",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: paused.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("完成 1 · 安全拦截 1 · 待执行 1");
    expect(host.textContent).not.toContain("2/3 已处理");
    expect(host.querySelector(".terminate-business")).toBeNull();
    app.unmount();
  });

  it("已完成阶段的后续计划生成失败不误报为证据校验失败", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const paused = ops.createTask("server-a", "safe", "model-deepseek");
    paused.status = "needs_adjustment";
    paused.pauseReason = "当前阶段已完成；调整计划生成失败：第 12 步未通过校验";
    paused.plan = [{
      id: "step-1",
      title: "构建前端",
      description: "构建前端",
      command: "npm run build",
      expected: "dist 存在",
      validation: "test -f dist/index.html",
      risk: "medium",
      status: "completed",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: paused.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("当前步骤已完成，后续计划生成失败");
    expect(host.textContent).not.toContain("证据校验未通过，任务已暂停");
    app.unmount();
  });

  it("已结束任务的旁问不会显示成上一轮计划和总结的当前轮次", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "completed";
    task.rootGoal = "部署静态站点";
    task.currentInstruction = "其他机器访问什么地址？";
    task.lastRequirementRelation = "side_question";
    task.plan = [];
    task.summary = undefined;
    task.planHistory = [{
      id: "previous-round",
      requirement: "部署静态站点",
      status: "completed",
      plan: [{
        id: "serve",
        title: "启动静态服务",
        description: "监听 8080",
        command: "systemd-run --unit site python3 -m http.server 8080",
        expected: "服务可访问",
        validation: "curl -f http://127.0.0.1:8080/",
        risk: "medium",
        status: "completed",
      }],
      summary: "静态站点部署完成",
      createdAt: "2026-08-25T15:00:00.000Z",
      completedAt: "2026-08-25T15:10:00.000Z",
    }];
    ops.pushMessage(task, { role: "user", kind: "message", content: "其他机器访问什么地址？" });
    ops.pushMessage(task, { role: "assistant", kind: "message", content: "访问 http://192.168.1.237:8080/" });
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("访问 http://192.168.1.237:8080/");
    expect(host.querySelector(".archived-plan")).not.toBeNull();
    expect(host.querySelector(".current-plan-card")).toBeNull();
    expect(host.querySelector(".summary-card:not(.archived-summary)")).toBeNull();
    app.unmount();
  });

  it("历史轮次没有生成计划时显示计划生成未完成而不是零步骤", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.planHistory = [{
      id: "failed-planning-round",
      requirement: "检查 SSH 40122 连接问题",
      status: "needs_adjustment",
      plan: [],
      pauseReason: "计划生成未通过安全校验",
      createdAt: "2026-08-26T01:00:00.000Z",
      completedAt: "2026-08-26T01:00:05.000Z",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("计划生成未完成。");
    expect(host.textContent).not.toContain("已生成 0 个执行步骤");
    app.unmount();
  });

  it("计划编译失败不显示业务调整按钮或托管倒计时", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "planning_failed";
    task.pauseReason = "计划生成未通过协议校验，可直接重试规划。";
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("计划编译失败");
    expect(host.textContent).toContain("可直接重试规划");
    expect(host.textContent).toContain("重试规划");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("生成调整方案"))).toBe(false);
    expect(host.querySelector(".managed-approval-countdown")).toBeNull();
    app.unmount();
  });

  it("完全托管调整进行中或等待终端恢复时不显示无效的生成按钮", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.adjustmentInProgress = true;
    task.plan = [{
      id: "failed-step",
      title: "安装依赖",
      description: "安装项目依赖",
      command: "npm install",
      expected: "依赖安装成功",
      validation: "test -d node_modules",
      risk: "medium",
      status: "failed",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("正在生成调整方案…");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("生成调整方案"))).toBe(false);

    task.adjustmentInProgress = false;
    task.adjustmentIncident = {
      fingerprint: "transport-incident",
      kind: "transport",
      category: "terminal_transport",
      stepFingerprint: "failed-step",
      targetFingerprint: "terminal-generation-1",
      evidenceFingerprint: "terminal-not-released",
      executionAttemptCount: 0,
      generationFailureCount: 0,
      automatic: true,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    await nextTick();

    expect(host.textContent).toContain("正在等待终端恢复…");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("生成调整方案"))).toBe(false);
    app.unmount();
  });

  it("折叠重复调整提示，并可展开查看阶段总结和执行步骤", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "awaiting_plan_approval";
    ops.pushMessage(task, { role: "user", kind: "message", content: "拉取并部署 RuoYi" });
    [1, 2, 3].forEach((index) => {
      ops.pushMessage(task, {
        role: "assistant",
        kind: "message",
        content: `已根据失败结果自动生成 ${index} 个调整步骤，完全托管模式已自动批准并继续；高风险步骤仍需单独确认。`,
      });
    });
    task.phaseHistory = [{
      id: "phase-1",
      roundId: task.currentRoundId!,
      requirement: "拉取并部署 RuoYi",
      reason: "adjustment",
      summary: "Git 环境可用，但目标目录尚未创建，因此需要先获取源码。",
      createdAt: "2026-08-31T16:29:00.000Z",
      completedAt: "2026-08-31T16:30:00.000Z",
      plan: [{
        id: "check-source",
        title: "检查目标目录与 Git 环境",
        description: "确认源码获取前置条件",
        command: "git --version",
        expected: "Git 可用",
        validation: "git --version",
        risk: "low",
        status: "failed",
        result: {
          executionStatus: "failed",
          observationStatus: "unknown",
          facts: { targetMissing: true },
          warnings: [],
          evidenceIds: [],
          failureReason: "目标目录尚不存在",
        },
      }],
    }];
    task.plan = [{
      id: "clone-source",
      title: "获取源码",
      description: "克隆仓库到目标目录",
      command: "git clone https://gitee.com/y_project/RuoYi.git /opt/ruoyi",
      expected: "源码目录可用",
      validation: "test -d /opt/ruoyi/.git",
      risk: "high",
      status: "pending",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelectorAll(".task-message.assistant")).toHaveLength(1);
    expect(host.textContent).toContain("下一阶段计划已生成。");
    expect(host.textContent).not.toContain("完全托管模式已自动批准并继续");
    expect(host.textContent).toContain("阶段 1");
    expect(host.textContent).toContain("发现阻断，已转入下一方案");
    expect(host.textContent).not.toContain("Git 环境可用，但目标目录尚未创建");

    host.querySelector<HTMLButtonElement>(".phase-history-head")!.click();
    await nextTick();

    expect(host.textContent).toContain("本阶段执行总结");
    expect(host.textContent).toContain("Git 环境可用，但目标目录尚未创建，因此需要先获取源码。");
    expect(host.textContent).toContain("检查目标目录与 Git 环境");
    app.unmount();
  });

  it("敏感值安全保存失败时保留用户输入并显示原因", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "awaiting_input";
    task.plan = [{
      id: "secret-step",
      title: "Git 凭据",
      description: "读取私有仓库",
      command: "git clone https://gitee.com/example/private.git",
      expected: "仓库可用",
      validation: "test -d /opt/private/.git",
      risk: "medium",
      status: "awaiting_input",
    }];
    ops.pendingSecret = {
      taskId: task.id,
      stepId: "secret-step",
      key: "GIT_HTTP_CREDENTIAL",
      label: "Gitee 访问令牌",
      description: "用于 gitee.com HTTPS 认证",
      unlockDescription: "提交后继续拉取仓库",
    };
    vi.spyOn(ops, "provideSecret").mockImplementation(async () => {
      if (ops.pendingSecret) ops.pendingSecret.error = "安全保存失败：钥匙串已锁定";
      return false;
    });
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id,
      automationEnabled: true,
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();
    const input = host.querySelector<HTMLInputElement>(".secret-unlock-input input")!;
    input.value = "temporary-token";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLFormElement>(".secret-unlock-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(input.value).toBe("temporary-token");
    expect(host.textContent).toContain("安全保存失败：钥匙串已锁定");
    app.unmount();
  });
});
