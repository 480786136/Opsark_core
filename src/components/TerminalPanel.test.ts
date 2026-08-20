// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";
import { useTerminalSessionStore } from "@/features/terminal/terminalSessionStore";

const terminalBackend = vi.hoisted(() => ({
  startTerminal: vi.fn<(terminalId: string, connection: unknown) => Promise<number>>(async () => 1),
  closeTerminal: vi.fn<(terminalId: string) => Promise<void>>(async () => undefined),
  resizeTerminal: vi.fn<(terminalId: string, columns: number, rows: number) => Promise<void>>(async () => undefined),
  writeTerminal: vi.fn<(terminalId: string, data: string) => Promise<void>>(async () => undefined),
  outputListeners: [] as Array<(event: { terminalId: string; data: string; stream: "stdout" }) => void>,
  statusListeners: [] as Array<(event: { terminalId: string; generation: number; status: "connected"; retryable: boolean }) => void>,
  inputListeners: [] as Array<(data: string) => void>,
  scrollListeners: [] as Array<(position: number) => void>,
  scrollToBottomCalls: 0,
  displayWrites: [] as string[],
  activeBuffer: {
    cursorY: 0,
    viewportY: 0,
    baseY: 0,
    getLine: () => ({ translateToString: () => "$ " }),
  },
}));

