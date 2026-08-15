// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { STORAGE_KEY, useAgentWorkspaceStore } from "./agentWorkspaceStore";

describe("agentWorkspaceStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => vi.useRealTimers());

  it("按服务器持久化任务选择、草稿、模型和授权模式", () => {
    const store = useAgentWorkspaceStore();
    store.updateServer("server-a", {
      activeTaskId: "task-a",
      draft: "检查 nginx",
      permission: "observe",
      modelId: "model-a",
      automationEnabled: true,
      showTasks: false,
    });
    store.updateServer("server-b", { activeTaskId: "task-b", draft: "检查磁盘" });
    vi.runAllTimers();

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").workspaces["server-a"])
      .toMatchObject({ activeTaskId: "task-a", draft: "检查 nginx", permission: "observe" });
    expect(store.workspaces["server-b"].draft).toBe("检查磁盘");
  });

  it("任务删除后只修正对应服务器的活动任务", () => {
    const store = useAgentWorkspaceStore();
    store.updateServer("server-a", { activeTaskId: "missing" });
    store.updateServer("server-b", { activeTaskId: "task-b" });
    store.reconcileTasks("server-a", ["task-a"]);

    expect(store.workspaces["server-a"].activeTaskId).toBe("task-a");
    expect(store.workspaces["server-b"].activeTaskId).toBe("task-b");
  });
});
