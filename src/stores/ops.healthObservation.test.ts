import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import * as taskArchive from "@/services/taskArchive";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import { normalizeHealthObservationRequest } from "@/features/tools/healthObservation";
import type { ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  const store = useOpsStore(); store.servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
});
afterEach(async () => {
  const store = useOpsStore(); for (const task of store.tasks) task.cancelRequested = true;
  store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
function setup() {
  const store = useOpsStore(), task = store.createTask(server.id, "observe", "model");
  task.status = "running"; task.currentRoundId = "round";
  const request = normalizeHealthObservationRequest({ url: "http://127.0.0.1:19001/health", windowSeconds: 3, intervalSeconds: 1 });
  task.plan = [{ id: "observe-step", title: "等待健康恢复", description: "只读观察", command: "", validation: "", expected: "实际HTTP状态与窗口", risk: "low", status: "running", kind: "observe",
    action: { type: "tool", toolId: "services.observe", arguments: { ...request } } }];
  task.messages.push({ id: "requirement", role: "user", kind: "message", content: "观察恢复", createdAt: new Date(Date.now() - 30_000).toISOString() });
  const call = { id: "observe-call", toolId: "services.observe", arguments: { ...request } };
  return { store, task, call };
}
describe("store health observation ownership and persistence", () => {
  it("archives preparation before sending and retains original child receipt", async () => {
    const { store, task, call } = setup();
    task.requirementLifecycle = { version: 1, revision: 1, items: [], focus: { roundId: "round", sourceMessageId: "requirement", requirementIds: [] } };
    task.messages.push({ id: "question", role: "user", kind: "message", content: "还要多久", requirementRelation: "side_question", createdAt: new Date().toISOString() });
    const execute = vi.spyOn(backend, "executeCommand").mockImplementation(async (_command, _connection, _approved, options) => {
      const archive = await taskArchive.readTaskArchive(task.id);
      expect(archive?.snapshot?.observationWindows?.[0]).toMatchObject({ state: "preparing", binding: { taskId: task.id, executionId: call.id } });
      const id = options!.executionId;
      options!.onProgress?.({ executionId: id, stream: "stdout", data: `OPSARK_HEALTH_STARTED ${id}\n` });
      return { success: true, simulated: true, exitCode: 0, output: "", stdout: `OPSARK_HEALTH_STARTED ${id}\nOPSARK_HEALTH_RESULT ${id} 0 200\n`, stdoutTruncated: false };
    });
    const result = await store.executeToolCall(server.id, call, undefined, undefined, task.id);
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(task.observationWindows?.[0]).toMatchObject({ state: "matched", samples: [{ executionId: "observe-call-p0", status: "valid", matched: true }] });
    expect(task.status).toBe("running"); // An observation does not decide the whole user's business task.
    expect(task.observationWindows?.[0].preparationElapsedMs).toBeGreaterThanOrEqual(30_000);
    expect((await taskArchive.readTaskArchive(task.id))?.snapshot?.observationWindows?.[0].state).toBe("matched");
  });
  it("rejects a call for a different active target before dispatch", async () => {
    const { store, task, call } = setup();
    const execute = vi.spyOn(backend, "executeCommand");
    call.arguments.url = "http://127.0.0.1:19002/foreign";
    const result = await store.executeToolCall(server.id, call, undefined, undefined, task.id);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(task.observationWindows).toBeUndefined();
  });
  it("restores interrupted observations without inventing an end or sending a probe", async () => {
    const { store, task } = setup();
    task.observationWindows = [{ version: 1, binding: { taskId: task.id, roundId: "round", workflowEpoch: 0, stepId: "observe-step", executionId: "old-call" },
      policy: { windowMs: 3000, intervalMs: 1000, probeTimeoutMs: 1000 }, preparationStartedAt: Date.now() - 1000,
      startedAt: Date.now(), observationElapsedMs: 0, maxSampleGapMs: 0, state: "preparing", windowSatisfied: false, samples: [] }];
    await store.persist(true); store.$dispose();
    setActivePinia(createPinia());
    const execute = vi.spyOn(backend, "executeCommand");
    const restored = useOpsStore().tasks.find(item => item.id === task.id)!;
    expect(restored.observationWindows?.[0]).toMatchObject({ state: "interrupted", windowSatisfied: false, interruptedAt: expect.any(Number) });
    expect(restored.observationWindows?.[0].finishedAt).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it("failed durable preparation cannot turn into a remote request", async () => {
    const { store, task, call } = setup();
    const execute = vi.spyOn(backend, "executeCommand");
    const save = vi.spyOn(taskArchive, "archiveTasks").mockRejectedValue(new Error("disk full"));
    const result = await store.executeToolCall(server.id, call, undefined, undefined, task.id);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(task.observationWindows?.[0].state).toBe("preparing");
    save.mockRestore();
  });
  it.each([false, true])("cancellation keeps original child and saves late receipt without revival (removed=%s)", async removed => {
    const { store, task, call } = setup();
    let release!: (value: Awaited<ReturnType<typeof backend.executeCommand>>) => void;
    let childId = "";
    vi.spyOn(backend, "executeCommand").mockImplementation((_command, _connection, _approved, options) => {
      childId = options!.executionId;
      options!.onProgress?.({ executionId: childId, stream: "stdout", data: `OPSARK_HEALTH_STARTED ${childId}\n` });
      return new Promise(resolve => { release = resolve; });
    });
    const cancel = vi.spyOn(backend, "cancelCommand").mockResolvedValue();
    const separateEvidence = vi.spyOn(backend, "saveTaskEvidence").mockResolvedValue("fixture-late-evidence");
    const running = store.executeToolCall(server.id, call, undefined, undefined, task.id);
    await vi.waitFor(() => expect(childId).toBe("observe-call-p0"));
    task.cancelRequested = true; task.status = "cancelled"; task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
    const result = await running;
    expect(result.success).toBe(true); // Result says cancelled; never says the service is ready.
    expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: server.host }), childId);
    if (removed) {
      await taskArchive.markTaskArchived(JSON.parse(JSON.stringify(task)), "removed");
      store.tasks = store.tasks.filter(item => item.id !== task.id);
    }
    release({ success: true, simulated: true, exitCode: 0, output: "", stdout: `OPSARK_HEALTH_STARTED ${childId}\nOPSARK_HEALTH_RESULT ${childId} 0 200\n`, stdoutTruncated: false });
    await vi.waitFor(() => expect(task.observationWindows?.[0].samples).toHaveLength(1));
    expect(task.observationWindows?.[0]).toMatchObject({ state: "cancelled", windowSatisfied: false, samples: [{ late: true, matched: true, executionId: childId }] });
    expect(task.status).toBe("cancelled");
    if (removed) {
      await vi.waitFor(() => expect(separateEvidence).toHaveBeenCalledOnce());
      expect(separateEvidence).toHaveBeenCalledWith(task.id, expect.objectContaining({ executionId: call.id, kind: "health_observation_after_removal" }));
      expect(JSON.parse(String(separateEvidence.mock.calls[0][1].text)).samples[0]).toMatchObject({ executionId: childId, late: true });
      expect((await taskArchive.readTaskArchive(task.id))?.disposition).toBe("removed");
      expect(store.tasks.some(item => item.id === task.id)).toBe(false);
    } else {
      await vi.waitFor(async () => expect((await taskArchive.readTaskArchive(task.id))?.snapshot?.observationWindows?.[0].samples).toHaveLength(1));
      expect(separateEvidence).not.toHaveBeenCalled();
    }
  });
});
