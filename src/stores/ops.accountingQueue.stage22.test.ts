import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import type { ServerProfile } from "@/types";
import type { TaskModelRequest } from "@/services/taskModelRequests";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks();
});

describe("store concurrent late accounting never continues obsolete business", () => {
  it.each(["settled", "task_removed", "model_replaced", "endpoint_changed", "credential_changed"])("handles queued originals with %s", async scenario => {
    localStorage.clear(); setActivePinia(createPinia()); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const store = useOpsStore();
    store.servers = [{ id: "server", name: "fixture", host: "fixture.invalid", port: 22, username: "deploy" } as ServerProfile];
    store.models = [{ id: "model", name: "fixture", provider: "fixture", model: "fixed", endpoint: "http://127.0.0.1:18767/v1", enabled: true,
      hasApiKey: true, requestLifecycleAdapter: { protocol: "opsark-local-v1", baseUrl: "http://127.0.0.1:18767/" } }];
    store.modelApiKeys.model = "private-fixture-key";
    const tasks = Array.from({ length: 6 }, () => {
      const task = store.createTask("server", "observe", "model");
      task.status = "cancelled"; task.currentRoundId = "new-round";
      return task;
    });
    const records = new Map<string, TaskModelRequest>(tasks.map((task, i) => [task.id, {
      taskId: task.id, requestId: `original-${i}`, operationId: `old-operation-${i}`, roundId: "old-round",
      state: "unknown", phase: "transport_uncertain", cancelRequested: true, late: false,
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    }]));
    const release: Array<() => void> = [];
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.spyOn(backend, "listTaskModelRequests").mockImplementation(async taskId => [records.get(taskId)!]);
    const recover = vi.spyOn(backend, "recoverTaskModelRequest").mockImplementation(async taskId => {
      if (recover.mock.calls.length <= 4) await new Promise<void>(resolve => release.push(resolve));
      const original = { ...records.get(taskId)!, state: "completed" as const, late: true, usage: { total_tokens: 19 } };
      records.set(taskId, original); return original;
    });
    const execute = vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("forbidden"));
    const generate = vi.spyOn(backend, "generatePlan").mockRejectedValue(new Error("forbidden"));
    for (const task of tasks) await store.refreshTaskModelAccounting(task.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(4);
    if (scenario === "task_removed") store.tasks = store.tasks.filter(task => !tasks.slice(4).includes(task));
    if (scenario === "model_replaced") store.models = [{ ...store.models[0]! }];
    if (scenario === "endpoint_changed") store.models[0]!.endpoint = "http://127.0.0.1:18768/v1";
    if (scenario === "credential_changed") store.modelApiKeys.model = "replacement-fixture-key";
    release.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(100_000);
    expect(recover).toHaveBeenCalledTimes(scenario === "settled" ? 6 : 4);
    for (const call of recover.mock.calls) expect(call.slice(2)).toEqual(["http://127.0.0.1:18767/v1", "private-fixture-key", undefined, true]);
    for (const [i, task] of tasks.entries()) {
      expect(task.status).toBe("cancelled"); expect(task.currentRoundId).toBe("new-round");
      expect(task.plan).toHaveLength(0); expect(task.planApproval).toBeUndefined();
      if (scenario === "settled" || i < 4) expect(task.modelRequests?.[0]).toMatchObject({ state: "completed", late: true, usage: { total_tokens: 19 } });
      else expect(records.get(task.id)?.state).toBe("unknown");
    }
    expect(execute).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
});
