// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "./serverWorkspaceTabsStore";
import { closeWorkspaceTab, installWorkspaceTabRouting } from "./workspaceRouting";

beforeEach(() => localStorage.clear());

it("keeps an active tab when navigation is rejected and can close it on the next attempt", async () => {
  const pinia = createPinia();
  const ops = useOpsStore(pinia);
  ops.servers = ["a", "b"].map(id => ({ ...ops.servers[0], id, name: id }));
  const router = createRouter({ history: createMemoryHistory(), routes: ["/local", "/server/:id"].map(path => ({ path, component: { template: "<div/>" } })) });
  installWorkspaceTabRouting(router, pinia);
  await router.push("/server/a");
  await router.push("/server/b");
  const tabs = useServerWorkspaceTabsStore(pinia);
  let reject = true;
  router.beforeEach(() => { if (reject) return false; });
  await closeWorkspaceTab(router, "b", pinia);
  expect(router.currentRoute.value.path).toBe("/server/b");
  expect(tabs.openServerIds).toEqual(["a", "b"]);
  expect(tabs.activeTabId).toBe("b");

  reject = false;
  await Promise.all([closeWorkspaceTab(router, "b", pinia), closeWorkspaceTab(router, "a", pinia)]);
  expect(router.currentRoute.value.path).toBe("/local");
  expect(tabs.openTabs).toEqual([{ id: "local", kind: "local" }]);
  expect(tabs.activeTabId).toBe("local");
});
