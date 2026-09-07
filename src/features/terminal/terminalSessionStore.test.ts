import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { STORAGE_KEY, useTerminalSessionStore } from "./terminalSessionStore";

describe("user terminal session store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("owns only user Shell tabs and never exposes Agent command slots", () => {
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    const pane = store.sessionsByServer["server-1"][0].panes[0];
    expect(pane.kind).toBe("shell");
    expect("agentTaskId" in pane).toBe(false);
    expect("agentCommandByPane" in store).toBe(false);
    expect("requestAgentPtyCommand" in store).toBe(false);
  });

  it("drops legacy Agent bindings during persisted-layout migration", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      activeSessionByServer: { "server-1": "legacy" },
      sessionsByServer: {
        "server-1": [{
          id: "legacy",
          label: "Legacy",
          createdAt: "2026-08-29T00:00:00.000Z",
          activePaneId: "agent-pane",
          panes: [{ id: "agent-pane", createdAt: "2026-08-29T00:00:00.000Z", kind: "agent", agentTaskId: "task-1" }],
          layout: { type: "pane", paneId: "agent-pane" },
        }],
      },
    }));
    const store = useTerminalSessionStore();
    store.ensureWorkspace("server-1");
    expect(store.sessionsByServer["server-1"][0].panes[0].kind).toBe("shell");
    expect(JSON.stringify(store.sessionsByServer)).not.toContain("task-1");
  });

  it("tracks user-terminal generations independently", () => {
    const store = useTerminalSessionStore();
    store.setPaneStatus("pane-1", "connected");
    store.setPaneStatus("pane-1", "connected");
    store.setPaneStatus("pane-1", "disconnected");
    store.setPaneStatus("pane-1", "connected");
    expect(store.terminalGenerationByPane["pane-1"]).toBe(2);
  });
});
