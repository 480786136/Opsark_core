import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useAgentTerminalStore } from "@/features/terminal/agentTerminalStore";
import type { AgentSessionRef, OpsTask, PermissionLevel, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const server = (id: string): ServerProfile => ({
  id, host: `${id}.example.invalid`, port: 22, username: "tester", name: id, group: "test",
  status: "offline", environment: [], createdAt: "2026-09-15T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
});
function session(task: OpsTask, state: AgentSessionRef["state"] = "ready"): AgentSessionRef {
  return { id: `agent-${task.id}`, taskId: task.id, serverId: task.executionTargetServerId ?? task.serverId,
    generation: 2, state, context: { environment: {}, sourceFiles: [], shell: "bash", revision: 0 }, createdAt: task.createdAt };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(permission: PermissionLevel = "safe", state: AgentSessionRef["state"] = "ready") {
  const ops = useOpsStore();
  const task = ops.createTask("a", permission, "test-model");
  task.status = "needs_adjustment";
  task.managedAdjustmentPhase = "waiting_transport";
  task.managedStopReason = "transport_recovery";
  task.plan = [{ id: "failed", kind: "change", title: "更新应用", description: "更新应用", command: "app apply",
    validation: "app status", expected: "应用正常", risk: "medium", status: "failed",
    result: { executionStatus: "failed", observationStatus: "unknown", warnings: [], evidenceIds: [],
      facts: { category: "terminal_transport" } } }];
  const terminals = useAgentTerminalStore();
  terminals.registerSession(session(task, state));
  return { ops, task, terminals };
}
async function connect(id: string) {
  const target = useOpsStore().servers.find(item => item.id === id)!;
  await useConnectionStore().connect(id, { host: target.host, port: target.port, username: target.username, password: "fixture" });
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("bounded task transport recovery", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    setActivePinia(createPinia());
    useOpsStore().servers = [server("a"), server("b")];
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "generatePlan").mockResolvedValue([]);
    vi.spyOn(backend, "processRequirement").mockResolvedValue({ intent: "execute", relation: "new_goal", plan: [] });
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("unexpected business command"));
    vi.spyOn(backend, "executeAgentCommand").mockRejectedValue(new Error("unexpected Agent business command"));
    vi.spyOn(backend, "createAgentTerminal").mockImplementation(async (_serverId, taskId) =>
      session(useOpsStore().tasks.find(task => task.id === taskId)!));
    await connect("a");
  });
  afterEach(async () => {
    useOpsStore().tasks.forEach(task => { task.cancelRequested = true; });
    await vi.advanceTimersByTimeAsync(500);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each(["safe", "observe"] as const)("%s consumes periodic transport state without starting business planning", async permission => {
    const { ops, task } = fixture(permission);
    task.plan[0].result!.facts = { category: "terminal_recovery", stoppedByPeriodicReview: true };
    await ops.requestAdjustment(task.id, true);
    expect(task.plan[0].result!.facts.category).toBe("periodic_review");
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.managedAdjustmentPhase).toBeUndefined();
    expect(task.managedStopReason).toBeUndefined();
    expect(task.pauseReason).toContain("手动生成后续计划");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("managed periodic recovery hands off to the normal managed strategy after clearing wait state", async () => {
    const { ops, task } = fixture("managed");
    task.plan[0].result!.facts = { category: "terminal_recovery", stoppedByPeriodicReview: true };
    const queue = vi.spyOn(ops, "queueManagedAdjustment").mockResolvedValue(undefined);
    await ops.requestAdjustment(task.id, true);
    expect(queue).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(task.managedAdjustmentPhase).toBeUndefined();
    expect(task.managedStopReason).toBeUndefined();
  });

  it("a ready channel with unknown command side effects stops manually without replay", async () => {
    const { ops, task } = fixture("managed");
    const approve = vi.spyOn(ops, "approvePlan").mockResolvedValue(undefined);
    await ops.requestAdjustment(task.id, true);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.managedStopReason).toBe("transport_recovery");
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.plan[0].status).toBe("failed");
    expect(approve).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("clears stale wait state before replaying an explicitly unsent step", async () => {
    const { ops, task } = fixture();
    task.plan[0].result!.facts.commandDispatched = false;
    const approve = vi.spyOn(ops, "approvePlan").mockImplementation(async () => {
      expect(task.managedAdjustmentPhase).toBeUndefined();
      expect(task.managedStopReason).toBeUndefined();
      expect(task.adjustmentIncident).toBeUndefined();
      task.status = "needs_adjustment";
    });
    await ops.requestAdjustment(task.id, true);
    expect(approve).toHaveBeenCalledExactlyOnceWith(task.id, true);
    expect(task.plan[0].command).toBe("app apply");
    expect(task.transportRecovery?.replayCount).toBe(1);
    expect(task.managedAdjustmentPhase).toBeUndefined();
  });

  it("ready without a failed step consumes the wait instead of self-routing forever", async () => {
    const { ops, task, terminals } = fixture("managed", "busy");
    task.plan = [];
    task.pauseReason = "绑定终端尚未就绪";
    await ops.requestAdjustment(task.id, true);
    expect(ops.transportRecoveryTaskIds).toContain(task.id);
    terminals.sessionsByTask[task.id].state = "ready";
    await vi.advanceTimersByTimeAsync(250);
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.pauseReason).toContain("没有可自动重放的失败步骤");
    expect(task.status).toBe("needs_adjustment");
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("a recovered channel whose blocker is now business does not start a model from the transport entry", async () => {
    const { ops, task, terminals } = fixture("managed", "busy");
    task.plan[0].result!.facts.category = "business_failure";
    await ops.requestAdjustment(task.id, true);
    terminals.sessionsByTask[task.id].state = "ready";
    await vi.advanceTimersByTimeAsync(250);
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.managedStopReason).toBeUndefined();
    expect(task.adjustmentIncident).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("the direct transport-only adjustment contract rejects business planning too", async () => {
    const { ops, task } = fixture("managed");
    task.plan[0].result!.facts.category = "business_failure";
    const planning = vi.spyOn(ops, "beginAdjustment").mockResolvedValue(undefined);
    await ops.requestAdjustment(task.id, true, true);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.managedStopReason).toBeUndefined();
    expect(task.pauseReason).toContain("不会生成业务调整计划");
    expect(planning).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("refreshes a recovering Agent after verified SSH recovery and consumes unknown effects manually", async () => {
    const { ops, task, terminals } = fixture("managed", "recovering");
    await ops.requestAdjustment(task.id, true);
    await flush();
    expect(backend.createAgentTerminal).toHaveBeenCalledOnce();
    expect(terminals.sessionsByTask[task.id].state).toBe("ready");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("does not refresh a busy Agent slot and bounds the wait to 30 seconds", async () => {
    const { ops, task, terminals } = fixture("managed", "busy");
    await ops.requestAdjustment(task.id, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.createAgentTerminal).not.toHaveBeenCalled();
    expect(terminals.sessionsByTask[task.id].state).toBe("busy");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
  });

  it("limits unsuccessful local session refreshes without polling the backend every 250 ms", async () => {
    const { ops, task } = fixture("managed", "recovering");
    vi.mocked(backend.createAgentTerminal).mockImplementation(async () => session(task, "recovering"));
    await ops.requestAdjustment(task.id, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.createAgentTerminal).toHaveBeenCalledTimes(3);
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
  });

  it("times out a hung session refresh and rejects its late ready response", async () => {
    const { ops, task, terminals } = fixture("managed", "recovering");
    const pending = deferred<AgentSessionRef>();
    vi.mocked(backend.createAgentTerminal).mockReturnValueOnce(pending.promise);
    await ops.requestAdjustment(task.id, true);
    expect(ops.transportRecoveryTaskIds).toContain(task.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.pauseReason).toContain("检查超时");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    pending.resolve(session(task));
    await flush();
    expect(terminals.sessionsByTask[task.id].state).toBe("recovering");
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("finishes rejected recovery checks manually and releases runtime ownership", async () => {
    const { ops, task } = fixture("managed", "recovering");
    vi.mocked(backend.createAgentTerminal).mockRejectedValueOnce(new Error("local session unavailable"));
    await ops.requestAdjustment(task.id, true);
    await flush();
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.pauseReason).toContain("local session unavailable");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
  });

  it("checks the actual execution target when there is no Agent session", async () => {
    const { ops, task, terminals } = fixture("managed");
    task.executionTargetServerId = "b";
    delete terminals.sessionsByTask[task.id];
    await ops.requestAdjustment(task.id, true);
    expect(ops.transportRecoveryTaskIds).toContain(task.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task.managedAdjustmentPhase).toBe("waiting_transport");
    expect(backend.createAgentTerminal).not.toHaveBeenCalled();
    await connect("b");
    await vi.advanceTimersByTimeAsync(250);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(backend.createAgentTerminal).toHaveBeenCalledWith("b", task.id, expect.objectContaining({ host: "b.example.invalid" }));
  });

  it.each(["round", "cancel", "target", "connection", "busy"] as const)(
    "rejects a delayed session registration after %s changes", async kind => {
      const { ops, task, terminals } = fixture("managed", "recovering");
      const pending = deferred<AgentSessionRef>();
      vi.mocked(backend.createAgentTerminal).mockReturnValueOnce(pending.promise);
      const ensuring = ops.ensureTaskAgentSession(task.id);
      const old = session(task);
      if (kind === "round") task.currentRoundId = "new-round";
      if (kind === "cancel") task.cancelRequested = true;
      if (kind === "target") task.executionTargetServerId = "b";
      if (kind === "connection") useConnectionStore().state("a").generation += 1;
      if (kind === "busy") terminals.sessionsByTask[task.id].state = "busy";
      pending.resolve(old);
      expect(await ensuring).toBeUndefined();
      expect(terminals.sessionsByTask[task.id].state).toBe(kind === "busy" ? "busy" : "recovering");
      expect(task.agentSessionId).toBeUndefined();
    },
  );

  it("releases an old worker without changing a newer task round", async () => {
    const { ops, task } = fixture("managed", "busy");
    await ops.requestAdjustment(task.id, true);
    task.currentRoundId = "new-round";
    task.pauseReason = "new round evidence";
    task.managedAdjustmentPhase = "manual_required";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task.pauseReason).toBe("new round evidence");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
  });

  it("releases ownership before replay so a new transport failure can start its own wait", async () => {
    const { ops, task, terminals } = fixture("managed", "busy");
    task.plan[0].result!.facts.commandDispatched = false;
    vi.spyOn(ops, "approvePlan").mockImplementationOnce(async () => {
      expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
      task.status = "needs_adjustment";
      task.plan[0].status = "failed";
      task.plan[0].result = { executionStatus: "failed", observationStatus: "unknown", warnings: [], evidenceIds: [],
        facts: { category: "terminal_transport" } };
      terminals.sessionsByTask[task.id].state = "busy";
      await ops.requestAdjustment(task.id, true);
    });
    await ops.requestAdjustment(task.id, true);
    terminals.sessionsByTask[task.id].state = "ready";
    await vi.advanceTimersByTimeAsync(250);
    expect(ops.transportRecoveryTaskIds).toContain(task.id);
    expect(task.managedAdjustmentPhase).toBe("waiting_transport");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
  });

  it("does not replenish replay budget when only the Agent failure generation increases", async () => {
    const { ops, task, terminals } = fixture("managed");
    const failed = JSON.parse(JSON.stringify(task.plan[0]));
    failed.result.facts.commandDispatched = false;
    task.plan = [failed];
    const approve = vi.spyOn(ops, "approvePlan").mockImplementation(async () => { task.status = "needs_adjustment"; });
    await ops.requestAdjustment(task.id, true);
    expect(approve).toHaveBeenCalledTimes(1);
    task.plan = [JSON.parse(JSON.stringify(failed))];
    terminals.sessionsByTask[task.id].generation += 1;
    await ops.requestAdjustment(task.id, true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(task.pauseReason).toContain("已自动重放过一次");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    useConnectionStore().disconnect("a");
    await connect("a");
    await ops.requestAdjustment(task.id, true);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it("checks a restored transport marker without failed steps or matching prose, and never invokes a business model", async () => {
    const { ops, task, terminals } = fixture("managed", "closed");
    task.plan = [];
    task.managedAdjustmentPhase = "manual_required";
    task.managedStopReason = "transport_recovery";
    task.pauseReason = "上次检查中断";
    await ops.routeAutomaticAdjustment(task.id, { transportRecovery: true });
    await flush();
    expect(backend.createAgentTerminal).toHaveBeenCalledOnce();
    expect(terminals.sessionsByTask[task.id].state).toBe("ready");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.pauseReason).toContain("没有可自动重放的失败步骤");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("contains a failed handoff without leaving a phantom worker", async () => {
    const { ops, task, terminals } = fixture("managed", "busy");
    await ops.requestAdjustment(task.id, true);
    vi.spyOn(ops, "routeAutomaticAdjustment").mockRejectedValueOnce(new Error("recovery handoff failed"));
    terminals.sessionsByTask[task.id].state = "ready";
    await vi.advanceTimersByTimeAsync(250);
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.pauseReason).toContain("recovery handoff failed");
    expect(ops.transportRecoveryTaskIds).not.toContain(task.id);
  });

  it("restores persisted waits as an explicit manual check, never as a live worker", () => {
    const { ops, task } = fixture("managed");
    ops.transportRecoveryTaskIds.push(task.id);
    ops.persist(true);
    setActivePinia(createPinia());
    const restored = useOpsStore();
    expect(restored.transportRecoveryTaskIds).toEqual([]);
    expect(restored.tasks.find(item => item.id === task.id)).toMatchObject({
      managedAdjustmentPhase: "manual_required", managedStopReason: "transport_recovery",
      pauseReason: expect.stringContaining("上次终端恢复检查已中断"),
    });
  });
});
