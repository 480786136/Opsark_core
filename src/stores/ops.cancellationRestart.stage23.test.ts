import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import { archiveTasks } from "@/services/taskArchive";
import * as ledger from "@/services/executionLedger";
import { taskTerminalEvidenceSummary } from "@/features/agent/taskTerminalEvidence";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const step = (status: PlanStep["status"]): PlanStep => ({ id: "old-step", title: "原变更", description: "仅本地夹具，禁止派发",
  kind: "change", action: { type: "shell", command: "printf fixture" }, command: "printf fixture", validation: "", expected: "取得真实结果",
  risk: "medium", status });
function setup(status: OpsTask["status"] = "running", stepStatus: PlanStep["status"] = "running") {
  const store = useOpsStore();
  store.servers = [{ id: "server", name: "fixture", host: "fixture.invalid", port: 22, username: "fixture" } as ServerProfile];
  const task = store.createTask("server", "managed", "model");
  task.status = status; task.plan = [step(stepStatus)]; task.currentExecutionId = "old-execution";
  return { store, task };
}
function reload(id: string) {
  useOpsStore().$dispose(); setActivePinia(createPinia());
  return useOpsStore().tasks.find(task => task.id === id)!;
}
beforeEach(() => {
  localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("forbidden"));
  vi.spyOn(backend, "generatePlan").mockRejectedValue(new Error("forbidden"));
  vi.spyOn(backend, "decideNextStage").mockRejectedValue(new Error("forbidden"));
});
afterEach(() => { useOpsStore().$dispose(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); localStorage.clear(); });
function noBusiness() {
  expect(backend.executeCommand).not.toHaveBeenCalled(); expect(backend.generatePlan).not.toHaveBeenCalled();
  expect(backend.decideNextStage).not.toHaveBeenCalled();
}

