import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { ToolExecutionError } from "@/features/tools/toolFailure";
import { operationalRecoveryContext, prepareOperationalDecision } from "@/features/agent/operationalRecovery";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { useOpsStore } from "./ops";
import type { NextStageDecision, PlanStep, ServerProfile } from "@/types";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-09-30T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const proposal = (): PlanStep => ({ id: "read", title: "读取项目目录", description: "读取 /app", kind: "observe",
  action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/app" } },
  command: "", validation: "", expected: "取得项目目录", risk: "low", status: "pending" });

describe("read tool failure fallback through the actual store lifecycle", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "model", name: "test", provider: "Test", model: "test", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys.model = "fixture";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
  });
  afterEach(() => {
    const store = useOpsStore();
    for (const task of store.tasks) task.cancelRequested = true;
    store.stopConnectionMonitor(); store.persist(true); store.$dispose();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  function setup(permission: "managed" | "safe" = "managed") {
    const store = useOpsStore();
    const task = store.createTask(server.id, permission, "model");
    task.rootGoal = "读取项目目录"; task.currentRoundId = "round"; task.status = "running";
    task.plan = [proposal(), { ...proposal(), id: "dependent", command: "pwd", action: { type: "shell", command: "pwd" } }];
    const queue = vi.spyOn(store, "queueManagedAdjustment").mockResolvedValue();
    const advance = vi.spyOn(store, "advanceTask").mockResolvedValue();
    return { store, task, queue, advance };
  }

  it.each(["managed", "safe"] as const)("exhausts three transient read attempts and routes %s without advancing the failed plan", async permission => {
    const { store, task, queue, advance } = setup(permission);
    vi.useFakeTimers();
    const read = vi.spyOn(backend, "getRemoteFileStructure").mockRejectedValue(new ToolExecutionError("fixture network failure", "network", "not_sent"));
    const run = store.runStep(task.id, "read");
    await vi.advanceTimersByTimeAsync(2_100);
    await run;
    expect(read).toHaveBeenCalledTimes(3);
    expect(task.plan[0].status).toBe("failed");
    expect(task.plan[0].result?.facts.attempts).toHaveLength(3);
    expect(task.plan[0].result?.executionStatus).toBe("failed");
    expect(task.plan[1].status).toBe("pending");
    expect(task.status).toBe("needs_adjustment");
    expect(advance).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(permission === "managed" ? 1 : 0);
    expect(operationalRecoveryContext(task).toolFallback?.failures[0]).toMatchObject({ stepId: "read", category: "network", attempts: 3 });
    const next = { ...proposal(), id: "repeat" };
    const decision: NextStageDecision = { decision: "adjust", source: "model", reason: "换方法", summary: "保留失败", steps: [next] };
    expect(() => prepareOperationalDecision(task, decision)).toThrow("同参数调用已失败");
    const alternative = { ...next, command: "ls -la /app", action: { type: "shell" as const, command: "ls -la /app" } };
    expect(prepareOperationalDecision(task, { ...decision, steps: [alternative] }).steps).toEqual([alternative]);
    expect(operationalRecoveryContext(task).toolFallback?.instruction).toContain("升级 Python");
  });

  it.each(["unavailable", "output"] as const)("routes a deterministic %s failure after one attempt", async category => {
    const { store, task, queue } = setup();
    const read = vi.spyOn(backend, "getRemoteFileStructure").mockRejectedValue(new ToolExecutionError("fixture failure", category, "not_sent"));
    await store.runStep(task.id, "read");
    expect(read).toHaveBeenCalledOnce();
    expect(task.plan[0].status).toBe("failed");
    expect(queue).toHaveBeenCalledOnce();
  });

  it("generates an alternate read plan with the failure context and preserves safe-mode approval", async () => {
    const { store, task } = setup("safe");
    vi.spyOn(backend, "getRemoteFileStructure").mockRejectedValue(new ToolExecutionError("probe unavailable", "unavailable", "not_sent"));
    await store.runStep(task.id, "read");
    const original = JSON.parse(JSON.stringify(task.plan[0])) as PlanStep;
    const command = "ls -la /app";
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "adjust", source: "model",
      reason: "探针不可用，改用已授权的只读命令", summary: "读取同一目录", steps: [{ ...proposal(), id: "alternative", command,
        action: { type: "shell", command }, validation: "", executionScope: "isolated_exec" }] });
    const execute = vi.spyOn(backend, "executeCommand");
    await store.requestAdjustment(task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.plan[0].action).toEqual({ type: "shell", command });
    expect(task.phaseHistory?.some(phase => phase.plan.some(step => step.id === "read" && step.status === "failed"))).toBe(true);
    expect(task.phaseHistory?.flatMap(phase => phase.plan).find(step => step.id === "read")?.result).toEqual(original.result);
    const context = JSON.parse(decide.mock.calls[0][1]!.context!);
    expect(context.operationsRecovery.toolFallback.failures[0]).toMatchObject({ toolId: "files.get_structure", category: "unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not grant Shell capability to an alternate plan", async () => {
    const { store, task } = setup();
    vi.spyOn(backend, "getRemoteFileStructure").mockRejectedValue(new ToolExecutionError("probe unavailable", "unavailable", "not_sent"));
    await store.runStep(task.id, "read");
    const failed = JSON.parse(JSON.stringify(task.plan[0])) as PlanStep;
    task.phaseHistory = [{ id: "failed-phase", roundId: task.currentRoundId!, reason: "adjustment", requirement: task.rootGoal!,
      plan: [failed], createdAt: task.createdAt, completedAt: task.updatedAt }];
    const command = "ls -la /app";
    task.plan = [{ ...proposal(), id: "alternative", command, action: { type: "shell", command } }];
    task.status = "running";
    localStorage.setItem("opsark.executionPermissions", JSON.stringify({ allowShell: false, toolIds: ["files.get_structure"] }));
    const execute = vi.spyOn(backend, "executeCommand");
    await store.runStep(task.id, "alternative");
    expect(execute).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("执行权限禁止 Agent Shell");
    expect(task.phaseHistory![0].plan[0].status).toBe("failed");
  });

  it.each(["authentication", "permission"] as const)("does not use alternate methods to bypass %s", async category => {
    const { store, task, queue, advance } = setup();
    const read = vi.spyOn(backend, "getRemoteFileStructure").mockRejectedValue(new ToolExecutionError("fixture refusal", category, "not_sent"));
    await store.runStep(task.id, "read");
    expect(read).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(operationalRecoveryContext(task).toolFallback).toBeUndefined();
  });

  it.each(["target", "connection", "arguments"])("does not route stale results when %s changes during retry", async change => {
    const { store, task, queue } = setup();
    vi.useFakeTimers();
    const read = vi.spyOn(backend, "getRemoteFileStructure").mockImplementationOnce(async () => {
      if (change === "target") task.executionTargetServerId = "other";
      else if (change === "connection") store.serverConnection(task.serverId).generation += 1;
      else if (task.plan[0].action?.type === "tool") task.plan[0].action.arguments.rootPath = "/changed";
      throw new ToolExecutionError("temporary", "network", "not_sent");
    });
    const run = store.runStep(task.id, "read");
    await vi.advanceTimersByTimeAsync(600); await run;
    expect(read).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
  });

  it("does not convert a ledger storage failure into a tool fallback", async () => {
    const { store, task, queue } = setup();
    const repository = createMemoryExecutionLedgerRepository();
    vi.spyOn(repository, "prepare").mockRejectedValue(new Error("EXECUTION_LEDGER_STORAGE: fixture disk full"));
    configureExecutionLedger(store, repository, async () => "a".repeat(64));
    const read = vi.spyOn(backend, "getRemoteFileStructure");
    await store.runStep(task.id, "read");
    expect(read).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(task.executionLedgerError?.stage).toBe("prepare");
    expect(operationalRecoveryContext(task).toolFallback).toBeUndefined();
  });
});
