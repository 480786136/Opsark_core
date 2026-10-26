import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger,
  pendingExecutionReceipts, resetExecutionLedgerForTests, runRecordedExecution } from "@/services/executionLedger";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { directExecutionLedgerOwner, runDirectExecution } from "@/services/directExecutionLedger";
import { executionDigest } from "@/features/agent/planPreparation";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";
import { normalizeOperationsRequest } from "@/features/tools/operationsInspection";
import { boundedFileAppendContract } from "@/features/agent/boundedFileReconciliation";
import { normalizeSshCommandInvokeError } from "@/services/sshCommandTransport";

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
const preflightError = () => normalizeSshCommandInvokeError("OPSARK_SSH_EXEC_PREFLIGHT_V1:" + JSON.stringify({
  version: 1, origin: "core", code: "SSH_EXEC_PAYLOAD_TOO_LARGE", stage: "exec_preflight",
  dispatchCertainty: "not_dispatched", retryable: false, payloadBytes: 40000, payloadLimitExclusive: 34744,
}));
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

  async function uncertainAppendTask() {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const command = "set -eu\nf='/tmp/record'\nb='/tmp/backup'\nprintf '%s\\n' 'old' | cmp - \"$f\"\ntest ! -e \"$b\"\ncp -p -- \"$f\" \"$b\"\nprintf '%s\\n' 'new' >> \"$f\"";
    task.plan = [{ ...proposal(), title: "备份并追加一条记录", kind: "change", risk: "medium", runtimeClass: "bounded",
      command, action: { type: "shell", command }, expected: "原记录完整保留且仅追加一次" }];
    store.prepareTaskPlan(task);
    configureExecutionLedger(store, repository, async (_taskId, evidence) => executionDigest(evidence));
    const execute = vi.fn(async () => { throw new Error("transport lost after append"); });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "append-original", () => true, execute)).rejects.toThrow();
    task.status = "needs_adjustment"; task.plan[0].status = "failed";
    task.executionReconciliation = { id: "append-incident", stepId: task.plan[0].id, serverId: server.id,
      recordedAt: new Date().toISOString(), command, expected: task.plan[0].expected, knownStepIds: [], reason: "回执丢失" };
    const original = (await listExecutionLedger(store, task.id))[0];
    const c = boundedFileAppendContract(original.intent.semantic)!;
    const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const stdout = ["OPSARK_BOUNDED_FILE_V1", "append-original", c.commandSha256, boot, "812", "731", "0", "CURRENT_BOOT", boot,
      "PROCESS_GROUPS", "1", "900", "FILE_DIGESTS", `${c.afterSha256}  /tmp/record`, `${c.beforeSha256}  /tmp/backup`,
      `${c.afterSha256}  /tmp/record`, `${c.beforeSha256}  /tmp/backup`, "END"].join("\n");
    return { store, task, repository, original, execute, stdout };
  }

  it("records trusted native rejection for an Agent command without losing the bounded diagnostic", async () => {
    const { store, task } = preparedTask();
    const execute = vi.fn(async () => { throw preflightError(); });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "native-rejected-command", () => true, execute))
      .rejects.toMatchObject({ name: "SshExecPayloadError", code: "SSH_EXEC_PAYLOAD_TOO_LARGE" });
    const [record] = await listExecutionLedger(store, task.id);
    expect(record).toMatchObject({ state: "not_dispatched", attempts: [{ status: "not_dispatched", outcome: {
      result: { error: { diagnostic: { payloadBytes: 40000, dispatchCertainty: "not_dispatched" } } },
    } }] });
    expect(record.attempts[0].outcome?.evidenceRefs).toHaveLength(1); expect(execute).toHaveBeenCalledOnce();
  });

  it("propagates native preflight through the real tool adapter to Agent operation and evidence", async () => {
    const { store, task } = inspectionTask();
    vi.mocked(backend.executeCommand).mockRejectedValue(preflightError());
    const call = { id: "native-rejected-tool", toolId: "files.find_large", arguments: { path: "/srv", maxEntries: 10 } };
    const result = await store.recordStepExecution(task, task.plan[0], "tool", call.id, () => true,
      () => store.executeToolCall(server.id, call));
    expect(result).toMatchObject({ success: false, error: { code: "SSH_EXEC_PAYLOAD_TOO_LARGE", category: "unavailable",
      dispatchState: "not_sent" }, data: { dispatchPreflight: { payloadBytes: 40000, retryable: false } } });
    const [record] = await listExecutionLedger(store, task.id);
    expect(record).toMatchObject({ state: "not_dispatched", attempts: [{ status: "not_dispatched", outcome: {
      result: { error: { code: "SSH_EXEC_PAYLOAD_TOO_LARGE", dispatchState: "not_sent" },
        data: { dispatchPreflight: { payloadBytes: 40000 } } },
    } }] });
    expect(record.attempts).toHaveLength(1); expect(backend.executeCommand).toHaveBeenCalledOnce();
  });

  it.each(["PROBE_DECODER_UNAVAILABLE", "PROBE_SOURCE_INVALID"] as const)(
    "preserves an actual remote decoder failure as sent/failed: %s", async code => {
      const { store, task } = inspectionTask();
      const stdout = "OPSARK_PROBE_DELIVERY " + JSON.stringify({ version: 1, code,
        stage: code === "PROBE_DECODER_UNAVAILABLE" ? "decoder_import" : "source_decode" }) + "\n";
      vi.mocked(backend.executeCommand).mockResolvedValue({ success: false, simulated: false, output: "delivery failed",
        stdout, stderr: "", stdoutTruncated: false, exitCode: 125 });
      const call = { id: "decoder-rejected", toolId: "files.find_large", arguments: { path: "/srv", maxEntries: 10 } };
      const result = await store.recordStepExecution(task, task.plan[0], "tool", call.id, () => true,
        () => store.executeToolCall(server.id, call));
      expect(result).toMatchObject({ success: false, error: { code, dispatchState: "sent" } });
      expect(JSON.stringify(result.data)).toContain("125");
      expect(JSON.stringify(result.data)).toContain("OPSARK_PROBE_DELIVERY");
      expect((await listExecutionLedger(store, task.id))[0]).toMatchObject({ state: "failed",
        attempts: [{ status: "failed", outcome: { result: { error: { code, dispatchState: "sent" } } } }] });
      expect(backend.executeCommand).toHaveBeenCalledOnce();
    });

  it.each(["stderr", "mixed_stdout", "truncated", "unknown_completeness", "wrong_exit"])(
    "does not trust an incomplete or mixed decoder receipt: %s", async kind => {
      const { store } = inspectionTask();
      const raw = 'OPSARK_PROBE_DELIVERY {"version":1,"code":"PROBE_SOURCE_INVALID","stage":"source_decode"}\n';
      const receipt = { success: false, simulated: false, output: "failed", stdout: raw, stderr: "", stdoutTruncated: false, exitCode: 125 };
      if (kind === "stderr") receipt.stderr = "unexpected error";
      if (kind === "mixed_stdout") receipt.stdout += 'OPSARK_RESULT {}\n';
      if (kind === "truncated") receipt.stdoutTruncated = true;
      if (kind === "unknown_completeness") Reflect.deleteProperty(receipt, "stdoutTruncated");
      if (kind === "wrong_exit") receipt.exitCode = 1;
      vi.mocked(backend.executeCommand).mockResolvedValue(receipt);
      const result = await store.executeToolCall(server.id, { id: "untrusted-decoder", toolId: "files.find_large",
        arguments: { path: "/srv", maxEntries: 10 } });
      expect(result).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT", category: "output", dispatchState: "sent" } });
      if (kind === "wrong_exit") expect(result.data).toBeUndefined();
      else expect(result.data).toMatchObject({ probeDeliveryReceipt: {
        exitCode: 125, stdout: receipt.stdout, stderr: receipt.stderr, capturedPartial: true,
      } });
      expect(backend.executeCommand).toHaveBeenCalledOnce();
    });

  it("retains a late preflight rejection under the original attempt without applying it to a new workflow", async () => {
    const { store, task } = preparedTask();
    const gate = deferred<void>(); let current = true;
    const execute = vi.fn(async () => { await gate.promise; throw preflightError(); });
    const pending = store.recordStepExecution(task, task.plan[0], "command", "late-native-rejection", () => current, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    current = false; gate.resolve();
    await expect(pending).rejects.toMatchObject({ stage: "stale_result" });
    expect((await listExecutionLedger(store, task.id))[0]).toMatchObject({ state: "not_dispatched",
      attempts: [{ status: "not_dispatched", late: true }] });
    expect(task.plan[0].ledgerAppliedAttemptIds ?? []).toHaveLength(0);
  });

  it("redacts secrets in an untrusted decoder receipt while retaining the sent failure evidence", async () => {
    const { store } = inspectionTask();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: false, simulated: false, output: "failed",
      stdout: 'OPSARK_PROBE_DELIVERY {"unexpected":"fixture-only"}\n', stderr: "credential=fixture-only",
      stdoutTruncated: false, exitCode: 125 });
    const result = await store.executeToolCall(server.id, { id: "redacted-delivery", toolId: "files.find_large",
      arguments: { path: "/srv", maxEntries: 10 } });
    expect(result).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT", dispatchState: "sent" },
      data: { probeDeliveryReceipt: { exitCode: 125, stdoutPresent: true, stderrPresent: true, capturedPartial: true } } });
    expect(JSON.stringify(result)).not.toContain("fixture-only");
    expect(JSON.stringify(result)).toContain("OPSARK_PROBE_DELIVERY");
  });

  it("does not retroactively classify a legacy SDK error as a native preflight rejection", async () => {
    const { store, task } = inspectionTask();
    vi.mocked(backend.executeCommand).mockRejectedValue(new Error("SSH 命令执行失败: [Session(-34)]"));
    const call = { id: "legacy-sdk-error", toolId: "files.find_large", arguments: { path: "/srv", maxEntries: 10 } };
    const result = await store.recordStepExecution(task, task.plan[0], "tool", call.id, () => true,
      () => store.executeToolCall(server.id, call));
    expect(result).toMatchObject({ success: false, error: { code: "TOOL_EXECUTION_FAILED", dispatchState: "unknown" } });
    expect(result.data).toBeUndefined();
    expect((await listExecutionLedger(store, task.id))[0]).toMatchObject({ state: "failed", attempts: [{ status: "failed" }] });
  });

  it("cannot use a later preflight rejection to replace or unlock an existing unknown write", async () => {
    const { store, task, original } = await uncertainAppendTask();
    const execute = vi.fn(async () => { throw preflightError(); });
    await expect(store.recordStepExecution(task, task.plan[0], "command", "new-command-id", () => true, execute))
      .rejects.toMatchObject({ stage: "begin" });
    expect(execute).not.toHaveBeenCalled();
    const [record] = await listExecutionLedger(store, task.id);
    expect(record.operationId).toBe(original.operationId);
    expect(record.state).toBe("unknown"); expect(record.attempts).toHaveLength(1);
  });

  it("G02 automatically reconciles before the next model decision without a recovery click or second append", async () => {
    const { store, task, original, execute, stdout } = await uncertainAppendTask();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, output: "wrapped", stdout, stdoutTruncated: false, exitCode: 0 });
    vi.mocked(backend.decideNextStage).mockImplementation(async () => {
      const resolved = (await listExecutionLedger(store, task.id)).find(row => row.operationId === original.operationId)!;
      expect(resolved.reconciliation?.status).toBe("completed");
      expect(task.executionReconciliation?.resolution?.status).toBe("completed");
      return { decision: "complete", reason: "原目标证据与台账一致", summary: "完成", source: "model", steps: [] };
    });
    await store.beginAdjustment(task.id, true);
    expect(execute).toHaveBeenCalledOnce();
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    const read = vi.mocked(backend.executeCommand).mock.calls[0];
    expect(read[0]).toContain("/tmp/opsark-receipt-append-original/done");
    expect(read[0]).not.toContain("cp -p");
    expect(read[3]?.captureStreams).toBe(true);
    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    const resolved = (await listExecutionLedger(store, task.id)).find(row => row.operationId === original.operationId)!;
    expect(resolved.state).toBe("unknown"); expect(resolved.attempts).toHaveLength(1);
    expect(task.executionLedgerRecovery?.items.some(item => item.attemptId === original.attempts[0].id)).toBe(false);
    expect(task.automaticReconciliationAttempts).toEqual([original.attempts[0].id]);
    expect(task.status).toBe("completed");
  });

  it("G02 missing receipt stays unknown and a later adjustment cannot automatically repeat the same probe", async () => {
    const { store, task, original, execute } = await uncertainAppendTask();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: false, simulated: true, output: "receipt missing", stdout: "", stdoutTruncated: false, exitCode: 1 });
    await store.reconcilePendingExecution(task.id);
    await store.reconcilePendingExecution(task.id);
    expect(execute).toHaveBeenCalledOnce();
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    expect((await listExecutionLedger(store, task.id)).find(row => row.operationId === original.operationId)?.reconciliation).toBeUndefined();
    expect(task.executionReconciliation?.resolution).toBeUndefined();
    expect(task.executionLedgerRecovery?.items.some(item => item.kind === "uncertain")).toBe(true);
    expect(task.automaticReconciliationAttempts).toEqual([original.attempts[0].id]);
  });

  it.each(["pending", "failed"] as const)("G01 a %s requirement prevents manual reconciliation before ledger reads or remote dispatch", async state => {
    const { store, task, repository, original } = await uncertainAppendTask();
    task.pendingRequirements = [{ id: "new-target-request", content: "停止原目标，先处理新需求", baseRevision: 1,
      state, receivedAt: new Date().toISOString() }];
    const list = vi.spyOn(repository, "list");
    const resolve = vi.spyOn(repository, "resolve");
    await store.reconcileExecutionAttempt(task.id, original.attempts[0].id);
    expect(list).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.executionReconciliation?.resolution).toBeUndefined();
    expect(task.pendingRequirements[0].state).toBe(state);
  });

  it("G02 a successful probe cannot resolve another attempt or release its endpoint ownership", async () => {
    const { store, task, original, stdout } = await uncertainAppendTask();
    const semantic = { ...original.intent.semantic, stepId: "other-step", targets: [{ ...original.intent.semantic.targets[0], host: "other.test", serverId: "other-server" }] };
    const otherIntent = { version: "execution-intent@1" as const, algorithm: "sha256" as const, semantic,
      digest: executionDigest({ version: "execution-intent@1", semantic }) };
    await expect(runRecordedExecution({ owner: store, task: { id: task.id }, step: { id: "other-step", executionIntent: otherIntent },
      phase: "command", executionId: "other-write", execute: async () => { throw new Error("other lost response"); } })).rejects.toThrow();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, output: "wrapped", stdout, stdoutTruncated: false, exitCode: 0 });
    await store.reconcilePendingExecution(task.id);
    const records = await listExecutionLedger(store, task.id);
    expect(records.find(row => row.operationId === original.operationId)?.reconciliation?.status).toBe("completed");
    expect(records.find(row => row.stepId === "other-step")?.reconciliation).toBeUndefined();
    const nextSemantic = { ...semantic, stepId: "another-step" };
    const nextIntent = { ...otherIntent, semantic: nextSemantic, digest: executionDigest({ version: "execution-intent@1", semantic: nextSemantic }) };
    const dispatch = vi.fn(async () => ({ success: true }));
    await expect(runRecordedExecution({ owner: store, task: { id: task.id }, step: { id: "another-step", executionIntent: nextIntent },
      phase: "command", executionId: "another-write", execute: dispatch })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(task.executionLedgerRecovery?.items.filter(item => item.kind === "uncertain")).toHaveLength(1);
  });

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
    // The save-only action becomes available after the asynchronous refresh,
    // rather than relying on an incidental number of Promise continuations.
    await vi.waitFor(() => expect(task.executionLedgerRecovery?.items.some(item => item.action === "retry_storage")).toBe(true));
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
    expect(store.tasks).toHaveLength(0);
    expect(store.executionRecoveryCases).toHaveLength(0);
    expect(JSON.stringify((await listExecutionLedger(store, taskId))[0].intent)).toBe(intent);
    const history = await store.loadExecutionHistory(taskId);
    expect(history[0].receipts).toHaveLength(1);
    expect(history[0].receipts[0].title).toBe("命令检查");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.reviewStep).not.toHaveBeenCalled();
  });

  it("does not surface successful direct deletes as orphan recovery cases, while retaining both history receipts", async () => {
    const store = useOpsStore(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    configureExecutionLedger(directExecutionLedgerOwner, repository, async () => "a".repeat(64));
    for (const [index, path] of ["/opt/core-case", "/root/core-case"].entries()) {
      await runDirectExecution({ executionId: `direct-delete-${index}`, phase: "tool",
        action: { type: "tool", toolId: "core.sftp.delete", arguments: { path, kind: "directory" } },
        connections: [{ host: server.host, port: server.port, username: server.username, password: "fixture-only" }],
        execute: async () => undefined });
    }
    const before = JSON.stringify(await listExecutionLedger(store));
    await store.restoreExecutionLedgerTasks();
    await store.restoreExecutionLedgerTasks();
    expect(store.executionRecoveryCases).toEqual([]); expect(store.tasks).toEqual([]);
    const history = await store.loadExecutionHistory();
    expect(history).toHaveLength(1); expect(history[0].receipts).toHaveLength(2);
    expect(history[0].receipts.every(receipt => receipt.status === "succeeded")).toBe(true);
    expect(JSON.stringify(await listExecutionLedger(store))).toBe(before);
    expect(backend.executeCommand).not.toHaveBeenCalled(); expect(backend.reviewStep).not.toHaveBeenCalled();
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
    expect(store.tasks).toHaveLength(0);
    const restored = store.executionRecoveryCases[0];
    expect(restored.taskId).toMatch(/^direct-/);
    expect(restored.targets[0].host).toBe(server.host);
    expect(restored.recovery.items[0]).toMatchObject({ kind: "uncertain", action: "none" });
    localStorage.setItem("opsark.taskArchive.v1", '{"version":99}');
    await store.restoreExecutionLedgerTasks();
    expect(store.executionRecoveryCases).toHaveLength(1);
    expect(store.executionLedgerReadError).toContain("归档暂不可读");
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
  it("reconciles an orphan under its original identity without replaying the change or creating a task", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    const semantic = { ...task.plan[0].executionIntent!.semantic, kind: "change" as const, effect: "change" as const,
      action: { type: "shell" as const, command: "systemctl start app.service" }, runtimeClass: "persistent_service" as const,
      validator: { type: "service" as const, command: "systemctl is-active app.service", validStates: ["healthy" as const] } };
    task.plan[0].executionIntent = { version: "execution-intent@1", algorithm: "sha256", semantic,
      digest: executionDigest({ version: "execution-intent@1", semantic }) };
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await expect(store.recordStepExecution(task, task.plan[0], "command", "orphan-service", () => true,
      async () => ({ success: false, error: { category: "network", dispatchState: "unknown" } }))).rejects.toThrow();
    const original = (await listExecutionLedger(store, task.id))[0];
    store.tasks = [];
    await Promise.all([store.restoreExecutionLedgerTasks(), store.restoreExecutionLedgerTasks()]);
    expect(store.executionRecoveryCases).toHaveLength(1);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    vi.mocked(backend.executeCommand).mockResolvedValue({ success: true, simulated: true, exitCode: 0, output: "active" });
    await Promise.all([store.reconcileExecutionAttempt(task.id, original.attempts[0].id),
      store.reconcileExecutionAttempt(task.id, original.attempts[0].id)]);
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backend.executeCommand).mock.calls[0][0]).toBe("systemctl is-active app.service");
    const records = await listExecutionLedger(store, task.id);
    expect(records.every(record => record.taskId === task.id)).toBe(true);
    expect(records.find(record => record.operationId === original.operationId)?.reconciliation?.status).toBe("completed");
    expect(store.executionRecoveryCases).toHaveLength(0); expect(store.tasks).toHaveLength(0);
    expect(backend.reviewStep).not.toHaveBeenCalled();
  });

  it("backs up an untouched legacy shell before removing it, but preserves subsequent user work", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.recordStepExecution(task, task.plan[0], "command", "legacy-read", () => true,
      async () => ({ success: true, exitCode: 0, output: "READY" }));
    const original = (await listExecutionLedger(store, task.id))[0];
    Object.assign(task, { title: "执行记录恢复 · old server", modelId: "", permission: "observe", messages: [], plan: [],
      rootGoal: original.intent.semantic.expected, status: "awaiting_continuation", createdAt: new Date(original.createdAt).toISOString(),
      pauseReason: "已恢复历史检查结果，可查看已有证据；这不代表当前任务目标已完成。" });
    const { readTaskArchive } = await import("@/services/taskArchive");
    const snapshot = JSON.parse(JSON.stringify(task));
    await store.restoreExecutionLedgerTasks();
    expect(store.tasks).toHaveLength(0);
    expect(await readTaskArchive(task.id)).toMatchObject({ disposition: "legacy_recovery", snapshot });
    store.tasks = [snapshot];
    store.pushMessage(store.tasks[0], { role: "user", kind: "message", content: "继续处理新需求" });
    await store.restoreExecutionLedgerTasks();
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].messages[0].content).toBe("继续处理新需求");
    expect((await readTaskArchive(task.id))?.disposition).toBe("active");
    expect(backend.executeCommand).not.toHaveBeenCalled(); expect(backend.reviewStep).not.toHaveBeenCalled();
  });

  it("does not revive a task removed while a ledger scan is pending", async () => {
    const { store, task } = preparedTask(), repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    await store.recordStepExecution(task, task.plan[0], "command", "race-read", () => true,
      async () => ({ success: true, exitCode: 0, output: "READY" }));
    const records = await listExecutionLedger(store, task.id), listing = deferred<typeof records>();
    vi.spyOn(repository, "list").mockReturnValueOnce(listing.promise);
    const scan = store.restoreExecutionLedgerTasks();
    const removal = store.deleteTask(task.id);
    await vi.waitFor(() => expect(store.tasks).toHaveLength(0));
    listing.resolve(records);
    await scan; expect(await removal).toBe(true);
    await store.restoreExecutionLedgerTasks();
    expect(store.tasks).toHaveLength(0); expect(store.executionRecoveryCases).toHaveLength(0);
    expect((await store.loadExecutionHistory(task.id))[0]).toMatchObject({ removed: true, canOpen: false });
  });

});
