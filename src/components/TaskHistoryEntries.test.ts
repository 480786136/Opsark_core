// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import * as archive from "@/services/taskArchive";
import TaskHistoryEntries from "./TaskHistoryEntries.vue";

describe("paginated task list", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    i18n.global.locale.value = "zh-CN";
    host = document.createElement("div"); document.body.append(host);
  });
  afterEach(() => { host.remove(); vi.restoreAllMocks(); });
  const flush = async () => { for (let n = 0; n < 10; n++) await nextTick(); };

  it("merges cached and archived tasks into ordered pages, searches all tasks, and opens details only on selection", async () => {
    const pinia = createPinia(), store = useOpsStore(pinia);
    const tasks = Array.from({ length: 45 }, (_, index) => {
      const task = store.createTask("server-a", "safe", "model");
      task.title = `部署应用 ${index}`;
      task.createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      return task;
    });
    const other = store.createTask("server-b", "safe", "model"); other.title = "其他服务器";
    const removed = store.createTask("server-a", "safe", "model"); removed.title = "已移除任务";
    await archive.archiveTasks([...tasks, other, removed]);
    await archive.markTaskArchived(removed, "removed");
    // The cache deliberately contains an older task as well as the newest one.
    store.tasks = [tasks[44], tasks[0]];
    store.tasks[0].title = "最新任务标题";
    const list = vi.spyOn(archive, "listTaskArchives");
    vi.spyOn(store, "refreshExecutionLedger").mockResolvedValue();
    const open = vi.spyOn(store, "openArchivedTask");
    const opened = vi.fn(), count = vi.fn(), query = ref("");
    const app = createApp({ render: () => h(TaskHistoryEntries, { serverId: "server-a", query: query.value, onOpened: opened, onCount: count }) }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await flush();
      expect(list).toHaveBeenCalledOnce();
      expect(count).toHaveBeenLastCalledWith(45);
      await vi.waitFor(() => expect(host.querySelectorAll(".task-select")).toHaveLength(20));
      expect(host.querySelector(".task-select")?.textContent).toContain("最新任务标题");
      for (const hidden of [other.title, removed.title, "查找历史任务", "更早的任务"]) expect(host.textContent).not.toContain(hidden);
      expect(open).not.toHaveBeenCalled();
      host.querySelector<HTMLButtonElement>(".task-load-more")!.click(); await flush();
      expect(host.querySelectorAll(".task-select")).toHaveLength(40);
      host.querySelector<HTMLButtonElement>(".task-load-more")!.click(); await flush();
      expect(host.querySelectorAll(".task-select")).toHaveLength(45);
      expect(host.querySelector(".task-load-more")).toBeNull();
      query.value = "部署应用 1"; await flush();
      await vi.waitFor(() => expect(host.querySelectorAll(".task-select")).toHaveLength(11));
      expect(open).not.toHaveBeenCalled();
      query.value = "不存在"; await flush();
      await vi.waitFor(() => expect(host.querySelector(".task-select")).toBeNull());
      query.value = "部署应用 1"; await flush();
      host.querySelector<HTMLButtonElement>(".task-select")!.click(); await flush();
      expect(open).toHaveBeenCalledWith(tasks[19].id);
      expect(opened).toHaveBeenCalledWith(tasks[19].id);
      await vi.waitFor(() => expect(host.querySelectorAll(".task-select")).toHaveLength(11));
      query.value = ""; await flush();
      await vi.waitFor(() => expect(host.querySelectorAll(".task-select")).toHaveLength(20));
      // Removing a cached task must not reveal its stale archive entry.
      store.tasks = store.tasks.filter(task => task.id !== tasks[44].id); await flush();
      await vi.waitFor(() => expect(host.textContent).not.toContain("最新任务标题"));
      expect(host.textContent).not.toContain("部署应用 44");
      expect(count).toHaveBeenLastCalledWith(44);
    } finally { app.unmount(); }
  });

  it("keeps cached tasks usable when directory loading fails and supports retry", async () => {
    const pinia = createPinia(), store = useOpsStore(pinia);
    const task = store.createTask("server-a", "safe", "model");
    const list = vi.spyOn(archive, "listTaskArchives").mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce([]);
    const opened = vi.fn();
    const app = createApp(TaskHistoryEntries, { serverId: "server-a", query: "", onOpened: opened }).use(pinia).use(i18n);
    app.mount(host);
    try {
      await flush();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("读取失败");
      host.querySelector<HTMLButtonElement>(".task-select")!.click(); await flush();
      expect(opened).toHaveBeenCalledWith(task.id);
      host.querySelector<HTMLButtonElement>(".new-task")!.click(); await flush();
      expect(list).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelectorAll(".task-select")).toHaveLength(1);
    } finally { app.unmount(); }
  });

  it("ignores a late directory response after switching servers", async () => {
    const pinia = createPinia(), serverId = ref("server-a");
    let finish!: (rows: archive.TaskArchiveEntry[]) => void;
    vi.spyOn(archive, "listTaskArchives")
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce([{ taskId: "b", title: "当前服务器任务", serverId: "server-b", disposition: "active" }]);
    const app = createApp({ render: () => h(TaskHistoryEntries, { serverId: serverId.value, query: "" }) }).use(pinia).use(i18n);
    app.mount(host);
    try {
      serverId.value = "server-b"; await flush();
      finish([]); await flush();
      expect(host.textContent).toContain("当前服务器任务");
    } finally { app.unmount(); }
  });
});