describe("cancelled workflows stay stopped across cache and archive restoration", () => {
  it("saves reject intent immediately instead of waiting for the ordinary debounce", async () => {
    const { store, task } = setup(); await store.persist(true);
    store.rejectTask(task.id);
    const saved = JSON.parse(localStorage.getItem("opsark.tasks")!)[0];
    expect(saved.status).toBe("cancelled"); expect(saved.cancelRequested).toBe(true);
    expect(saved.terminalEvidence.cancellations).toHaveLength(1);
    expect(saved.terminalEvidence.terminals).toHaveLength(1);
    noBusiness();
  });

  it.each(["running", "validating"] as const)("keeps reject terminal and uncertain remote facts after restart: %s", async status => {
    const { store, task } = setup(status, status); store.rejectTask(task.id); await store.persist(true);
    const terminal = JSON.parse(JSON.stringify(task.terminalEvidence));
    const summary = task.summary, round = task.currentRoundId, epoch = task.workflowEpoch;
    const restored = reload(task.id);
    expect(restored.status).toBe("cancelled"); expect(restored.cancelRequested).toBe(true);
    expect(restored.currentRoundId).toBe(round); expect(restored.workflowEpoch).toBe(epoch);
    expect(restored.summary).toBe(summary); expect(restored.pauseReason).toBeUndefined();
    expect(restored.currentExecutionId).toBeUndefined(); expect(restored.plan[0]!.status).toBe("failed");
    expect(restored.executionReconciliation).toMatchObject({ stepId: "old-step", serverId: "server" });
    expect(restored.executionReconciliation?.resolution).toBeUndefined();
    expect(restored.terminalEvidence).toEqual(terminal);
    expect(taskTerminalEvidenceSummary(restored)).toMatchObject({ terminalAt: terminal.terminals[0].transitionedAt, remoteState: "pending" });
    expect(restored.planApproval).toBeUndefined(); expect(restored.preparedPlan).toBeUndefined(); noBusiness();
  });

  it("starts saving the stop fence before a remote termination response arrives", async () => {
    const { store, task } = setup(); await store.persist(true);
    vi.spyOn(store, "getRuntimeConnection").mockReturnValue({ host: "fixture.invalid", port: 22, username: "fixture", password: "fixture-password" });
    vi.spyOn(backend, "cancelSftpTransfer").mockResolvedValue(false);
    let release!: () => void;
    vi.spyOn(backend, "cancelCommand").mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const stopping = store.terminateTask(task.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      const saved = JSON.parse(localStorage.getItem("opsark.tasks")!)[0];
      expect(saved.cancelRequested).toBe(true); expect(saved.workflowEpoch).toBe(task.workflowEpoch);
      expect(saved.currentExecutionId).toBe("old-execution"); expect(saved.terminalEvidence.cancellations).toHaveLength(1);
      const restored = reload(task.id);
      expect(restored.status).toBe("cancelled"); expect(restored.cancelRequested).toBe(true);
      expect(restored.executionReconciliation?.resolution).toBeUndefined();
      expect(taskTerminalEvidenceSummary(restored)).toMatchObject({ terminalAt: undefined, remoteState: "pending" });
      noBusiness();
    } finally { release(); await stopping; }
  });

  it.each(["planning", "running", "validating", "awaiting_input"] as const)("restores a durable cancellation fence as a local stop without inventing terminal time: %s", status => {
    const { task } = setup(status, status === "awaiting_input" ? "awaiting_input" : "pending");
    task.cancelRequested = true; task.autoAdjustmentSeconds = 5; task.managedAdjustmentPhase = "generating";
    localStorage.setItem("opsark.tasks", JSON.stringify([task]));
    const restored = reload(task.id);
    expect(restored.status).toBe("cancelled"); expect(restored.cancelRequested).toBe(true);
    expect(restored.autoAdjustmentSeconds).toBeUndefined(); expect(restored.adjustmentInProgress).toBe(false);
    expect(restored.currentExecutionId).toBeUndefined(); expect(restored.terminalEvidence?.terminals).toBeUndefined();
    expect(taskTerminalEvidenceSummary(restored).terminalAt).toBeUndefined();
    expect(useOpsStore().pendingUserInputs).toEqual([]); noBusiness();
  });

  it("the desktop persistence path submits the cancellation snapshot before remote cleanup completes", async () => {
    const { store, task } = setup(); await store.persist(true);
    vi.spyOn(store, "cancelTaskModelRequests").mockResolvedValue();
    vi.spyOn(store, "refreshExecutionLedger").mockResolvedValue();
    vi.spyOn(ledger, "cancelExecutionLedger").mockResolvedValue([]);
    vi.spyOn(store, "getRuntimeConnection").mockReturnValue({ host: "fixture.invalid", port: 22, username: "fixture", password: "fixture-password" });
    vi.spyOn(backend, "cancelSftpTransfer").mockResolvedValue(false);
    let releaseArchive!: () => void, releaseCommand!: () => void;
    vi.mocked(invoke).mockImplementation(command => command === "save_task_snapshots" && !releaseArchive
      ? new Promise<void>(resolve => { releaseArchive = resolve; }) as never : Promise.resolve() as never);
    vi.spyOn(backend, "cancelCommand").mockImplementation(() => new Promise<void>(resolve => { releaseCommand = resolve; }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const stopping = store.terminateTask(task.id);
    await vi.waitFor(() => expect(releaseCommand).toBeTypeOf("function"));
    try {
      const saved = vi.mocked(invoke).mock.calls.find(call => call[0] === "save_task_snapshots")?.[1] as { snapshots: OpsTask[] };
      expect(saved.snapshots[0]).toMatchObject({ id: task.id, cancelRequested: true, currentExecutionId: "old-execution" });
      expect(JSON.parse(localStorage.getItem("opsark.tasks")!)[0].cancelRequested).not.toBe(true);
      releaseArchive();
      await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("opsark.tasks")!)[0].cancelRequested).toBe(true));
      expect(task.status).toBe("running"); // No remote response or terminal-time claim yet.
      noBusiness();
    } finally { releaseArchive?.(); releaseCommand(); await stopping; await store.persist(true); }
  });

  it("opening a cancelled archive retains the terminal and never relaunches the old step", async () => {
    const { store, task } = setup(); store.rejectTask(task.id); await store.persist(true);
    await archiveTasks([JSON.parse(JSON.stringify(task))]);
    const terminal = JSON.parse(JSON.stringify(task.terminalEvidence));
    store.tasks = []; localStorage.removeItem("opsark.tasks");
    vi.spyOn(store, "refreshExecutionLedger").mockResolvedValue();
    const restored = await store.openArchivedTask(task.id);
    expect(restored.status).toBe("cancelled"); expect(restored.terminalEvidence).toEqual(terminal);
    expect(restored.executionReconciliation?.resolution).toBeUndefined(); noBusiness();
  });

  it("a second restoration does not duplicate cancellation, terminal or uncertainty records", async () => {
    const { store, task } = setup(); store.rejectTask(task.id); await store.persist(true);
    const first = reload(task.id), snapshot = JSON.parse(JSON.stringify(first));
    await useOpsStore().persist(true);
    const second = reload(task.id);
    expect(second.status).toBe("cancelled"); expect(second.terminalEvidence).toEqual(snapshot.terminalEvidence);
    expect(second.executionReconciliation).toEqual(snapshot.executionReconciliation); noBusiness();
  });

  it.each(["completed", "failed"] as const)("a historical cancellation flag alone does not replace a saved %s terminal", status => {
    const { task } = setup(status, "completed"); task.cancelRequested = true;
    task.summary = "原终态结论"; localStorage.setItem("opsark.tasks", JSON.stringify([task]));
    const restored = reload(task.id);
    expect(restored.status).toBe(status); expect(restored.summary).toBe("原终态结论"); noBusiness();
  });
});
