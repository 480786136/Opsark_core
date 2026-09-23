// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useOpsStore } from "@/stores/ops";
import { useAccountStore } from "@/features/account/accountStore";
import { useOfficialCatalogStore } from "@/features/account/officialCatalogStore";
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

  it("正常续接使用下一步计划入口和中性进度，点击沿用现有规划流程", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "awaiting_continuation";
    task.pauseReason = "环境检查已完成，接下来需要构建应用。";
    task.plan = [{ id: "inspect", title: "检查环境", description: "读取环境信息", command: "uname -a",
      expected: "取得环境信息", validation: "", risk: "low", status: "completed" }];
    task.latestGoalReview = { decision: { decision: "continue", reason: "需要构建", summary: task.pauseReason, source: "model" },
      snapshot: {}, nextPlan: [{ ...task.plan[0], id: "build", status: "pending" }], createdAt: task.createdAt };
    const request = vi.spyOn(ops, "requestAdjustment").mockResolvedValue(undefined);
    const app = mountTask(pinia, task);
    const previousLocale = i18n.global.locale.value;
    try {
      await nextTick();
      const bar = host.querySelector<HTMLElement>(".approval-bar.continuation")!;
      expect(bar.querySelector("strong")?.textContent).toBe("当前阶段已完成，准备下一步");
      expect(bar.querySelector(".lucide-shield-alert-icon")).toBeNull();
      expect(host.querySelector(".summary-card.summary-progress .lucide-arrow-right-icon")).not.toBeNull();
      expect(host.querySelector(".task-state-pill.continuation")).not.toBeNull();
      const button = bar.querySelector<HTMLButtonElement>(".button.primary")!;
      expect(button.textContent).toBe("生成下一步计划");
      button.click();
      await nextTick();
      expect(request).toHaveBeenCalledExactlyOnceWith(task.id);
      i18n.global.locale.value = "en-US";
      await nextTick();
      expect(button.textContent).toBe("Plan next steps");
    } finally { i18n.global.locale.value = previousLocale; app.unmount(); }
  });

  it("完全托管正常续接的倒计时和生成提示表达任务推进", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "awaiting_continuation";
    task.plan = [{ id: "inspect", title: "检查环境", description: "读取环境信息", command: "uname -a",
      expected: "取得环境信息", validation: "", risk: "low", status: "completed" }];
    task.autoAdjustmentSeconds = 3;
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      expect(host.querySelector(".managed-approval-countdown")?.textContent)
        .toBe("3 秒后生成下一步计划并继续执行；高风险步骤仍需确认");
      expect(host.querySelector(".approval-bar .button.primary")).toBeNull();
      task.autoAdjustmentSeconds = undefined;
      task.adjustmentInProgress = true;
      task.managedAdjustmentPhase = "generating";
      await nextTick();
      expect(host.querySelector(".managed-approval-countdown")?.textContent).toBe("正在规划下一步…");
      expect(host.querySelector(".approval-bar .button.primary")).toBeNull();
    } finally { app.unmount(); }
  });

  it.each([
    { permission: "safe", reason: "no_action" },
    { permission: "managed", reason: "no_action" },
    { permission: "managed", reason: "no_progress" },
  ] as const)("$permission 模式遇到 $reason 时保留阻断提示，不宣称阶段成功", async ({ permission, reason }) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", permission, "model-deepseek");
    task.status = "awaiting_continuation";
    task.pauseReason = "缺少部署授权，需要先确认部署范围。";
    if (reason === "no_action") task.latestGoalReview = {
      decision: { decision: "adjust", reason: task.pauseReason, summary: task.pauseReason, source: "model" },
      snapshot: {}, nextPlan: [], createdAt: task.createdAt,
    };
    if (permission === "managed") {
      task.managedStopReason = reason;
      task.managedAdjustmentPhase = "manual_required";
    }
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const bar = host.querySelector<HTMLElement>(".approval-bar.warning")!;
      expect(bar.textContent).toContain("缺少部署授权");
      expect(bar.querySelector(".button.primary")?.textContent).toBe("重新评估下一步");
      expect(host.textContent).not.toContain("当前阶段已完成");
      expect(host.querySelector(".summary-progress")).toBeNull();
      expect(host.querySelector(".managed-approval-countdown")).toBeNull();
    } finally { app.unmount(); }
  });

  it("后续计划生成失败时显示重试入口，即使原步骤仍保留失败记录", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.pauseReason = "当前结果和已有执行证据已保留，但后续方案暂未就绪。可以稍后重试生成。未完成目标也已保留。";
    task.plan = [{ id: "install", title: "安装依赖", description: "安装依赖", command: "npm install",
      expected: "安装完成", validation: "", risk: "medium", status: "failed",
      result: { executionStatus: "failed", observationStatus: "unknown", facts: {}, warnings: [], evidenceIds: [] } }];
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const bar = host.querySelector<HTMLElement>(".approval-bar.warning")!;
      expect(bar.querySelector(".button.primary")?.textContent).toBe("重试生成计划");
      expect(bar.querySelector("strong")?.textContent).toBe("当前检查结果已保留，后续方案待完善");
      expect(host.querySelector(".plan-step.failed")).not.toBeNull();
    } finally { app.unmount(); }
  });

  it.each(["planning_failed", "needs_adjustment", "awaiting_continuation"] as const)("额度阻断展示明确警告和账户入口：%s", async (status) => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    useAccountStore(pinia).apply({ user: { id: "member", email: "member@example.test" },
      balance: { available: 0, reserved: 0, revision: 1, unit: "tokens" },
      models: [{ id: "official-trial", name: "OpsArk Trial" }], endpoint: "https://example.invalid/v1" });
    const task = ops.createTask("server-a", "managed", ops.models.find(model => model.source === "official")!.id);
    task.status = status;
    ops.recordModelPlanningBlocker(task, {
      httpStatus: 402, code: "INSUFFICIENT_CREDITS", message: "余额不足", retryable: false,
      details: { billing_mode: "direct", available_tokens: 0 },
    });
    const workspace = useAgentWorkspaceStore(pinia);
    workspace.updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });
    workspaceStores.add(workspace);
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", component: { render: () => null } },
      { path: "/account", component: { render: () => null } },
    ] });
    await router.push("/");
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n).use(router);
    app.mount(host);
    try {
      await nextTick();
      const alert = host.querySelector<HTMLElement>(".approval-bar[role='alert']")!;
      expect(alert.querySelector("strong")?.textContent).toBe("模型额度不足，任务已暂停");
      expect(alert.textContent).toContain("模型可用余额已用完");
      expect(alert.textContent).not.toContain("证据校验未通过");
      expect(alert.querySelector(".button.primary")?.textContent).toBe("重试生成计划");
      expect(host.querySelector(".approval-bar.continuation")).toBeNull();
      const accountButton = Array.from(alert.querySelectorAll("button")).find(button => button.textContent === "查看账户额度")!;
      accountButton.click();
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/account"));
      ops.recordModelPlanningBlocker(task, { httpStatus: 402, code: "CREDITS_RECONCILIATION_REQUIRED", message: "待结算", retryable: false });
      await nextTick();
      expect(alert.querySelector("strong")?.textContent).toBe("模型账户待结算核对，任务已暂停");
    } finally { app.unmount(); }
  });

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

  it.each([false, true])("响应解析失败不会显示为证据校验失败（旧记录：%s）", async legacy => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "needs_adjustment";
    task.pauseReason = legacy ? "后续流程暂不可用：ModelInvocationError: 阶段联合决策结构解析失败：missing field steps"
      : "后续阶段响应格式不完整或不正确，未执行新的计划。已完成步骤及其证据保持有效。";
    task.plan = [{ id: "inspect", kind: "observe", title: "读取文件", description: "读取部署入口",
      command: "pwd", validation: "", expected: "取得结果", risk: "low", status: "completed" }];
    if (!legacy) task.protocolRepair = { serverId: task.serverId, roundId: task.currentRoundId,
      repair: { errorCode: "next_stage_response_invalid", validationError: "missing field steps",
        previousModelOutput: [], rawModelResponse: '{"decision":"adjust"}', instruction: "重新生成" },
      repairError: "响应无法解析" };
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      expect(host.textContent).toContain("后续阶段响应格式错误，已完成结果已保留");
      expect(host.textContent).not.toContain("证据校验未通过");
    } finally { app.unmount(); }
  });

  it.each(["safe", "managed"] as const)("%s 模式仅在自动协议恢复耗尽后显示中性重试入口", async permission => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", permission, "model-deepseek");
    task.status = "needs_adjustment";
    task.managedAdjustmentPhase = "manual_required";
    task.pauseReason = "PlanProtocolError：OBSERVE_COMMAND_MUTATION；PROTOCOL_REPAIR_SCOPE_VIOLATION";
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
      expect(host.textContent).toContain("当前检查结果已保留，后续方案待完善");
      expect(host.textContent).toContain("当前检查结果和已完成步骤已保留");
      expect(host.textContent).not.toContain("PlanProtocolError");
      expect(host.textContent).not.toContain("OBSERVE_COMMAND_MUTATION");
      expect(host.textContent).not.toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
      expect(host.querySelector<HTMLButtonElement>(".approval-bar.warning .button.secondary")?.textContent)
        .toBe("保留结果并结束");
      expect(button.textContent).toBe("重试生成计划");
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

  it("交错提交时旧 Task 的 catch/finally 不覆盖新 Task 的规划态、草稿和终端引用", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const createFinishedTask = (label: string) => {
      const current = ops.createTask("server-a", "safe", "model");
      current.title = `${label} 旧任务`;
      current.rootGoal = `${label} 旧目标`;
      current.currentRoundId = `${label}-round`;
      current.status = "cancelled";
      current.plan = [{ id: `${label}-step`, title: `${label} 旧计划`, description: "保留原计划", command: "true",
        expected: "done", validation: "", risk: "low", status: "skipped" }];
      return current;
    };
    const taskA = createFinishedTask("A");
    const taskC = createFinishedTask("C");
    const taskB = createFinishedTask("B");
    const deferred = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const submit = vi.spyOn(ops, "submitRequirement").mockImplementation((
      _serverId, content, _permission, _modelId, _terminalReference, taskId,
    ) => {
      const owner = ops.tasks.find(item => item.id === taskId)!;
      owner.requirementProcessing = true;
      ops.pushMessage(owner, { role: "user", kind: "message", content });
      return new Promise<void>((resolve, reject) => deferred.set(owner.id, {
        resolve: () => { owner.requirementProcessing = false; resolve(); },
        reject: (error) => { owner.requirementProcessing = false; reject(error); },
      }));
    });
    const workspace = useAgentWorkspaceStore(pinia);
    workspace.updateServer("server-a", {
      activeTaskId: taskA.id, automationEnabled: true, modelId: "model", draft: "A 新需求",
    });
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n);
    app.mount(host);
    const setDraft = (value: string) => {
      const textarea = host.querySelector<HTMLTextAreaElement>(".composer textarea")!;
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const setTerminalReference = async (lines: string[]) => {
      ops.terminalLines.splice(0, ops.terminalLines.length, ...lines);
      host.querySelector<HTMLButtonElement>(".context-button")!.click();
      await nextTick();
    };
    const submitComposer = async () => {
      host.querySelector<HTMLFormElement>(".composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await nextTick();
    };
    try {
      await nextTick();
      await setTerminalReference(["A-reference"]);
      await submitComposer();
      expect(deferred.has(taskA.id)).toBe(true);

      workspace.updateServer("server-a", { activeTaskId: taskC.id });
      await nextTick();
      setDraft("C 新需求");
      await setTerminalReference(["C-reference-1", "C-reference-2"]);
      await submitComposer();
      expect(deferred.has(taskC.id)).toBe(true);

      workspace.updateServer("server-a", { activeTaskId: taskB.id });
      await nextTick();
      setDraft("B 新需求");
      await setTerminalReference(["B-reference-1", "B-reference-2", "B-reference-3"]);
      await submitComposer();
      expect(deferred.has(taskB.id)).toBe(true);
      expect(submit.mock.calls.map(call => call[4])).toEqual([
        "A-reference", "C-reference-1\nC-reference-2", "B-reference-1\nB-reference-2\nB-reference-3",
      ]);
      expect(host.querySelector(".agent-title-copy small")?.textContent).toContain("B 新需求");
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(1);
      expect(host.querySelector(".current-plan-card")).toBeNull();
      expect(host.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("");
      expect(host.querySelector(".context-chip")?.textContent).toContain("3");
      const terminateButton = host.querySelector<HTMLButtonElement>(".requirement-processing-terminate")!;
      expect(terminateButton).not.toBeNull();
      expect(host.querySelectorAll(".terminate-business")).toHaveLength(1);

      deferred.get(taskA.id)!.reject(new Error("A 规划失败"));
      await vi.waitFor(() => expect(submit.mock.settledResults[0]?.type).toBe("rejected"));
      expect(host.querySelector(".agent-title-copy small")?.textContent).toContain("B 新需求");
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(1);
      expect(host.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("");
      expect(host.querySelector('[role="alert"]')).toBeNull();

      deferred.get(taskC.id)!.resolve();
      await vi.waitFor(() => expect(submit.mock.settledResults[1]?.type).toBe("fulfilled"));
      expect(host.querySelector(".agent-title-copy small")?.textContent).toContain("B 新需求");
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(1);
      expect(host.querySelector(".context-chip")?.textContent).toContain("3");

      deferred.get(taskB.id)!.resolve();
      await vi.waitFor(() => expect(submit.mock.settledResults[2]?.type).toBe("fulfilled"));
      expect(host.querySelector(".context-chip")).toBeNull();
    } finally { app.unmount(); }
  });

  it("终止需求分类时立即释放本地 owner，旧提交稍后成功也不切换 Task", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model");
    task.title = "原任务";
    task.rootGoal = "原目标";
    task.status = "cancelled";
    task.plan = [{ id: "old-step", title: "原计划", description: "保留计划", command: "true",
      expected: "done", validation: "", risk: "low", status: "skipped" }];
    const child = ops.createTask("server-a", "safe", "model");
    child.title = "新子任务";
    let resolveSubmit!: () => void;
    const submit = vi.spyOn(ops, "submitRequirement").mockImplementation((_serverId, content) => {
      task.requirementProcessing = true;
      task.status = "planning";
      ops.pushMessage(task, { role: "user", kind: "message", content });
      return new Promise<void>(resolve => {
        resolveSubmit = () => { task.requirementProcessing = false; resolve(); };
      });
    });
    const realTerminate = ops.terminateTask.bind(ops);
    let resolveTerminate!: () => void;
    const terminate = vi.spyOn(ops, "terminateTask").mockImplementation(async taskId => {
      await realTerminate(taskId);
      await new Promise<void>(resolve => { resolveTerminate = resolve; });
    });
    const workspace = useAgentWorkspaceStore(pinia);
    workspace.updateServer("server-a", {
      activeTaskId: task.id, automationEnabled: true, modelId: "model", draft: "继续执行",
    });
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      ops.terminalLines.splice(0, ops.terminalLines.length, "pending-reference");
      host.querySelector<HTMLButtonElement>(".context-button")!.click();
      host.querySelector<HTMLFormElement>(".composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await nextTick();
      expect(submit).toHaveBeenCalledOnce();
      expect(host.querySelector(".agent-title-copy small")?.textContent).toContain("继续执行");
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(1);

      host.querySelector<HTMLButtonElement>(".requirement-processing-terminate")!.click();
      await nextTick();
      expect(terminate).toHaveBeenCalledExactlyOnceWith(task.id);
      expect(terminate.mock.settledResults[0]?.type).toBe("incomplete");
      expect(host.querySelector(".agent-title-copy small")?.textContent).toBe("原任务");
      expect(host.querySelector(".requirement-processing-terminate")).toBeNull();
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(0);
      expect(host.querySelector(".current-plan-card")).not.toBeNull();

      ops.activeTaskId = child.id;
      resolveSubmit();
      await vi.waitFor(() => expect(submit.mock.settledResults[0]?.type).toBe("fulfilled"));
      expect(workspace.workspaces["server-a"].activeTaskId).toBe(task.id);
      expect(host.querySelector(".context-chip")).not.toBeNull();

      await vi.waitFor(() => expect(resolveTerminate).toBeTypeOf("function"));
      resolveTerminate();
      await vi.waitFor(() => expect(terminate.mock.settledResults[0]?.type).toBe("fulfilled"));
    } finally { app.unmount(); }
  });

  it("仅切换查看 B 时，A 的 new_goal 稍后完成不把界面切到子 Task", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const taskA = ops.createTask("server-a", "safe", "model");
    taskA.title = "Task A";
    taskA.status = "cancelled";
    const taskB = ops.createTask("server-a", "safe", "model");
    taskB.title = "Task B";
    taskB.status = "cancelled";
    const child = ops.createTask("server-a", "safe", "model");
    child.title = "A 创建的子 Task";
    let resolveSubmit!: () => void;
    const submit = vi.spyOn(ops, "submitRequirement").mockImplementation((_serverId, content) => {
      taskA.requirementProcessing = true;
      ops.pushMessage(taskA, { role: "user", kind: "message", content });
      return new Promise<void>(resolve => {
        resolveSubmit = () => { taskA.requirementProcessing = false; resolve(); };
      });
    });
    const workspace = useAgentWorkspaceStore(pinia);
    workspace.updateServer("server-a", {
      activeTaskId: taskA.id, automationEnabled: true, modelId: "model", draft: "为 A 创建新目标",
    });
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      host.querySelector<HTMLFormElement>(".composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await nextTick();
      expect(submit).toHaveBeenCalledOnce();
      workspace.updateServer("server-a", { activeTaskId: taskB.id });
      await nextTick();
      ops.activeTaskId = child.id;
      resolveSubmit();
      await vi.waitFor(() => expect(submit.mock.settledResults[0]?.type).toBe("fulfilled"));
      expect(workspace.workspaces["server-a"].activeTaskId).toBe(taskB.id);
      expect(host.querySelector(".agent-title-copy small")?.textContent).toBe("Task B");
    } finally { app.unmount(); }
  });

  it("需求分类期间隐藏并拒绝旧的审批、参数和密钥交互", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const task = clarificationTask(ops);
    const provideInput = vi.spyOn(ops, "provideUserInput").mockResolvedValue(true);
    const approvePlan = vi.spyOn(ops, "approvePlan").mockResolvedValue(undefined);
    const approveStep = vi.spyOn(ops, "approveStep").mockResolvedValue(undefined);
    const provideSecret = vi.spyOn(ops, "provideSecret").mockResolvedValue(true);
    const app = mountTask(pinia, task);
    try {
      await nextTick();
      const oldInputForm = host.querySelector<HTMLFormElement>(".user-input-card")!;
      enterClarification("旧参数");
      task.requirementProcessing = true;
      await nextTick();
      expect(host.querySelector(".user-input-card")).toBeNull();
      submitClarification(oldInputForm);
      expect(provideInput).not.toHaveBeenCalled();

      task.requirementProcessing = false;
      task.status = "awaiting_plan_approval";
      task.plan[0].status = "pending";
      await nextTick();
      const oldPlanApprovalButton = host.querySelector<HTMLButtonElement>(".approval-bar .primary")!;
      task.requirementProcessing = true;
      await nextTick();
      expect(host.querySelector(".approval-bar")).toBeNull();
      oldPlanApprovalButton.click();
      expect(approvePlan).not.toHaveBeenCalled();

      task.requirementProcessing = false;
      task.status = "awaiting_step_approval";
      task.plan[0].status = "awaiting_approval";
      await nextTick();
      const oldApprovalButton = host.querySelector<HTMLButtonElement>(".approval-bar .primary")!;
      task.requirementProcessing = true;
      await nextTick();
      expect(host.querySelector(".approval-bar")).toBeNull();
      oldApprovalButton.click();
      expect(approveStep).not.toHaveBeenCalled();

      task.requirementProcessing = false;
      task.status = "awaiting_input";
      task.plan[0].status = "awaiting_input";
      ops.pendingUserInputs = [];
      ops.pendingSecret = {
        taskId: task.id, stepId: task.plan[0].id, key: "TOKEN", label: "令牌",
        description: "输入令牌", unlockDescription: "继续执行",
      };
      await nextTick();
      const oldSecretForm = host.querySelector<HTMLFormElement>(".secret-unlock-card")!;
      const secret = oldSecretForm.querySelector<HTMLInputElement>("input")!;
      secret.value = "secret";
      secret.dispatchEvent(new Event("input", { bubbles: true }));
      task.requirementProcessing = true;
      await nextTick();
      expect(host.querySelector(".secret-unlock-card")).toBeNull();
      oldSecretForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(provideSecret).not.toHaveBeenCalled();
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

  it("同一轮继续与旁问按时间线展示，旧阶段位于继续消息上方", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "awaiting_plan_approval";
    task.currentRoundId = "round-current";
    task.messages = [
      { id: "original", role: "user", kind: "message", content: "部署服务", requirementRelation: "new_goal",
        createdAt: "2026-09-06T01:00:00.000Z" },
      { id: "continue", role: "user", kind: "message", content: "继续执行", requirementRelation: "continue",
        createdAt: "2026-09-06T01:05:00.000Z" },
      { id: "question", role: "user", kind: "message", content: "现在进展如何？", requirementRelation: "side_question",
        createdAt: "2026-09-06T01:06:00.000Z" },
      { id: "answer", role: "assistant", kind: "message", content: "已完成第一阶段。",
        createdAt: "2026-09-06T01:06:01.000Z" },
    ];
    task.phaseHistory = [{
      id: "old-phase", roundId: task.currentRoundId, archivedBeforeMessageId: "continue",
      requirement: "部署服务", reason: "replan", plan: [],
      createdAt: "2026-09-06T01:01:00.000Z", completedAt: task.messages[1].createdAt,
    }];
    task.plan = [{
      id: "new-step", title: "验证服务", description: "检查服务健康状态", command: "systemctl is-active app",
      expected: "服务运行", validation: "", risk: "low", status: "pending",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      const timeline = host.querySelector<HTMLElement>(".agent-timeline")!;
      const children = [...timeline.children];
      const userMessages = [...timeline.querySelectorAll<HTMLElement>(".task-message.user")];
      const original = userMessages.find(element => element.textContent?.includes("部署服务"))!;
      const continuation = userMessages.find(element => element.textContent?.includes("继续执行"))!;
      const question = userMessages.find(element => element.textContent?.includes("现在进展如何？"))!;
      const phase = timeline.querySelector<HTMLElement>(".phase-history-card")!;
      const currentPlan = timeline.querySelector<HTMLElement>(".current-plan-card")!;
      expect(original).toBeDefined();
      expect(continuation).toBeDefined();
      expect(question).toBeDefined();
      expect(children.indexOf(original)).toBeLessThan(children.indexOf(phase));
      expect(children.indexOf(phase)).toBeLessThan(children.indexOf(continuation));
      expect(children.indexOf(continuation)).toBeLessThan(children.indexOf(question));
      expect(children.indexOf(question)).toBeLessThan(children.indexOf(currentPlan));
    } finally { app.unmount(); }
  });

  it("后续补充需求不会丢失上一轮的继续、旁问和回答", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    const archivedMessages: OpsTask["messages"] = [
      { id: "goal", role: "user", kind: "message", content: "部署服务", requirementRelation: "new_goal",
        createdAt: "2026-09-06T01:00:00.000Z" },
      { id: "continue", role: "user", kind: "message", content: "继续执行", requirementRelation: "continue",
        createdAt: "2026-09-06T01:05:00.000Z" },
      { id: "question", role: "user", kind: "message", content: "已经做到哪了？", requirementRelation: "side_question",
        createdAt: "2026-09-06T01:06:00.000Z" },
      { id: "answer", role: "assistant", kind: "message", content: "已完成第一阶段。",
        createdAt: "2026-09-06T01:06:01.000Z" },
    ];
    task.rootGoal = "部署服务";
    task.currentRoundId = "round-supplement";
    task.status = "completed";
    task.messages = [...archivedMessages, {
      id: "supplement", role: "user", kind: "message", content: "再增加健康检查", requirementRelation: "supplement",
      createdAt: "2026-09-06T02:00:00.000Z",
    }];
    task.planHistory = [{
      id: "round-original", roundId: "round-original", requirement: "部署服务", status: "completed", plan: [],
      messages: archivedMessages.map(message => ({ ...message })),
      phases: [{ id: "old-phase", roundId: "round-original", archivedBeforeMessageId: "continue",
        requirement: "部署服务", reason: "replan", plan: [], createdAt: "2026-09-06T01:01:00.000Z",
        completedAt: archivedMessages[1].createdAt }],
      createdAt: archivedMessages[0].createdAt, completedAt: "2026-09-06T01:10:00.000Z",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      const timeline = host.querySelector<HTMLElement>(".agent-timeline")!;
      const texts = [...timeline.querySelectorAll<HTMLElement>(".task-message p")].map(element => element.textContent);
      for (const expected of ["部署服务", "继续执行", "已经做到哪了？", "已完成第一阶段。", "再增加健康检查"]) {
        expect(texts.filter(text => text === expected)).toHaveLength(1);
      }
      const continuation = [...timeline.querySelectorAll<HTMLElement>(".task-message")]
        .find(element => element.querySelector("p")?.textContent === "继续执行")!;
      const phase = timeline.querySelector<HTMLElement>(".phase-history-card")!;
      expect([...timeline.children].indexOf(phase)).toBeLessThan([...timeline.children].indexOf(continuation));
    } finally { app.unmount(); }
  });

  it("已结束任务提交新需求的规划期间把旧计划保留在新消息上方", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "test", provider: "test", model: "test", endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model");
    task.status = "cancelled";
    task.currentRoundId = "round-current";
    task.rootGoal = "部署服务";
    task.messages = [
      { id: "original", role: "user", kind: "message", content: "部署服务", requirementRelation: "new_goal",
        createdAt: "2026-09-06T01:00:00.000Z" },
      { id: "previous-continue", role: "user", kind: "message", content: "继续处理", requirementRelation: "continue",
        createdAt: "2026-09-06T01:02:00.000Z" },
    ];
    task.plan = [{ id: "old-step", title: "未完成步骤", description: "保留原计划", command: "true", expected: "done",
      validation: "", risk: "low", status: "skipped" }];
    // A prior phase may legitimately contain the same persisted step id. Only
    // the phase anchored to this submission can replace the provisional card.
    task.phaseHistory = [{
      id: "previous-phase", roundId: task.currentRoundId,
      requirement: "部署服务", reason: "replan", plan: task.plan.map(step => ({ ...step })),
      createdAt: "2026-09-06T01:01:00.000Z", completedAt: task.messages[1].createdAt,
    }];
    let fail!: () => void;
    let pushSubmittedMessage!: () => void;
    vi.spyOn(ops, "submitRequirement").mockImplementation((_serverId, content) => {
      task.requirementProcessing = true;
      pushSubmittedMessage = () => { ops.pushMessage(task, { role: "user", kind: "message", content }); };
      return new Promise<void>((_resolve, reject) => {
        fail = () => {
          task.requirementProcessing = false;
          reject(new Error("规划服务暂时不可用"));
        };
      });
    });
    useAgentWorkspaceStore(pinia).updateServer("server-a", {
      activeTaskId: task.id, automationEnabled: true, modelId: "model", draft: "继续执行",
    });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await nextTick();
      host.querySelector<HTMLFormElement>(".composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await nextTick();
      const timeline = host.querySelector<HTMLElement>(".agent-timeline")!;
      // Before submitRequirement creates the new message, a legacy phase with
      // no anchor must not satisfy undefined === undefined and hide the snapshot.
      expect(timeline.querySelectorAll(".phase-history-card")).toHaveLength(2);
      expect(timeline.querySelector(".current-plan-card")).toBeNull();
      pushSubmittedMessage();
      await nextTick();
      const phases = [...timeline.querySelectorAll<HTMLElement>(".phase-history-card")];
      const phase = phases[phases.length - 1];
      const continuation = [...timeline.querySelectorAll<HTMLElement>(".task-message.user")]
        .find(element => element.textContent?.includes("继续执行"))!;
      expect(phase).toBeDefined();
      expect(continuation).toBeDefined();
      expect([...timeline.children].indexOf(phase)).toBeLessThan([...timeline.children].indexOf(continuation));
      expect(host.querySelector(".current-plan-card")).toBeNull();
      expect(phases).toHaveLength(2);
      fail();
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("规划服务暂时不可用"));
      expect(host.querySelectorAll(".phase-history-card")).toHaveLength(1);
      expect(host.querySelectorAll(".current-plan-card")).toHaveLength(1);
    } finally { app.unmount(); }
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
    expect(host.textContent).not.toContain("正在重新规划");
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
    expect(host.textContent).toContain("重新规划");
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

    expect(host.textContent).toContain("当前检查结果已保留，后续方案待完善");
    expect(host.textContent).toContain("当前检查结果和已完成步骤已保留");
    expect(host.textContent).not.toContain("生成失败");
    expect(host.textContent).not.toContain("证据校验未通过，任务已暂停");
    expect(host.querySelector(".approval-bar .button.primary")?.textContent).toBe("重试生成计划");
    app.unmount();
  });

  it("旧协议详情不会从阶段、归档总结或归档记录重新显示", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const task = ops.createTask("server-a", "safe", "model-deepseek");
    task.status = "awaiting_plan_approval";
    task.currentRoundId ||= "current-round";
    const diagnostic = "PlanProtocolError: OBSERVE_COMMAND_MUTATION / steps[3].command / PROTOCOL_REPAIR_SCOPE_VIOLATION";
    task.plan = [{
      id: "current-step", kind: "observe", title: "继续检查", description: "读取状态",
      command: "uptime", expected: "返回运行时间", validation: "", risk: "low", status: "pending",
    }];
    task.phaseHistory = [{
      id: "legacy-phase", roundId: task.currentRoundId, requirement: "检查运行状态", reason: "replan",
      plan: [], summary: diagnostic, createdAt: "2026-09-16T23:58:00.000Z", completedAt: "2026-09-16T23:59:00.000Z",
    }];
    task.planHistory = [{
      id: "legacy-round", roundId: "legacy-round-id", requirement: "检查运行状态", status: "needs_adjustment",
      plan: [{
        id: "legacy-step", kind: "observe", title: "检查系统", description: "读取状态",
        command: "hostname", expected: "返回主机名", validation: "", risk: "low", status: "completed",
      }],
      response: { id: "legacy-response", role: "assistant", kind: "summary", content: diagnostic,
        createdAt: "2026-09-16T23:57:00.000Z" },
      records: [{ id: "legacy-record", role: "system", kind: "event", content: diagnostic,
        createdAt: "2026-09-16T23:57:30.000Z" }],
      summary: diagnostic,
      createdAt: "2026-09-16T23:50:00.000Z", completedAt: "2026-09-16T23:59:00.000Z",
    }];
    useAgentWorkspaceStore(pinia).updateServer("server-a", { activeTaskId: task.id, automationEnabled: true });

    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();
    expect(host.textContent).toContain("当前检查结果和已完成步骤已保留");
    expect(host.textContent).not.toContain("OBSERVE_COMMAND_MUTATION");

    host.querySelector<HTMLButtonElement>(".phase-history-head")!.click();
    host.querySelector<HTMLButtonElement>(".archived-plan .archived-head")!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>(".execution-record-card .archived-head")!.click();
    await nextTick();

    expect(host.textContent).not.toContain("PlanProtocolError");
    expect(host.textContent).not.toContain("OBSERVE_COMMAND_MUTATION");
    expect(host.textContent).not.toContain("steps[3].command");
    expect(host.textContent).not.toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
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

    expect(host.textContent).toContain("执行方案待完善");
    expect(host.textContent).toContain("当前检查结果和已完成步骤已保留");
    expect(host.textContent).not.toContain("协议校验");
    expect(host.textContent).toContain("重试生成计划");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("重新规划"))).toBe(false);
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

    expect(host.textContent).toContain("正在重新规划…");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("重新规划"))).toBe(false);

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
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("重新规划"))).toBe(false);
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
      expect(host.querySelector(".approval-bar.warning .button.primary")?.textContent).toContain("重新规划");
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

  it("未登录时展示官方模型登录入口，登录后显示剩余积分", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const catalog = useOfficialCatalogStore(pinia);
    catalog.models = [{ id: "official-trial", name: "OpsArk Trial" }];
    catalog.loaded = true;
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    useAgentWorkspaceStore(pinia).updateServer("server-a", { automationEnabled: true });
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/account", component: { template: "<div/>" } },
    ] });
    await router.push("/");
    const app = createApp(AgentConsole, { serverId: "server-a" }).use(pinia).use(i18n).use(router);
    app.mount(host); await nextTick();

    host.querySelector<HTMLElement>(".composer summary")!.click(); await nextTick();
    const login = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find(option => option.textContent?.includes("OpsArk Trial"))!;
    expect(login.dataset.action).toBe("true");
    login.click(); await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/account"));
    expect(useAgentWorkspaceStore(pinia).ensureServer("server-a").modelId).toBe("");

    useAccountStore(pinia).apply({ user: { id: "member", email: "member@example.test" },
      balance: { available: 11_000, reserved: 0, revision: 1, unit: "tokens" },
      models: [{ id: "official-trial", name: "OpsArk Trial" }], endpoint: "https://zgspace.cn/v1" });
    await nextTick();
    host.querySelector<HTMLElement>(".composer summary")!.click(); await nextTick();
    expect(document.body.textContent).toContain("OpsArk Trial · 剩余 2 积分");
    app.unmount();
  });
});
