// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, KeepAlive, nextTick, type VNode } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { installWorkspaceTabRouting } from "@/features/workspace/workspaceRouting";
import { STORAGE_KEY, useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";
import WorkspaceNavigation from "@/features/workspace/WorkspaceNavigation.vue";
import { workspaceEntry } from "@/features/workspace/workspaceEntry";

function workspaceStub(className: string) {
  return defineComponent({
    props: { serverId: { type: String, required: true } },
    setup(props) {
      return () => h("div", { class: className, "data-server-id": props.serverId });
    },
  });
}

vi.mock("@/components/FileExplorer.vue", () => ({ default: workspaceStub("files-stub") }));
vi.mock("@/features/terminal/TerminalWorkspace.vue", () => ({ default: workspaceStub("terminal-stub") }));
vi.mock("@/components/AgentConsole.vue", () => ({ default: workspaceStub("agent-stub") }));
vi.mock("@/components/MetricsBar.vue", () => ({ default: defineComponent(() => () => h("div")) }));
vi.mock("@/components/StatusDot.vue", () => ({ default: defineComponent(() => () => h("i")) }));
vi.mock("@/features/workspace/WorkspaceToolbar.vue", () => ({ default: defineComponent(() => () => h("div")) }));
vi.mock("@/features/files/FileEditorPanel.vue", () => ({ default: defineComponent(() => () => h("div")) }));

import WorkspaceView from "./WorkspaceView.vue";

describe("WorkspaceView 多服务器切换", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  it("使用持久窗口标签切换服务器并保持已打开终端挂载", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const createdAt = new Date().toISOString();
    store.servers = [
      { id: "server-a", name: "Alpha", host: "alpha.test", port: 22, username: "ops", group: "test", status: "online", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
      { id: "server-b", name: "Beta", host: "beta.test", port: 22, username: "root", group: "test", status: "offline", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
    ];
    vi.spyOn(store, "ensureServerConnected").mockResolvedValue(true);
    vi.spyOn(store, "refreshMetrics").mockResolvedValue(undefined);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/server/:id", component: WorkspaceView }],
    });
    installWorkspaceTabRouting(router, pinia);
    await router.push("/server/server-a");
    await router.isReady();
    const app = createApp(defineComponent(() => () => h(RouterView)));
    app.use(pinia).use(i18n).use(router).mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>(".navigation-add")?.click();
    await nextTick();
    const betaButton = [...host.querySelectorAll<HTMLButtonElement>(".navigation-menu > button")]
      .find((button) => button.textContent?.includes("Beta"));
    betaButton?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe("server-b"));
    await nextTick();

    expect(host.querySelector(".files-stub")?.getAttribute("data-server-id")).toBe("server-b");
    expect([...host.querySelectorAll(".terminal-stub")].map((item) => item.getAttribute("data-server-id")))
      .toEqual(["server-a", "server-b"]);
    expect((host.querySelector('.terminal-stub[data-server-id="server-a"]') as HTMLElement)?.style.display).toBe("none");
    expect((host.querySelector('.terminal-stub[data-server-id="server-b"]') as HTMLElement)?.style.display).not.toBe("none");
    expect([...host.querySelectorAll(".agent-stub")].map((item) => item.getAttribute("data-server-id")))
      .toEqual(["server-a", "server-b"]);
    expect((host.querySelector('.agent-stub[data-server-id="server-a"]') as HTMLElement)?.style.display).toBe("none");
    expect((host.querySelector('.agent-stub[data-server-id="server-b"]') as HTMLElement)?.style.display).not.toBe("none");
    expect(store.ensureServerConnected).toHaveBeenCalledWith("server-b");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      version: 2,
      activeTabId: "server-b",
    });
    expect(useServerWorkspaceTabsStore(pinia).openServerIds).toEqual(["server-a", "server-b"]);
    app.unmount();
  });

  it("经过 Local 返回服务器时保留终端与 Agent 实例且不发起无效或重复连接", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.servers = [
      { id: "server-a", name: "Alpha", host: "alpha.test", port: 22, username: "ops", group: "test", status: "online", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt: new Date().toISOString() },
    ];
    const ensureConnected = vi.spyOn(store, "ensureServerConnected").mockResolvedValue(true);
    vi.spyOn(store, "refreshMetrics").mockResolvedValue(undefined);
    const Local = defineComponent({ name: "LocalWorkspaceView", setup: () => () => h("div", { class: "local-stub" }) });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/server/:id", component: WorkspaceView },
        { path: "/local", component: Local },
      ],
    });
    installWorkspaceTabRouting(router, pinia);
    await router.push("/server/server-a");
    await router.isReady();
    const app = createApp(defineComponent(() => () => h(RouterView, null, {
      default: ({ Component }: { Component: VNode }) => h(KeepAlive, null, { default: () => Component }),
    })));
    app.use(pinia).use(i18n).use(router).mount(host);
    try {
      await nextTick();
      const terminal = host.querySelector('.terminal-stub[data-server-id="server-a"]');
      const agent = host.querySelector('.agent-stub[data-server-id="server-a"]');
      expect(terminal).not.toBeNull();
      expect(agent).not.toBeNull();
      expect(ensureConnected.mock.calls).toEqual([["server-a"]]);

      await router.push("/local");
      await nextTick();
      expect(host.querySelector(".local-stub")).not.toBeNull();
      expect(host.querySelector(".terminal-stub")).toBeNull();
      expect(ensureConnected.mock.calls).toEqual([["server-a"]]);

      await router.push("/server/server-a");
      await nextTick();
      expect(host.querySelector('.terminal-stub[data-server-id="server-a"]')).toBe(terminal);
      expect(host.querySelector('.agent-stub[data-server-id="server-a"]')).toBe(agent);
      expect(ensureConnected.mock.calls).toEqual([["server-a"]]);
      expect(host.querySelector('[data-workspace-id="server-a"]')?.classList.contains("is-active")).toBe(true);
    } finally {
      app.unmount();
    }
  });
  it.each(["sequential", "before navigation completes"])("does not restore a closed server when closing all tabs %s", async (mode) => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.servers = ["a", "b"].map(id => ({
      id, name: `Server ${id}`, host: `${id}.test`, port: 22, username: "ops", group: "test",
      status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    }));
    const ensureConnected = vi.spyOn(store, "ensureServerConnected").mockResolvedValue(true);
    vi.spyOn(store, "refreshMetrics").mockResolvedValue(undefined);
    const tabs = useServerWorkspaceTabsStore(pinia);
    const Local = defineComponent({
      name: "LocalWorkspaceView",
      setup: () => () => h("div", { class: "local-stub" }, [h(WorkspaceNavigation)]),
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: defineComponent(() => () => h("div", { class: "management-stub" })) },
        { path: "/server/:id", component: WorkspaceView },
        { path: "/local", component: Local },
        { path: "/workspace", redirect: () => workspaceEntry(tabs.openTabs, tabs.activeTabId) },
      ],
    });
    installWorkspaceTabRouting(router, pinia);
    await router.push("/local");
    await router.isReady();
    const app = createApp(defineComponent(() => () => h(RouterView, null, {
      default: ({ Component }: { Component: VNode }) => h(KeepAlive, null, { default: () => Component }),
    })));
    app.use(pinia).use(i18n).use(router).mount(host);
    try {
      await router.push("/server/a");
      await router.push("/server/b");
      await nextTick();
      const closeA = host.querySelector<HTMLButtonElement>('[data-workspace-id="a"] .navigation-tab-close')!;
      const closeB = host.querySelector<HTMLButtonElement>('[data-workspace-id="b"] .navigation-tab-close')!;
      expect(closeA).not.toBeNull();
      expect(closeB).not.toBeNull();

      closeB.click();
      if (mode === "sequential") {
        await vi.waitFor(() => expect(tabs.openServerIds).toEqual(["a"]));
      }
      // The second close used to read a stale activeId prop while B -> A was
      // pending, allowing that navigation to reopen A after its tab was removed.
      closeA.click();
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/local"));
      await vi.waitFor(() => expect(tabs.openServerIds).toEqual([]));
      await nextTick();
      const assertOnlyLocal = () => {
        expect([...host.querySelectorAll<HTMLElement>(".navigation-tab")].map(item => item.dataset.workspaceId)).toEqual(["local"]);
        expect(host.querySelector('.navigation-tab.is-active')?.getAttribute("data-workspace-id")).toBe("local");
        expect(host.querySelector(".terminal-stub")).toBeNull();
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
          version: 2, openTabs: [{ id: "local", kind: "local" }], activeTabId: "local",
        });
      };
      assertOnlyLocal();
      const connectionCount = ensureConnected.mock.calls.length;
      await router.push("/");
      await router.push("/workspace");
      await nextTick();
      expect(router.currentRoute.value.path).toBe("/local");
      assertOnlyLocal();
      expect(ensureConnected).toHaveBeenCalledTimes(connectionCount);
    } finally {
      app.unmount();
    }
  });
});
