import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger,
  resetExecutionLedgerForTests } from "@/services/executionLedger";
import { readTaskArchive } from "@/services/taskArchive";
import * as taskArchive from "@/services/taskArchive";
import { mergeTaskRemoteEvidence } from "@/features/agent/taskTerminalEvidence";
import { transitionTask } from "@/features/agent/taskMachine";
import { archiveActivePhase } from "@/features/agent/taskGoal";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";

const server: ServerProfile = { id: "receipt-server", host: "receipt.example.invalid", port: 22, username: "tester",
  name: "终态回执测试", group: "test", status: "offline", environment: [], createdAt: "2026-10-21T00:00:00Z",
  info: { os: "Test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const step = (id: string): PlanStep => ({ id, title: "读取状态", description: "读取状态", kind: "observe", risk: "low",
  status: "pending", action: { type: "shell", command: `printf 'READY-${id}\\n'` }, command: `printf 'READY-${id}\\n'`,
  validation: "", expected: "READY", executionScope: "isolated_exec" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}

describe("终态归档包含已提交的原回执", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "receipt-model", name: "测试", provider: "Test", model: "test", endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys["receipt-model"] = "fixture-only";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, simulated: true, output: "READY", exitCode: 0 });
    vi.spyOn(backend, "validateStep").mockResolvedValue({ passed: true, detail: "READY" });
    vi.spyOn(backend, "reviewStep").mockResolvedValue({ decision: "continue", reason: "证据一致", summary: "完成", source: "model" });
    vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "complete", reason: "目标已验证", summary: "完成", source: "model", steps: [] });
    vi.spyOn(backend, "reviewGoal").mockResolvedValue({ decision: "complete", reason: "目标已验证", summary: "完成", source: "model" });
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture-only" });
  });
  afterEach(async () => {
    const store = useOpsStore(); for (const task of store.tasks) task.cancelRequested = true;
    await store.persist(true); store.stopConnectionMonitor(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
  function setup() {
    const store = useOpsStore(), task = store.createTask(server.id, "safe", "receipt-model");
    task.rootGoal = "读取目标状态"; task.currentRoundId = `round-${task.id}`; task.workflowEpoch = 1;
    task.status = "awaiting_plan_approval"; task.plan = [step("receipt-step")];
    store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal }); store.prepareTaskPlan(task);
    const repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    return { store, task, repository };
  }

  it("最后Shell已commit且后台刷新尚未发生时，最终complete的归档不漏回执", async () => {
    const { store, task } = setup();
    // Model completion is allowed before any background ledger refresh.
    vi.spyOn(store, "refreshExecutionLedger").mockResolvedValue(undefined);
    await store.approvePlan(task.id); await store.persist(true);
    expect(task.status).toBe("completed");
    const records = await listExecutionLedger(store, task.id), archived = await readTaskArchive(task.id);
    const expected = records.flatMap(op => op.attempts.map(a => [op.operationId, a.id, a.status]));
    expect(expected.length).toBeGreaterThan(0);
    expect(archived?.snapshot?.terminalEvidence?.remoteAttempts.map(a => [a.operationId, a.attemptId, a.status])).toEqual(expected);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("同计划多条及跨阶段多轮的原attempt全部保存，重启读取不重发", async () => {
    const { store, task } = setup(), execute = vi.fn(async () => ({ exitCode: 0, output: "READY" }));
    task.status = "running"; task.plan = [step("cpu"), step("memory"), step("disk")]; store.prepareTaskPlan(task);
    for (const item of task.plan) await store.recordStepExecution(task, item, "command", `exec-${item.id}`, () => true, execute);
    archiveActivePhase(task, "adjustment", new Date().toISOString());
    task.currentRoundId = "round-next"; task.workflowEpoch = 2; task.plan = [step("next")]; store.prepareTaskPlan(task);
    await store.recordStepExecution(task, task.plan[0], "command", "exec-next", () => true, execute);
    transitionTask(task, "completed"); await store.persist(true);
    const archived = (await readTaskArchive(task.id))!.snapshot!;
    expect(archived.terminalEvidence!.remoteAttempts).toHaveLength(4);
    expect(archived.terminalEvidence!.remoteAttempts.map(a => a.roundId)).toEqual([`round-${task.id}`, `round-${task.id}`, `round-${task.id}`, "round-next"]);
    localStorage.removeItem("opsark.tasks"); store.tasks = [];
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts).toHaveLength(4);
    expect(execute).toHaveBeenCalledTimes(4); expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)("%s收尾也保留已提交回执", async status => {
    const { store, task } = setup();
    await store.recordStepExecution(task, task.plan[0], "command", "exec-terminal", () => true, async () => ({ exitCode: 1, output: "FAIL", success: false }));
    transitionTask(task, status); await store.persist(true);
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts[0]).toMatchObject({ status: "failed", state: "exit_recorded", exitCode: 1 });
  });

  it("取消并改变需求轮次后迟到回执只补原事实，不完成新步骤", async () => {
    const { store, task } = setup(), returned = deferred<{ exitCode: number }>();
    const original = task.plan[0], pending = store.recordStepExecution(task, original, "command", "late-original", () => task.workflowEpoch === 1, () => returned.promise);
    await vi.waitFor(() => expect(original.executionLedgerAttempts).toHaveLength(1));
    task.cancelRequested = true; task.workflowEpoch = 2; task.currentRoundId = "new-round";
    task.plan = [step("new-step")]; transitionTask(task, "cancelled"); returned.resolve({ exitCode: 130 });
    await expect(pending).rejects.toMatchObject({ stage: "stale_result" });
    expect(task.status).toBe("cancelled"); expect(task.plan[0].status).toBe("pending");
    expect(original.ledgerAppliedAttemptIds).toBeUndefined();
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts[0]).toMatchObject({ roundId: `round-${task.id}`, workflowEpoch: 1, late: true, exitCode: 130 });
  });

  it("成功提交后等待归档期间需求改变也不会应用旧结果", async () => {
    const { store, task } = setup(), held = deferred<void>(); let receiptSaved = false;
    const realArchive = taskArchive.archiveTasks;
    vi.spyOn(taskArchive, "archiveTasks").mockImplementation(async snapshots => {
      if (snapshots.some(t => t.terminalEvidence?.remoteAttempts.some(a => a.resultRecordedAt !== undefined))) {
        receiptSaved = true; await held.promise;
      }
      return realArchive(snapshots);
    });
    const pending = store.recordStepExecution(task, task.plan[0], "command", "commit-then-change", () => task.workflowEpoch === 1, async () => ({ exitCode: 0 }));
    await vi.waitFor(() => expect(receiptSaved).toBe(true)); task.workflowEpoch = 2; held.resolve();
    await expect(pending).rejects.toMatchObject({ stage: "stale_result" });
    expect(task.plan[0].ledgerAppliedAttemptIds).toBeUndefined();
    expect(task.terminalEvidence!.remoteAttempts[0].workflowEpoch).toBe(1);
  });

  it("结构化工具无Shell退出码时保持原语义，旧读取不回退已提交事实", async () => {
    const { store, task, repository } = setup();
    const oldRows: Awaited<ReturnType<typeof listExecutionLedger>> = [];
    const realComplete = repository.complete.bind(repository);
    vi.spyOn(repository, "complete").mockImplementation(async receipt => { oldRows.push(...await repository.list(task.id)); return realComplete(receipt); });
    await store.recordStepExecution(task, task.plan[0], "tool", "structured", () => true, async () => ({ success: true, data: { state: "ok" } }));
    const original = JSON.stringify(task.terminalEvidence!.remoteAttempts);
    expect(task.terminalEvidence!.remoteAttempts[0]).toMatchObject({ state: "pending", status: "succeeded", resultRecordedAt: expect.any(Number) });
    expect(task.terminalEvidence!.remoteAttempts[0].exitCode).toBeUndefined();
    expect(mergeTaskRemoteEvidence(task, oldRows)).toBe(false);
    expect(JSON.stringify(task.terminalEvidence!.remoteAttempts)).toBe(original);
  });

  it("账本list失败时仍从真实commit回执保存汇总，不增加模型或远端调用", async () => {
    const { store, task, repository } = setup(); vi.spyOn(repository, "list").mockRejectedValue(new Error("read unavailable"));
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await store.recordStepExecution(task, task.plan[0], "command", "list-failed", () => true, execute);
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce(); expect(backend.decideNextStage).not.toHaveBeenCalled();
  });

  it("result_commit失败不伪造收据，保存重试后仅投影原attempt", async () => {
    const { store, task, repository } = setup();
    vi.spyOn(repository, "complete").mockRejectedValueOnce(new Error("commit failed"));
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await expect(store.recordStepExecution(task, task.plan[0], "command", "commit-failed", () => true, execute)).rejects.toMatchObject({ stage: "result_commit" });
    expect(task.terminalEvidence?.remoteAttempts ?? []).toHaveLength(0);
    await store.refreshExecutionLedger(task.id);
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts[0]).toMatchObject({ executionId: "commit-failed", exitCode: 0 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["sync", "async"])("归档%s失败提示本地保存问题，重试保存不重发", async kind => {
    const { store, task } = setup(), realArchive = taskArchive.archiveTasks;
    const archive = vi.spyOn(taskArchive, "archiveTasks").mockImplementation(snapshots => {
      if (snapshots.some(t => t.terminalEvidence?.remoteAttempts.length)) {
        if (kind === "sync") throw new Error("archive unavailable");
        return Promise.reject(new Error("archive unavailable"));
      }
      return realArchive(snapshots);
    });
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await expect(store.recordStepExecution(task, task.plan[0], "command", "archive-failed", () => true, execute)).resolves.toEqual({ exitCode: 0 });
    expect(store.persistenceWarning).toContain("归档保存失败");
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("succeeded");
    archive.mockRestore(); await store.persist(true);
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("任务已移除时只保留原账本，不重建任务或归档", async () => {
    const { store, task } = setup(), returned = deferred<{ exitCode: number }>();
    const pending = store.recordStepExecution(task, task.plan[0], "command", "removed-original", () => store.tasks.includes(task), () => returned.promise);
    await vi.waitFor(() => expect(task.plan[0].executionLedgerAttempts).toHaveLength(1));
    store.tasks = []; returned.resolve({ exitCode: 0 });
    await expect(pending).rejects.toMatchObject({ stage: "stale_result" });
    expect(store.tasks).toHaveLength(0); expect((await listExecutionLedger(store, task.id))[0].attempts[0].late).toBe(true);
  });

  it("原生归档队列确实落盘后才交付结果，后续归档不会被旧快照覆盖", async () => {
    const { store, task } = setup(), gate = deferred<void>(); let barrierReached = false, returned = false;
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    const snapshots: typeof task[] = [];
    vi.spyOn(taskArchive, "archiveTasks").mockImplementation(async rows => {
      if (rows.some(t => t.terminalEvidence?.remoteAttempts.some(a => a.resultRecordedAt !== undefined))) {
        barrierReached = true; await gate.promise;
      }
      snapshots.push(...JSON.parse(JSON.stringify(rows)));
    });
    const pending = store.recordStepExecution(task, task.plan[0], "command", "native-barrier", () => true, async () => ({ exitCode: 0 }))
      .then(() => { returned = true; });
    await vi.waitFor(() => expect(barrierReached).toBe(true)); expect(returned).toBe(false);
    gate.resolve(); await pending;
    task.status = "completed"; await store.persist(true);
    expect(snapshots[snapshots.length - 1].status).toBe("completed");
    expect(snapshots[snapshots.length - 1].terminalEvidence!.remoteAttempts[0]).toMatchObject({ executionId: "native-barrier", state: "exit_recorded" });
  });

  it("unknown写操作仅记录原状态，后续尝试仍被账本阻断", async () => {
    const { store, task } = setup();
    task.plan[0].kind = "change"; task.plan[0].risk = "medium"; store.prepareTaskPlan(task);
    const execute = vi.fn(async () => { throw new Error("write response lost"); });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "unknown-original", () => true, execute)).rejects.toMatchObject({ stage: "execution" });
    expect(task.terminalEvidence!.remoteAttempts[0]).toMatchObject({ status: "unknown", state: "pending" });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "unknown-retry", () => true, execute)).rejects.toMatchObject({ stage: "begin" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("unknown原attempt被真实迟到回执细化后只更新事实，不复活取消任务", async () => {
    const { store, task, repository } = setup();
    task.plan[0].kind = "change"; task.plan[0].risk = "medium"; store.prepareTaskPlan(task);
    const execute = vi.fn(async () => { throw new Error("original response unknown"); });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "unknown-then-late", () => true, execute)).rejects.toMatchObject({ stage: "execution" });
    const [operation] = await repository.list(task.id), attempt = operation.attempts[0];
    await repository.cancel(operation.operationId); transitionTask(task, "cancelled"); task.cancelRequested = true;
    await repository.complete({ operationId: operation.operationId, attemptId: attempt.id, eventId: "original-real-late-result", late: true,
      outcome: { status: "succeeded", result: { exitCode: 0, output: "original result" }, evidenceRefs: ["real-late-evidence"] } });
    await store.refreshExecutionLedger(task.id);
    expect(task.status).toBe("cancelled"); expect(task.plan[0].status).toBe("pending");
    expect((await readTaskArchive(task.id))!.snapshot!.terminalEvidence!.remoteAttempts[0]).toMatchObject({
      attemptId: attempt.id, executionId: "unknown-then-late", state: "exit_recorded", status: "succeeded", late: true, cancelRequested: true, exitCode: 0,
    });
    expect(execute).toHaveBeenCalledOnce(); expect((await repository.list(task.id))[0].attempts).toHaveLength(1);
  });
});
