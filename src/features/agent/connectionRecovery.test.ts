import { describe, expect, it } from "vitest";
import { preparePlanForApproval } from "./planPreparation";
import { acceptPreparedPlanApproval } from "./stepApproval";
import {
  CONNECTION_RECOVERY_WINDOW_MS, captureConnectionRecovery, createConnectionRecovery, decideConnectionRecovery,
  hasActiveConnectionRecovery, type ConnectionRecoveryInput,
} from "./connectionRecovery";
import type { ConnectionRecoveryDecisionCode, OpsTask, PlanStep, ServerProfile, TaskConnectionRecovery } from "@/types";

const START = 1_790_000_000_000;
function fixture() {
  const server: ServerProfile = {
    id: "server", host: "192.0.2.12", port: 22, username: "operator", name: "演示主机",
    group: "", status: "online", environment: [], createdAt: "",
    info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" },
  };
  const step: PlanStep = { id: "resource", action: { type: "shell", command: "df -Pk" }, kind: "observe",
    command: "df -Pk", title: "检查容量", description: "只读检查", expected: "取得当前容量",
    validation: "", status: "pending", risk: "low" };
  const prepared = preparePlanForApproval([step], {
    taskId: "task", requirementRevision: 4, permission: "managed", server, servers: [server], connectionGeneration: 2,
  });
  const task: OpsTask = { id: "task", serverId: server.id, title: "巡检", status: "running", permission: "managed",
    modelId: "model", messages: [], plan: structuredClone(prepared.compatibilitySteps),
    preparedPlan: prepared, planApproval: acceptPreparedPlanApproval(prepared, prepared, "policy"),
    currentRoundId: "round", workflowEpoch: 3, credentialRevision: 2,
    requirementLifecycle: { version: 1, revision: 4, items: [], focus: { roundId: "round", requirementIds: [] } },
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };
  const input: ConnectionRecoveryInput & { step: PlanStep; connectionReady: boolean } = {
    task, step: task.plan[0]!, target: { serverId: server.id, host: server.host, port: server.port, username: server.username, generation: 2 },
    now: START, dispatchState: "not_dispatched", operationPresent: false, preparedCurrent: true, connectionReady: false,
  };
  const record = createConnectionRecovery(input);
  expect(record.state).toBe("waiting");
  return { task, input, record };
}