vi.mock("@/services/backend", () => ({
  backend: {
    startTerminal: terminalBackend.startTerminal,
    closeTerminal: terminalBackend.closeTerminal,
    resizeTerminal: terminalBackend.resizeTerminal,
    writeTerminal: terminalBackend.writeTerminal,
    onTerminalOutput: vi.fn(async (listener) => {
      terminalBackend.outputListeners.push(listener);
      return () => undefined;
    }),
    onTerminalStatus: vi.fn(async (listener) => {
      terminalBackend.statusListeners.push(listener);
      return () => undefined;
    }),
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = { active: terminalBackend.activeBuffer };
    constructor(options: Record<string, unknown>) { this.options = options; }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(listener: (data: string) => void) {
      terminalBackend.inputListeners.push(listener);
      return { dispose() {} };
    }
    onScroll(listener: (position: number) => void) {
      terminalBackend.scrollListeners.push(listener);
      return { dispose() {} };
    }
    write(data: string, callback?: () => void) { terminalBackend.displayWrites.push(data); callback?.(); }
    writeln() {}
    scrollToBottom() {
      terminalBackend.activeBuffer.viewportY = terminalBackend.activeBuffer.baseY;
      terminalBackend.scrollToBottomCalls += 1;
    }
    focus() {}
    clear() {}
    dispose() {}
    paste() {}
    getSelection() { return ""; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {}; findPrevious() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

import TerminalPanel from "./TerminalPanel.vue";

describe("TerminalPanel 多分屏隔离", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    terminalBackend.startTerminal.mockClear();
    terminalBackend.closeTerminal.mockClear();
    terminalBackend.writeTerminal.mockClear();
    terminalBackend.outputListeners.length = 0;
    terminalBackend.statusListeners.length = 0;
    terminalBackend.inputListeners.length = 0;
    terminalBackend.scrollListeners.length = 0;
    terminalBackend.scrollToBottomCalls = 0;
    terminalBackend.displayWrites.length = 0;
    terminalBackend.activeBuffer.cursorY = 0;
    terminalBackend.activeBuffer.viewportY = 0;
    terminalBackend.activeBuffer.baseY = 0;
    vi.stubGlobal("ResizeObserver", class { observe() {}; disconnect() {} });
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    host.remove();
  });

  it("后台分屏输出不覆盖活动上下文且重连只作用于目标 PTY", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a",
      name: "Test",
      host: "127.0.0.1",
      port: 22,
      username: "ops",
      group: "test",
      status: "online",
      environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.serverPasswords["server-a"] = "secret";
    ops.connectedServerIds.push("server-a");
    const Wrapper = defineComponent(() => () => h("div", [
      h(TerminalPanel, { serverId: "server-a", sessionId: "pane-a", active: true }),
      h(TerminalPanel, { serverId: "server-a", sessionId: "pane-b", active: false }),
    ]));
    const app = createApp(Wrapper).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    terminalBackend.outputListeners.forEach((listener) => listener({ terminalId: "pty-server-a-pane-a", data: "alpha\n", stream: "stdout" }));
    terminalBackend.outputListeners.forEach((listener) => listener({ terminalId: "pty-server-a-pane-b", data: "beta\n", stream: "stdout" }));
    expect(ops.terminalLines).toEqual(["alpha"]);

    host.querySelectorAll<HTMLButtonElement>('button[title="更多终端操作"]')[0]?.click();
    await nextTick();
    host.querySelectorAll<HTMLButtonElement>('button[title="重新连接终端"]')[0]?.click();
    await Promise.resolve();
    await nextTick();
    expect(terminalBackend.closeTerminal).toHaveBeenCalledWith("pty-server-a-pane-a");
    expect(terminalBackend.closeTerminal).not.toHaveBeenCalledWith("pty-server-a-pane-b");
    expect(terminalBackend.startTerminal.mock.calls.filter(([id]) => id === "pty-server-a-pane-a")).toHaveLength(2);
    expect(terminalBackend.startTerminal.mock.calls.filter(([id]) => id === "pty-server-a-pane-b")).toHaveLength(1);
    app.unmount();
  });

  it("只由已连接的活动分屏消费 SFTP 路径并将 OSC 7 目录同步回文件区", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a",
      name: "Test",
      host: "127.0.0.1",
      port: 22,
      username: "ops",
      group: "test",
      status: "online",
      environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.serverPasswords["server-a"] = "secret";
    ops.connectedServerIds.push("server-a");
    const app = createApp(TerminalPanel, { serverId: "server-a", sessionId: "pane-a", active: true });
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    await Promise.resolve();
    const links = useWorkspaceLinkStore(pinia);
    links.requestTerminalPath("server-a", "/srv/my app");
    await nextTick();
    expect(terminalBackend.writeTerminal).not.toHaveBeenCalled();

    terminalBackend.statusListeners.forEach((listener) => listener({
      terminalId: "pty-server-a-pane-a",
      generation: 1,
      status: "connected",
      retryable: false,
    }));
    await nextTick();
    expect(terminalBackend.writeTerminal).toHaveBeenCalledWith(
      "pty-server-a-pane-a",
      expect.stringContaining("cd -- '/srv/my app'"),
    );

    terminalBackend.outputListeners.forEach((listener) => listener({
      terminalId: "pty-server-a-pane-a",
      data: "\u001b]7;file://host/var/log\u0007",
      stream: "stdout",
    }));
    host.querySelector<HTMLButtonElement>('button[title="更多终端操作"]')?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('button[title="在 SFTP 中打开终端当前目录"]')?.click();
    expect(links.sftpPathRequests["server-a"]?.path).toBe("/var/log");
    app.unmount();
  });

  it("智能任务执行时保持 Shell 可见、不自动打开实时记录并锁定输入", async () => {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a",
      name: "Test",
      host: "127.0.0.1",
      port: 22,
      username: "ops",
      group: "test",
      status: "online",
      environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.connectedServerIds.push("server-a");
    const task = ops.createTask("server-a", "managed", "model-deepseek");
    task.status = "running";
    const sessions = useTerminalSessionStore(pinia);
    sessions.ensureWorkspace("server-a");
    const paneId = sessions.bindAgentTask("server-a", task.id)!;
    const app = createApp(TerminalPanel, {
      serverId: "server-a",
      sessionId: paneId,
      active: true,
      agentTaskId: task.id,
    });
    app.use(pinia).use(i18n).mount(host);
    await nextTick();

    sessions.publishAgentOutput(paneId, "执行 node --version\nv16.20.2\n");
    await nextTick();
    terminalBackend.inputListeners.forEach((listener) => listener("whoami\r"));

    expect(host.querySelector(".terminal-agent-view")).toBeNull();
    expect(host.querySelector<HTMLElement>(".terminal-host")?.style.display).not.toBe("none");
    expect(host.querySelector<HTMLElement>(".terminal-host")?.classList.contains("locked")).toBe(true);
    expect(terminalBackend.writeTerminal).not.toHaveBeenCalledWith(expect.anything(), "whoami\r");
    app.unmount();
  });

  it("通过单行 PTY 协议识别实时输出和退出码", async () => {
    vi.useFakeTimers();
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a", name: "Test", host: "127.0.0.1", port: 22, username: "ops", group: "test",
      status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.serverPasswords["server-a"] = "secret";
    ops.connectedServerIds.push("server-a");
    const sessions = useTerminalSessionStore(pinia);
    sessions.ensureWorkspace("server-a");
    const paneId = sessions.resolveActivePaneId("server-a")!;
    const app = createApp(TerminalPanel, { serverId: "server-a", sessionId: paneId, active: true });
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    await Promise.resolve();
    terminalBackend.statusListeners.forEach((listener) => listener({
      terminalId: `pty-server-a-${paneId}`, generation: 1, status: "connected", retryable: false,
    }));
    const chunks: string[] = [];
    const resultPromise = sessions.requestAgentPtyCommand(paneId, "exec-1", "pwd", (chunk) => chunks.push(chunk));
    await nextTick();
    expect(terminalBackend.scrollToBottomCalls).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(terminalBackend.writeTerminal).toHaveBeenCalledWith(
      `pty-server-a-${paneId}`,
      expect.stringContaining("set +o history"),
    );
    expect(terminalBackend.writeTerminal).toHaveBeenCalledWith(
      `pty-server-a-${paneId}`,
      expect.stringMatching(/__OPSARK_BEGIN_exec-1__.*__OPSARK_END_exec-1_/),
    );
    const protocolCommand = terminalBackend.writeTerminal.mock.calls
      .map(([, data]) => data)
      .find((data) => data.includes("__OPSARK_BEGIN_exec-1__"));
    expect(protocolCommand).toContain("set -o history");
    expect(protocolCommand).toContain("history -d");
    terminalBackend.activeBuffer.baseY = 20;
    terminalBackend.activeBuffer.viewportY = 4;
    terminalBackend.scrollListeners.forEach((listener) => listener(4));
    const scrollCallsBeforeHistoricalViewOutput = terminalBackend.scrollToBottomCalls;
    terminalBackend.outputListeners.forEach((listener) => listener({
      terminalId: `pty-server-a-${paneId}`,
      data: "__OPSARK_BEGIN_exec-1__\r\n/root\r\n__OPSARK_END_exec-1_0__\r\n",
      stream: "stdout",
    }));
    await vi.advanceTimersByTimeAsync(60);
    await expect(resultPromise).resolves.toMatchObject({ output: "/root", exitCode: 0, success: true });
    expect(chunks.join("")).toContain("/root");
    expect(terminalBackend.scrollToBottomCalls).toBe(scrollCallsBeforeHistoricalViewOutput);
    app.unmount();
    vi.useRealTimers();
  });

  it("在当前可见 PTY 中执行 SSH 并安全响应密码提示", async () => {
    vi.useFakeTimers();
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a", name: "Source", host: "192.168.1.236", port: 22, username: "root", group: "test",
      status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.serverPasswords["server-a"] = "source-secret";
    ops.connectedServerIds.push("server-a");
    const sessions = useTerminalSessionStore(pinia);
    sessions.ensureWorkspace("server-a");
    const paneId = sessions.resolveActivePaneId("server-a")!;
    const app = createApp(TerminalPanel, { serverId: "server-a", sessionId: paneId, active: true });
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
    terminalBackend.statusListeners.forEach((listener) => listener({
      terminalId: `pty-server-a-${paneId}`, generation: 1, status: "connected", retryable: false,
    }));
    await nextTick();

    const resultPromise = sessions.requestAgentPtySshJump(
      paneId,
      "ssh-jump-1",
      { host: "192.168.1.237", port: 22, username: "root" },
      "target-secret",
    ).catch((error) => { throw error; });
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminalBackend.displayWrites.join("")).toContain("[Agent]");
    expect(terminalBackend.displayWrites.join("")).toContain("ssh -p 22 root@192.168.1.237");
    expect(terminalBackend.writeTerminal.mock.calls.flat().join("\n")).not.toContain("target-secret");

    terminalBackend.outputListeners.forEach((listener) => listener({
      terminalId: `pty-server-a-${paneId}`, data: "root@192.168.1.237's password: ", stream: "stdout",
    }));
    await vi.advanceTimersByTimeAsync(60);
    expect(terminalBackend.writeTerminal).toHaveBeenCalledWith(`pty-server-a-${paneId}`, "target-secret\r");

    terminalBackend.outputListeners.forEach((listener) => listener({
      terminalId: `pty-server-a-${paneId}`,
      data: "\r\n__OPSARK_SSH_CONNECTED_ssh-jump-1__\r\n[root@target ~]# ",
      stream: "stdout",
    }));
    await vi.advanceTimersByTimeAsync(60);
    await expect(resultPromise).resolves.toMatchObject({ success: true, exitCode: 0 });
    app.unmount();
  });

});
