// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import { archiveTasks, listTaskArchives, markTaskArchived, readTaskArchive } from "./taskArchive";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); });
beforeEach(() => { localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia()); });
it("archives all 51 tasks before bounding the cache and explicitly reopens the original identity and goal", async () => {
  const store = useOpsStore();
  const first = store.createTask("server", "observe", "model"); first.rootGoal = "真实用户目标";
  for (let i = 0; i < 50; i++) store.createTask("server", "observe", "model");
  store.persist(true);
  expect(JSON.parse(localStorage.getItem("opsark.tasks")!)).toHaveLength(50);
  expect(await listTaskArchives()).toHaveLength(51);
  store.tasks = JSON.parse(localStorage.getItem("opsark.tasks")!);
  expect(store.tasks.some(task => task.id === first.id)).toBe(false);
  expect((await store.loadExecutionHistory()).map(group => group.taskId)).toEqual([first.id]);
  const original = await store.openArchivedTask(first.id);
  expect(original.id).toBe(first.id); expect(original.rootGoal).toBe("真实用户目标");
  expect(original.modelId).toBe("model"); expect(original.messages).toEqual(first.messages);
  expect(await store.loadExecutionHistory()).toEqual([]);
});
it("does not let automatic or stale writes revive a removed task", async () => {
  const store = useOpsStore(), task = store.createTask("server", "observe", "model");
  await markTaskArchived(task, "removed"); task.title = "stale title";
  await archiveTasks([task]);
  expect((await readTaskArchive(task.id))?.disposition).toBe("removed");
  expect((await readTaskArchive(task.id))?.title).not.toBe("stale title");
  await expect(store.openArchivedTask(task.id)).rejects.toThrow("没有可恢复");
  // Simulate a crash after durable removal but before the old display cache was updated.
  await store.restoreExecutionLedgerTasks();
  expect(store.tasks).toHaveLength(0);
});
it("preserves the old cache and visible task when archive storage cannot be read", async () => {
  const store = useOpsStore(), task = store.createTask("server", "observe", "model");
  store.persist(true); const cache = localStorage.getItem("opsark.tasks");
  localStorage.setItem("opsark.taskArchive.v1", '{"version":99,"entries":[]}');
  task.title = "new"; store.persist(true);
  expect(localStorage.getItem("opsark.tasks")).toBe(cache);
  expect(store.persistenceWarning).toContain("归档保存失败");
  expect(await store.deleteTask(task.id)).toBe(false);
  expect(store.tasks).toHaveLength(1);
  expect(localStorage.getItem("opsark.taskArchive.v1")).toContain('"version":99');
});

it("waits for the native archive before shrinking the cache and suppresses stale cache commits", async () => {
  const store = useOpsStore();
  const task = store.createTask("server", "observe", "model"); task.title = "before";
  store.persist(true); const previousCache = localStorage.getItem("opsark.tasks");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  let finishFirst!: () => void, finishSecond!: () => void;
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  const second = new Promise<void>(resolve => { finishSecond = resolve; });
  vi.mocked(invoke).mockReturnValueOnce(first).mockReturnValueOnce(second);
  task.title = "first update"; const pendingFirst = store.persist(true);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledWith("save_task_snapshots", expect.objectContaining({ snapshots: expect.any(Array) }));
  task.title = "latest update"; const pendingSecond = store.persist(true);
  expect(localStorage.getItem("opsark.tasks")).toBe(previousCache);
  finishFirst(); await pendingFirst;
  expect(localStorage.getItem("opsark.tasks")).toBe(previousCache);
  finishSecond(); await pendingSecond;
  expect(JSON.parse(localStorage.getItem("opsark.tasks")!)[0].title).toBe("latest update");
});
