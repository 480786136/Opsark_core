// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  LEGACY_STORAGE_KEY, LOCAL_WORKSPACE_ID, MAX_OPEN_SERVER_WINDOWS, STORAGE_KEY,
  useServerWorkspaceTabsStore,
} from "./serverWorkspaceTabsStore";

const local = { id: LOCAL_WORKSPACE_ID, kind: "local" };
const server = (id: string) => ({ id, kind: "server" });

function restore(available = ["a", "b", "c"]) {
  setActivePinia(createPinia());
  const store = useServerWorkspaceTabsStore();
  store.hydrate(available);
  return store;
}

describe("serverWorkspaceTabsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("starts with Local and does not open a server just because it exists or a cached route points to it", () => {
    const store = useServerWorkspaceTabsStore();
    store.hydrate(["a"], "a");
    expect(store.openTabs).toEqual([local]);
    expect(store.activeTabId).toBe("local");
    expect(store.activeServerId).toBe("");
  });

  it("persists one shared order and active identity for Local and servers", () => {
    const store = restore();
    store.open("a");
    store.open("b");
    expect(store.close("local")).toBe("b");
    store.open("local");
    store.activate("a");
    expect(store.openTabs).toEqual([server("a"), server("b"), local]);
    expect(store.activeServerId).toBe("a");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      version: 2, openTabs: [server("a"), server("b"), local], activeTabId: "a",
    });
    const restored = restore();
    expect(restored.openTabs).toEqual(store.openTabs);
    expect(restored.activeTabId).toBe("a");
    expect(restored.activate("missing")).toBe(false);
    expect(restored.activeTabId).toBe("a");
  });

  it("selects the right neighbor, then the left, regardless of tab kind", () => {
    const store = restore();
    store.open("a");
    store.open("b");
    store.open("c");
    store.activate("a");
    expect(store.close("a")).toBe("b");
    expect(store.close("b")).toBe("c");
    expect(store.close("c")).toBe("local");
    expect(store.openTabs).toEqual([local]);
    expect(store.close("local")).toBe("local");
    expect(store.openTabs).toEqual([local]);
  });

  it("can close Local while a server remains and recreates Local only when all tabs close", () => {
    const store = restore();
    store.open("a");
    store.activate("local");
    expect(store.close("local")).toBe("a");
    expect(store.openTabs).toEqual([server("a")]);
    expect(restore().openTabs).toEqual([server("a")]);
    expect(store.close("a")).toBe("local");
    expect(store.openTabs).toEqual([local]);
  });

  it("does not resurrect the last closed server during hydration or reload", () => {
    const store = restore();
    store.open("a");
    store.close("a");
    store.hydrate(["a"], "a");
    expect(store.openTabs).toEqual([local]);
    localStorage.setItem("opsark.lastWorkspace.v1", "/server/a");
    expect(restore(["a"]).openTabs).toEqual([local]);
    expect(restore(["a"]).activeTabId).toBe("local");
  });

  it("migrates legacy server tabs once and respects the last Local selection", () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1, openServerIds: ["a", "b", "a", "deleted"], activeServerId: "b",
    }));
    localStorage.setItem("opsark.lastWorkspace.v1", "/local");
    const store = restore();
    expect(store.openTabs).toEqual([local, server("a"), server("b")]);
    expect(store.activeTabId).toBe("local");
    store.close("b");
    store.close("local");
    expect(restore().openTabs).toEqual([server("a")]);
    expect(restore().activeTabId).toBe("a");
  });

  it("migrates a valid legacy active server but never reopens an active id absent from the list", () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1, openServerIds: ["a"], activeServerId: "a",
    }));
    expect(restore().activeTabId).toBe("a");
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1, openServerIds: ["a"], activeServerId: "b",
    }));
    const store = restore();
    expect(store.openTabs).toEqual([local, server("a")]);
    expect(store.activeTabId).toBe("local");
  });

  it("cleans deleted servers and moves an active deleted tab to its surviving neighbor", () => {
    const store = restore();
    store.open("a");
    store.open("b");
    store.open("c");
    store.activate("b");
    store.hydrate(["a", "c"]);
    expect(store.openTabs).toEqual([local, server("a"), server("c")]);
    expect(store.activeTabId).toBe("c");
    store.close("local");
    store.hydrate([]);
    expect(store.openTabs).toEqual([local]);
    expect(store.activeTabId).toBe("local");
  });

  it("normalizes malformed saved tabs and active identity without adding closed Local", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      openTabs: [null, {}, server("a"), server("a"), server("deleted"), { id: "local", kind: "server" }],
      activeTabId: "deleted",
    }));
    const store = restore();
    expect(store.openTabs).toEqual([server("a")]);
    expect(store.activeTabId).toBe("a");
  });

  it("keeps the same neighboring selection when an active server was deleted between launches", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, openTabs: [local, server("a"), server("b"), server("c")], activeTabId: "b",
    }));
    const store = restore(["a", "c"]);
    expect(store.openTabs).toEqual([local, server("a"), server("c")]);
    expect(store.activeTabId).toBe("c");
  });

  it("falls back to Local for corrupted current storage instead of reviving stale legacy tabs", () => {
    localStorage.setItem(STORAGE_KEY, "{broken");
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, openServerIds: ["a"], activeServerId: "a" }));
    expect(restore().openTabs).toEqual([local]);
  });

  it("limits server tabs without evicting Local and does not reorder existing tabs", () => {
    const store = restore([]);
    const ids = Array.from({ length: MAX_OPEN_SERVER_WINDOWS + 1 }, (_, index) => `server-${index}`);
    for (const id of ids) store.open(id);
    expect(store.openTabs).toEqual([local, ...ids.slice(1).map(server)]);
    expect(store.openServerIds).toHaveLength(MAX_OPEN_SERVER_WINDOWS);
    store.open("local");
    expect(store.openTabs[0]).toEqual(local);
    expect(store.activeTabId).toBe("local");
    store.open(ids[1]);
    expect(store.openTabs[1]).toEqual(server(ids[1]));
    expect(store.activeTabId).toBe(ids[1]);
  });
});
