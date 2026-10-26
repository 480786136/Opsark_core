// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { createTaskModelBudget, type TaskModelBudgetSnapshot } from "@/features/agent/taskModelBudget";
import type { TaskModelRequest } from "@/services/taskModelRequests";
import { useOpsStore } from "@/stores/ops";
import TaskModelAccounting from "./TaskModelAccounting.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
let app: App | undefined;
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); setActivePinia(createPinia()); });
afterEach(() => {
  app?.unmount(); app = undefined;
  const store = useOpsStore(); store.stopConnectionMonitor(); store.persist(true); store.$dispose();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it.each([
  ["completed", false], ["completed", true], ["accepted", true], ["unknown", true],
] as const)("store stop and accounting refresh preserve %s receipt (historical cancellation=%s)", async (state, cancelRequested) => {
  const store = useOpsStore();
  const task = store.createTask("isolated-server", "managed", "model", createTaskModelBudget(250000));
  task.modelTokenBudget!.lockedAt = new Date().toISOString();
  task.status = "planning_failed";
  store.recordModelPlanningBlocker(task, { code: "MODEL_DISPATCH_UNKNOWN", origin: "core", stage: "request_recovery",
    retryable: false, message: "original result pending", requestKey: "original-request" });
  const completed = state === "completed";
  const original: TaskModelRequest = { requestId: "original-request", operationId: "original-operation", taskId: task.id,
    roundId: task.currentRoundId, state, phase: completed ? "completed" : "running", cancelRequested, late: false,
    usage: completed ? { total_tokens: 17843 } : undefined, createdAtMs: 1, updatedAtMs: 2 };
  const account = { maxTotalTokens: 250000, accountedTokens: completed ? 17843 : 32028,
    knownUsageTokens: completed ? 17843 : 0, estimatedReservedTokens: completed ? 0 : 32028,
    exactTokens: completed, unknownUsageAttempts: completed ? 0 : 1 };
  const snapshot: TaskModelBudgetSnapshot = { version: 1, persistent: true, taskId: task.id,
    roundId: task.currentRoundId!, task: { ...account }, round: { ...account } };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  const cancel = vi.spyOn(backend, "cancelCurrentTaskModelRequests").mockResolvedValue();
  const list = vi.spyOn(backend, "listTaskModelRequests").mockResolvedValue([original]);
  vi.spyOn(backend, "queryTaskModelBudget").mockResolvedValue(snapshot);
  const generate = vi.spyOn(backend, "processRequirement");
  const command = vi.spyOn(backend, "executeCommand");
  const host = document.createElement("div"); document.body.append(host);
  app = createApp(TaskModelAccounting, { task, draftPolicy: createTaskModelBudget(250000) });
  app.mount(host);
  store.rejectTask(task.id);
  await vi.waitFor(() => expect(task.modelBudgetSnapshot).toEqual(snapshot));
  await nextTick();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(task.id);
  expect(list).toHaveBeenCalledExactlyOnceWith(task.id);
  expect(task.status).toBe("cancelled");
  expect(task.modelRequests).toEqual([original]);
  expect(host.textContent).toContain(completed ? "已知用量 17,843；预留 0" : "已知用量 0；预留 32,028");
  if (completed) {
    expect(host.textContent).toContain("响应已记录");
    expect(host.textContent).not.toContain("未确认停止");
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "查询原请求")).toBe(false);
  } else {
    expect(host.textContent).toContain("已请求取消，未确认停止");
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "查询原请求")).toBe(true);
  }
  expect(generate).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

it.each([false, true])("an older accounting read cannot replace a newer balance or error, reject=%s", async rejectOld => {
  const store = useOpsStore();
  const task = store.createTask("isolated-server", "managed", "model", createTaskModelBudget(250000));
  task.modelTokenBudget!.lockedAt = new Date().toISOString();
  const account = (tokens: number) => ({ maxTotalTokens: 250000, accountedTokens: tokens,
    knownUsageTokens: tokens, estimatedReservedTokens: 0, exactTokens: true, unknownUsageAttempts: 0 });
  const snapshot = (tokens: number): TaskModelBudgetSnapshot => ({ version: 1, persistent: true, taskId: task.id,
    roundId: task.currentRoundId!, task: account(tokens), round: account(tokens) });
  let resolveOld!: (value: TaskModelBudgetSnapshot) => void, failOld!: (error: Error) => void;
  const oldRead = new Promise<TaskModelBudgetSnapshot>((resolve, reject) => { resolveOld = resolve; failOld = reject; });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.spyOn(backend, "listTaskModelRequests").mockResolvedValue([]);
  vi.spyOn(backend, "queryTaskModelBudget").mockImplementationOnce(() => oldRead).mockResolvedValue(snapshot(146393));
  const first = store.refreshTaskModelAccounting(task.id);
  await store.refreshTaskModelAccounting(task.id);
  if (rejectOld) failOld(new Error("stale read failed")); else resolveOld(snapshot(17843));
  await first;
  expect(task.modelBudgetSnapshot?.task.knownUsageTokens).toBe(146393);
  expect(task.modelAccountingError).toBeUndefined();
});
