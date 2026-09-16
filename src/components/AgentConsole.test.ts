// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useOpsStore } from "@/stores/ops";
import { buildAdjustmentBlockerSnapshot, openAdjustmentIncident } from "@/features/agent/adjustmentIncident";
import type { PendingUserInput } from "@/features/tools/types";
import type { OpsTask, TaskStatus } from "@/types";

vi.mock("@/components/ModelSettingsModal.vue", () => ({
  default: defineComponent(() => () => h("div")),
}));

import AgentConsole from "./AgentConsole.vue";

function clarificationTask(ops: ReturnType<typeof useOpsStore>) {
  const task = ops.createTask("server-a", "safe", "model-deepseek");
  task.status = "awaiting_input";
  task.currentRoundId = "round-current";
  task.plan = [{
    id: "clarify",
    title: "确认任务范围",
    description: "继续执行前需要用户确认",
    command: "request_user_input",
    expected: "用户确认范围",
    validation: "",
    risk: "low",
    status: "awaiting_input",
  }];
  const request: PendingUserInput = {
    taskId: task.id,
    stepId: "clarify",
    callId: "clarification-call",
    title: "确认任务范围",
    fields: [{ key: "scope", label: "范围", description: "指定需要处理的范围", type: "text", required: true }],
  };
  ops.pendingUserInputs.push(request);
  return task;
}

function selectionTask(ops: ReturnType<typeof useOpsStore>, withConfirmation = false) {
  const task = clarificationTask(ops);
  ops.pendingUserInputs[0].fields = [{
    key: "target",
    label: "处理目标",
    description: "选择本次任务的目标",
    type: "select",
    required: true,
    placeholder: "请选择处理目标",
    options: [{ value: "target-a", label: "目标 A（测试环境）" }, { value: "target-b", label: "目标 B（演示环境）" }],
  }];
  if (withConfirmation) ops.pendingUserInputs[0].fields.push({
    key: "confirmation", label: "确认说明", description: "单独填写确认说明", type: "text", required: true,
  });
  return task;
}

