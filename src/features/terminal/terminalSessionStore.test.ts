// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  MAX_SESSIONS_PER_SERVER,
  STORAGE_KEY,
  useTerminalSessionStore,
} from "./terminalSessionStore";

describe("terminalSessionStore 终端选项卡", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("创建独立终端并在关闭活动标签后选择相邻标签", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const firstId = store.activeSessionByServer["server-1"];
    const second = store.addSession("server-1")!;

    store.removeSession("server-1", second.id);

    expect(store.sessionsByServer["server-1"]).toHaveLength(1);
    expect(store.activeSessionByServer["server-1"]).toBe(firstId);
  });

  it("关闭最后一个标签后保持空工作区", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    store.removeSession("server-1", store.activeSessionByServer["server-1"]);

    expect(store.sessionsByServer["server-1"]).toHaveLength(0);
    expect(store.activeSessionByServer["server-1"]).toBeUndefined();
  });

  it("限制单服务器终端选项卡数量", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    for (let index = 1; index < MAX_SESSIONS_PER_SERVER + 2; index += 1) store.addSession("server-1");
    expect(store.sessionsByServer["server-1"]).toHaveLength(MAX_SESSIONS_PER_SERVER);
  });

  it("将旧分屏中的 Shell 叶子迁移成独立选项卡并丢弃旧 Agent 叶子", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      sessionsByServer: {
        "server-1": [{
          id: "layout-1",
          label: "Legacy",
          createdAt: "2026-08-15T00:00:00.000Z",
          panes: [
            { id: "shell-a", createdAt: "2026-08-15T00:00:00.000Z", kind: "shell" },
            { id: "agent-old", createdAt: "2026-08-15T00:00:01.000Z", kind: "agent" },
            { id: "shell-b", createdAt: "2026-08-15T00:00:02.000Z", kind: "shell" },
          ],
          activePaneId: "shell-b",
          layout: {
            type: "split",
            id: "root",
            direction: "vertical",
            ratio: 50,
            first: { type: "pane", paneId: "shell-a" },
            second: {
              type: "split",
              id: "nested",
              direction: "horizontal",
              ratio: 50,
              first: { type: "pane", paneId: "agent-old" },
              second: { type: "pane", paneId: "shell-b" },
            },
          },
        }],
      },
      activeSessionByServer: { "server-1": "layout-1" },
    }));
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");

    expect(store.sessionsByServer["server-1"].map(({ id }) => id)).toEqual(["shell-a", "shell-b"]);
    expect(store.activeSessionByServer["server-1"]).toBe("shell-b");
    expect(store.sessionsByServer["server-1"].every(({ panes, layout }) =>
      panes.length === 1 && layout.type === "pane")).toBe(true);
  });

  it("将智能任务持久化绑定到当前活动终端", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const second = store.addSession("server-1")!;
    const paneId = store.bindAgentTask("server-1", "task-1")!;
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");

    expect(paneId).toBe(second.activePaneId);
    expect(store.resolveTaskPaneId("server-1", "task-1")).toBe(paneId);
    expect(saved.sessionsByServer["server-1"][1].panes[0].agentTaskId).toBe("task-1");
  });

  it("只允许绑定终端接收 Agent 输出并在消费后清理", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const paneId = store.resolveActivePaneId("server-1")!;
    store.publishAgentOutput(paneId, "ignored");
    expect(store.agentOutputByPane[paneId]).toBeUndefined();

    store.bindAgentTask("server-1", "task-1");
    store.publishAgentOutput(paneId, "running");
    const eventId = store.agentOutputByPane[paneId][0].id;
    store.consumeAgentOutput(paneId, eventId);
    expect(store.agentOutputByPane[paneId]).toBeUndefined();
  });

  it("连接状态和 Agent 队列不进入持久化 DTO", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const paneId = store.bindAgentTask("server-1", "task-1")!;
    store.setPaneStatus(paneId, "connected");
    store.publishAgentOutput(paneId, "running");
    store.persist();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.paneStatusById).toBeUndefined();
    expect(saved.agentOutputByPane).toBeUndefined();
  });
});
