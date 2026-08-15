// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useOpsStore } from "@/stores/ops";

vi.mock("@/components/ModelSettingsModal.vue", () => ({
  default: defineComponent(() => () => h("div")),
}));

import AgentConsole from "./AgentConsole.vue";

describe("AgentConsole 服务器工作区隔离", () => {
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

  it("分别恢复每台服务器的活动任务和输入草稿", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    vi.spyOn(ops, "refreshModelAvailability").mockResolvedValue(undefined);
    const taskA = ops.createTask("server-a", "safe", "model-deepseek");
    taskA.title = "Alpha Nginx";
    const taskB = ops.createTask("server-b", "observe", "model-deepseek");
    taskB.title = "Beta Disk";
    const workspaces = useAgentWorkspaceStore(pinia);
    workspaces.updateServer("server-a", {
      activeTaskId: taskA.id,
      automationEnabled: true,
      draft: "继续检查 Alpha",
    });
    workspaces.updateServer("server-b", {
      activeTaskId: taskB.id,
      automationEnabled: true,
      draft: "继续检查 Beta",
    });
    const Wrapper = defineComponent(() => () => h("div", [
      h(AgentConsole, { serverId: "server-a" }),
      h(AgentConsole, { serverId: "server-b" }),
    ]));
    const app = createApp(Wrapper).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    const panels = host.querySelectorAll<HTMLElement>(".agent-panel");
    expect(panels[0].textContent).toContain("Alpha Nginx");
    expect(panels[0].textContent).not.toContain("Beta Disk");
    expect(panels[1].textContent).toContain("Beta Disk");
    expect(panels[1].textContent).not.toContain("Alpha Nginx");
    expect(panels[0].querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("继续检查 Alpha");
    expect(panels[1].querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("继续检查 Beta");
    app.unmount();
  });
});
