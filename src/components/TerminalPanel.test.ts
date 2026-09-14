// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { backend, type TerminalOutputEvent, type TerminalStatusEvent } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { i18n } from "@/features/preferences/i18n";
import TerminalPanel from "./TerminalPanel.vue";

const fake = vi.hoisted(() => ({
  input: undefined as ((data: string) => void) | undefined,
  keys: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  write: vi.fn(), clear: vi.fn(), find: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 100; rows = 30; options = {};
  buffer = { active: { cursorY: 0, getLine: () => ({ translateToString: () => "$ " }) } };
  loadAddon() {} open() {} focus() {} dispose() {} clearSelection() {}
  getSelection() { return "old output"; }
  write = fake.write; writeln = fake.write; clear = fake.clear;
  paste(data: string) { fake.input?.(data); }
  attachCustomKeyEventHandler(fn: typeof fake.keys) { fake.keys = fn; }
  onData(fn: typeof fake.input) { fake.input = fn; return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findPrevious = fake.find; findNext = fake.find; } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

describe("TerminalPanel connection gating", () => {
  let app: App | undefined;
  let host: HTMLElement;
  let status: (event: TerminalStatusEvent) => void;
  let output: (event: TerminalOutputEvent) => void;
  let ops: ReturnType<typeof useOpsStore>;
  const terminalId = "pty-server-a-pane-a";

  async function mount(online = true) {
    const pinia = createPinia();
    ops = useOpsStore(pinia);
    ops.serverConnection("server-a").status = online ? "connected" : "idle";
    vi.spyOn(ops, "getRuntimeConnection").mockImplementation(() => ops.isServerConnected("server-a")
      ? { host: "localhost", port: 22, username: "ops", password: "test" } : undefined);
    vi.spyOn(ops, "reportConnectionFailure").mockImplementation(() => undefined);
    app = createApp(TerminalPanel, { serverId: "server-a", sessionId: "pane-a", active: true });
    app.use(pinia).use(i18n).mount(host);
    if (online) await vi.waitFor(() => expect(backend.startTerminal).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await nextTick();
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    host = document.createElement("div"); document.body.append(host);
    vi.spyOn(backend, "onTerminalStatus").mockImplementation(async (listener) => { status = listener; return () => {}; });
    vi.spyOn(backend, "onTerminalOutput").mockImplementation(async (listener) => { output = listener; return () => {}; });
    vi.spyOn(backend, "startTerminal").mockResolvedValue(1);
    vi.spyOn(backend, "closeTerminal").mockResolvedValue(undefined);
    vi.spyOn(backend, "writeTerminal").mockResolvedValue(undefined);
  });
  afterEach(() => { app?.unmount(); app = undefined; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("blocks input immediately while offline and preserves the output buffer", async () => {
    await mount();
    status({ terminalId, generation: 1, status: "connected", retryable: false });
    output({ terminalId, generation: 1, data: "saved output", stream: "stdout" });
    fake.input?.("p");
    expect(backend.writeTerminal).toHaveBeenCalledTimes(1);
    ops.serverConnection("server-a").status = "suspect";
    fake.input?.("rm -rf /tmp/demo\r");
    expect(fake.keys?.(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
    expect(backend.writeTerminal).toHaveBeenCalledTimes(1);
    expect(fake.clear).not.toHaveBeenCalled();
    expect(fake.write).toHaveBeenCalledWith("saved output");
    expect(host.querySelector(".terminal-paste-dialog")).toBeNull();
  });

  it("waits for the coordinator on initial offline entry and reports terminal start rejection", async () => {
    await mount(false);
    fake.input?.("p");
    expect(backend.startTerminal).not.toHaveBeenCalled();
    expect(backend.writeTerminal).not.toHaveBeenCalled();
    vi.mocked(backend.startTerminal).mockRejectedValueOnce(new Error("SSH_NETWORK_ERROR: Connection reset"));
    ops.serverConnection("server-a").status = "connected";
    await vi.waitFor(() => expect(ops.reportConnectionFailure).toHaveBeenCalledWith("server-a", "Error: SSH_NETWORK_ERROR: Connection reset"));
    expect(host.textContent).toContain("Connection reset");
    fake.input?.("p");
    expect(backend.writeTerminal).not.toHaveBeenCalled();
  });

  it("does not reopen a normally exited shell or mark its server offline", async () => {
    await mount();
    status({ terminalId, generation: 1, status: "disconnected", retryable: false, reason: "远程 Shell 已结束" });
    ops.serverConnection("server-a").status = "suspect";
    ops.serverConnection("server-a").status = "connected";
    await nextTick();
    await Promise.resolve();
    expect(ops.reportConnectionFailure).not.toHaveBeenCalled();
    expect(backend.startTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps a healthy shell and its output alive during server health confirmation", async () => {
    await mount();
    status({ terminalId, generation: 1, status: "connected", retryable: false });
    ops.serverConnection("server-a").status = "suspect";
    fake.input?.("p");
    output({ terminalId, generation: 1, data: "running command output", stream: "stdout" });
    expect(backend.writeTerminal).not.toHaveBeenCalled();
    expect(backend.closeTerminal).not.toHaveBeenCalled();
    expect(fake.write).toHaveBeenCalledWith("running command output");
    ops.serverConnection("server-a").status = "connected";
    await nextTick();
    await Promise.resolve();
    expect(backend.startTerminal).toHaveBeenCalledTimes(1);
    fake.input?.("p");
    expect(backend.writeTerminal).toHaveBeenCalledTimes(1);
  });

  it("reports transport failure to the server coordinator without a pane retry loop", async () => {
    await mount();
    status({ terminalId, generation: 1, status: "error", retryable: true, reason: "Connection reset" });
    expect(ops.reportConnectionFailure).toHaveBeenCalledWith("server-a", "Connection reset");
    await nextTick();
    expect(backend.startTerminal).toHaveBeenCalledTimes(1);
    ops.serverConnection("server-a").status = "suspect";
    ops.serverConnection("server-a").status = "connected";
    await vi.waitFor(() => expect(backend.startTerminal).toHaveBeenCalledTimes(2));
    expect(fake.clear).not.toHaveBeenCalled();
  });

  it("ignores a late terminal start after the pane closes", async () => {
    let resolve!: (generation: number) => void;
    vi.mocked(backend.startTerminal).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount();
    app?.unmount(); app = undefined;
    resolve(10);
    await vi.waitFor(() => expect(backend.closeTerminal).toHaveBeenCalled());
    output({ terminalId, generation: 10, data: "late output", stream: "stdout" });
    expect(fake.write).not.toHaveBeenCalledWith("late output");
    expect(backend.startTerminal).toHaveBeenCalledTimes(1);
  });
});
