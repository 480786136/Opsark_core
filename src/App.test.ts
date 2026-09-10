// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted, type App as VueApp } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { closeWorkspaceTab, installWorkspaceTabRouting } from "@/features/workspace/workspaceRouting";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";
import { workspaceEntry } from "@/features/workspace/workspaceEntry";

vi.mock("@/features/preferences/AppearanceControls.vue", () => ({ default: defineComponent(() => () => h("span")) }));
vi.mock("@/components/WindowTitleBar.vue", () => ({ default: defineComponent(() => () => h("span")) }));

import App from "./App.vue";

let app: VueApp | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
});

it("preserves workspace instances on switching and releases them only when their tabs close", async () => {
  const pinia = createPinia();
  const ops = useOpsStore(pinia);
  ops.servers = [{
    id: "a", name: "Server A", host: "a.test", port: 22, username: "ops", group: "test",
    status: "online", environment: [],
    info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
    createdAt: new Date().toISOString(),
  }];
  vi.spyOn(ops, "hydrateCredentials").mockResolvedValue(undefined);
  const tabs = useServerWorkspaceTabsStore(pinia);
  const mounted = vi.fn();
  const unmounted = vi.fn();
  let serial = 0;
  function trackedView(name: string, kind: string) {
    return defineComponent({
      name,
      setup() {
        const instance = `${kind}-${++serial}`;
        onMounted(() => mounted(instance));
        onUnmounted(() => unmounted(instance));
        return () => h("div", { "data-view": kind, "data-instance": instance });
      },
    });
  }
  const Empty = defineComponent(() => () => h("div"));
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/local", component: trackedView("LocalWorkspaceView", "local") },
      { path: "/server/:id", component: trackedView("WorkspaceView", "server") },
      { path: "/workspace", redirect: () => workspaceEntry(tabs.openTabs, tabs.activeTabId) },
      ...["/", "/logs", "/secrets", "/models", "/tools", "/skills", "/settings"].map(path => ({ path, component: Empty })),
    ],
  });
  installWorkspaceTabRouting(router, pinia);
  await router.push("/local");
  await router.isReady();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp(App).use(pinia).use(i18n).use(router);
  app.mount(host);
  await nextTick();
  const firstLocal = host.querySelector('[data-view="local"]');
  const firstLocalId = firstLocal?.getAttribute("data-instance");
  expect(firstLocal).not.toBeNull();

  await router.push("/server/a");
  await nextTick();
  const server = host.querySelector('[data-view="server"]');
  const serverId = server?.getAttribute("data-instance");
  expect(server).not.toBeNull();
  await router.push("/local");
  await nextTick();
  expect(host.querySelector('[data-view="local"]')).toBe(firstLocal);
  expect(mounted).toHaveBeenCalledTimes(2);
  expect(unmounted).not.toHaveBeenCalled();

  await router.push("/server/a");
  await closeWorkspaceTab(router, "local", pinia);
  await nextTick();
  expect(router.currentRoute.value.path).toBe("/server/a");
  expect(host.querySelector('[data-view="server"]')).toBe(server);
  expect(unmounted.mock.calls).toEqual([[firstLocalId]]);

  await router.push("/local");
  await nextTick();
  const secondLocal = host.querySelector('[data-view="local"]');
  expect(secondLocal).not.toBeNull();
  expect(secondLocal).not.toBe(firstLocal);
  expect(mounted).toHaveBeenCalledTimes(3);
  await router.push("/server/a");
  await closeWorkspaceTab(router, "a", pinia);
  await nextTick();
  expect(router.currentRoute.value.path).toBe("/local");
  expect(host.querySelector('[data-view="local"]')).toBe(secondLocal);
  expect(unmounted.mock.calls).toEqual([[firstLocalId], [serverId]]);
  expect(tabs.openServerIds).toEqual([]);
  expect(tabs.activeTabId).toBe("local");
});
