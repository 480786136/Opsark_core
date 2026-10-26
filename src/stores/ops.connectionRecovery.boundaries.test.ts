import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { preparePlanForApproval } from "@/features/agent/planPreparation";
import { acceptPreparedPlanApproval } from "@/features/agent/stepApproval";
import { readExecutionLedger } from "@/features/agent/executionLedgerRecovery";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, type ExecutionOperationRecord } from "@/services/executionLedger";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const server: ServerProfile = { id: "boundary-server", host: "192.0.2.40", port: 22, username: "fixture",
  name: "连接恢复边界夹具", group: "test", status: "online", environment: [], createdAt: "",
  info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };
const flush = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function pendingStep(id = "pending") : PlanStep {
  return { id, action: { type: "shell", command: "df -Pk" }, kind: "observe", title: "当前容量",
    description: "只读采集", command: "df -Pk", validation: "", expected: "取得真实容量", risk: "low", status: "pending" };
}

async function fixture() {
  const ops = useOpsStore(); ops.servers = [structuredClone(server)];
  // A runnable profile prevents a missing-model fallback from hiding a paid-path regression.
  ops.models = [{ id: "fixture-model", name: "本地测量模型", provider: "OpenAI", model: "fixture",
    endpoint: "http://127.0.0.1:1/v1", enabled: true, hasApiKey: true, apiProtocol: "chat_completions" }];
  ops.modelApiKeys["fixture-model"] = "fixture-not-a-real-key";
  const connections = useConnectionStore();
  await connections.connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
  const generation = connections.state(server.id).generation;
  const raw: OpsTask = { id: "boundary-task", serverId: server.id, title: "资源检查", status: "running", permission: "managed",
    modelId: "fixture-model", messages: [], plan: [pendingStep()], currentRoundId: "boundary-round", workflowEpoch: 1,
    credentialRevision: 1, modelTokenBudget: { version: 1, maxTaskTokens: 250000, maxRoundTokens: 250000, coverage: "complete", lockedAt: "2026-10-13T14:00:00Z" },
    requirementLifecycle: { version: 1, revision: 1, items: [], focus: { roundId: "boundary-round", requirementIds: [] } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  ops.tasks.push(raw);
  const task = ops.tasks.find(item => item.id === raw.id)!;
  const prepared = ops.prepareTaskPlan(task);
  task.planApproval = acceptPreparedPlanApproval(prepared, prepared, "user");
  expect(ops.connectionRecoveryPrepared(task, task.plan[0]!)).toBe(true);
  const repository = createMemoryExecutionLedgerRepository();
  const list = vi.spyOn(repository, "list");
  configureExecutionLedger(ops, repository, async () => "fixture-evidence");
  const advance = vi.spyOn(ops, "advanceTask").mockResolvedValue(undefined);
  connections.state(server.id).status = "suspect";
  return { ops, task, connections, generation, repository, list, advance };
}

async function otherOperation(context: Awaited<ReturnType<typeof fixture>>, status: "dispatching" | "unknown") {
  const { task, repository, generation } = context;
  const prepared = preparePlanForApproval([pendingStep("other-unprojected")], { taskId: task.id,
    permission: task.permission, server, servers: [server], connectionGeneration: generation, requirementRevision: 1 });
  const intent = prepared.steps[0]!.intent;
  await repository.prepare({ version: 1, operationId: "other-operation", taskId: task.id, stepId: "other-unprojected",
    roundId: "earlier-round", workflowEpoch: 0, planRevision: prepared.planRevision, stepRevision: prepared.steps[0]!.stepRevision,
    intentDigest: intent.digest, intent, phase: "command", effect: "read", resourceKeys: [] });
  await repository.begin("other-operation", "other-attempt", "other-exec");
  if (status === "unknown") await repository.complete({ operationId: "other-operation", attemptId: "other-attempt", eventId: "unknown-result",
    outcome: { status: "unknown", evidenceRefs: [] } });
  const records = await repository.list(task.id);
  expect(readExecutionLedger(records).compatible).toBe(true);
  expect(records[0]!.state).toBe(status);
  return records;
}

function expectNoRemoteOrModel() {
  expect(backend.generatePlan).not.toHaveBeenCalled();
  expect(backend.decideNextStage).not.toHaveBeenCalled();
  expect(backend.processRequirement).not.toHaveBeenCalled();
  expect(backend.reviewGoal).not.toHaveBeenCalled();
  expect(backend.executeCommand).not.toHaveBeenCalled();
  expect(backend.executeAgentCommand).not.toHaveBeenCalled();
}

describe("连接恢复生产接线的独立边界反例", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T14:00:00Z"));
    localStorage.clear(); setActivePinia(createPinia());
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("禁止真实命令"));
    vi.spyOn(backend, "executeAgentCommand").mockRejectedValue(new Error("禁止真实Agent命令"));
    vi.spyOn(backend, "generatePlan").mockResolvedValue([]);
    vi.spyOn(backend, "decideNextStage").mockRejectedValue(new Error("禁止真实阶段模型"));
    vi.spyOn(backend, "processRequirement").mockRejectedValue(new Error("禁止真实需求模型"));
    vi.spyOn(backend, "reviewGoal").mockRejectedValue(new Error("禁止真实目标模型"));
  });
  afterEach(async () => {
    useOpsStore().tasks.forEach(task => { task.cancelRequested = true; });
    await vi.advanceTimersByTimeAsync(300); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each(["dispatching", "unknown"] as const)("同task另一步%s的新鲜账本事实未投影到缓存也阻止续接", async status => {
    const context = await fixture();
    const { ops, task, connections, repository, advance } = context;
    const records = await otherOperation(context, status);
    expect(task.executionReconciliation).toBeUndefined();
    expect(task.executionLedgerRecovery).toBeUndefined();
    expect(task.plan[0]!.executionLedgerAttempts).toBeUndefined();
    const originalPlan = JSON.stringify(task.plan), originalGrant = JSON.stringify(task.planApproval), originalBudget = JSON.stringify(task.modelTokenBudget);
    ops.pauseTaskForConnection(task); await flush();
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([ops.requestAdjustment(task.id, true), ops.beginAdjustment(task.id, true), ops.queueManagedAdjustment(task.id)]);
    expect(task.connectionRecovery?.state).toBe("stopped");
    expect(task.connectionRecovery?.stopReason).toBe("operation_present");
    expect(task.connectionRecovery?.dispatchState).toBe("unknown");
    expect(advance).not.toHaveBeenCalled();
    expect(JSON.stringify(task.plan)).toBe(originalPlan);
    expect(JSON.stringify(task.planApproval)).toBe(originalGrant);
    expect(JSON.stringify(task.modelTokenBudget)).toBe(originalBudget);
    expect(await repository.list(task.id)).toEqual(records);
    expectNoRemoteOrModel();
  });

  it("真实查询等待五秒超时保持unknown，迟到空列表不会恢复旧续接", async () => {
    const { ops, task, connections, list, advance } = await fixture();
    const hold = deferred<ExecutionOperationRecord[]>(); list.mockReturnValueOnce(hold.promise);
    const grant = JSON.stringify(task.planApproval), budget = JSON.stringify(task.modelTokenBudget);
    ops.pauseTaskForConnection(task); await flush();
    const deadline = task.connectionRecovery!.deadlineAt;
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(5_001);
    expect(task.connectionRecovery).toMatchObject({ state: "stopped", stopReason: "ledger_unavailable", dispatchState: "unknown", resumeCount: 0, deadlineAt: deadline });
    const stoppedMessages = task.messages.length;
    hold.resolve([]); await flush();
    await Promise.all([ops.requestAdjustment(task.id, true), ops.beginAdjustment(task.id, true), ops.queueManagedAdjustment(task.id)]);
    expect(advance).not.toHaveBeenCalled();
    expect(task.messages.length).toBe(stoppedMessages);
    expect(task.connectionRecovery!.deadlineAt).toBe(deadline);
    expect(JSON.stringify(task.planApproval)).toBe(grant);
    expect(JSON.stringify(task.modelTokenBudget)).toBe(budget);
    expectNoRemoteOrModel();
  });

  it.each(["credentialRevision", "permission"] as const)("等待期间%s变化不会复用原审批与续接", async field => {
    const { ops, task, connections, advance } = await fixture();
    ops.pauseTaskForConnection(task); await flush();
    const fingerprint = task.connectionRecovery!.approvalFingerprint;
    if (field === "credentialRevision") task.credentialRevision! += 1;
    else task.permission = "safe";
    connections.state(server.id).status = "connected";
    await vi.advanceTimersByTimeAsync(300);
    expect(task.connectionRecovery?.state).toBe("stopped");
    expect(task.connectionRecovery?.stopReason).toBe(field === "credentialRevision" ? "credential_changed" : "approval_changed");
    expect(task.connectionRecovery?.approvalFingerprint).toBe(fingerprint);
    expect(advance).not.toHaveBeenCalled();
    expectNoRemoteOrModel();
  });

  it("实际缓存恢复保留原窗口并清旧审批，不因重开store继续原待派发步骤", async () => {
    const { ops, task } = await fixture();
    ops.pauseTaskForConnection(task); await flush();
    const saved = JSON.parse(JSON.stringify(task)) as OpsTask;
    const started = saved.connectionRecovery!.startedAt, deadline = saved.connectionRecovery!.deadlineAt;
    task.cancelRequested = true; await vi.advanceTimersByTimeAsync(300);
    localStorage.setItem("opsark.tasks", JSON.stringify([saved]));
    localStorage.setItem("opsark.servers", JSON.stringify([server]));
    setActivePinia(createPinia());
    const restored = useOpsStore();
    const reopened = restored.tasks.find(item => item.id === saved.id)!;
    expect(reopened).toBeDefined();
    expect(reopened.connectionRecovery?.startedAt).toBe(started);
    expect(reopened.connectionRecovery?.deadlineAt).toBe(deadline);
    expect(reopened.preparedPlan).toBeUndefined();
    expect(reopened.planApproval).toBeUndefined();
    expect(reopened.plan[0]!.executionIntent).toBeUndefined();
    expect(reopened.modelTokenBudget).toEqual(saved.modelTokenBudget);
    const connections = useConnectionStore();
    await connections.connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
    const repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(restored, repository, async () => "fixture-evidence");
    const advance = vi.spyOn(restored, "advanceTask").mockResolvedValue(undefined);
    await restored.waitForTaskConnectionRecovery(reopened.id);
    expect(reopened.connectionRecovery?.state).toBe("stopped");
    expect(reopened.connectionRecovery?.deadlineAt).toBe(deadline);
    expect(reopened.planApproval).toBeUndefined();
    expect(advance).not.toHaveBeenCalled();
    expectNoRemoteOrModel();
  });
});
