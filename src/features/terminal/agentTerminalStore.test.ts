import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAgentTerminalStore } from "./agentTerminalStore";

describe("agent terminal store", () => {
  beforeEach(() => setActivePinia(createPinia()));

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
});
