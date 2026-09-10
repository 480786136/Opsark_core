// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "./serverWorkspaceTabsStore";
import WorkspaceNavigation from "./WorkspaceNavigation.vue";
import { installWorkspaceTabRouting } from "./workspaceRouting";

let app: App;
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; localStorage.clear(); });
it("uses the same ordered tabs and active state across Local and remote routes", async () => {
  const pinia = createPinia();
  const ops = useOpsStore(pinia);
  ops.servers = ["a", "b"].map(id => ({ ...ops.servers[0], id, name: id, username: "ops", host: `${id}.test`, status: "offline" }));
  const tabs = useServerWorkspaceTabsStore(pinia);
  tabs.hydrate(["a", "b"]); tabs.open("a"); tabs.open("b");
  const router = createRouter({ history: createMemoryHistory(), routes: ["/", "/local", "/server/:id"].map(path => ({ path, component: { template: "<div/>" } })) });
  installWorkspaceTabRouting(router, pinia);
  await router.push("/local");
  const root = document.createElement("div"); document.body.append(root);
  app = createApp(defineComponent(() => () => h(WorkspaceNavigation))).use(pinia).use(router).use(i18n);
  app.mount(root); await nextTick();
  const ids = () => [...root.querySelectorAll<HTMLElement>(".navigation-tab")].map(element => element.dataset.workspaceId);
  expect(ids()).toEqual(["local", "a", "b"]);
  expect(root.querySelector('.is-active')?.getAttribute("data-workspace-id")).toBe("local");
  root.querySelector<HTMLAnchorElement>('[data-workspace-id="a"] a')!.click();
  await router.isReady(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
  expect(ids()).toEqual(["local", "a", "b"]);
  expect(root.querySelector('.is-active')?.getAttribute("data-workspace-id")).toBe("a");
  root.querySelector<HTMLAnchorElement>('[data-workspace-id="local"] a')!.click();
  await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
  root.querySelector<HTMLButtonElement>('[data-workspace-id="a"] .navigation-tab-close')!.click();
  await vi.waitFor(() => expect(ids()).toEqual(["local", "b"]));
  expect(router.currentRoute.value.path).toBe("/local");
  expect(ids()).toEqual(["local", "b"]);
  root.querySelector<HTMLButtonElement>('.navigation-add')!.click(); await nextTick();
  const option = [...root.querySelectorAll<HTMLButtonElement>('.navigation-menu>button')].find(button => button.textContent?.includes("a.test"))!;
  option.click(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
  expect(tabs.openServerIds).toEqual(["b", "a"]);
  expect(router.currentRoute.value.path).toBe("/server/a");

  // Local is a regular tab: close it in the background and reopen from the same picker.
  root.querySelector<HTMLButtonElement>('[data-workspace-id="local"] .navigation-tab-close')!.click();
  await vi.waitFor(() => expect(ids()).toEqual(["b", "a"]));
  expect(router.currentRoute.value.path).toBe("/server/a");
  root.querySelector<HTMLButtonElement>('.navigation-add')!.click(); await nextTick();
  const localOption = [...root.querySelectorAll<HTMLButtonElement>('.navigation-menu>button')].find(button => button.textContent?.includes("Local"))!;
  localOption.click();
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/local"));
  expect(ids()).toEqual(["b", "a", "local"]);
  expect(tabs.activeTabId).toBe("local");
  expect(tabs.activeServerId).toBe("");
  expect(root.querySelector('[data-workspace-id="local"] .navigation-tab-close')).not.toBeNull();
});
