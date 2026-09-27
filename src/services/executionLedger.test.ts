import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIntentSnapshot, ExecutionIntentSemantic } from "@/types";
import { executionDigest } from "@/features/agent/planPreparation";
import {
  cancelExecutionLedger, configureExecutionLedger, createMemoryExecutionLedgerRepository,
  ExecutionLedgerError, flushPendingReceipts, listExecutionLedger, pendingExecutionReceipts,
  redactExecutionValue, resetExecutionLedgerForTests, resolveExecutionOperation, runRecordedExecution,
  type ExecutionLedgerRepository, type RecordedExecutionOptions,
} from "./executionLedger";

function intent(effect: "read" | "change" = "change", stepId = "step"): ExecutionIntentSnapshot {
  const semantic: ExecutionIntentSemantic = { taskId: "task", stepId,
    action: { type: "shell", command: effect === "read" ? "cat /srv/config" : "touch /srv/config" },
    targets: [{ role: "execution", serverId: "server", host: "EXAMPLE.com", port: 22, username: "deploy" }],
    kind: effect === "read" ? "observe" : "change", effect, risk: "medium", expected: "检查真实结果",
    dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "j1" };
  return { version: "execution-intent@1", algorithm: "sha256", digest: executionDigest({ version: "execution-intent@1", semantic }), semantic };
}
function options(owner: object, execute: () => Promise<unknown> = async () => "done", effect: "read" | "change" = "change",
  stepId = "step", executionId = "physical-1"): RecordedExecutionOptions<unknown> {
  return { owner, task: { id: "task", currentRoundId: "round", workflowEpoch: 1, planRevision: 2 },
    step: { id: stepId, executionIntent: intent(effect, stepId), stepRevision: 1 }, phase: "command", executionId, execute };
}
function setup(repository?: ExecutionLedgerRepository, writer = vi.fn(async (_taskId: string, _record: Record<string, unknown>) => "evidence-1")) {
  const owner = {}, store = repository ?? createMemoryExecutionLedgerRepository();
  configureExecutionLedger(owner, store, writer); return { owner, store, writer };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("durable execution coordination", () => {
  beforeEach(resetExecutionLedgerForTests);

  it("persists intent and dispatch admission before I/O; archives receipt before returning", async () => {
    const { owner, store, writer } = setup(); const order: string[] = [];
    const value = { output: "done", exitCode: 0 };
    const request = options(owner, async () => {
      const records = await store.list("task");
      expect(records[0]?.state).toBe("dispatching"); expect(records[0]?.attempts[0]?.executionId).toBe("physical-1");
      order.push("execute"); return value;
    });
    request.onAttempt = (_operation, attempt) => { expect(attempt.status).toBe("dispatching"); order.push("attempt"); };
    request.onCommitted = async () => { expect((await store.list())[0]?.state).toBe("succeeded"); order.push("committed"); };
    expect(await runRecordedExecution(request)).toBe(value);
    expect(writer).toHaveBeenCalledTimes(1); expect(order).toEqual(["attempt", "execute", "committed"]);
    const [record] = await listExecutionLedger(owner, "task");
    expect(record).toMatchObject({ resourceKeys: ["endpoint:example.com:22"], planRevision: 2, stepRevision: 1,
      state: "succeeded", attempts: [{ outcome: { evidenceRefs: ["evidence-1"], result: value } }] });
  });

  it.each(["prepare", "begin"] as const)("does not dispatch if %s fails", async stage => {
    const repository = createMemoryExecutionLedgerRepository();
    repository[stage] = vi.fn(async () => { throw new Error("EXECUTION_LEDGER_STORAGE_UNAVAILABLE"); });
    const { owner } = setup(repository); const execute = vi.fn(async () => "done");
    await expect(runRecordedExecution(options(owner, execute))).rejects.toMatchObject({ stage, remoteResultKnown: false,
      code: "EXECUTION_LEDGER_STORAGE_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a mismatched admission identity before dispatch", async () => {
    const repository = createMemoryExecutionLedgerRepository(); const begin = repository.begin;
    repository.begin = async (...args) => ({ ...await begin(...args), executionId: "unrelated" });
    const { owner } = setup(repository); const execute = vi.fn(async () => "done");
    await expect(runRecordedExecution(options(owner, execute))).rejects.toMatchObject({ stage: "begin", code: "EXECUTION_LEDGER_RESULT_MISMATCH" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("archives a late response after cancellation without projecting it", async () => {
    const { owner, writer } = setup(); const response = deferred<string>(), dispatched = deferred<void>();
    let current = true; const committed = vi.fn();
    const request = { ...options(owner, async () => { dispatched.resolve(); return response.promise; }),
      isCurrent: () => current, onCommitted: committed };
    const run = runRecordedExecution(request); const checked = expect(run).rejects.toMatchObject({ stage: "stale_result", remoteResultKnown: true });
    await dispatched.promise; current = false; await cancelExecutionLedger(owner, "task"); response.resolve("created on remote"); await checked;
    const [record] = await listExecutionLedger(owner);
    expect(record).toMatchObject({ state: "succeeded", cancelRequested: true,
      attempts: [{ late: true, cancelRequested: true, outcome: { result: "created on remote" } }] });
    expect(writer).toHaveBeenCalledTimes(1); expect(committed).not.toHaveBeenCalled();
  });

  it("keeps late evidence bound to the captured round after a reactive task changes", async () => {
    const { owner, writer } = setup(); const response = deferred<string>(), started = deferred<void>();
    const task = { id: "task", currentRoundId: "old-round", workflowEpoch: 1, planRevision: 2 };
    const request = { ...options(owner, async () => { started.resolve(); return response.promise; }), task,
      isCurrent: () => task.currentRoundId === "old-round" };
    const run = runRecordedExecution(request), checked = expect(run).rejects.toMatchObject({ stage: "stale_result" });
    await started.promise; task.currentRoundId = "new-round"; task.workflowEpoch = 9; task.planRevision = 7;
    response.resolve("old remote result"); await checked;
    expect((await listExecutionLedger(owner))[0]).toMatchObject({ roundId: "old-round", workflowEpoch: 1, planRevision: 2 });
    expect(writer.mock.calls[0]?.[1]).toMatchObject({ roundId: "old-round", stepId: "step", late: true });
  });

  it("records a cancelled pre-dispatch attempt as not_dispatched", async () => {
    const { owner } = setup(); const execute = vi.fn(async () => "done"); let current = true;
    await expect(runRecordedExecution({ ...options(owner, execute), isCurrent: () => current,
      onAttempt: () => { current = false; } })).rejects.toMatchObject({ stage: "stale_result", remoteResultKnown: false });
    expect(execute).not.toHaveBeenCalled(); expect((await listExecutionLedger(owner))[0]?.state).toBe("not_dispatched");
  });

  it("retains a failed evidence write and only retries storage, never remote execution", async () => {
    const writer = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue("evidence-2");
    const { owner } = setup(undefined, writer); const execute = vi.fn(async () => ({ output: "applied" }));
    await expect(runRecordedExecution(options(owner, execute))).rejects.toMatchObject({ stage: "result_commit", remoteResultKnown: true,
      result: { output: "applied" } });
    expect(pendingExecutionReceipts(owner)).toHaveLength(1);
    await expect(runRecordedExecution(options(owner, execute, "change", "next", "physical-2")))
      .rejects.toMatchObject({ stage: "result_commit" });
    const receipts = await flushPendingReceipts(owner, "task");
    expect(receipts[0]?.outcome?.evidenceRefs).toEqual(["evidence-2"]); expect(execute).toHaveBeenCalledTimes(1);
    expect(pendingExecutionReceipts(owner)).toHaveLength(0); expect((await listExecutionLedger(owner))[0]?.state).toBe("succeeded");
  });

  it("retries an acknowledged-lost completion idempotently with the same result event", async () => {
    const repository = createMemoryExecutionLedgerRepository(); const complete = repository.complete; let fail = true;
    repository.complete = vi.fn(async receipt => { const value = await complete(receipt);
      if (fail) { fail = false; throw new Error("acknowledgement lost"); } return value; });
    const { owner, writer } = setup(repository); const execute = vi.fn(async () => "done");
    await expect(runRecordedExecution(options(owner, execute))).rejects.toMatchObject({ stage: "result_commit" });
    await flushPendingReceipts(owner); expect(writer).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
    expect((await repository.list())[0]?.attempts).toHaveLength(1);
    expect(vi.mocked(repository.complete).mock.calls[0]?.[0].eventId).toBe(vi.mocked(repository.complete).mock.calls[1]?.[0].eventId);
  });

  it("rejects mismatched result acknowledgements and retains the receipt for retry", async () => {
    const repository = createMemoryExecutionLedgerRepository(); const complete = repository.complete;
    repository.complete = async receipt => ({ ...await complete(receipt), id: "other-attempt" });
    const { owner } = setup(repository);
    await expect(runRecordedExecution(options(owner))).rejects.toMatchObject({ stage: "result_commit", code: "EXECUTION_LEDGER_RESULT_MISMATCH" });
    expect(pendingExecutionReceipts(owner)).toHaveLength(1);
    repository.complete = complete; await flushPendingReceipts(owner); expect(pendingExecutionReceipts(owner)).toHaveLength(0);
  });

  it("holds an uncertain mutation and rejects another mutation to the same endpoint", async () => {
    const { owner } = setup();
    await expect(runRecordedExecution(options(owner, async () => { throw new Error("transport read"); })))
      .rejects.toMatchObject({ stage: "execution", remoteResultKnown: false });
    expect((await listExecutionLedger(owner))[0]?.state).toBe("unknown");
    const next = vi.fn(async () => "second mutation");
    await expect(runRecordedExecution(options(owner, next, "change", "next", "physical-2")))
      .rejects.toMatchObject({ stage: "begin", code: "EXECUTION_LEDGER_RESOURCE_BUSY" });
    expect(next).not.toHaveBeenCalled();
    await expect(runRecordedExecution(options(owner, async () => "read facts", "read", "verify", "physical-3"))).resolves.toBe("read facts");
  });

  it("shares a mutation lock across accounts on the same host and port", async () => {
    const { owner } = setup();
    await expect(runRecordedExecution(options(owner, async () => { throw new Error("transport lost"); }))).rejects.toMatchObject({ stage: "execution" });
    const execute = vi.fn(async () => "mutated as root"), request = options(owner, execute, "change", "other-account", "root-id");
    request.step.executionIntent!.semantic.targets[0].username = "root";
    request.step.executionIntent!.digest = executionDigest({ version: "execution-intent@1", semantic: request.step.executionIntent!.semantic });
    await expect(runRecordedExecution(request)).rejects.toMatchObject({ code: "EXECUTION_LEDGER_RESOURCE_BUSY" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not repeat a completed mutation but records every allowed read attempt", async () => {
    const { owner } = setup(); const execute = vi.fn(async () => "done");
    await runRecordedExecution(options(owner, execute));
    await expect(runRecordedExecution(options(owner, execute, "change", "step", "physical-2"))).rejects.toMatchObject({ stage: "begin" });
    expect(execute).toHaveBeenCalledTimes(1);
    await runRecordedExecution(options(owner, execute, "read", "read", "physical-3"));
    await runRecordedExecution(options(owner, execute, "read", "read", "physical-4"));
    expect((await listExecutionLedger(owner)).find(record => record.effect === "read")?.attempts).toHaveLength(2);
  });

  it("keeps framework sub-actions distinct while physical IDs never change operation identity", async () => {
    const { owner } = setup();
    await runRecordedExecution({ ...options(owner, undefined, "read", "read", "p1"), phase: "framework:probe" });
    await runRecordedExecution({ ...options(owner, undefined, "read", "read", "p2"), phase: "framework:probe" });
    await runRecordedExecution({ ...options(owner, undefined, "read", "read", "p3"), phase: "framework:verify" });
    const rows = await listExecutionLedger(owner); expect(rows).toHaveLength(2);
    expect(rows.map(row => row.attempts.length)).toEqual([2, 1]); expect(rows.every(row => row.phase === "framework")).toBe(true);
  });

  it("redacts nested strings before JSON escaping and never persists credential fields", async () => {
    const { owner, writer } = setup(); const secret = 'a"b\nc';
    const raw = { password: "also-secret", nested: [{ stdout: `prefix ${secret}` }], error: new Error(secret) };
    await runRecordedExecution({ ...options(owner, async () => raw), redact: value => value.split(secret).join("[SECRET]") });
    const archive = writer.mock.calls[0]?.[1]; const rows = await listExecutionLedger(owner);
    expect(JSON.stringify(archive)).not.toContain("also-secret"); expect(JSON.stringify(rows)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(rows[0]?.attempts[0]?.outcome?.result).toEqual({ password: "[REDACTED]", nested: [{ stdout: "prefix [SECRET]" }],
      error: { name: "Error", message: "[SECRET]" } });
    expect(redactExecutionValue({ apiKey: "value", credentialRef: "keychain:1" })).toEqual({ apiKey: "[REDACTED]", credentialRef: "keychain:1" });
  });

  it("isolates default test repositories by owner", async () => {
    const first = {}, second = {};
    await runRecordedExecution(options(first)); await runRecordedExecution(options(second));
    expect((await listExecutionLedger(first))[0]?.attempts).toHaveLength(1);
    expect((await listExecutionLedger(second))[0]?.attempts).toHaveLength(1);
  });

  it("refuses a snapshot containing raw secrets rather than silently changing its approved digest", async () => {
    const { owner, store, writer } = setup(); const execute = vi.fn(async () => "done");
    const request = options(owner, execute); request.step.executionIntent!.semantic.action = { type: "shell", command: "echo raw-password" };
    request.step.executionIntent!.digest = executionDigest({ version: "execution-intent@1", semantic: request.step.executionIntent!.semantic });
    request.redact = value => value.replace("raw-password", "[SECRET]");
    await expect(runRecordedExecution(request)).rejects.toMatchObject({ stage: "prepare", remoteResultKnown: false });
    expect(await store.list()).toHaveLength(0); expect(execute).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
  });

  it("uses a typed error for a known but explicitly uncertain return value", async () => {
    const { owner } = setup();
    await expect(runRecordedExecution({ ...options(owner, async () => ({ exitCode: null, partial: true })), classifyResult: () => "unknown" }))
      .rejects.toBeInstanceOf(ExecutionLedgerError);
    expect((await listExecutionLedger(owner))[0]?.state).toBe("unknown");
  });

  it("preserves a nested storage-error identity after recording the outer attempt", async () => {
    const { owner } = setup(); const nested = new ExecutionLedgerError("nested receipt failed", "result_commit", true, "inner", "inner-attempt");
    await expect(runRecordedExecution(options(owner, async () => { throw nested; }))).rejects.toBe(nested);
    expect((await listExecutionLedger(owner))[0]?.state).toBe("unknown");
  });

  it("reconciles current service state from a later read without rewriting the uncertain execution", async () => {
    const { owner } = setup(); const mutation = options(owner, async () => { throw new Error("transport lost"); });
    const semantic = mutation.step.executionIntent!.semantic;
    semantic.runtimeClass = "persistent_service"; semantic.validation = "systemctl is-active example";
    mutation.step.executionIntent!.digest = executionDigest({ version: "execution-intent@1", semantic });
    await expect(runRecordedExecution(mutation)).rejects.toMatchObject({ stage: "execution" });
    const probe = options(owner, async () => ({ exitCode: 0, output: "active\n" }), "read", "verify", "probe-id");
    const probeSemantic = probe.step.executionIntent!.semantic;
    probeSemantic.action = { type: "shell", command: semantic.validation };
    probe.step.executionIntent!.digest = executionDigest({ version: "execution-intent@1", semantic: probeSemantic });
    await runRecordedExecution(probe);
    const records = await listExecutionLedger(owner), original = records.find(row => row.stepId === "step")!, read = records.find(row => row.stepId === "verify")!;
    const result = await resolveExecutionOperation(owner, original.operationId, original.attempts[0].id,
      { version: 1, kind: "service", readOperationId: read.operationId });
    expect(result.state).toBe("unknown"); expect(result.attempts[0].status).toBe("unknown");
    expect(result.reconciliation).toMatchObject({ status: "completed", reason: "current_state_verified", readOperationIds: [read.operationId] });
    await expect(runRecordedExecution(options(owner, async () => "new action", "change", "next", "next-id"))).resolves.toBe("new action");
    await expect(runRecordedExecution({ ...mutation, executionId: "forbidden-replay" })).rejects.toMatchObject({ stage: "begin" });
  });
});
