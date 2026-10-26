import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { createTaskModelBudget, taskBudgetRegistration } from "@/features/agent/taskModelBudget";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import type { ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "budget-server", host: "fixture.invalid", port: 22, username: "fixture",
  name: "预算测试", group: "test", status: "offline", environment: [], createdAt: "2026-10-12T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };

describe("task budget ownership at store entry points", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "model", name: "test", provider: "Test", model: "test", endpoint: "https://fixture.invalid",
      enabled: true, hasApiKey: true }];
    store.modelApiKeys.model = "fixture";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("本测试禁止远端派发"));
    // Capture the real store-built context without invoking a paid model or
    // depending on requirement classification behavior in this budget regression.
    vi.spyOn(backend, "processRequirement").mockRejectedValue(new Error("fixture stops after context capture"));
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port,
      username: server.username, password: "fixture" });
  });
  afterEach(() => {
    const store = useOpsStore();
    for (const task of store.tasks) task.cancelRequested = true;
    store.stopConnectionMonitor(); store.persist(true); store.$dispose();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  it.each([[250_000, 600_000], [600_000, 250_000]])(
    "a task with %i tokens borrowing a %i-token reference keeps its own registration",
    async (actualLimit, referenceLimit) => {
      const store = useOpsStore();
      const actual = store.createTask(server.id, "safe", "model", createTaskModelBudget(actualLimit, actualLimit - 10_000));
      const reference = store.createTask(server.id, "safe", "model", createTaskModelBudget(referenceLimit));
      reference.rootGoal = "历史部署需求，仅作为上下文参考";
      reference.currentRoundId = "reference-round";
      const actualRound = actual.currentRoundId;
      await store.submitRequirement(server.id, "读取当前服务状态", "safe", "model", "", actual.id, reference.id);
      expect(backend.processRequirement).toHaveBeenCalledOnce();
      const context = vi.mocked(backend.processRequirement).mock.calls[0][1].context;
      expect(taskBudgetRegistration(context)).toEqual({ taskId: actual.id, roundId: actualRound,
        maxTaskTokens: actualLimit, maxRoundTokens: actualLimit - 10_000, safetyReserveTokens: 0 });
      expect(actual.modelTokenBudget?.lockedAt).toEqual(expect.any(String));
      expect(reference.modelTokenBudget?.lockedAt).toBeUndefined();
      expect(reference.modelTokenBudget?.maxTaskTokens).toBe(referenceLimit);
      expect(backend.executeCommand).not.toHaveBeenCalled();
    });

  it("saving an imported task's remaining allowance freezes it before direct planning retry", async () => {
    const store = useOpsStore();
    const task = store.createTask(server.id, "safe", "model");
    task.rootGoal = "读取服务状态"; task.currentInstruction = task.rootGoal;
    task.status = "needs_adjustment"; task.currentRoundId = "imported-round";
    delete task.modelTokenBudget;
    store.recordModelPlanningBlocker(task, { code: "MODEL_FORMAT_INVALID", message: "fixture invalid JSON",
      origin: "core", stage: "json_parse", retryable: false });
    store.configureTaskModelTokens(task.id, 250_000, 200_000);
    const currentPolicy = () => store.tasks.find(current => current.id === task.id)?.modelTokenBudget;
    const lockedAt = currentPolicy()?.lockedAt;
    expect(currentPolicy()).toMatchObject({ coverage: "from_registration", lockedAt: expect.any(String) });
    expect(() => store.configureTaskModelTokens(task.id, 600_000, 600_000)).toThrow(/不能修改/);
    const decide = vi.spyOn(backend, "decideNextStage").mockRejectedValue(new Error("fixture stops after retry context capture"));
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalledOnce();
    expect(taskBudgetRegistration(decide.mock.calls[0][1]!.context)).toEqual({ taskId: task.id, roundId: "imported-round",
      maxTaskTokens: 250_000, maxRoundTokens: 200_000, safetyReserveTokens: 0 });
    expect(currentPolicy()?.lockedAt).toBe(lockedAt);
    expect(() => store.configureTaskModelTokens(task.id, 300_000, 200_000)).toThrow(/不能修改/);
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("a fresh draft remains editable until submission, including a failed first model call", async () => {
    const store = useOpsStore();
    const task = store.createTask(server.id, "safe", "model");
    store.configureTaskModelTokens(task.id, 250_000, 200_000);
    store.configureTaskModelTokens(task.id, 600_000, 300_000);
    expect(task.modelTokenBudget).toMatchObject({ coverage: "complete", maxTaskTokens: 600_000, maxRoundTokens: 300_000 });
    expect(task.modelTokenBudget?.lockedAt).toBeUndefined();
    await store.submitRequirement(server.id, "只读核对主机状态", "safe", "model", "", task.id);
    expect(task.modelTokenBudget?.lockedAt).toEqual(expect.any(String));
    expect(taskBudgetRegistration(vi.mocked(backend.processRequirement).mock.calls[0][1].context)).toMatchObject({
      taskId: task.id, maxTaskTokens: 600_000, maxRoundTokens: 300_000 });
    expect(() => store.configureTaskModelTokens(task.id, 1_000_000, 1_000_000)).toThrow(/不能修改/);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
