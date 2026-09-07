// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { STORAGE_KEY, useServerWorkspaceTabsStore } from "./serverWorkspaceTabsStore";

describe("serverWorkspaceTabsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("持久化窗口顺序和活动服务器并过滤已删除服务器", () => {
    const store = useServerWorkspaceTabsStore();
    store.hydrate(["a", "b", "c"], "a");
    store.open("b");
    store.open("c");
    store.activate("b");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      version: 1,
      openServerIds: ["a", "b", "c"],
      activeServerId: "b",
    });

    setActivePinia(createPinia());
    const restored = useServerWorkspaceTabsStore();
    restored.hydrate(["a", "b"], "b");
    expect(restored.openServerIds).toEqual(["a", "b"]);
    expect(restored.activeServerId).toBe("b");
  });

  it("关闭活动窗口后选择视觉相邻窗口", () => {
    const store = useServerWorkspaceTabsStore();
    store.hydrate(["a", "b", "c"], "a");
    store.open("b");
    store.open("c");
    expect(store.close("c")).toBe("b");
    expect(store.close("b")).toBe("a");
    expect(store.close("a")).toBe("");
  });

});