describe("未派发步骤的有界连接恢复判定", () => {
  it("同目标同代次短暂不可用先等待，恢复后仅建议沿原批准入口继续", () => {
    const { task, input, record } = fixture();
    const before = JSON.stringify(task);
    expect(decideConnectionRecovery(record, { ...input, now: START + 10_000 })).toEqual({ action: "wait", code: "waiting_for_connection" });
    expect(decideConnectionRecovery(record, { ...input, now: START + 11_000, connectionReady: true })).toEqual({ action: "resume", code: "ready_to_resume" });
    expect(JSON.stringify(task)).toBe(before);
    expect(record.resumeCount).toBe(0);
  });

  it("异步查询前只捕获原身份及窗口，checking即使连接和账本已可用也不能直接resume", () => {
    const { input } = fixture();
    const record = captureConnectionRecovery(input);
    expect(record).toMatchObject({ state: "checking", dispatchState: "unknown", startedAt: START, deadlineAt: START + 60_000 });
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true })).toEqual({ action: "wait", code: "checking_dispatch" });
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true, operationPresent: undefined, dispatchState: undefined }).action).toBe("wait");
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true, operationPresent: true }).code).toBe("operation_present");
    // Only the owner with a fresh successful lookup can propose this state change.
    const checked: TaskConnectionRecovery = { ...record, state: "waiting", dispatchState: "not_dispatched" };
    expect(decideConnectionRecovery(checked, { ...input, connectionReady: true }).action).toBe("resume");
    expect(decideConnectionRecovery(checked, { ...input, connectionReady: true, operationPresent: undefined }).code).toBe("dispatch_unknown");
  });

  it("异步查询期间变更需求/授权不能确认旧捕获；恢复重读保留原窗口", () => {
    const { input } = fixture();
    const captured = captureConnectionRecovery(input);
    const checked: TaskConnectionRecovery = { ...captured, state: "waiting", dispatchState: "not_dispatched" };
    const reread = captureConnectionRecovery({ ...input, now: START + 10_000, previous: captured });
    expect(reread.startedAt).toBe(START);
    expect(reread.deadlineAt).toBe(captured.deadlineAt);
    input.task.planApproval = undefined;
    expect(decideConnectionRecovery(checked, { ...input, connectionReady: true }).code).toBe("approval_changed");
    expect(captureConnectionRecovery({ ...input, now: START + 20_000, previous: captured }).state).toBe("stopped");
    input.task.requirementLifecycle!.revision += 1;
    expect(decideConnectionRecovery(captured, { ...input, connectionReady: true }).code).toBe("requirements_changed");
  });

  it("保存60秒原窗口，重复进入和JSON恢复均不能延长，已知更早期限优先", () => {
    const { input, record } = fixture();
    expect(record.deadlineAt).toBe(START + CONNECTION_RECOVERY_WINDOW_MS);
    const restored: TaskConnectionRecovery = JSON.parse(JSON.stringify(record));
    const repeated = createConnectionRecovery({ ...input, now: START + 25_000, previous: restored, totalDeadlineAt: START + 100_000 });
    expect(repeated.startedAt).toBe(START);
    expect(repeated.deadlineAt).toBe(record.deadlineAt);
    expect(restored).toEqual(record);
    const shorter = createConnectionRecovery({ ...input, previous: record, totalDeadlineAt: START + 20_000 });
    expect(shorter.deadlineAt).toBe(START + 20_000);
    expect(decideConnectionRecovery(shorter, { ...input, now: START + 20_000, connectionReady: true }).code).toBe("deadline_expired");
    expect(createConnectionRecovery({ ...input, totalDeadlineAt: START + 5_000 }).deadlineAt).toBe(START + 5_000);
  });

  it.each([
    ["取消", (i: ConnectionRecoveryInput) => { i.task.cancelRequested = true; }, "cancelled"],
    ["目标已取消", (i: ConnectionRecoveryInput) => { i.task.goalCancellation = { reason: "user_cancelled", at: "now" }; }, "cancelled"],
    ["任务已完成", (i: ConnectionRecoveryInput) => { i.task.status = "completed"; }, "task_inactive"],
    ["轮次变化", (i: ConnectionRecoveryInput) => { i.task.currentRoundId = "new-round"; }, "context_changed"],
    ["任务变化", (i: ConnectionRecoveryInput) => { i.task.id = "other-task"; }, "context_changed"],
    ["流程代次变化", (i: ConnectionRecoveryInput) => { i.task.workflowEpoch! += 1; }, "context_changed"],
    ["需求修订", (i: ConnectionRecoveryInput) => { i.task.requirementLifecycle!.revision += 1; }, "requirements_changed"],
    ["需求分类在途", (i: ConnectionRecoveryInput) => { i.task.requirementProcessing = true; }, "requirements_changed"],
    ["未分类新指令", (i: ConnectionRecoveryInput) => { i.task.pendingRequirements = [{ id: "new", content: "安装软件", baseRevision: 4, state: "pending", receivedAt: "now" }]; }, "requirements_changed"],
    ["切换执行目标", (i: ConnectionRecoveryInput) => { i.task.executionTargetServerId = "other"; }, "target_changed"],
    ["同ID换host", (i: ConnectionRecoveryInput) => { i.target.host = "192.0.2.13"; }, "target_changed"],
    ["同ID换port", (i: ConnectionRecoveryInput) => { i.target.port = 2222; }, "target_changed"],
    ["同ID换username", (i: ConnectionRecoveryInput) => { i.target.username = "other"; }, "target_changed"],
    ["连接代次变化", (i: ConnectionRecoveryInput) => { i.target.generation += 1; }, "generation_changed"],
    ["凭据修订", (i: ConnectionRecoveryInput) => { i.task.credentialRevision! += 1; }, "credential_changed"],
    ["权限改变", (i: ConnectionRecoveryInput) => { i.task.permission = "safe"; }, "approval_changed"],
    ["审批撤销", (i: ConnectionRecoveryInput) => { i.task.planApproval = undefined; }, "approval_changed"],
    ["审批重签", (i: ConnectionRecoveryInput) => { i.task.planApproval!.grantedAt = "new"; }, "approval_changed"],
    ["步骤审批变化", (i: ConnectionRecoveryInput) => { i.step!.approvalGrant = { ...i.task.planApproval!, scope: "step", stepRevision: 1 }; }, "approval_changed"],
    ["步骤修订", (i: ConnectionRecoveryInput) => { i.step!.stepRevision! += 1; }, "plan_changed"],
    ["计划修订", (i: ConnectionRecoveryInput) => { i.step!.planRevision! += 1; }, "plan_changed"],
    ["实时提案改变", (i: ConnectionRecoveryInput) => { i.step!.command = "df -Pi"; }, "prepared_not_current"],
    ["实际提案回验失败", (i: ConnectionRecoveryInput) => { i.preparedCurrent = false; }, "prepared_not_current"],
    ["待用户确认", (i: ConnectionRecoveryInput) => { i.step!.status = "awaiting_approval"; }, "step_not_pending"],
    ["步骤运行中", (i: ConnectionRecoveryInput) => { i.step!.status = "running"; }, "step_not_pending"],
    ["有真实操作", (i: ConnectionRecoveryInput) => { i.operationPresent = true; }, "operation_present"],
    ["记录已有attempt", (i: ConnectionRecoveryInput) => { i.step!.executionLedgerAttempts = [{ operationId: "old", attemptId: "attempt", executionId: "exec", phase: "command" }]; }, "operation_present"],
    ["账本结果缺失", (i: ConnectionRecoveryInput) => { i.operationPresent = undefined; }, "dispatch_unknown"],
    ["派发证明缺失", (i: ConnectionRecoveryInput) => { i.dispatchState = undefined; }, "dispatch_unknown"],
    ["派发未知", (i: ConnectionRecoveryInput) => { i.dispatchState = "unknown"; }, "dispatch_unknown"],
    ["另有运行操作", (i: ConnectionRecoveryInput) => { i.task.currentExecutionId = "exec"; }, "dispatch_unknown"],
    ["已固定执行时限", (i: ConnectionRecoveryInput) => { i.step!.executionPolicy = { version: 1, executionId: "exec", kind: "bounded", startedAt: START }; }, "dispatch_unknown"],
    ["账本读取在途", (i: ConnectionRecoveryInput) => { i.task.executionLedgerLoading = true; }, "ledger_unavailable"],
    ["账本读取失败", (i: ConnectionRecoveryInput) => { i.task.executionLedgerError = { stage: "read", message: "unavailable", remoteResultKnown: false }; }, "ledger_unavailable"],
  ] as Array<[string, (input: ConnectionRecoveryInput) => void, ConnectionRecoveryDecisionCode]>)("%s时不自动续接", (_name, mutate, code) => {
    const { input, record } = fixture();
    mutate(input);
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true })).toEqual({ action: "stop", code });
  });

  it("恢复前出现其他等待步骤或原前置重新打开时停止，不跳过现有步骤", () => {
    const { input, record } = fixture();
    input.task.plan.push({ ...input.step, id: "waiting", status: "awaiting_input" } as PlanStep);
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true }).code).toBe("preconditions_changed");
    input.task.plan = [{ ...input.step, id: "earlier", status: "pending" } as PlanStep, input.step!];
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true }).code).toBe("step_not_pending");
  });

  it("未核对的原操作始终阻断，即使连接恢复也不自动重放", () => {
    const { input, record } = fixture();
    input.task.executionReconciliation = { id: "unknown", stepId: "old", serverId: "server", recordedAt: "now", command: "old command",
      expected: "unknown", knownStepIds: ["old"], reason: "submitted" };
    expect(decideConnectionRecovery(record, { ...input, connectionReady: true }).code).toBe("dispatch_unknown");
  });

  it.each(["stopped", "completed", "resuming"] as const)("%s记录不再次自动续接或生成窗口", state => {
    const { input, record } = fixture();
    const previous: TaskConnectionRecovery = { ...record, state, resumeCount: 1, ...(state === "stopped" ? { stopReason: "generation_changed" as const } : {}) };
    expect(decideConnectionRecovery(previous, { ...input, connectionReady: true }).action).toBe("stop");
    expect(createConnectionRecovery({ ...input, now: START + 1000, previous }).deadlineAt).toBe(record.deadlineAt);
  });

  it("窗口到期或时钟回退均不能通过；持久记录不能携带无限、非法或扩展期限", () => {
    const { input, record } = fixture();
    expect(decideConnectionRecovery(record, { ...input, now: record.deadlineAt, connectionReady: true }).code).toBe("deadline_expired");
    expect(decideConnectionRecovery(record, { ...input, now: START - 1, connectionReady: true }).code).toBe("invalid_recovery");
    for (const invalid of [{ ...record, deadlineAt: Number.POSITIVE_INFINITY }, { ...record, deadlineAt: START + 60_001 },
      { ...record, resumeCount: -1 }, { ...record, intentDigest: "unverified" }]) {
      expect(decideConnectionRecovery(invalid, { ...input, connectionReady: true }).code).toBe("invalid_recovery");
    }
    expect(createConnectionRecovery({ ...input, totalDeadlineAt: Number.NaN }).state).toBe("stopped");
  });

  it("创建时缺少真实未派发证明、审批或当前准备状态即停止", () => {
    const { input } = fixture();
    expect(createConnectionRecovery({ ...input, operationPresent: undefined }).stopReason).toBe("dispatch_unknown");
    expect(createConnectionRecovery({ ...input, dispatchState: undefined }).stopReason).toBe("dispatch_unknown");
    expect(createConnectionRecovery({ ...input, preparedCurrent: false }).stopReason).toBe("prepared_not_current");
    input.task.planApproval = undefined;
    expect(createConnectionRecovery(input).stopReason).toBe("approval_changed");
  });

  it("新发现代次改变立即停原窗口，不因重新进入又获一次自动恢复", () => {
    const { input, record } = fixture();
    const stopped = createConnectionRecovery({ ...input, previous: record, reasonCode: "connection_generation_changed" });
    expect(stopped.state).toBe("stopped");
    expect(stopped.stopReason).toBe("generation_changed");
    expect(stopped.deadlineAt).toBe(record.deadlineAt);
  });

  it("只持久公开审批身份摘要，不保存附加凭据、原文或整步，预算模型账本不变", () => {
    const { input, record } = fixture();
    Object.assign(input.task.planApproval!, { password: "private-marker", userInput: "do-not-persist" });
    Object.assign(input.target, { password: "target-private-marker", rawInput: "raw-do-not-persist" });
    input.task.modelTokenBudget = { version: 1, maxTaskTokens: 250000, maxRoundTokens: 250000, coverage: "complete", lockedAt: "now" };
    const budget = JSON.stringify(input.task.modelTokenBudget);
    const next = createConnectionRecovery(input);
    expect(next.approvalFingerprint).toBe(record.approvalFingerprint);
    expect(JSON.stringify(next)).not.toMatch(/private-marker|do-not-persist|df -Pk/);
    const captured = captureConnectionRecovery(input);
    Object.assign(captured, { rawInput: "copied-do-not-persist" });
    Object.assign(captured.target, { password: "copied-private-marker" });
    const restored = captureConnectionRecovery({ ...input, previous: captured });
    expect(JSON.stringify(restored)).not.toMatch(/private-marker|do-not-persist|df -Pk/);
    expect(JSON.stringify(input.task.modelTokenBudget)).toBe(budget);
  });

  it("活动分类只认本task/round/epoch，不认终态旧记录", () => {
    const { task, record } = fixture();
    task.connectionRecovery = record;
    expect(hasActiveConnectionRecovery(task)).toBe(true);
    task.currentRoundId = "other";
    expect(hasActiveConnectionRecovery(task)).toBe(false);
    task.currentRoundId = "round";
    task.connectionRecovery.state = "completed";
    expect(hasActiveConnectionRecovery(task)).toBe(false);
  });
});
