// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import LogsView from "./LogsView.vue";

describe("LogsView", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => host.remove());

  it("switches from audit logs to complete developer diagnostics", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.addDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "需求处理模型调用失败",
      summary: "模型响应缺少需求理解结果",
      trace: { attempts: [{ attempt: 1, response: { choices: [] } }] },
    });
    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("操作日志");
    expect(host.querySelector(".developer-log-panel")).toBeNull();

    host.querySelectorAll<HTMLButtonElement>(".log-mode-tabs button")[1].click();
    await nextTick();

    expect(host.textContent).toContain("开发者日志");
    expect(host.querySelector(".developer-log-panel")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("需求处理模型调用失败");
    app.unmount();
  });

  it("keeps server lifecycle events separate from task execution logs", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.logs = [
      {
        id: "log-server-connected",
        category: "system",
        level: "success",
        title: "SSH 连接状态：SSH 已连接",
        detail: JSON.stringify({ status: "connected", generation: 2 }),
        serverId: "srv-production-01",
        serverName: "测试服务器",
        createdAt: "2026-09-15T06:48:10.550Z",
      },
      {
        id: "log-task-created",
        category: "task",
        level: "info",
        title: "正在理解需求并汇总服务器上下文…",
        detail: "",
        serverId: "srv-production-01",
        serverName: "测试服务器",
        taskId: "task-k8s",
        taskTitle: "部署一套k8s,将本机作为主节点",
        createdAt: "2026-09-15T03:24:33.279Z",
      },
    ];

    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("服务器事件");
    expect(host.textContent).toContain("部署一套k8s,将本机作为主节点");
    expect(host.textContent).not.toContain("未关联任务");

    host.querySelector<HTMLButtonElement>(".log-server-summary")!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    await nextTick();

    expect(host.querySelector(".server-task-list")?.textContent).toContain("服务器级事件");
    expect(host.querySelector(".server-task-list")?.textContent).toContain("task-k8s");
    expect(host.querySelector(".task-process-heading")?.textContent).toContain("服务器级事件");
    expect(host.querySelector(".task-process-heading")?.textContent).not.toContain("无任务 ID");
    app.unmount();
  });
});
