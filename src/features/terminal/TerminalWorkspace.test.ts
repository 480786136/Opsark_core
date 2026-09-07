// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";

vi.mock("@/components/TerminalPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "TerminalPanelStub",
      props: { sessionId: String, active: Boolean, agentTaskId: String },
      emits: ["activate", "statusChange"],
      setup(props) {
        return () => h("section", {
          class: "terminal-panel-stub",
          "data-session-id": props.sessionId,
          "data-active": String(props.active),
          "data-agent-task-id": props.agentTaskId,
        });
      },
    }),
  };
});

vi.mock("./AgentTerminalPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "AgentTerminalPanelStub",
      props: { taskId: String, active: Boolean },
      setup(props) {
        return () => h("section", {
          class: "agent-terminal-panel-stub",
          "data-task-id": props.taskId,
          "data-active": String(props.active),
        });
      },
    }),
  };
});

import TerminalWorkspace from "./TerminalWorkspace.vue";
import { useAgentTerminalStore } from "./agentTerminalStore";
import { useTerminalSessionStore } from "./terminalSessionStore";
import { useOpsStore } from "@/stores/ops";

function addServer(pinia: ReturnType<typeof createPinia>) {
  useOpsStore(pinia).servers.push({
    id: "server-a",
    name: "Production",
    host: "111.231.1.58",
    port: 22,
    username: "root",
    group: "prod",
    status: "online",
    environment: [],
    info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
    createdAt: new Date().toISOString(),
  });
}

describe("TerminalWorkspace 终端选项卡", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => host.remove());

  it("使用带关闭按钮的单终端选项卡", () => {
    const pinia = createPinia();
    addServer(pinia);
    const app = createApp(TerminalWorkspace, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);

    expect(host.querySelector('[role="tab"]')?.textContent).toContain("Shell · root@111.231.1.58 · 1");
    expect(host.querySelectorAll(".terminal-tab-close")).toHaveLength(1);
    expect(host.querySelectorAll(".terminal-panel-stub")).toHaveLength(1);
    expect(host.querySelector(".terminal-tab-list")).not.toBeNull();
    app.unmount();
  });

  it("新增终端后常驻挂载并通过选项卡单个显示", async () => {
    const pinia = createPinia();
    addServer(pinia);
    const app = createApp(TerminalWorkspace, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    host.querySelector<HTMLButtonElement>('button[title="新建终端"]')?.click();
    await nextTick();

    const panels = [...host.querySelectorAll<HTMLElement>(".terminal-panel-stub")];
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(panels).toHaveLength(2);
    expect(panels.map(({ style }) => style.display)).toEqual(["none", ""]);

    host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0].click();
    await nextTick();
    expect(panels.map(({ style }) => style.display)).toEqual(["", "none"]);
    app.unmount();
  });

  it("点击标题关闭按钮后关闭对应终端并激活相邻标签", async () => {
    const pinia = createPinia();
    addServer(pinia);
    const app = createApp(TerminalWorkspace, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    const store = useTerminalSessionStore(pinia);
    store.addSession("server-a");
    await nextTick();
    const firstId = store.sessionsByServer["server-a"][0].id;

    host.querySelectorAll<HTMLButtonElement>(".terminal-tab-close")[1].click();
    await nextTick();

    expect(store.sessionsByServer["server-a"]).toHaveLength(1);
    expect(store.activeSessionByServer["server-a"]).toBe(firstId);
    expect(host.querySelectorAll(".terminal-panel-stub")).toHaveLength(1);
    app.unmount();
  });

  it("用户 Shell 标签不承载 Agent 绑定或标识", async () => {
    const pinia = createPinia();
    addServer(pinia);
    const app = createApp(TerminalWorkspace, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    const store = useTerminalSessionStore(pinia);
    store.addSession("server-a");
    await nextTick();

    expect(host.querySelectorAll(".terminal-agent-mark")).toHaveLength(0);
    expect(host.querySelectorAll<HTMLElement>(".terminal-panel-stub")[1].dataset.agentTaskId).toBeUndefined();
    expect(host.querySelectorAll<HTMLElement>(".terminal-panel-stub")[0].dataset.agentTaskId).toBeUndefined();
    app.unmount();
  });

  it("后台服务器窗口保留终端但不激活上下文", () => {
    const app = createApp(TerminalWorkspace, { serverId: "server-a", workspaceActive: false });
    app.use(createPinia()).use(i18n).mount(host);
    expect(host.querySelector(".terminal-panel-stub")?.getAttribute("data-active")).toBe("false");
    app.unmount();
  });

  it("切回 Shell 后 Agent 更新不抢焦点，关闭 Agent 标签会真正移除视图", async () => {
    const pinia = createPinia();
    addServer(pinia);
    const ops = useOpsStore(pinia);
    const task = ops.createTask("server-a", "managed", "model-1");
    task.title = "后台只读检查";
    task.agentSessionId = "agent-1";
    task.status = "running";
    const agentTerminals = useAgentTerminalStore(pinia);
    const session = {
      id: "agent-1",
      serverId: "server-a",
      taskId: task.id,
      generation: 1,
      state: "busy" as const,
      context: { environment: {}, sourceFiles: [], shell: "bash" as const, revision: 0 },
      createdAt: new Date().toISOString(),
    };
    agentTerminals.registerSession(session);

    const app = createApp(TerminalWorkspace, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    expect(host.querySelector(".agent-sandbox-tab")).not.toBeNull();
    expect(host.querySelector(".agent-terminal-panel-stub")?.getAttribute("data-active")).toBe("true");

    host.querySelector<HTMLButtonElement>('.terminal-workspace-tab:not(.agent-sandbox-tab) [role="tab"]')?.click();
    agentTerminals.registerSession({ ...session, generation: 2 });
    await nextTick();
    expect(agentTerminals.activeTaskByServer["server-a"]).toBeUndefined();
    expect(host.querySelector(".terminal-panel-stub")?.getAttribute("data-active")).toBe("true");

    host.querySelector<HTMLButtonElement>('.agent-sandbox-tab [role="tab"]')?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>(".agent-sandbox-tab .terminal-tab-close")?.click();
    await nextTick();

    expect(host.querySelector(".agent-sandbox-tab")).toBeNull();
    expect(host.querySelector(".agent-terminal-panel-stub")).toBeNull();
    expect(agentTerminals.sessionsByTask[task.id].state).toBe("busy");
    expect(host.querySelector(".terminal-panel-stub")?.getAttribute("data-active")).toBe("true");
    app.unmount();
  });
});
