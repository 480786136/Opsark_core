import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { watch } from "vue";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { backend } from "@/services/backend";
import type { Metrics, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server = (id: string): ServerProfile => ({
  id, host: `${id}.example.invalid`, port: 22, username: "tester", name: id, group: "test",
  status: "offline", environment: [], createdAt: "2026-09-14T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
});
const sample = (cpu: number): Metrics => ({ cpu, memory: 20, disk: 30, networkIn: 1, networkOut: 1, sampledAt: new Date().toISOString() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("SSH 连接与工作台数据集成", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    localStorage.clear();
    setActivePinia(createPinia());
    const ops = useOpsStore();
    ops.servers = [server("a"), server("b")];
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "deleteCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "probeSsh").mockResolvedValue({ info: server("a").info, environment: [], hostname: "test" });
    vi.spyOn(backend, "getSshMetrics").mockImplementation(async () => sample(10));
    vi.spyOn(backend, "getMetrics").mockImplementation(async () => sample(99));
    vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, output: "done", exitCode: 0, simulated: true });
    vi.spyOn(backend, "processRequirement");
  });
  afterEach(() => {
    useOpsStore().stopConnectionMonitor();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("未连接不采集指标、不回退合成数据，也不向模型提供零值冒充实时指标", async () => {
    const ops = useOpsStore();
    await ops.refreshMetrics("a");
    await ops.refreshMetrics();
    expect(backend.getSshMetrics).not.toHaveBeenCalled();
    expect(backend.getMetrics).not.toHaveBeenCalled();
    expect(ops.contextMetrics("a")).toBeUndefined();
    expect(ops.metricState("a")).toMatchObject({ stale: true, loading: false, sample: undefined });
  });

  it("错误密码清除在线状态但不覆盖已保存的有效密码", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "old-good");
    vi.mocked(backend.saveCredential).mockClear();
    vi.mocked(backend.checkSshConnection).mockRejectedValueOnce(new Error("SSH_AUTH_FAILED: 身份验证失败"));
    expect(await ops.connectServer("a", "new-bad")).toBe(false);
    expect(ops.serverConnection("a").status).toBe("auth_failed");
    expect(ops.connectedServerIds).not.toContain("a");
    expect(ops.serverPasswords.a).toBe("old-good");
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(ops.getRuntimeConnection("a")).toBeUndefined();
  });

  it("不同密码并发提交不能复用前一次成功结果保存错误密码", async () => {
    const ops = useOpsStore();
    const firstGate = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockReturnValueOnce(firstGate.promise)
      .mockRejectedValueOnce(new Error("SSH_AUTH_FAILED: 身份验证失败"));
    const first = ops.connectServer("a", "first-good");
    const second = ops.connectServer("a", "second-bad");
    firstGate.resolve();
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(ops.serverPasswords.a).toBeUndefined();
  });

  it("首次失败后自动重连验证成功才提交候选密码", async () => {
    const ops = useOpsStore();
    ops.startConnectionMonitor();
    vi.mocked(backend.checkSshConnection).mockRejectedValueOnce(new Error("SSH_NETWORK_ERROR: connection refused"));
    expect(await ops.connectServer("a", "new-good")).toBe(false);
    expect(ops.serverConnection("a").status).toBe("reconnecting");
    expect(backend.saveCredential).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    expect(ops.isServerConnected("a")).toBe(true);
    expect(ops.serverPasswords.a).toBe("new-good");
    expect(backend.saveCredential).toHaveBeenCalledExactlyOnceWith("server", "a", "new-good");
    expect(JSON.stringify(ops.logs)).not.toContain("new-good");
  });

  it("关闭或删除服务器后迟到认证不能保存密码或重新置在线", async () => {
    const ops = useOpsStore();
    const gate = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockReturnValueOnce(gate.promise);
    const connecting = ops.connectServer("a", "pending-password");
    ops.removeServer("a");
    gate.resolve();
    expect(await connecting).toBe(false);
    expect(ops.connectedServerIds).not.toContain("a");
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(ops.serverPasswords.a).toBeUndefined();
  });

  it("各服务器指标可以同时刷新，迟到结果不会串入另一台服务器", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "a-password");
    await ops.connectServer("b", "b-password");
    await flush();
    const aGate = deferred<Metrics>();
    const bGate = deferred<Metrics>();
    vi.mocked(backend.getSshMetrics).mockImplementation(connection => connection.host.startsWith("a.") ? aGate.promise : bGate.promise);
    const aRefresh = ops.refreshMetrics("a");
    const bRefresh = ops.refreshMetrics("b");
    bGate.resolve(sample(22));
    await bRefresh;
    aGate.resolve(sample(11));
    await aRefresh;
    expect(ops.contextMetrics("a")?.cpu).toBe(11);
    expect(ops.contextMetrics("b")?.cpu).toBe(22);
  });

  it("断线保留旧样本但标过期，并丢弃断线前未完成的采集", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "a-password");
    await flush();
    const gate = deferred<Metrics>();
    vi.mocked(backend.getSshMetrics).mockReturnValueOnce(gate.promise);
    const refresh = ops.refreshMetrics("a");
    ops.disconnectServer("a");
    gate.resolve(sample(88));
    await refresh;
    expect(ops.metricState("a")).toMatchObject({ sample: { cpu: 10 }, stale: true, loading: false });
    expect(ops.contextMetrics("a")).toBeUndefined();
    expect(backend.getMetrics).not.toHaveBeenCalled();
  });

  it("无连接不能发送需求或执行手动命令", async () => {
    const ops = useOpsStore();
    await expect(ops.submitRequirement("a", "检查状态", "safe", "model")).rejects.toThrow("SSH 未连接");
    await expect(ops.runTerminalCommand("hostname", "a")).rejects.toThrow("SSH 未连接");
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("断线阻止后续任务步骤，保留已有证据而不重放", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "a-password");
    const task = ops.createTask("a", "managed", "model");
    task.status = "running";
    task.plan = [{ id: "step", title: "检查", description: "检查", command: "hostname", validation: "true", expected: "主机名", risk: "low", status: "pending" } as PlanStep];
    useConnectionStore().disconnect("a");
    await ops.runStep(task.id, "step");
    expect(task.plan[0].status).toBe("pending");
    expect(task.pauseReason).toContain("不会自动重放");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("主动断开后可从系统凭据恢复并手动重连", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "saved-password");
    ops.disconnectServer("a");
    ops.credentialsHydrated = true;
    vi.mocked(backend.loadCredential).mockResolvedValueOnce("saved-password");
    expect(await ops.reconnectServer("a")).toBe(true);
    expect(ops.getRuntimeConnection("a")?.password).toBe("saved-password");
  });

  it("首次连接成功触发的目录读取不会被随后保存凭据清空", async () => {
    const ops = useOpsStore();
    const files = useFileWorkspaceStore();
    vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const stop = watch(() => ops.isServerConnected("a"), connected => {
      if (connected) void files.loadDirectory("a", ops.getRuntimeConnection("a")!, "/");
    }, { flush: "sync" });
    try {
      await ops.connectServer("a", "first-password");
      await flush();
      expect(files.ensureServer("a").lastSuccessAt).toBeTruthy();
      expect(files.ensureServer("a").stale).toBe(false);
    } finally { stop(); }
  });

  it("主命令返回前断线，不派发独立校验也不调用模型重放业务", async () => {
    const ops = useOpsStore();
    await ops.connectServer("a", "a-password");
    const task = ops.createTask("a", "managed", "model");
    task.status = "running";
    task.plan = [{ id: "step", title: "写入测试标记", description: "写入", command: "touch /tmp/opsark-test-marker", validation: "test -f /tmp/opsark-test-marker", expected: "文件存在", risk: "low", status: "pending", kind: "change" } as PlanStep];
    const gate = deferred<Awaited<ReturnType<typeof backend.executeCommand>>>();
    vi.mocked(backend.executeCommand).mockReturnValueOnce(gate.promise);
    const validation = vi.spyOn(backend, "validateStep");
    const review = vi.spyOn(backend, "reviewStep");
    const running = ops.runStep(task.id, "step");
    await flush();
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    ops.disconnectServer("a");
    gate.resolve({ success: true, output: "done", exitCode: 0, simulated: true });
    await running;
    expect(validation).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    task.cancelRequested = true;
  });
});
