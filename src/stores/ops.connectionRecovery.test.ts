import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import * as agentService from "@/features/agent/agentService";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { preparePlanForApproval } from "@/features/agent/planPreparation";
import { acceptPreparedPlanApproval } from "@/features/agent/stepApproval";
import { canTransitionTask, transitionTask } from "@/features/agent/taskMachine";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, type ExecutionOperationRecord } from "@/services/executionLedger";
import type { OpsTask, PermissionLevel, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const server: ServerProfile = { id: "connection-target", host: "192.0.2.20", port: 22, username: "fixture",
  name: "恢复测试主机", group: "test", status: "online", environment: [], createdAt: "",
  info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };
const flush = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(permission: PermissionLevel = "managed", command = "df -Pk") {
  const ops = useOpsStore();
  ops.servers = [structuredClone(server)];
  const connections = useConnectionStore();
  await connections.connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
  const generation = connections.state(server.id).generation;
  const step: PlanStep = { id: "pending-resource", action: { type: "shell", command }, kind: "observe", title: "查询容量",
    description: "只读采集", command, validation: "", expected: "取得真实容量", risk: "low", status: "pending" };
  const prepared = preparePlanForApproval([step], { taskId: "connection-task", permission, server: ops.servers[0]!,
    servers: ops.servers, connectionGeneration: generation, requirementRevision: 1 });
  const raw: OpsTask = { id: "connection-task", serverId: server.id, title: "资源巡检", status: "running", permission,
    modelId: "fixture-model", messages: [], plan: structuredClone(prepared.compatibilitySteps), preparedPlan: prepared,
    planApproval: acceptPreparedPlanApproval(prepared, prepared, "user"), currentRoundId: "connection-round", workflowEpoch: 1,
    requirementLifecycle: { version: 1, revision: 1, items: [], focus: { roundId: "connection-round", requirementIds: [] } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  ops.tasks.push(raw);
  const task = ops.tasks.find(item => item.id === raw.id)!;
  // Use the real store preparation context, including its constraint/binding
  // defaults, rather than a subtly different standalone helper fixture.
  const livePrepared = ops.prepareTaskPlan(task);
  task.planApproval = acceptPreparedPlanApproval(livePrepared, livePrepared, "user");
  expect(ops.connectionRecoveryPrepared(task, task.plan[0]!)).toBe(true);
  const repository = createMemoryExecutionLedgerRepository();
  const list = vi.spyOn(repository, "list");
  configureExecutionLedger(ops, repository, async () => "fixture-evidence");
  const realAdvance = ops.advanceTask.bind(ops);
  const advance = vi.spyOn(ops, "advanceTask").mockResolvedValue(undefined);
  const generate = vi.spyOn(ops, "beginAdjustment");
  connections.state(server.id).status = "suspect";
  return { ops, task, connections, repository, list, advance, realAdvance, generate, generation };
}

describe("连接门禁的原计划有限续接生产接线", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T14:00:00Z"));
    localStorage.clear(); setActivePinia(createPinia());
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("unexpected command"));
    vi.spyOn(backend, "executeAgentCommand").mockRejectedValue(new Error("unexpected Agent command"));
    vi.spyOn(backend, "generatePlan").mockResolvedValue([]);
    vi.spyOn(agentService, "decideTaskNextStage").mockRejectedValue(new Error("unexpected business planning"));
  });
  afterEach(async () => {
    useOpsStore().tasks.forEach(task => { task.cancelRequested = true; });
    await vi.advanceTimersByTimeAsync(300); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each(["managed", "safe", "observe"] as const)("%s同代次恢复沿原入口继续一次，保留审批且不生成业务调整", async permission => {
    const { ops, task, connections, advance, generate, list } = await fixture(permission);
    const planIds = task.plan.map(step => step.id), approval = JSON.stringify(task.planApproval);
    expect(ops.pauseTaskForConnection(task)).toBe(true);
    await flush();
    expect(task.connectionRecovery?.state).toBe("waiting");
    expect(task.status).toBe("needs_adjustment");
    connections.state(server.id).status = "connected";
    await Promise.all([ops.queueManagedAdjustment(task.id), ops.requestAdjustment(task.id, true), ops.routeAutomaticAdjustment(task.id)]);
    await vi.advanceTimersByTimeAsync(250);
    expect(advance).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(task.status).toBe("running");
    expect(task.connectionRecovery?.state).toBe("completed");
    expect(task.connectionRecovery?.resumeCount).toBe(1);
    expect(JSON.stringify(task.planApproval)).toBe(approval);
    expect(task.plan.map(step => step.id)).toEqual(planIds);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(generate).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("账本查询尚未返回时只有checking，恢复连接也不能凭pending继续", async () => {
    const { ops, task, connections, list, advance } = await fixture();
    const hold = deferred<ExecutionOperationRecord[]>(); list.mockReturnValueOnce(hold.promise);
    ops.pauseTaskForConnection(task); await flush();
    expect(task.connectionRecovery?.state).toBe("checking");
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(advance).not.toHaveBeenCalled();
    hold.resolve([]); await flush();
    expect(advance).toHaveBeenCalledOnce();
  });

  it("原步骤已有native prepared operation但没有attempt也不能续接", async () => {
    const { ops, task, repository, advance } = await fixture();
    const step = task.plan[0]!;
    await repository.prepare({ version: 1, operationId: "existing-op", taskId: task.id, stepId: step.id,
      roundId: task.currentRoundId, workflowEpoch: 1, planRevision: step.planRevision!, stepRevision: step.stepRevision!,
      intentDigest: step.executionIntent!.digest, intent: step.executionIntent!, phase: "command", effect: "read", resourceKeys: [] });
    ops.pauseTaskForConnection(task); await flush();
    expect(task.connectionRecovery?.stopReason).toBe("operation_present");
    expect(advance).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("读取失败保留unknown和原计划，不启动自动模型", async () => {
    const { ops, task, list, advance } = await fixture();
    list.mockRejectedValue(new Error("persistent ledger unavailable"));
    ops.pauseTaskForConnection(task); await flush();
    expect(task.connectionRecovery?.dispatchState).toBe("unknown");
    expect(task.connectionRecovery?.stopReason).toBe("ledger_unavailable");
    await ops.queueManagedAdjustment(task.id); await ops.requestAdjustment(task.id, true);
    await ops.beginAdjustment(task.id, true); await ops.routeAutomaticAdjustment(task.id);
    expect(advance).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(agentService.decideTaskNextStage).not.toHaveBeenCalled();
  });

  it.each(["target", "generation", "approval", "requirement", "intent", "cancel"])("等待期间%s变化使原回调止步", async change => {
    const { ops, task, connections, advance } = await fixture();
    ops.pauseTaskForConnection(task); await flush();
    if (change === "target") ops.servers[0]!.host = "192.0.2.21";
    if (change === "generation") connections.state(server.id).generation += 1;
    if (change === "approval") task.planApproval = undefined;
    if (change === "requirement") task.requirementLifecycle!.revision += 1;
    if (change === "intent") task.plan[0]!.command = "df -Pi";
    if (change === "cancel") task.cancelRequested = true;
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(250);
    expect(advance).not.toHaveBeenCalled();
    expect(task.connectionRecovery?.state).toBe("stopped");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("60秒后停止，重复入口与恢复序列化记录不续窗口", async () => {
    const { ops, task, advance } = await fixture();
    ops.pauseTaskForConnection(task); await flush();
    const deadline = task.connectionRecovery!.deadlineAt;
    await vi.advanceTimersByTimeAsync(25_000);
    await ops.requestAdjustment(task.id, true);
    expect(task.connectionRecovery!.deadlineAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(task.connectionRecovery?.stopReason).toBe("deadline_expired");
    expect(advance).not.toHaveBeenCalled();
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    await ops.beginAdjustment(task.id, true);
    expect(agentService.decideTaskNextStage).not.toHaveBeenCalled();
  });

  it("普通状态迁移不开放needs_adjustment到running", async () => {
    const { task } = await fixture();
    task.status = "needs_adjustment";
    expect(canTransitionTask("needs_adjustment", "running")).toBe(false);
    expect(() => transitionTask(task, "running")).toThrow("非法任务状态迁移");
  });

  it("恢复实际经过原advance/runStep/持久执行链，仅提交一次原命令", async () => {
    const { ops, task, connections, repository, advance, realAdvance } = await fixture("managed", "printf 'READY\\n'");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, output: "READY\n", exitCode: 0 });
    // The first handoff is the real production executor. Its later final-review
    // advance is held so this test never calls a business model.
    advance.mockImplementationOnce(realAdvance);
    ops.pauseTaskForConnection(task); await flush();
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(backend.executeCommand).mock.calls[0]![0]).toBe("printf 'READY\\n'");
    const records = await repository.list(task.id);
    expect(records.filter(item => item.stepId === "pending-resource" && item.phase === "command")).toHaveLength(1);
    expect(records[0]!.attempts).toHaveLength(1);
    expect(records[0]!.state).toBe("succeeded");
    expect(task.plan[0]!.status).toBe("completed");
    expect(task.connectionRecovery?.resumeCount).toBe(1);
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("等待中的账本迟到响应不能覆盖新轮次或派发新计划", async () => {
    const { ops, task, list, advance } = await fixture();
    const hold = deferred<ExecutionOperationRecord[]>(); list.mockReturnValueOnce(hold.promise);
    ops.pauseTaskForConnection(task); await flush();
    task.workflowEpoch! += 1; task.currentRoundId = "new-round"; task.status = "planning"; task.pauseReason = "正在处理新要求";
    hold.resolve([]); await flush();
    expect(advance).not.toHaveBeenCalled();
    expect(task.status).toBe("planning");
    expect(task.pauseReason).toBe("正在处理新要求");
    expect(task.connectionRecovery?.state).toBe("stopped");
  });

  it("账本第二次读取发现新operation时，不使用首次空快照续接", async () => {
    const { ops, task, connections, list, advance, repository } = await fixture();
    ops.pauseTaskForConnection(task); await flush();
    const step = task.plan[0]!;
    await repository.prepare({ version: 1, operationId: "racing-operation", taskId: task.id, stepId: step.id,
      roundId: task.currentRoundId, workflowEpoch: 1, planRevision: step.planRevision!, stepRevision: step.stepRevision!,
      intentDigest: step.executionIntent!.digest, intent: step.executionIntent!, phase: "command", effect: "read", resourceKeys: [] });
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(250);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(task.connectionRecovery?.stopReason).toBe("operation_present");
    expect(advance).not.toHaveBeenCalled();
  });

  it("停止后用户明确重拟并接纳新计划，同轮后续阶段不受旧记录永久阻断", async () => {
    const { ops, task, connections, list } = await fixture();
    list.mockRejectedValueOnce(new Error("persistent ledger unavailable"));
    ops.pauseTaskForConnection(task); await flush();
    const stopped = task.connectionRecovery!;
    connections.state(server.id).status = "connected";
    const replacement: PlanStep = { id: "newly-admitted-step", kind: "observe", title: "新只读容量检查",
      description: "重新核验容量", action: { type: "shell", command: "df -Pi" }, command: "df -Pi",
      validation: "", expected: "取得容量", risk: "low", status: "pending" };
    vi.mocked(agentService.decideTaskNextStage).mockResolvedValueOnce({ requirement: "重新核验容量", context: {},
      nextPlan: [replacement], complete: false } as Awaited<ReturnType<typeof agentService.decideTaskNextStage>>);
    const approve = vi.spyOn(ops, "approvePlan").mockResolvedValue(undefined);
    await ops.requestAdjustment(task.id, false);
    expect(agentService.decideTaskNextStage).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect(task.plan[0]!.id).toBe(replacement.id);
    expect(task.preparedPlan!.executionDigest).not.toBe(stopped.planExecutionDigest);
    expect(task.connectionRecovery).toEqual(stopped);
    task.planApproval = acceptPreparedPlanApproval(task.preparedPlan!, task.preparedPlan!, "user");
    task.plan[0]!.status = "completed"; task.status = "awaiting_continuation";
    const request = vi.spyOn(ops, "requestAdjustment").mockImplementation(async () => { task.status = "planning"; });
    await ops.queueManagedAdjustment(task.id, 0);
    expect(request).toHaveBeenCalledExactlyOnceWith(task.id, true);
    expect(stopped.state).toBe("stopped");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
