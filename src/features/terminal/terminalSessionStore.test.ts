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

  it("关闭最后一个标签后立即且只创建一个新终端", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const closedId = store.activeSessionByServer["server-1"];
    store.removeSession("server-1", closedId);

    expect(store.sessionsByServer["server-1"]).toHaveLength(1);
    expect(store.activeSessionByServer["server-1"]).not.toBe(closedId);
    expect(store.activeSessionByServer["server-1"]).toBe(store.sessionsByServer["server-1"][0].id);

    store.addSession("server-1");
    expect(store.sessionsByServer["server-1"]).toHaveLength(2);
  });

  it("活动标签记录缺失时关闭最后一个标签仍自动补建终端", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const onlySession = store.sessionsByServer["server-1"][0];
    delete store.activeSessionByServer["server-1"];

    store.removeSession("server-1", onlySession.id);

    expect(store.sessionsByServer["server-1"]).toHaveLength(1);
    expect(store.activeSessionByServer["server-1"]).toBe(store.sessionsByServer["server-1"][0].id);
  });

  it("限制单服务器终端选项卡数量", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    for (let index = 1; index < MAX_SESSIONS_PER_SERVER + 2; index += 1) store.addSession("server-1");
    expect(store.sessionsByServer["server-1"]).toHaveLength(MAX_SESSIONS_PER_SERVER);
  });

  it("启动恢复时只保留旧布局中的活动 Shell 标签", () => {
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

    expect(store.sessionsByServer["server-1"].map(({ id }) => id)).toEqual(["shell-b"]);
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

  it("可按分屏 ID 显示智能任务绑定的终端标签", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-a");
    const first = store.sessionsByServer["server-a"][0];
    const second = store.addSession("server-a")!;

    expect(store.activatePane("server-a", first.activePaneId)).toBe(true);
    expect(store.activeSessionByServer["server-a"]).toBe(first.id);
    expect(store.activatePane("server-a", "missing-pane")).toBe(false);
    expect(store.activeSessionByServer["server-a"]).not.toBe(second.id);
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

  it("将绑定 PTY 的实时输出和退出码返回执行器", async () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const paneId = store.bindAgentTask("server-1", "task-1")!;
    const chunks: string[] = [];
    const resultPromise = store.requestAgentPtyCommand(paneId, "exec-1", "pwd", (chunk) => chunks.push(chunk));

    expect(store.agentCommandByPane[paneId]).toMatchObject({ id: "exec-1", command: "pwd" });
    store.publishAgentPtyProgress("exec-1", "/srv/app\n");
    store.completeAgentPtyCommand(paneId, "exec-1", "/srv/app", 0);

    await expect(resultPromise).resolves.toMatchObject({ output: "/srv/app", exitCode: 0, success: true });
    expect(chunks).toEqual(["/srv/app\n"]);
    expect(store.agentCommandByPane[paneId]).toBeUndefined();
  });

  it("中断 PTY 命令后仍等待真实退出标记，不提前进入校验", async () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const paneId = store.bindAgentTask("server-1", "task-1")!;
    let settled = false;
    const resultPromise = store.requestAgentPtyCommand(paneId, "exec-1", "make install")
      .finally(() => { settled = true; });

    store.interruptAgentPtyCommand(paneId);
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(store.agentCommandByPane[paneId]?.id).toBe("exec-1");
    expect(store.agentInterruptByPane[paneId]).toBe(1);

    store.completeAgentPtyCommand(paneId, "exec-1", "interrupted", 130);
    await expect(resultPromise).resolves.toMatchObject({ success: false, exitCode: 130 });
  });

  it("终端内 SSH 跳转只在运行时保存密码并等待登录标记", async () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const paneId = store.bindAgentTask("server-1", "task-1")!;
    const resultPromise = store.requestAgentPtySshJump(
      paneId,
      "ssh-1",
      { host: "192.168.1.237", port: 22, username: "root" },
      "private-password",
    );

    expect(store.agentSshJumpByPane[paneId]).toMatchObject({
      id: "ssh-1", host: "192.168.1.237", username: "root",
    });
    expect(JSON.stringify(store.$state)).not.toContain("private-password");
    expect(store.readAgentSshPassword("ssh-1")).toBe("private-password");

    store.completeAgentPtySshJump(paneId, "ssh-1", "connected");
    await expect(resultPromise).resolves.toMatchObject({ success: true, output: "connected" });
    expect(store.effectiveSshTargetByPane[paneId]).toEqual({
      host: "192.168.1.237", port: 22, username: "root",
    });
    expect(store.readAgentSshPassword("ssh-1")).toBeUndefined();
    expect(store.agentSshJumpByPane[paneId]).toBeUndefined();
    store.clearAgentPtySshTarget(paneId);
    expect(store.effectiveSshTargetByPane[paneId]).toBeUndefined();
  });
});