describe("AgentConsole 服务器工作区隔离", () => {
  let host: HTMLElement;
  const workspaceStores = new Set<ReturnType<typeof useAgentWorkspaceStore>>();

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    workspaceStores.forEach((workspace) => workspace.persist(true));
    workspaceStores.clear();
    vi.restoreAllMocks();
    host.remove();
  });

  function mountTask(pinia: ReturnType<typeof createPinia>, task: OpsTask) {
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const workspace = useAgentWorkspaceStore(pinia);
    workspace.updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    workspace.persist(true);
    workspaceStores.add(workspace);
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n);
    app.mount(host);
    return app;
  }

  function enterClarification(value: string) {
    const input = host.querySelector<HTMLInputElement>(".user-input-card input")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  }

  function submitClarification(form = host.querySelector<HTMLFormElement>(".user-input-card")!) {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  async function chooseTarget(index = 0) {
    host.querySelector<HTMLElement>(".user-input-card .parameter-select summary")!.click();
    await nextTick();
    document.querySelectorAll<HTMLButtonElement>(".parameter-options [role='option']")[index].click();
    await nextTick();
  }

  it("单选字段初始为空，必填未选时不提交，也不显示凭据保存说明", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = selectionTask(ops);
    const provide = vi.spyOn(ops, "provideUserInput").mockResolvedValue(true);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const form = host.querySelector<HTMLFormElement>(".user-input-card")!;
      const trigger = form.querySelector<HTMLElement>("summary")!;
      expect(trigger.textContent).toBe("请选择处理目标");
      expect(trigger.getAttribute("aria-label")).toBe("处理目标");
      trigger.click();
      await nextTick();
      expect(document.querySelector(".parameter-options [role='option'][aria-selected='true']")).toBeNull();
      expect(document.querySelector(".parameter-options [role='listbox']")?.getAttribute("aria-required")).toBe("true");
      expect(form.querySelector("input, select")).toBeNull();
      expect(form.querySelector(".user-input-actions > span")).toBeNull();
      expect(form.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
      submitClarification();
      expect(provide).not.toHaveBeenCalled();
    } finally { app.unmount(); }
  });

  it("单选提交真实 value，提交期间禁用选择和重复提交，失败后保留选择", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = selectionTask(ops);
    let finish!: (submitted: boolean) => void;
    const provide = vi.spyOn(ops, "provideUserInput").mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      await chooseTarget(1);
      const trigger = host.querySelector<HTMLElement>(".user-input-card summary")!;
      expect(trigger.textContent).toBe("目标 B（演示环境）");
      submitClarification();
      submitClarification();
      expect(provide).toHaveBeenCalledExactlyOnceWith(task.id, { target: "target-b" }, "clarification-call");
      await nextTick();
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(host.querySelector<HTMLButtonElement>(".user-input-card button[type='submit']")?.disabled).toBe(true);
      trigger.click();
      await nextTick();
      expect(document.querySelector(".parameter-options")).toBeNull();
      expect(trigger.closest("details")?.open).toBe(false);
      expect(trigger.textContent).toBe("目标 B（演示环境）");
      finish(false);
      await vi.waitFor(() => expect(trigger.getAttribute("aria-disabled")).toBe("false"));
      expect(trigger.textContent).toBe("目标 B（演示环境）");
      provide.mockResolvedValue(true);
      submitClarification();
      await vi.waitFor(() => expect(trigger.textContent).toBe("请选择处理目标"));
      expect(provide).toHaveBeenCalledTimes(2);
    } finally { app.unmount(); }
  });

  it("选择目标不会代替独立的必填文本确认", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = selectionTask(ops, true);
    const provide = vi.spyOn(ops, "provideUserInput").mockResolvedValue(true);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      await chooseTarget();
      const confirmation = host.querySelector<HTMLInputElement>(".user-input-card input")!;
      expect(confirmation.type).toBe("text");
      expect(confirmation.value).toBe("");
      expect(confirmation.required).toBe(true);
      submitClarification();
      expect(provide).not.toHaveBeenCalled();
      enterClarification("仅处理选定目标");
      submitClarification();
      expect(provide).toHaveBeenCalledExactlyOnceWith(task.id, {
        target: "target-a", confirmation: "仅处理选定目标",
      }, "clarification-call");
    } finally { app.unmount(); }
  });

  it.each([false, true])("仅可选单选允许清空为未填写，required=%s", async (required) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = selectionTask(ops);
    ops.pendingUserInputs[0].fields[0].required = required;
    const provide = vi.spyOn(ops, "provideUserInput").mockResolvedValue(true);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      await chooseTarget();
      const trigger = host.querySelector<HTMLElement>(".user-input-card summary")!;
      trigger.click();
      await nextTick();
      const clear = document.querySelector<HTMLButtonElement>(".parameter-options .parameter-clear");
      if (required) {
        expect(clear).toBeNull();
      } else {
        expect(clear?.getAttribute("aria-label")).toBe("清空 处理目标");
        expect(clear?.closest("[role='listbox']")).toBeNull();
        clear!.click();
        await nextTick();
        expect(trigger.textContent).toBe("请选择处理目标");
        trigger.click();
        await nextTick();
        expect(document.querySelector(".parameter-options [aria-selected='true']")).toBeNull();
        expect(document.querySelectorAll(".parameter-options [role='option']")).toHaveLength(2);
        submitClarification();
        expect(provide).toHaveBeenCalledExactlyOnceWith(task.id, { target: "" }, "clarification-call");
      }
    } finally { app.unmount(); }
  });

  it.each(["text", "password", "credential"] as const)("仅凭据相关表单显示长期保存说明：%s", async (kind) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    const field = ops.pendingUserInputs[0].fields[0];
    if (kind === "password") field.type = "password";
    if (kind === "credential") field.credential = { group: "auth", kind: "service", role: "username", target: "service.example" };
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const hint = host.querySelector(".user-input-actions > span");
      if (kind === "text") expect(hint).toBeNull();
      else expect(hint?.textContent).toContain("系统钥匙串");
    } finally { app.unmount(); }
  });

  it("只在任务等待输入时显示澄清表单，状态变更立即拒绝旧表单提交", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    const provide = vi.spyOn(ops, "provideUserInput").mockResolvedValue(true);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const form = host.querySelector<HTMLFormElement>(".user-input-card")!;
      expect(form).not.toBeNull();
      task.status = "planning";
      submitClarification(form);
      expect(provide).not.toHaveBeenCalled();
      const inactiveStatuses: TaskStatus[] = ["planning", "running", "validating", "awaiting_plan_approval", "awaiting_step_approval", "needs_adjustment", "completed", "cancelled"];
      for (const status of inactiveStatuses) {
        task.status = status;
        await nextTick();
        expect(host.querySelector(".user-input-card"), status).toBeNull();
      }
    } finally { app.unmount(); }
  });

  it("拒绝任务、步骤、轮次或执行上下文不匹配的澄清请求", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    const current = { ...ops.pendingUserInputs[0] };
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      expect(host.querySelector(".user-input-card")).not.toBeNull();
      const invalidBindings: Partial<PendingUserInput>[] = [
        { taskId: "another-task" }, { stepId: "another-step" }, { roundId: "previous-round" },
        { workflowEpoch: 99 }, { serverId: "another-server" }, { command: "superseded-command" },
      ];
      for (const binding of invalidBindings) {
        ops.pendingUserInputs = [{ ...current, ...binding }];
        await nextTick();
        expect(host.querySelector(".user-input-card"), JSON.stringify(binding)).toBeNull();
      }
      ops.pendingUserInputs = [current];
      task.plan[0].status = "completed";
      await nextTick();
      expect(host.querySelector(".user-input-card")).toBeNull();
      task.plan[0].status = "awaiting_input";
      task.cancelRequested = true;
      await nextTick();
      expect(host.querySelector(".user-input-card")).toBeNull();
    } finally { app.unmount(); }
  });

  it("澄清等待不会被遗留的步骤审批按钮遮挡", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    task.plan.unshift({ ...task.plan[0], id: "old-approval", status: "awaiting_approval" });
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      expect(host.querySelector(".user-input-card")).not.toBeNull();
      expect(host.querySelector(".approval-bar")).toBeNull();
    } finally { app.unmount(); }
  });

  it("澄清提交期间禁用输入与按钮并防止重复提交，失败后保留输入供重试", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    let finish!: (submitted: boolean) => void;
    const provide = vi.spyOn(ops, "provideUserInput").mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const input = enterClarification("测试环境");
      submitClarification();
      submitClarification();
      expect(provide).toHaveBeenCalledExactlyOnceWith(task.id, { scope: "测试环境" }, "clarification-call");
      await nextTick();
      expect(input.disabled).toBe(true);
      expect(host.querySelector<HTMLButtonElement>(".user-input-card button[type='submit']")?.disabled).toBe(true);
      ops.pendingUserInputs[0].error = "请进一步说明范围";
      finish(false);
      await vi.waitFor(() => expect(input.disabled).toBe(false));
      expect(input.value).toBe("测试环境");
      expect(host.textContent).toContain("请进一步说明范围");
      provide.mockResolvedValue(true);
      submitClarification();
      await vi.waitFor(() => expect(input.value).toBe(""));
      expect(provide).toHaveBeenCalledTimes(2);
    } finally { app.unmount(); }
  });

  it.each(["request", "task", "round"] as const)("旧提交完成后保留新表单内容：切换 %s", async (change) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    let finish!: (submitted: boolean) => void;
    const provide = vi.spyOn(ops, "provideUserInput").mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      enterClarification("旧答案");
      submitClarification();
      await nextTick();
      if (change === "task") {
        const nextTask = clarificationTask(ops);
        useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: nextTask.id });
      } else if (change === "round") {
        task.currentRoundId = "next-round";
        ops.pendingUserInputs = [{ ...ops.pendingUserInputs[0], roundId: "next-round" }];
      } else {
        ops.pendingUserInputs = [{ ...ops.pendingUserInputs[0], callId: "next-clarification-call" }];
      }
      await nextTick();
      const newInput = host.querySelector<HTMLInputElement>(".user-input-card input")!;
      expect(newInput.value).toBe("");
      expect(newInput.disabled).toBe(false);
      enterClarification("新答案");
      finish(true);
      await vi.waitFor(() => expect(provide.mock.settledResults[0]?.type).toBe("fulfilled"));
      await nextTick();
      expect(newInput.value).toBe("新答案");
    } finally { app.unmount(); }
  });

  it("步骤审批只在对应等待状态显示，状态改变后旧按钮也不可触发审批", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    task.status = "awaiting_step_approval";
    task.plan[0].status = "awaiting_approval";
    const approve = vi.spyOn(ops, "approveStep").mockResolvedValue(undefined);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const button = host.querySelector<HTMLButtonElement>(".approval-bar .primary")!;
      expect(button).not.toBeNull();
      task.status = "planning";
      button.click();
      expect(approve).not.toHaveBeenCalled();
      const inactiveStatuses: TaskStatus[] = ["planning", "running", "validating", "awaiting_input", "completed", "cancelled"];
      for (const status of inactiveStatuses) {
        task.status = status;
        await nextTick();
        expect(host.querySelector(".approval-bar"), status).toBeNull();
      }
    } finally { app.unmount(); }
  });

  it.each(["safe", "managed"] as const)("%s 模式协议阻断显示重新规划并评估风险，点击进入业务调整入口", async permission => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", permission, "model-deepseek");
    task.status = "needs_adjustment";
    task.managedAdjustmentPhase = "manual_required";
    task.pauseReason = "OBSERVE_COMMAND_MUTATION：协议修复失败，原计划未执行";
    task.plan = [{ id: "inspect", kind: "observe", title: "检查组件", description: "读取组件版本",
      command: "uname -a", validation: "", expected: "获取真实版本", risk: "low", status: "completed" }];
    task.protocolRepair = { serverId: task.serverId, roundId: task.currentRoundId,
      repair: { errorCode: "plan_normalization_failed", validationError: "OBSERVE_COMMAND_MUTATION",
        previousModelOutput: [{ ...task.plan[0], command: "kubeadm init --dry-run", status: "pending" }],
        fieldPath: "steps[0].command", instruction: "只修复协议" },
      repairError: "PROTOCOL_REPAIR_NO_PROGRESS" };
    const request = vi.spyOn(ops, "requestAdjustment").mockResolvedValue(undefined);
    const recovery = vi.spyOn(ops, "routeAutomaticAdjustment").mockResolvedValue(undefined);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const button = host.querySelector<HTMLButtonElement>(".approval-bar.warning .button.primary")!;
      expect(button.textContent).toBe("重新规划并评估风险");
      expect(host.querySelector(".managed-approval-countdown")).toBeNull();
      button.click();
      await nextTick();
      expect(request).toHaveBeenCalledExactlyOnceWith(task.id);
      expect(recovery).not.toHaveBeenCalled();
    } finally { app.unmount(); }
  });

  it("新业务步骤的原决定和具体变更授权提示直接可见，保持真实低风险标签", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "awaiting_step_approval";
    const decisionSummary = "系统前置调整授权：no-system-changes；CNI 网络插件：待定";
    task.plan = [{ id: "new-change", kind: "change", title: "准备备份目录", description: "创建部署前的备份目录",
      command: "mkdir -p /var/backups/app", validation: "test -d /var/backups/app", expected: "目录存在",
      risk: "low", status: "awaiting_approval", protocolReplanApproval: {
        inputFingerprint: "confirmed-decisions-1", decisionSummary,
      } }];
    const approve = vi.spyOn(ops, "approveStep").mockResolvedValue(undefined);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      // These reminders must be visible without opening the step details first.
      expect(host.querySelector(".step-detail")).toBeNull();
      const approvalBar = host.querySelector<HTMLElement>(".approval-bar.warning")!;
      expect(approvalBar.textContent).toContain(decisionSummary);
      expect(approvalBar.textContent).toContain("确认仅授权当前具体变更，不撤销其他限制");
      const risk = host.querySelector<HTMLElement>(".plan-step .risk-tag")!;
      expect(risk.classList.contains("low")).toBe(true);
      expect(risk.textContent).toBe("低风险");
      expect(task.plan[0].risk).toBe("low");
      approvalBar.querySelector<HTMLButtonElement>(".primary")!.click();
      await nextTick();
      expect(approve).toHaveBeenCalledExactlyOnceWith(task.id, "new-change");
    } finally { app.unmount(); }
  });

  it.each(["awaiting_plan_approval", "awaiting_step_approval"] as const)("审批在途时防止重复点击：%s", async (status) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    task.status = status;
    task.plan[0].status = status === "awaiting_step_approval" ? "awaiting_approval" : "pending";
    let finish!: () => void;
    const approve = vi.spyOn(ops, status === "awaiting_step_approval" ? "approveStep" : "approvePlan")
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const button = host.querySelector<HTMLButtonElement>(".approval-bar .primary")!;
      button.click();
      button.click();
      expect(approve).toHaveBeenCalledTimes(1);
      await nextTick();
      expect(button.disabled).toBe(true);
      finish();
      await vi.waitFor(() => expect(button.disabled).toBe(false));
    } finally { app.unmount(); }
  });

  it.each(["completed", "failed", "cancelled"] as const)("%s 窗口继续输入时先提交原 Task，由分类结果决定身份", async status => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model");
    task.rootGoal = "部署 Kubernetes";
    task.status = status;
    task.currentRoundId = "stable-round";
    const submit = vi.spyOn(ops, "submitRequirement").mockResolvedValue(undefined);
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true, modelId: "model", draft: "继续完成" });
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      host.querySelector<HTMLFormElement>(".composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
      expect(submit.mock.calls[0][5]).toBe(task.id);
      expect(submit.mock.calls[0][6]).toBeUndefined();
      expect(ops.tasks).toHaveLength(1);
      expect(task.currentRoundId).toBe("stable-round");
    } finally { app.unmount(); }
  });

  it("发送期间连接失效时保留草稿并显示错误，离线禁用发送", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    vi.spyOn(ops, "submitRequirement").mockImplementation(async () => {
      ops.serverConnection("server-a").status = "disconnected";
      throw new Error("SSH 未连接，请先重连");
    });
    useAgentWorkspaceStore(pinia).updateServer("server-a", { automationEnabled: true, modelId: "model", draft: "检查服务器状态" });
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      host.querySelector<HTMLFormElement>(".composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("草稿已保留"));
      expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("检查服务器状态");
      expect(host.querySelector<HTMLButtonElement>(".send-button")?.disabled).toBe(true);
    } finally { app.unmount(); }
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
    const upload = host.querySelector<HTMLButtonElement>(".agent-timeline .task-knowledge-upload button");
    expect(upload).not.toBeNull();
    expect(host.querySelector(".agent-panel > .task-knowledge-upload")).toBeNull();
    upload!.click();
    await nextTick();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请先在设置");
    app.unmount();
  });

  it("长任务标题在标题栏和任务列表中保留全文与悬停提示", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.title = "拉取https://gitee.com/qiwen-cloud/qiwen-file.git到/opt下并验收仓库";
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();
    const title = host.querySelector<HTMLElement>(".agent-title-copy small");
    expect(title?.textContent).toBe(task.title);
    expect(title?.title).toBe(task.title);
    host.querySelector<HTMLButtonElement>(".task-menu-trigger")!.click();
    await nextTick();
    const select = host.querySelector<HTMLButtonElement>(".task-select");
    expect(select?.title).toBe(task.title);
    expect(select?.querySelector("strong")?.textContent).toBe(task.title);
    app.unmount();
  });

  it("通道故障优先显示恢复等待，超时后停止转圈并显示检查恢复入口", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "needs_adjustment";
    task.managedAdjustmentPhase = "generating";
    task.plan = [{
      id: "clone", title: "克隆仓库", description: "获取源码", command: "git clone https://example.invalid/repo.git /opt/repo",
      expected: "仓库可用", validation: "test -d /opt/repo/.git", risk: "medium", status: "failed",
    }];
    task.autoAdjustmentSeconds = 3;
    task.adjustmentIncident = openAdjustmentIncident(
      buildAdjustmentBlockerSnapshot(task, undefined, { terminalBusy: true }), true, task.createdAt,
    );
    ops.transportRecoveryTaskIds.push(task.id);
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    const app = createApp(AgentConsole, { serverId: "server-a" });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    expect(host.textContent).toContain("正在等待终端恢复");
    expect(host.textContent).not.toContain("正在生成调整方案");
    task.managedAdjustmentPhase = "manual_required";
    task.managedStopReason = "transport_recovery";
    task.autoAdjustmentSeconds = undefined;
    await nextTick();
    expect(host.textContent).toContain("检查终端恢复");
    expect(host.textContent).not.toContain("正在等待终端恢复");
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
    ops.transportRecoveryTaskIds.push(task.id);
    await nextTick();

    expect(host.textContent).toContain("正在等待终端恢复…");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("生成调整方案"))).toBe(false);
    app.unmount();
  });

  it.each([
    { permission: "safe", withPlan: true }, { permission: "managed", withPlan: true },
    { permission: "safe", withPlan: false }, { permission: "managed", withPlan: false },
  ] as const)("$permission 模式（有计划=$withPlan）旧恢复标记没有后台等待者时显示检查入口，不持续 loading", async ({ permission, withPlan }) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const request = vi.spyOn(ops, "requestAdjustment").mockResolvedValue(undefined);
    const recovery = vi.spyOn(ops, "routeAutomaticAdjustment").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", permission, "model-deepseek");
    task.status = "needs_adjustment";
    if (withPlan) task.plan = [{ id: "inspect", kind: "observe", title: "检查服务", description: "读取服务状态",
      command: "hostname", expected: "取得真实状态", validation: "", risk: "low", status: "pending" }];
    task.managedAdjustmentPhase = "waiting_transport";
    task.managedStopReason = "transport_recovery";
    task.autoAdjustmentSeconds = 3;
    // Another task's active recovery must not drive this task's loading state.
    ops.transportRecoveryTaskIds.push("another-task");
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      expect(host.textContent).not.toContain("正在等待终端恢复");
      expect(host.querySelector(".managed-approval-countdown")).toBeNull();
      const check = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("检查终端恢复"));
      expect(check).toBeDefined();
      check!.click();
      await nextTick();
      expect(recovery).toHaveBeenCalledWith(task.id, { transportRecovery: true });
      expect(request).not.toHaveBeenCalled();
    } finally { app.unmount(); }
  });

  it("真实恢复等待结束后立即停止转圈，转为业务待操作时显示调整按钮", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.plan = [{ id: "inspect", kind: "observe", title: "检查服务", description: "读取服务状态",
      command: "hostname", expected: "取得真实状态", validation: "", risk: "low", status: "pending" }];
    task.managedAdjustmentPhase = "waiting_transport";
    task.managedStopReason = "transport_recovery";
    ops.transportRecoveryTaskIds.push(task.id);
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      expect(host.textContent).toContain("正在等待终端恢复");

      ops.transportRecoveryTaskIds.splice(0);
      await nextTick();
      expect(host.textContent).not.toContain("正在等待终端恢复");
      expect(host.textContent).toContain("检查终端恢复");

      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = undefined;
      task.pauseReason = "终端已恢复，业务问题需用户确认";
      await nextTick();
      expect(host.textContent).not.toContain("检查终端恢复");
      expect(host.querySelector(".approval-bar.warning .button.primary")?.textContent).toContain("生成调整方案");
      expect(host.querySelector(".managed-approval-countdown")).toBeNull();
    } finally { app.unmount(); }
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

  it("执行中默认保持收起，用户可手动展开过程记录", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "running";
    ops.pushMessage(task, { role: "system", kind: "event", content: "正在采集 Java 进程信息" });
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".execution-record-body")).toBeNull();
    expect(host.querySelector(".execution-record-preview")?.textContent).toContain("正在采集 Java 进程信息");

    host.querySelector<HTMLButtonElement>(".execution-record-card .plan-card-head")!.click();
    await nextTick();

    expect(host.querySelector(".execution-record-body")).not.toBeNull();
    expect(host.querySelector(".execution-event-row.active")?.textContent).toContain("正在采集 Java 进程信息");
    app.unmount();
  });

  it("执行转为等待用户操作时自动收起已手动展开的过程记录", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "running";
    task.currentRoundId = "round-current";
    task.plan = [{
      id: "clarify",
      title: "确认任务范围",
      description: "继续执行前需要用户确认",
      command: "request_user_input",
      expected: "用户确认范围",
      validation: "",
      risk: "low",
      status: "pending",
    }];
    ops.pushMessage(task, { role: "system", kind: "event", content: "正在分析可用目标" });
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".execution-record-body")).toBeNull();
    host.querySelector<HTMLButtonElement>(".execution-record-card .plan-card-head")!.click();
    await nextTick();
    expect(host.querySelector(".execution-record-body")).not.toBeNull();

    task.status = "awaiting_input";
    task.plan[0].status = "awaiting_input";
    ops.pendingUserInputs.push({
      taskId: task.id,
      stepId: "clarify",
      callId: "clarification-call",
      roundId: task.currentRoundId,
      title: "确认任务范围",
      fields: [{ key: "scope", label: "范围", description: "指定需要处理的范围", type: "text", required: true }],
    });
    await nextTick();

    expect(host.querySelector(".user-input-card")).not.toBeNull();
    expect(host.querySelector(".execution-record-body")).toBeNull();
    expect(host.querySelector(".execution-record-preview")?.textContent).toContain("正在分析可用目标");

    task.status = "running";
    task.plan[0].status = "running";
    ops.pendingUserInputs.splice(0);
    await nextTick();

    expect(host.querySelector(".execution-record-body")).toBeNull();
    app.unmount();
  });

  it("手动调整待操作时收起记录，开始生成调整后仍保持收起", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "running";
    task.plan = [{
      id: "inspect",
      title: "检查服务",
      description: "检查当前运行状态",
      command: "systemctl status app",
      expected: "获取服务状态",
      validation: "",
      risk: "low",
      status: "failed",
    }];
    ops.pushMessage(task, { role: "system", kind: "event", content: "正在结合失败证据生成调整" });
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".execution-record-body")).toBeNull();
    host.querySelector<HTMLButtonElement>(".execution-record-card .plan-card-head")!.click();
    await nextTick();
    expect(host.querySelector(".execution-record-body")).not.toBeNull();

    task.status = "needs_adjustment";
    await nextTick();
    expect(host.querySelector(".approval-bar.warning .button.primary")).not.toBeNull();
    expect(host.querySelector(".execution-record-body")).toBeNull();

    task.adjustmentInProgress = true;
    await nextTick();
    expect(host.querySelector(".approval-bar.warning .button.primary")).toBeNull();
    expect(host.querySelector(".execution-record-body")).toBeNull();
    app.unmount();
  });

  it("总结将标题和列表渲染为可扫读的信息层级", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "completed";
    task.summary = "## 执行结果\n- 发现 2 个 Java 进程\n- 监听端口为 8080";
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".summary-content h4")?.textContent).toBe("执行结果");
    expect(host.querySelectorAll(".summary-content li")).toHaveLength(2);
    app.unmount();
  });
});
