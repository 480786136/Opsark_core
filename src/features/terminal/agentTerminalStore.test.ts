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
      context: { environment: {}, sourceFiles: [], shell: "bash", revision: 0 },
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
});
