// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
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
  const agents = useAgentWorkspaceStore(pinia);
  agents.updateServer("b", { activeTaskId: "existing-task", draft: "unsent text" });
  let reject = true;
  router.beforeEach(() => { if (reject) return false; });
  await closeWorkspaceTab(router, "b", pinia);
  expect(router.currentRoute.value.path).toBe("/server/b");
  expect(tabs.openServerIds).toEqual(["a", "b"]);
  expect(tabs.activeTabId).toBe("b");
  expect(agents.ensureServer("b")).toMatchObject({ activeTaskId: "existing-task", draft: "unsent text" });

  reject = false;
  await Promise.all([closeWorkspaceTab(router, "b", pinia), closeWorkspaceTab(router, "a", pinia)]);
  expect(router.currentRoute.value.path).toBe("/local");
  expect(tabs.openTabs).toEqual([{ id: "local", kind: "local" }]);
  expect(tabs.activeTabId).toBe("local");
  expect(agents.ensureServer("b")).toMatchObject({ activeTaskId: "", draft: "" });
});

it("restores open workspace conversations but starts fresh after an explicit close and reopen", async () => {
  const pinia = createPinia(), ops = useOpsStore(pinia);
  ops.servers = ["a", "b"].map(id => ({ ...ops.servers[0], id, name: id }));
  const router = createRouter({ history: createMemoryHistory(), routes: ["/local", "/server/:id", "/logs"].map(path => ({ path, component: { template: "<div/>" } })) });
  installWorkspaceTabRouting(router, pinia);
  const agents = useAgentWorkspaceStore(pinia);
  await router.push("/server/a");
  const task = ops.createTask("a", "safe", "model-deepseek");
  agents.updateServer("a", { activeTaskId: task.id, draft: "继续检查", automationEnabled: true, modelId: "model-deepseek" });
  await router.push("/server/b");
  await router.push("/local");
  await router.push("/logs");
  await router.push("/server/a");
  expect(agents.ensureServer("a")).toMatchObject({ activeTaskId: task.id, draft: "继续检查" });
  await closeWorkspaceTab(router, "a", pinia);
  await router.push("/server/a");
  expect(agents.ensureServer("a")).toMatchObject({ activeTaskId: "", draft: "", showTasks: false,
    automationEnabled: true, modelId: "model-deepseek" });
  expect(ops.tasks.some(item => item.id === task.id)).toBe(true);
  expect(ops.tasks).toHaveLength(1);
});
