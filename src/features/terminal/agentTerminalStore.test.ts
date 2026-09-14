import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { OpsTask } from "@/types";
import { buildAgentTerminalTranscript } from "./agentTerminalTranscript";
import { useAgentTerminalStore } from "./agentTerminalStore";

describe("agent terminal store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("同步故障代次并释放 busy，不伪造退出码或接受旧会话事件", () => {
    const store = useAgentTerminalStore();
    store.registerSession({
      id: "agent-1", serverId: "server-1", taskId: "task-1", generation: 1, state: "ready",
      context: { environment: {}, sourceFiles: [], shell: "bash", revision: 0 }, createdAt: "now",
    });
    store.begin("task-1", "validation", "test -d /opt/repo/.git", "isolated_exec", true);
    store.invalidateSession("task-1", "agent-1", 2);
    expect(store.sessionsByTask["task-1"]).toMatchObject({ state: "recovering", generation: 2 });
    expect(store.entriesByTask["task-1"][0].exitCode).toBeUndefined();
    store.invalidateSession("task-1", "agent-1", 1);
    store.invalidateSession("task-1", "other-session", 3);
    expect(store.sessionsByTask["task-1"].generation).toBe(2);
    store.close("task-1");
    store.invalidateSession("task-1", "agent-1", 3);
    expect(store.sessionsByTask["task-1"].state).toBe("closed");
  });

  it("keeps Agent sessions outside user terminal pane state", () => {
    const store = useAgentTerminalStore();
    store.registerSession({
      id: "agent-1",
      serverId: "server-1",
      taskId: "task-1",
      generation: 1,
      state: "ready",
      context: { environment: {}, sourceFiles: [], shell: "bash" as const, revision: 0 },
      createdAt: new Date().toISOString(),
    });
    store.begin("task-1", "exec-1", "pwd", "agent_session");
    store.output("task-1", "exec-1", "/opt\n");
    store.finish("task-1", "exec-1", 0);
    expect(store.sessionsByTask["task-1"].state).toBe("ready");
    expect(store.entriesByTask["task-1"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command", scope: "agent_session" }),
      expect.objectContaining({ kind: "output", text: "/opt\n", exitCode: 0 }),
    ]));
  });

  it("places a non-streamed completion before one exit status", () => {
    const store = useAgentTerminalStore();
    store.begin("task-1", "exec-1", "ss -lntp", "agent_session");
    store.finish("task-1", "exec-1", 0);

    store.completionOutput("task-1", "exec-1", [
      "$ ss -lntp",
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
      "LISTEN 0      128    [::]:22             [::]:*",
      "[exit: 0]",
      "",
    ].join("\n"));

    expect(buildAgentTerminalTranscript(store.entriesByTask["task-1"])).toBe([
      "[Agent] $ ss -lntp",
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
      "LISTEN 0      128    [::]:22             [::]:*",
      "[Agent] process exited with code 0",
      "",
    ].join("\n"));
    expect(store.entriesByTask["task-1"][0]).not.toHaveProperty("exitCode");
    expect(store.entriesByTask["task-1"][1]).toMatchObject({ kind: "output", exitCode: 0 });
  });

  it("does not steal focus from Shell when an existing Agent session changes", () => {
    const store = useAgentTerminalStore();
    const session = {
      id: "agent-1",
      serverId: "server-1",
      taskId: "task-1",
      generation: 1,
      state: "ready" as const,
      context: { environment: {}, sourceFiles: [], shell: "bash" as const, revision: 0 },
      createdAt: new Date().toISOString(),
    };
    store.registerSession(session);
    expect(store.activeTaskByServer["server-1"]).toBe("task-1");

    store.activateTask("server-1", undefined);
    store.registerSession({ ...session, generation: 2, state: "busy" });

    expect(store.activeTaskByServer["server-1"]).toBeUndefined();
    expect(store.sessionsByTask["task-1"].generation).toBe(2);
  });

  it("dismisses an Agent tab without closing its background session", () => {
    const store = useAgentTerminalStore();
    store.registerSession({
      id: "agent-1",
      serverId: "server-1",
      taskId: "task-1",
      generation: 1,
      state: "busy",
      context: { environment: {}, sourceFiles: [], shell: "bash", revision: 0 },
      createdAt: new Date().toISOString(),
    });

    store.dismissTask("server-1", "task-1");

    expect(store.isTaskHidden("server-1", "task-1")).toBe(true);
    expect(store.activeTaskByServer["server-1"]).toBeUndefined();
    expect(store.sessionsByTask["task-1"].state).toBe("busy");
  });

  it("restores historical commands and raw output without treating output lines as command continuations", () => {
    const store = useAgentTerminalStore();
    const command = "ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null";
    const task = {
      id: "task-history",
      serverId: "server-1",
      agentSessionId: "agent-history",
      agentSessionGeneration: 1,
      createdAt: "2026-09-14T08:10:00.000Z",
      updatedAt: "2026-09-14T08:10:30.000Z",
      plan: [{
        id: "listen-ports",
        kind: "observe",
        title: "确认监听端口",
        description: "只读检查",
        command,
        validation: "test -r /proc/net/tcp",
        risk: "medium",
        expected: "列出监听端口",
        status: "completed",
        executionScope: "agent_session",
        output: [
          `$ ${command}`,
          "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
          "LISTEN 0      128    *:22                *:* users:((\"sshd\",pid=1055,fd=3))",
          "[exit: 0]",
        ].join("\n"),
        result: {
          executionStatus: "success",
          observationStatus: "observed",
          exitCode: 0,
          facts: {},
          warnings: [],
          evidenceIds: [],
        },
      }],
    } as unknown as OpsTask;

    store.restoreHistoricalTask(task);

    expect(store.entriesByTask[task.id]).toEqual([
      expect.objectContaining({ kind: "command", text: command }),
      expect.objectContaining({
        kind: "output",
        text: expect.stringContaining("State  Recv-Q Send-Q"),
        exitCode: 0,
      }),
    ]);
    expect(store.entriesByTask[task.id][0]).not.toHaveProperty("exitCode");
    const transcript = buildAgentTerminalTranscript(store.entriesByTask[task.id]);
    expect(transcript).toContain(`[Agent] $ ${command}\nState  Recv-Q Send-Q`);
    expect(transcript).not.toContain("[Agent] $ State");
    expect(transcript).not.toContain("[Agent] > LISTEN");
    expect(transcript.match(/process exited with code 0/g)).toHaveLength(1);
  });

  it("restores independent validation as a separate validation command", () => {
    const store = useAgentTerminalStore();
    const task = {
      id: "task-validation-history",
      serverId: "server-1",
      agentSessionId: "agent-history",
      createdAt: "2026-09-14T08:10:00.000Z",
      updatedAt: "2026-09-14T08:10:30.000Z",
      plan: [{
        id: "java-processes",
        command: "pgrep -af java",
        validation: "ps -eo comm= | grep -i '^java$'",
        output: [
          "$ pgrep -af java",
          "未发现匹配项（命令正常完成）",
          "[exit: 1]",
          "",
          "--- 独立校验 ---",
          "$ ps -eo comm= | grep -i '^java$'",
          "未发现匹配项（命令正常完成）",
          "[exit: 1]",
        ].join("\n"),
        result: { exitCode: 1 },
      }],
    } as unknown as OpsTask;

    store.restoreHistoricalTask(task);

    expect(store.entriesByTask[task.id].map(({ kind }) => kind)).toEqual([
      "command", "output", "validation", "output",
    ]);
    const transcript = buildAgentTerminalTranscript(store.entriesByTask[task.id]);
    expect(transcript).toContain("[Agent] $ pgrep -af java");
    expect(transcript).toContain("[Agent 验证] $ ps -eo comm= | grep -i '^java$'");
    expect(transcript.match(/\[exit:/g)).toBeNull();
    expect(transcript.match(/process exited with code 1/g)).toHaveLength(2);
  });
});
