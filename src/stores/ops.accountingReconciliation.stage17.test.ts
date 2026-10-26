import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import type { ServerProfile } from "@/types";
import type { TaskModelRequest } from "@/services/taskModelRequests";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); });
describe("store accounting refresh never continues obsolete business", () => {
  it("reconciles an old-round unknown from a cancelled task, without approval, regeneration or execution", async () => {
    localStorage.clear(); setActivePinia(createPinia()); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const store = useOpsStore();
    store.servers = [{ id: "server", name: "fixture", host: "fixture.invalid", port: 22, username: "deploy" } as ServerProfile];
    store.models = [{ id: "model", name: "fixture", provider: "fixture", model: "fixed", endpoint: "http://127.0.0.1:18767/v1", enabled: true,
      hasApiKey: true, requestLifecycleAdapter: { protocol: "opsark-local-v1", baseUrl: "http://127.0.0.1:18767/" } }];
    store.modelApiKeys.model = "private-fixture-key";
    const task = store.createTask("server", "observe", "model");
    task.status = "cancelled"; task.currentRoundId = "new-round";
    let original: TaskModelRequest = { taskId: task.id, requestId: "original", operationId: "original-operation", roundId: "old-round",
      state: "unknown", phase: "transport_uncertain", cancelRequested: true, late: false, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.spyOn(backend, "listTaskModelRequests").mockImplementation(async () => [original]);
    const recover = vi.spyOn(backend, "recoverTaskModelRequest").mockImplementation(async () => { original = { ...original, state: "completed", late: true, usage: { total_tokens: 19 } }; return original; });
    const execute = vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("forbidden"));
    const generate = vi.spyOn(backend, "generatePlan").mockRejectedValue(new Error("forbidden"));
    await store.refreshTaskModelAccounting(task.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(recover).toHaveBeenCalledExactlyOnceWith(task.id, "original", "http://127.0.0.1:18767/v1", "private-fixture-key", undefined, true);
    expect(task.status).toBe("cancelled"); expect(task.currentRoundId).toBe("new-round");
    expect(task.plan).toHaveLength(0); expect(task.planApproval).toBeUndefined();
    expect(task.modelRequests?.[0]?.state).toBe("completed");
    expect(execute).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
});
