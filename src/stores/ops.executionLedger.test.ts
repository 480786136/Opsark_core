import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger,
  pendingExecutionReceipts, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { directExecutionLedgerOwner, runDirectExecution } from "@/services/directExecutionLedger";
import { executionDigest } from "@/features/agent/planPreparation";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";
import { normalizeOperationsRequest } from "@/features/tools/operationsInspection";

const server: ServerProfile = { id: "ledger-server", host: "ledger.example.invalid", port: 22, username: "tester",
  name: "台账集成测试", group: "test", status: "offline", environment: [], createdAt: "2026-09-26T00:00:00Z",
  info: { os: "Test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const proposal = (): PlanStep => ({ id: "ledger-step", title: "读取状态", description: "读取明确目标的状态",
  action: { type: "shell", command: "printf 'READY\\n'" }, command: "printf 'READY\\n'", validation: "true",
  expected: "READY", kind: "observe", risk: "low", status: "pending", executionScope: "isolated_exec" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
function preparedTask() {
  const store = useOpsStore();
  const task = store.createTask(server.id, "safe", "ledger-model");
  task.rootGoal = "读取目标状态"; task.currentRoundId = `round-${task.id}`; task.workflowEpoch = 1;
  task.status = "awaiting_plan_approval"; task.plan = [proposal()];
  store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  store.prepareTaskPlan(task);
  return { store, task };
}

describe("J2 store dispatch and durable recovery", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "ledger-model", name: "测试", provider: "Test", model: "test", endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys["ledger-model"] = "fixture-only";
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
  afterEach(() => {
    for (const task of useOpsStore().tasks) task.cancelRequested = true;
    useOpsStore().stopConnectionMonitor(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  function inspectionTask() {
    const { store, task } = preparedTask();
    task.plan = [{ ...proposal(), command: "", validation: "", action: { type: "tool", toolId: "files.find_large", arguments: { path: "/srv", maxEntries: 10 } } }];
    store.prepareTaskPlan(task);
    const data = { request: normalizeOperationsRequest("files.find_large", { path: "/srv", maxEntries: 10 }),
      status: "no_match", items: [], scannedEntries: 3, matchedEntries: 0, skippedCount: 0, skipped: [],
      coverageComplete: true, truncated: false, elapsedMs: 1, finishedAt: "2026-09-27T00:00:00Z" };
    return { store, task, data };
  }

  it("J4 registers the approved read intent before sending its probe and records bounded evidence", async () => {
    const { store, task, data } = inspectionTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    vi.mocked(backend.executeCommand).mockImplementation(async (_command, connection, _approval, options) => {
      expect(connection?.host).toBe(server.host);
      const operations = await listExecutionLedger(store, task.id);
      expect(operations).toHaveLength(1);
      expect(task.plan[0].executionIntent?.semantic.effect).toBe("read");
      expect(task.plan[0].executionIntent?.semantic.action).toMatchObject({ type: "tool", toolId: "files.find_large", arguments: data.request });
      expect(options?.executionId).toBe(task.currentExecutionId);
      options?.onProgress?.({ executionId: options.executionId, data: "OPSARK_PROGRESS 3\n", stream: "stderr" });
      return { success: true, simulated: true, output: "merged presentation", stdout: "OPSARK_RESULT " + JSON.stringify(data), exitCode: 0 };
    });
    await store.approvePlan(task.id);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].result?.facts).toMatchObject({ evidenceComplete: true, inspectionStatus: "no_match" });
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("succeeded");
  });

  it("J4 never dispatches when durable registration fails", async () => {
    const { store, task } = inspectionTask(), repository = createMemoryExecutionLedgerRepository();
    vi.spyOn(repository, "prepare").mockRejectedValue(new Error("EXECUTION_LEDGER_STORAGE: disk full"));
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.approvePlan(task.id);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.executionLedgerError?.stage).toBe("prepare");
  });

  it("J4 consumes separate stdout even when the presentation stream is corrupted by progress", async () => {
    const { store, task, data } = inspectionTask();
    const body = { ...data, status: "complete", scannedEntries: 10, matchedEntries: 10,
      items: Array.from({ length: 10 }, (_, i) => ({ kind: "file", subject: `/srv/${"x".repeat(900)}-${i}`, sizeBytes: 200000000, allocatedBytes: 200000000, modifiedAt: 1 })) };
    const stdout = "OPSARK_RESULT " + JSON.stringify(body);
    expect(stdout.length).toBeGreaterThan(8192);
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, exitCode: 0,
      stdout, stderr: "OPSARK_PROGRESS 10\n", output: stdout.slice(0, 8192) + "\nOPSARK_PROGRESS 10\n" + stdout.slice(8192) });
    await store.approvePlan(task.id);
    expect(vi.mocked(backend.executeCommand).mock.calls[0][3]?.captureStreams).toBe(true);
    expect(task.plan[0].status).toBe("completed");
  });

  it("J4 classifies malformed tool output separately and leaves bounded redacted diagnostics", async () => {
    const { store, task } = inspectionTask();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, exitCode: 0,
      stdout: "OPSARK_RESULT {fixture-only malformed", stderr: "fixture-only", output: "presentation" });
    await store.approvePlan(task.id);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.plan[0].result?.facts).toMatchObject({ category: "output", errorCode: "TOOL_OUTPUT", dispatchState: "sent" });
    const log = store.logs.find(item => item.title === "工具输出协议诊断")!;
    expect(log).toBeDefined();
    expect(log.detail).not.toContain("fixture-only");
    expect(log.detail).toContain("stdoutPresent");
  });

  it("J4 stops the same physical probe and records a late result without reviving the task", async () => {
    const { store, task, data } = inspectionTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    const returned = deferred<{ success: boolean; simulated: boolean; output: string; stdout?: string; exitCode: number }>();
    vi.mocked(backend.executeCommand).mockReturnValue(returned.promise);
    vi.spyOn(backend, "cancelCommand").mockResolvedValue(undefined);
    const pending = store.approvePlan(task.id);
    await vi.waitFor(() => expect(backend.executeCommand).toHaveBeenCalledTimes(1));
    const executionId = task.currentExecutionId;
    await store.terminateTask(task.id);
    expect(backend.cancelCommand).toHaveBeenCalledWith(expect.objectContaining({ host: server.host }), executionId);
    returned.resolve({ success: true, simulated: true, output: "merged presentation", stdout: "OPSARK_RESULT " + JSON.stringify(data), exitCode: 0 });
    await pending;
    expect(task.status).toBe("cancelled");
    expect(task.plan[0].status).not.toBe("completed");
    expect((await listExecutionLedger(store, task.id))[0].attempts[0]).toMatchObject({ status: "succeeded", late: true });
  });

  it("does not dispatch backend execution when durable intent registration fails", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    vi.spyOn(repository, "prepare").mockRejectedValue(new Error("EXECUTION_LEDGER_STORAGE: disk full"));
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.approvePlan(task.id);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.executionLedgerError?.stage).toBe("prepare");
    expect(task.executionLedgerError?.remoteResultKnown).toBe(false);
    expect(task.plan[0].result?.executionStatus).not.toBe("failed");
  });

  it("persists a known returned result by storage retry without resending the command", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const complete = vi.spyOn(repository, "complete").mockRejectedValueOnce(new Error("EXECUTION_LEDGER_STORAGE: result commit unavailable"))
      .mockRejectedValueOnce(new Error("EXECUTION_LEDGER_STORAGE: automatic retry unavailable"));
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.approvePlan(task.id);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.executionLedgerError).toMatchObject({ stage: "result_commit", remoteResultKnown: true });
    expect(pendingExecutionReceipts(store, task.id)).toHaveLength(1);
    expect(task.plan[0].result?.executionStatus).not.toBe("failed");
    await store.retryExecutionLedgerStorage(task.id);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(pendingExecutionReceipts(store, task.id)).toHaveLength(0);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("succeeded");
    expect(task.executionLedgerRecovery?.items).toEqual([]);
    expect(task.executionLedgerRecovery?.recordedReads).toHaveLength(1);
  });

  it("automatically retries a captured receipt once without another remote execution", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const complete = vi.spyOn(repository, "complete").mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.approvePlan(task.id);
    await vi.waitFor(() => expect(task.executionLedgerRecovery?.recordedReads).toHaveLength(1));
    expect(pendingExecutionReceipts(store, task.id)).toHaveLength(0);
    expect(task.executionLedgerError).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.status).not.toBe("completed");
  });

  it("records a late result on its original attempt without applying success to a cancelled task", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    const returned = deferred<Awaited<ReturnType<typeof backend.executeCommand>>>();
    vi.mocked(backend.executeCommand).mockReturnValueOnce(returned.promise);
    const pending = store.approvePlan(task.id);
    await vi.waitFor(() => expect(backend.executeCommand).toHaveBeenCalledTimes(1));
    expect(task.plan[0].executionLedgerAttempts).toHaveLength(1);
    store.rejectTask(task.id);
    returned.resolve({ success: true, simulated: true, output: "late READY", exitCode: 0 });
    await pending;
    await store.refreshExecutionLedger(task.id);
    const operations = await listExecutionLedger(store, task.id);
    expect(operations[0].attempts[0]).toMatchObject({ status: "succeeded", late: true });
    expect(task.status).toBe("cancelled");
    expect(task.plan[0].status).not.toBe("completed");
    expect(task.plan[0].ledgerAppliedAttemptIds ?? []).toHaveLength(0);
    expect(task.executionLedgerRecovery?.items).toEqual([]);
    expect(task.executionLedgerRecovery?.recordedReads?.[0]).toMatchObject({ late: true, status: "succeeded" });
  });

  it("refuses to overwrite an unsupported projection version while displaying a read issue", () => {
    localStorage.setItem("opsark.tasks", JSON.stringify({ version: 99, contractVersion: "task-projection@99", tasks: [{ id: "future-task" }] }));
    const original = localStorage.getItem("opsark.tasks");
    setActivePinia(createPinia());
    const store = useOpsStore();
    store.persist(true);
    expect(localStorage.getItem("opsark.tasks")).toBe(original);
    expect(store.taskCacheReadError).toContain("版本");
  });

  it("reconciles a cancelled file transfer with read-only checks of both original endpoints, never retransfers", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const target = { ...structuredClone(server), id: "ledger-target", host: "target.example.invalid", name: "Target" };
    store.servers.push(target);
    await useConnectionStore().connect(target.id, { host: target.host, port: target.port, username: target.username, password: "fixture-only" });
    task.plan = [{ id: "ledger-transfer", title: "传输文件", description: "传输到明确目标", kind: "change", risk: "medium", command: "", validation: "",
      expected: "目标文件与源文件一致", status: "pending", action: { type: "tool", toolId: "files.transfer_between_servers",
        arguments: { sourcePath: "/tmp/source.bin", targetPath: "/tmp/target.bin", targetServer: target.id, overwrite: true } } }];
    store.prepareTaskPlan(task);
    configureExecutionLedger(store, repository, async () => "b".repeat(64));
    await expect(store.recordStepExecution(task, task.plan[0], "tool", "transfer-original", () => true, async () => ({
      success: false, error: { category: "network", dispatchState: "unknown" },
    }))).rejects.toThrow("不确定");
    const original = (await listExecutionLedger(store, task.id))[0], attemptId = original.attempts[0].id;
    task.cancelRequested = true; task.status = "cancelled";
    await store.refreshExecutionLedger(task.id);
    vi.mocked(backend.executeCommand).mockImplementation(async command => ({ success: true, simulated: true, exitCode: 0,
      output: `42\n${"c".repeat(64)}  ${command.includes("source.bin") ? "/tmp/source.bin" : "/tmp/target.bin"}\n42` }));
    const transfer = vi.spyOn(backend, "transferSftpBetweenServers");
    await store.reconcileExecutionAttempt(task.id, attemptId);
    expect(task.executionLedgerRecovery?.error).toBeUndefined();
    expect(backend.executeCommand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(backend.executeCommand).mock.calls.map(call => call[1]?.host)).toEqual([server.host, target.host]);
    expect(transfer).not.toHaveBeenCalled();
    const reconciled = (await listExecutionLedger(store, task.id)).find(operation => operation.operationId === original.operationId)!;
    expect(reconciled.reconciliation).toMatchObject({ status: "completed", reason: "current_state_verified", kind: "file_transfer" });
    expect(reconciled.attempts[0].status).toBe("unknown");
    expect(task.status).toBe("cancelled");
    expect(task.executionLedgerRecovery?.items.filter(item => item.attemptId === attemptId)).toHaveLength(0);
  });

  it("does not release an uncertain transfer when only the source fingerprint matches", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const target = { ...structuredClone(server), id: "ledger-target", host: "target.example.invalid" };
    store.servers.push(target);
    await useConnectionStore().connect(target.id, { host: target.host, port: target.port, username: target.username, password: "fixture-only" });
    task.plan = [{ id: "ledger-transfer", title: "传输文件", description: "文件传输", kind: "change", risk: "medium", command: "", validation: "",
      expected: "文件一致", status: "pending", action: { type: "tool", toolId: "files.transfer_between_servers",
        arguments: { sourcePath: "/tmp/source.bin", targetPath: "/tmp/target.bin", targetServer: target.id, overwrite: true } } }];
    store.prepareTaskPlan(task); configureExecutionLedger(store, repository, async () => "b".repeat(64));
    await expect(store.recordStepExecution(task, task.plan[0], "tool", "transfer-original", () => true, async () => ({
      success: false, error: { category: "network", dispatchState: "unknown" },
    }))).rejects.toThrow();
    const operation = (await listExecutionLedger(store, task.id))[0];
    vi.mocked(backend.executeCommand).mockImplementation(async command => ({ success: true, simulated: true, exitCode: 0,
      output: `42\n${(command.includes("source.bin") ? "c" : "d").repeat(64)}  /file\n42` }));
    await store.reconcileExecutionAttempt(task.id, operation.attempts[0].id);
    expect(task.executionLedgerRecovery?.error).toContain("原执行仍未确认");
    expect((await listExecutionLedger(store, task.id))[0].reconciliation).toBeUndefined();
    expect(task.executionLedgerRecovery?.items.some(item => item.kind === "uncertain")).toBe(true);
  });

  it("does not replay the same changed step after a new round and execution snapshot", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    task.plan = [{ ...proposal(), kind: "change", action: { type: "shell", command: "touch /tmp/ledger-marker" },
      command: "touch /tmp/ledger-marker", validation: "test -f /tmp/ledger-marker", expected: "标记文件存在", risk: "medium" }];
    store.prepareTaskPlan(task); configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.recordStepExecution(task, task.plan[0], "command", "original-change", () => true, async () => ({ success: true, exitCode: 0, output: "" }));
    const originalDigest = task.plan[0].executionIntent!.digest;
    task.currentRoundId = "replacement-round"; task.workflowEpoch = 7;
    task.plan[0].action = { type: "shell", command: "touch /tmp/another-marker" };
    task.plan[0].command = "touch /tmp/another-marker";
    task.plan[0].validation = "test -f /tmp/another-marker";
    task.plan[0].expected = "另一个标记文件存在";
    store.prepareTaskPlan(task);
    expect(task.plan[0].executionIntent!.digest).not.toBe(originalDigest);
    const redispatch = vi.fn(async () => ({ success: true, exitCode: 0, output: "" }));
    await expect(store.recordStepExecution(task, task.plan[0], "command", "new-change", () => true, redispatch)).rejects.toThrow("已有派发记录");
    expect(redispatch).not.toHaveBeenCalled();
    expect((await listExecutionLedger(store, task.id))).toHaveLength(1);
  });

  it("reports acknowledgement storage failure separately and retries without remote replay", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.recordStepExecution(task, task.plan[0], "command", "ack-save-failure", () => true,
      async () => ({ success: true, output: "READY", exitCode: 0 }));
    vi.spyOn(repository, "acknowledge").mockRejectedValueOnce(new Error("storage unavailable"));
    await store.refreshExecutionLedger(task.id);
    expect(task.executionLedgerRecovery?.items[0]).toMatchObject({ kind: "storage_failed", action: "retry_storage" });
    expect(task.executionLedgerRecovery?.items[0].summary).toContain("确认记录保存失败");
    await store.retryExecutionLedgerStorage(task.id);
    expect(task.executionLedgerRecovery?.items).toEqual([]);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("persists review acknowledgement outside task history and keeps it after cache loss", async () => {
    const { store, task } = preparedTask();
    task.plan[0].kind = "change";
    task.plan[0].action = { type: "shell", command: "touch /srv/example" };
    task.plan[0].command = "touch /srv/example";
    store.prepareTaskPlan(task);
    const step = task.plan[0];
    await store.recordStepExecution(task, step, "command", "owned-ack", () => true,
      async () => ({ success: true, output: "created", exitCode: 0 }));
    await store.markExecutionVerified(step);
    const [operation] = await listExecutionLedger(store, task.id);
    expect(operation.attempts[0]).toMatchObject({ projectionAppliedAt: expect.any(Number), reviewCompletedAt: expect.any(Number) });
    task.plan = []; task.phaseHistory = []; task.planHistory = [];
    task.executionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [], error: "旧版本不支持自动对账" };
    await store.refreshExecutionLedger(task.id);
    expect(task.executionLedgerRecovery?.items).toEqual([]);
    expect(task.executionLedgerRecovery?.error).toBeUndefined();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("restores orphaned read evidence without inventing task acceptance or executing it", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.recordStepExecution(task, task.plan[0], "command", "orphan-original", () => true,
      async () => ({ success: true, exitCode: 0, output: "READY" }));
    const intent = JSON.stringify(task.plan[0].executionIntent), taskId = task.id;
    store.tasks = [];
    await store.restoreExecutionLedgerTasks();
    const restored = store.tasks.find(item => item.id === taskId)!;
    expect(restored).toMatchObject({ status: "awaiting_continuation", permission: "observe", serverId: server.id });
    expect(restored.plan).toEqual([]);
    expect(JSON.stringify((await listExecutionLedger(store, taskId))[0].intent)).toBe(intent);
    expect(restored.executionLedgerRecovery?.items).toEqual([]);
    expect(restored.executionLedgerRecovery?.recordedReads).toHaveLength(1);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.reviewStep).not.toHaveBeenCalled();
  });

  it("exposes direct-operation uncertainty after task-cache loss on the uniquely matching server", async () => {
    const store = useOpsStore(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    configureExecutionLedger(directExecutionLedgerOwner, repository, async () => "a".repeat(64));
    await expect(runDirectExecution({ executionId: "direct-orphan-execution", phase: "command",
      action: { type: "shell", command: "touch /tmp/direct-marker" },
      connections: [{ host: server.host, port: server.port, username: server.username, password: "fixture-only" }],
      execute: async () => { throw new Error("SSH connection lost after dispatch"); },
    })).rejects.toThrow("无法确定远端结果");
    await store.restoreExecutionLedgerTasks();
    expect(store.tasks).toHaveLength(1);
    const restored = store.tasks[0];
    expect(restored.id).toMatch(/^direct-/);
    expect(restored.serverId).toBe(server.id);
    expect(restored.plan[0].executionIntent?.semantic.targets[0].serverId).toBeUndefined();
    expect(restored.executionLedgerRecovery?.items[0]).toMatchObject({ kind: "uncertain", action: "none" });
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("retains an old native reconciliation without resolving a new incident created while its commit was pending", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const semantic = { ...task.plan[0].executionIntent!.semantic, kind: "change" as const, effect: "change" as const,
      action: { type: "shell" as const, command: "systemctl start app.service" }, runtimeClass: "persistent_service" as const,
      validator: { type: "service" as const, command: "systemctl is-active app.service", validStates: ["healthy" as const] } };
    task.plan[0].executionIntent = { version: "execution-intent@1", algorithm: "sha256", semantic,
      digest: executionDigest({ version: "execution-intent@1", semantic }) };
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await expect(store.recordStepExecution(task, task.plan[0], "command", "original-service", () => true, async () => ({
      success: false, error: { category: "network", dispatchState: "unknown" },
    }))).rejects.toThrow();
    const original = (await listExecutionLedger(store, task.id))[0];
    task.executionReconciliation = { id: "old-incident", stepId: task.plan[0].id, serverId: server.id, recordedAt: "old", command: "old", expected: "active", knownStepIds: [], reason: "unknown" };
    const commit = deferred<void>(), realResolve = repository.resolve!.bind(repository);
    const resolving = vi.spyOn(repository, "resolve").mockImplementation(async (...args) => { await commit.promise; return realResolve(...args); });
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, exitCode: 0, output: "active" });
    const pending = store.reconcileExecutionAttempt(task.id, original.attempts[0].id);
    await vi.waitFor(() => expect(resolving).toHaveBeenCalledOnce());
    task.workflowEpoch = 9; task.currentRoundId = "new-business-round"; task.plan = [{ ...proposal(), id: "new-step" }];
    const nextIncident = { id: "new-incident", stepId: "new-step", serverId: server.id, recordedAt: "new", command: "new", expected: "new", knownStepIds: [], reason: "new unknown" };
    task.executionReconciliation = nextIncident;
    task.executionLedgerError = { stage: "new-context", message: "preserve new blocker", remoteResultKnown: false };
    commit.resolve(); await pending;
    expect(task.executionReconciliation).toEqual(nextIncident);
    expect(task.executionReconciliation.resolution).toBeUndefined();
    expect(task.executionLedgerError?.message).toBe("preserve new blocker");
    expect((await listExecutionLedger(store, task.id))[0].reconciliation?.status).toBe("completed");
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.messages.some(message => message.content.includes("只读证据已确认当前状态"))).toBe(false);
  });

  it("does not apply an old ledger read when execution starts before that read returns", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    const oldListing = deferred<Awaited<ReturnType<typeof repository.list>>>();
    vi.spyOn(repository, "list").mockReturnValueOnce(oldListing.promise);
    const refresh = store.refreshExecutionLedger(task.id);
    const returned = deferred<Awaited<ReturnType<typeof backend.executeCommand>>>();
    vi.mocked(backend.executeCommand).mockReturnValueOnce(returned.promise);
    const running = store.approvePlan(task.id);
    await vi.waitFor(() => expect(backend.executeCommand).toHaveBeenCalledOnce());
    oldListing.resolve([]); await refresh;
    expect(task.executionLedgerRecovery?.items ?? []).toHaveLength(0);
    returned.resolve({ success: true, simulated: true, output: "READY", exitCode: 0 });
    await running;
    await store.refreshExecutionLedger(task.id);
    expect(task.status).toBe("completed");
    expect(task.executionLedgerRecovery?.items ?? []).toHaveLength(0);
    expect((await listExecutionLedger(store, task.id))[0].attempts[0].status).toBe("succeeded");
  });
});
