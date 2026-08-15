// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";

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
    await router.push("/server/server-a");
    await router.isReady();
    const app = createApp(defineComponent(() => () => h(RouterView)));
    app.use(pinia).use(i18n).use(router).mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>(".workspace-server-tab-add > button")?.click();
    await nextTick();
    const betaButton = [...host.querySelectorAll<HTMLButtonElement>(".workspace-server-menu > button")]
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
    expect(JSON.parse(localStorage.getItem("opsark.serverWorkspaceTabs.v1") ?? "{}")).toMatchObject({
      openServerIds: ["server-a", "server-b"],
      activeServerId: "server-b",
    });
    app.unmount();
  });
});
