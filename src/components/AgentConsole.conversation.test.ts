// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { beginRequirementRound, capturePreviousRound } from "@/features/agent/taskGoal";
import { useOpsStore } from "@/stores/ops";
import type { PlanStep, TaskMessage } from "@/types";

vi.mock("@/components/ModelSettingsModal.vue", () => ({
  default: defineComponent(() => () => h("div")),
}));

import AgentConsole from "./AgentConsole.vue";

const oldRequirement = "分析磁盘空间占用并给出清理方案";
const oldSummary = "磁盘分析结论：剩余28.8GiB，尚未清理任何文件。";
const newRequirement = "拉取 core-case 仓库到 /opt 并进行部署";
const classificationError = "新需求分类失败：字段 /summary 未通过契约校验";

function completedStep(id: string, title: string): PlanStep {
  return {
    id, title, description: title, command: "du -sh /root/.m2", expected: "得到占用明细",
    validation: "", risk: "low", status: "completed", output: "OLD_DISK_OUTPUT",
  };
}

describe("AgentConsole 新需求按对话顺序追加", () => {
  let host: HTMLElement;
  const apps: App[] = [];
  const workspaces: ReturnType<typeof useAgentWorkspaceStore>[] = [];

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    apps.splice(0).forEach(app => app.unmount());
    workspaces.splice(0).forEach(workspace => workspace.persist(true));
    vi.restoreAllMocks();
    host.remove();
  });

  function setup(deferSubmittedMessage = false) {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.models = [{ id: "model", name: "测试模型", provider: "test", model: "test",
      endpoint: "https://example.invalid", enabled: true, hasApiKey: true }];
    ops.modelAvailability.model = { status: "available", reason: "test" };
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    vi.spyOn(ops, "refreshExecutionLedger").mockResolvedValue(undefined);
    const source = ops.createTask("server-a", "managed", "model");
    source.createdAt = "2026-10-28T12:00:00.000Z";
    source.updatedAt = "2026-10-28T12:15:00.000Z";
    source.title = oldRequirement;
    source.rootGoal = oldRequirement;
    source.currentInstruction = oldRequirement;
    source.currentRoundId = "disk-round";
    source.status = "completed";
    source.summary = oldSummary;
    source.messages = [
      { id: "disk-user", role: "user", kind: "message", content: oldRequirement,
        requirementRelation: "new_goal", createdAt: source.createdAt },
      { id: "disk-assistant", role: "assistant", kind: "message", content: "下一阶段计划已生成。",
        createdAt: "2026-10-28T12:14:00.000Z" },
      ...Array.from({ length: 48 }, (_, index): TaskMessage => ({ id: `disk-event-${index}`,
        role: "system", kind: "event", content: `OLD_DISK_EVENT_${index}`,
        createdAt: "2026-10-28T12:14:30.000Z" })),
    ];
    source.plan = [completedStep("disk-step-4", "统计 /root/.m2 占用明细")];
    source.phaseHistory = Array.from({ length: 3 }, (_, index) => ({
      id: `disk-phase-${index + 1}`, roundId: source.currentRoundId!, requirement: oldRequirement,
      reason: "replan" as const, plan: [completedStep(`disk-step-${index + 1}`, `旧阶段 ${index + 1}`)],
      createdAt: `2026-10-28T12:0${index + 1}:00.000Z`,
      completedAt: `2026-10-28T12:0${index + 2}:00.000Z`,
    }));
    let submitted: TaskMessage;
    let submittedContent = newRequirement;
    let resolveSubmission!: () => void;
    function pushSubmittedMessage() {
      submitted = ops.pushMessage(source, { role: "user", kind: "message", content: submittedContent });
      const admission = source.pendingRequirements!.find(item => item.id === "deploy-admission")!;
      admission.sourceMessageId = submitted.id;
      ops.pushMessage(source, { role: "system", kind: "event", content: "NEW_DEPLOY_EVENT：正在理解新需求" });
    }
    const submit = vi.spyOn(ops, "submitRequirement").mockImplementation((_server, content) => {
      source.requirementProcessing = true;
      source.status = "planning";
      submittedContent = content;
      source.pendingRequirements = [{ id: "deploy-admission", content, baseRevision: 0, state: "pending",
        receivedAt: new Date().toISOString() }];
      if (!deferSubmittedMessage) pushSubmittedMessage();
      return new Promise<void>(resolve => { resolveSubmission = resolve; });
    });
    const workspace = useAgentWorkspaceStore(pinia);
    workspaces.push(workspace);
    workspace.updateServer("server-a", { activeTaskId: source.id, automationEnabled: true,
      modelId: "model", permission: "managed", draft: newRequirement });
    const app = createApp(AgentConsole, { serverId: "server-a", active: false }).use(pinia).use(i18n);
    apps.push(app);
    app.mount(host);

    function createChild() {
      const child = ops.createTask("server-a", "managed", "model");
      child.createdAt = "2026-10-28T12:41:00.000Z";
      child.conversationId = source.conversationId ?? source.id;
      child.currentRoundId = "deploy-round";
      child.title = newRequirement;
      child.rootGoal = newRequirement;
      child.currentInstruction = newRequirement;
      child.lastRequirementRelation = "new_goal";
      child.status = "planning";
      child.requirementProcessing = true;
      child.messages = [{ ...submitted, requirementRelation: "new_goal" }];
      child.pendingRequirements = source.pendingRequirements?.map(item => ({ ...item }));
      source.pendingRequirements = undefined;
      source.messages = source.messages.filter(message => message.id !== submitted.id
        && !message.content.startsWith("NEW_DEPLOY_EVENT"));
      source.status = "completed";
      // The same in-flight submit owns source and child until its finally block.
      return child;
    }

    return { ops, source, workspace, submit, createChild, pushSubmittedMessage, resolve: () => resolveSubmission() };
  }

  async function submitComposer() {
    await nextTick();
    host.querySelector<HTMLFormElement>(".composer")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
  }

  function newUserMessage() {
    return [...host.querySelectorAll<HTMLElement>(".task-message.user")]
      .find(element => element.textContent?.includes(newRequirement))!;
  }

  function expectBefore(first: HTMLElement, second: HTMLElement) {
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  function expectOldRoundBeforeNewUser() {
    const summaries = [...host.querySelectorAll<HTMLElement>(".summary-card")]
      .filter(element => element.textContent?.includes(oldSummary));
    expect(summaries).toHaveLength(1);
    expectBefore(summaries[0], newUserMessage());
    const oldPlan = host.querySelector<HTMLElement>(".archived-plan")!;
    expect(oldPlan).not.toBeNull();
    expectBefore(oldPlan, newUserMessage());
    expect(host.querySelectorAll(".phase-history-card")).toHaveLength(3);
    const records = [...host.querySelectorAll<HTMLElement>(".execution-record-card")];
    expect(records).toHaveLength(2);
    expect(records[0].textContent).toContain("48");
    expectBefore(records[0], newUserMessage());
    expect(records[1].textContent).toContain("NEW_DEPLOY_EVENT");
    expect(records[1].textContent).not.toContain("OLD_DISK_EVENT");
    expect(records[1].textContent).not.toContain("48");
  }

  async function failBeforeClassification(context: ReturnType<typeof setup>) {
    context.source.status = "planning_failed";
    context.source.summary = undefined;
    context.source.pauseReason = classificationError;
    context.source.pendingRequirements![0].state = "failed";
    context.source.pendingRequirements![0].error = classificationError;
    context.source.requirementProcessing = false;
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    await nextTick();
  }

  it("规划等待时先固定旧轮次，再追加新需求；子任务创建后无需等待执行结束才切换", async () => {
    const context = setup();
    await submitComposer();
    expect(context.submit).toHaveBeenCalledOnce();
    expectOldRoundBeforeNewUser();
    expect(context.submit.mock.settledResults[0]?.type).toBe("incomplete");

    const child = context.createChild();
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    expect(newUserMessage()).toBeDefined();
    expect(host.textContent?.match(new RegExp(oldSummary, "gu"))).toHaveLength(1);
    expectBefore(host.querySelector<HTMLElement>(".archived-summary")!, newUserMessage());

    child.plan = [{ id: "deploy-clone", title: "克隆 core-case 仓库", description: "部署新项目",
      command: "git clone <repo> /opt/core-case", expected: "仓库存在", validation: "",
      risk: "medium", status: "pending" }];
    child.status = "running";
    await nextTick();
    const currentPlan = host.querySelector<HTMLElement>(".current-plan-card")!;
    expect(currentPlan.textContent).toContain("克隆 core-case 仓库");
    expect(currentPlan.textContent).not.toContain("统计 /root/.m2");
    expectBefore(newUserMessage(), currentPlan);
    expect(context.submit.mock.settledResults[0]?.type).toBe("incomplete");

    child.status = "planning_failed";
    child.pauseReason = "字段 /summary 未通过契约校验，新部署任务已暂停";
    child.requirementProcessing = false;
    await nextTick();
    const failure = [...host.querySelectorAll<HTMLElement>(".summary-card")]
      .find(element => element.textContent?.includes("字段 /summary"))!;
    expectBefore(newUserMessage(), failure);
    expectBefore(host.querySelector<HTMLElement>(".archived-summary")!, newUserMessage());
    context.source.requirementProcessing = false;
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    expect(newUserMessage()).toBeDefined();
  });

  it("用户已切换查看另一任务时，迟到的独立任务与提交完成均不抢回界面", async () => {
    const context = setup();
    await submitComposer();
    const other = context.ops.createTask("server-a", "safe", "model");
    other.title = "用户主动查看的 B 任务";
    other.status = "cancelled";
    context.workspace.updateServer("server-a", { activeTaskId: other.id });
    await nextTick();

    context.createChild();
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(other.id);
    expect(host.querySelector(".agent-title-copy small")?.textContent).toBe(other.title);
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(other.id);
  });

  it("等待凭据时先显示新需求；切走后仍确认真实消息，返回不重复且不恢复自动跟随", async () => {
    const context = setup(true);
    await submitComposer();
    const newUsers = () => [...host.querySelectorAll<HTMLElement>(".task-message.user")]
      .filter(element => element.textContent?.includes(newRequirement));
    expect(newUsers()).toHaveLength(1);
    expectBefore(host.querySelector<HTMLElement>(".archived-summary")!, newUserMessage());
    expect(context.source.messages.some(message => message.content === newRequirement)).toBe(false);

    const other = context.ops.createTask("server-a", "safe", "model");
    other.title = "用户主动查看的 B 任务";
    other.status = "cancelled";
    context.workspace.updateServer("server-a", { activeTaskId: other.id });
    await nextTick();
    // Credentials/session setup completes after the user has left this task.
    context.pushSubmittedMessage();
    await nextTick();
    context.workspace.updateServer("server-a", { activeTaskId: context.source.id });
    await nextTick();
    expect(newUsers()).toHaveLength(1);
    expectBefore(host.querySelector<HTMLElement>(".archived-summary")!, newUserMessage());

    context.createChild();
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(context.source.id);
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(context.source.id);
  });

  it("终止需求后不跟随迟到子任务，也不由迟到提交切换界面", async () => {
    const context = setup();
    vi.spyOn(context.ops, "terminateTask").mockImplementation(async taskId => {
      const task = context.ops.tasks.find(item => item.id === taskId)!;
      task.cancelRequested = true;
      task.status = "cancelled";
      task.requirementProcessing = false;
    });
    await submitComposer();
    host.querySelector<HTMLButtonElement>(".requirement-processing-terminate")!.click();
    await nextTick();
    expect(context.ops.terminateTask).toHaveBeenCalledWith(context.source.id);
    context.createChild();
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(context.source.id);
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(context.source.id);
  });

  it("已跟随子任务后终止的是子任务，迟到提交不再跟随其他任务", async () => {
    const context = setup();
    vi.spyOn(context.ops, "terminateTask").mockImplementation(async taskId => {
      const task = context.ops.tasks.find(item => item.id === taskId)!;
      task.cancelRequested = true;
      task.status = "cancelled";
      task.requirementProcessing = false;
    });
    await submitComposer();
    const child = context.createChild();
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    host.querySelector<HTMLButtonElement>(".requirement-processing-terminate")!.click();
    await nextTick();
    expect(context.ops.terminateTask).toHaveBeenCalledExactlyOnceWith(child.id);

    const late = context.ops.createTask("server-a", "managed", "model");
    late.conversationId = child.conversationId;
    late.lastRequirementRelation = "new_goal";
    late.messages = child.messages.map(message => ({ ...message }));
    late.requirementProcessing = true;
    late.status = "planning";
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    context.resolve();
    await vi.waitFor(() => expect(context.submit.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
  });

  it("分类前失败并完成提交后仍保留旧成功结果，新失败卡只显示重试和结束", async () => {
    const context = setup();
    await submitComposer();
    await failBeforeClassification(context);

    expectOldRoundBeforeNewUser();
    expect(context.source.plan[0].id).toBe("disk-step-4");
    expect(context.source.currentRoundId).toBe("disk-round");
    expect(context.source.summary).toBeUndefined();
    const currentPlan = host.querySelector<HTMLElement>(".current-plan-card")!;
    expect(currentPlan).not.toBeNull();
    expect(currentPlan.querySelectorAll(".plan-step")).toHaveLength(0);
    expect(currentPlan.textContent).toContain(classificationError);
    expect(currentPlan.textContent).not.toContain("统计 /root/.m2 占用明细");
    expect([...currentPlan.querySelectorAll(".approval-bar button")].map(button => button.textContent?.trim()))
      .toEqual(["结束任务", "重试生成计划"]);
    expectBefore(newUserMessage(), currentPlan);
    const newFailure = host.querySelector<HTMLElement>(".summary-planning_failed:not(.archived-summary)")!;
    expect(newFailure.textContent).toContain(classificationError);
    expect(newFailure.textContent).not.toContain(oldSummary);
    expectBefore(newUserMessage(), newFailure);
  });

  it("分类失败后显式重试绑定新消息，及时跟随子任务且旧总结不因源数据清空丢失", async () => {
    const context = setup();
    await submitComposer();
    await failBeforeClassification(context);
    const firstMessageId = context.source.pendingRequirements![0].sourceMessageId;
    let resolveRetry!: () => void;
    const retry = vi.spyOn(context.ops, "retryModelPlanning").mockImplementation(async taskId => {
      expect(taskId).toBe(context.source.id);
      context.source.requirementProcessing = true;
      context.source.status = "planning";
      context.source.pauseReason = undefined;
      context.source.pendingRequirements![0].state = "pending";
      context.source.pendingRequirements![0].error = undefined;
      context.pushSubmittedMessage();
      await new Promise<void>(resolve => { resolveRetry = resolve; });
    });
    host.querySelector<HTMLButtonElement>(".current-plan-card .approval-bar button.primary")!.click();
    await nextTick();
    expect(retry).toHaveBeenCalledExactlyOnceWith(context.source.id);
    expect(context.source.pendingRequirements![0].sourceMessageId).not.toBe(firstMessageId);
    expect(context.source.summary).toBeUndefined();
    expect(host.querySelector(".archived-summary")?.textContent).toContain(oldSummary);

    const child = context.createChild();
    await nextTick();
    expect(retry.mock.settledResults[0]?.type).toBe("incomplete");
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    expect(child.messages[0].id).not.toBe(firstMessageId);
    const oldSummaries = [...host.querySelectorAll<HTMLElement>(".summary-card")]
      .filter(element => element.textContent?.includes(oldSummary));
    expect(oldSummaries).toHaveLength(1);
    expectBefore(oldSummaries[0], newUserMessage());
    const oldRecords = [...host.querySelectorAll<HTMLElement>(".execution-record-card")]
      .filter(element => element.textContent?.includes("48"));
    expect(oldRecords).toHaveLength(1);
    expectBefore(oldRecords[0], newUserMessage());
    context.source.requirementProcessing = false;
    child.requirementProcessing = false;
    resolveRetry();
    await vi.waitFor(() => expect(retry.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(child.id);
    expect(host.querySelector(".archived-summary")?.textContent).toContain(oldSummary);
  });

  it("分类失败后结束当前需求，停止说明显示在新需求之后且旧成功总结保持在前", async () => {
    const context = setup();
    await submitComposer();
    await failBeforeClassification(context);
    const reject = vi.spyOn(context.ops, "rejectTask").mockImplementation(taskId => {
      expect(taskId).toBe(context.source.id);
      context.source.status = "cancelled";
      context.source.summary = "用户已结束当前需求";
      context.source.pauseReason = undefined;
    });
    host.querySelector<HTMLButtonElement>(".current-plan-card .approval-bar button.secondary")!.click();
    await nextTick();
    expect(reject).toHaveBeenCalledExactlyOnceWith(context.source.id);
    const oldResult = host.querySelector<HTMLElement>(".archived-summary")!;
    expect(oldResult.textContent).toContain(oldSummary);
    expectBefore(oldResult, newUserMessage());
    const stopped = host.querySelector<HTMLElement>(".summary-cancelled:not(.archived-summary)")!;
    expect(stopped).not.toBeNull();
    expect(stopped.textContent).toContain("用户已结束当前需求");
    expect(stopped.querySelector(".summary-content")?.textContent?.trim()).not.toBe("");
    expectBefore(newUserMessage(), stopped);
  });

  it("分类失败后重试识别为同任务补充，正式归档仍保留原成功总结并隔离新旧计划", async () => {
    const context = setup();
    await submitComposer();
    await failBeforeClassification(context);
    let finishSupplement!: () => void;
    const retry = vi.spyOn(context.ops, "retryModelPlanning").mockImplementation(async () => {
      // The real store captures the preceding round before appending a retry
      // message. At this point its summary has already been cleared by failure.
      const previous = capturePreviousRound(context.source);
      context.source.requirementProcessing = true;
      context.source.status = "planning";
      context.source.pauseReason = undefined;
      context.source.pendingRequirements![0].state = "pending";
      context.pushSubmittedMessage();
      await new Promise<void>(resolve => {
        finishSupplement = () => {
          const messageId = context.source.pendingRequirements![0].sourceMessageId;
          context.source.messages.find(message => message.id === messageId)!.requirementRelation = "supplement";
          beginRequirementRound(context.source, "deployment-supplement-round", previous);
          context.source.lastRequirementRelation = "supplement";
          context.source.currentInstruction = newRequirement;
          context.source.plan = [{ id: "supplement-check", title: "检查补充部署需求的前置条件",
            description: "新一轮部署计划", command: "git --version", expected: "git 可用",
            validation: "", risk: "low", status: "pending" }];
          context.source.pendingRequirements = undefined;
          context.source.status = "awaiting_plan_approval";
          context.source.requirementProcessing = false;
          resolve();
        };
      });
    });
    host.querySelector<HTMLButtonElement>(".current-plan-card .approval-bar button.primary")!.click();
    await nextTick();
    expect(retry.mock.settledResults[0]?.type).toBe("incomplete");
    finishSupplement();
    await vi.waitFor(() => expect(retry.mock.settledResults[0]?.type).toBe("fulfilled"));
    await nextTick();
    expect(context.workspace.workspaces["server-a"].activeTaskId).toBe(context.source.id);
    expect(context.source.currentRoundId).toBe("deployment-supplement-round");
    expect(context.source.planHistory?.[0].roundId).toBe("disk-round");
    expect(context.source.summary).toBeUndefined();
    const oldResults = [...host.querySelectorAll<HTMLElement>(".summary-card")]
      .filter(element => element.textContent?.includes(oldSummary));
    expect(oldResults).toHaveLength(1);
    const newUsers = [...host.querySelectorAll<HTMLElement>(".task-message.user")]
      .filter(element => element.textContent?.includes(newRequirement));
    const latestUser = newUsers[newUsers.length - 1];
    expectBefore(oldResults[0], latestUser);
    const oldPlan = host.querySelector<HTMLElement>(".archived-plan")!;
    expectBefore(oldPlan, latestUser);
    oldPlan.querySelector<HTMLButtonElement>(".plan-card-head")!.click();
    await nextTick();
    expect(oldPlan.textContent).toContain("统计 /root/.m2 占用明细");
    const newPlan = host.querySelector<HTMLElement>(".current-plan-card")!;
    expect(newPlan.textContent).toContain("检查补充部署需求的前置条件");
    expect(newPlan.textContent).not.toContain("统计 /root/.m2 占用明细");
    expectBefore(latestUser, newPlan);
  });
});
