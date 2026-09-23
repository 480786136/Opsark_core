import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { computed } from "vue";
import type { RuntimeConnection } from "@/services/backend";
import { connectionErrorMessage, isConnectionTransportFailure, useConnectionStore } from "./connectionStore";

const { checkSshConnection } = vi.hoisted(() => ({ checkSshConnection: vi.fn() }));
vi.mock("@/services/backend", () => ({ backend: { checkSshConnection } }));

const credentials: RuntimeConnection = {
  host: "server.example.invalid", port: 22, username: "operator", password: "test-password",
};
const networkError = () => new Error("SSH_NETWORK_ERROR: SSH 网络连接失败");

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
async function advanceAndTick(store: ReturnType<typeof useConnectionStore>, delay: number, ids = ["server"]) {
  await vi.advanceTimersByTimeAsync(delay);
  store.tick(ids);
  await flush();
}

async function failHealthTwice(store: ReturnType<typeof useConnectionStore>) {
  checkSshConnection.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
  await store.checkHealth("server");
  await store.checkHealth("server");
}

describe("server connection coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    setActivePinia(createPinia());
    checkSshConnection.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a reactive state proxy on the very first read", async () => {
    const store = useConnectionStore();
    const initial = store.state("server");
    const status = computed(() => initial.status);
    expect(status.value).toBe("idle");
    await store.connect("server", credentials);
    expect(status.value).toBe("connected");
    store.disconnect("server");
    expect(status.value).toBe("disconnected");
  });

  it("coalesces identical connection clicks and keeps credentials out of public state", async () => {
    const gate = deferred();
    checkSshConnection.mockReturnValueOnce(gate.promise);
    const store = useConnectionStore();
    const first = store.connect("server", credentials);
    const second = store.connect("server", { ...credentials });
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    expect(store.state("server").status).toBe("connecting");
    expect(store.connection("server")).toBeUndefined();
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(store.connection("server")).toEqual(credentials);
    expect(JSON.stringify(store.$state)).not.toContain(credentials.password);
  });

  it("does not authenticate a changed password using the previous successful promise", async () => {
    const old = deferred();
    const changed = deferred();
    checkSshConnection.mockReturnValueOnce(old.promise).mockReturnValueOnce(changed.promise);
    const store = useConnectionStore();
    const first = store.connect("server", credentials);
    const replacement = { ...credentials, password: "changed-password" };
    const second = store.connect("server", replacement);
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    old.resolve();
    expect(await first).toBe(false);
    await flush();
    expect(checkSshConnection).toHaveBeenLastCalledWith(replacement, 15_000);
    expect(store.isConnected("server")).toBe(false);
    changed.reject(new Error("SSH_AUTH_FAILED: SSH 身份认证失败"));
    expect(await second).toBe(false);
    expect(store.state("server").status).toBe("auth_failed");
    expect(store.connection("server")).toBeUndefined();
  });

  it("serializes changed credentials and only executes the latest queued intent", async () => {
    const firstGate = deferred();
    const latestGate = deferred();
    checkSshConnection.mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(latestGate.promise);
    const store = useConnectionStore();
    const first = store.connect("server", credentials);
    const middle = store.connect("server", { ...credentials, password: "middle" });
    const latest = { ...credentials, host: "replacement.example.invalid", password: "latest" };
    const third = store.connect("server", latest);
    const duplicate = store.connect("server", { ...latest });
    firstGate.resolve();
    expect(await first).toBe(false);
    expect(await middle).toBe(false);
    await flush();
    expect(checkSshConnection).toHaveBeenCalledTimes(2);
    expect(checkSshConnection).toHaveBeenLastCalledWith(latest, 15_000);
    latestGate.resolve();
    expect(await Promise.all([third, duplicate])).toEqual([true, true]);
    expect(store.connection("server")).toEqual(latest);
  });

  it.each(["disconnect", "forget"] as const)("%s invalidates both active and queued connection results", async (action) => {
    const gate = deferred();
    checkSshConnection.mockReturnValueOnce(gate.promise);
    const store = useConnectionStore();
    const first = store.connect("server", credentials);
    const second = store.connect("server", { ...credentials, password: "queued" });
    store[action]("server");
    const generation = store.state("server").generation;
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    expect(store.state("server")).toMatchObject({ status: "disconnected", generation });
    expect(store.connection("server")).toBeUndefined();
  });

  it("does not resurrect a disconnected server after waiting for an old health check", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    const health = deferred();
    checkSshConnection.mockReturnValueOnce(health.promise);
    const pendingHealth = store.checkHealth("server");
    const reconnect = store.connect("server", { ...credentials, password: "replacement" });
    store.disconnect("server");
    health.resolve();
    expect(await pendingHealth).toBe(false);
    expect(await reconnect).toBe(false);
    expect(checkSshConnection).toHaveBeenCalledTimes(2);
    expect(store.state("server").status).toBe("disconnected");
  });

  it("allows a new explicit connection after forget without reviving the old generation", async () => {
    const old = deferred();
    checkSshConnection.mockReturnValueOnce(old.promise);
    const store = useConnectionStore();
    const first = store.connect("server", credentials);
    store.forget("server");
    const forgottenGeneration = store.state("server").generation;
    const latest = { ...credentials, password: "new" };
    const second = store.connect("server", latest);
    old.resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(store.state("server").generation).toBeGreaterThan(forgottenGeneration);
    expect(store.connection("server")).toEqual(latest);
  });

  it("marks the first health failure suspect and coordinates recovery after the second", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    checkSshConnection.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    await store.checkHealth("server");
    expect(store.state("server").status).toBe("suspect");
    expect(store.connection("server")).toBeUndefined();
    await store.checkHealth("server");
    expect(store.state("server")).toMatchObject({ status: "reconnecting", attempt: 0 });
    await advanceAndTick(store, 1_999);
    expect(checkSshConnection).toHaveBeenCalledTimes(3);
    await advanceAndTick(store, 1);
    expect(store.state("server")).toMatchObject({ status: "connected", attempt: 1 });
  });

  it("initial network failures get at most three automatic retries", async () => {
    checkSshConnection.mockRejectedValue(networkError());
    const store = useConnectionStore();
    expect(await store.connect("server", credentials)).toBe(false);
    expect(store.state("server")).toMatchObject({ status: "reconnecting", attempt: 0 });
    for (const delay of [2_000, 5_000, 10_000]) await advanceAndTick(store, delay);
    expect(store.state("server")).toMatchObject({ status: "manual", attempt: 3 });
    expect(checkSshConnection).toHaveBeenCalledTimes(4);
    await advanceAndTick(store, 120_000);
    expect(checkSshConnection).toHaveBeenCalledTimes(4);
  });

  it("authentication rejection stops immediately and has a readable inline error", async () => {
    checkSshConnection.mockRejectedValue(new Error("SSH_AUTH_FAILED: SSH 身份认证失败"));
    const store = useConnectionStore();
    expect(await store.connect("server", credentials)).toBe(false);
    expect(store.state("server")).toMatchObject({ status: "auth_failed", error: "SSH 身份认证失败" });
    await advanceAndTick(store, 120_000);
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    expect(connectionErrorMessage("Error: SSH_TIMEOUT: 连接超时")).toBe("连接超时");
  });

  it("caps a stalled bridge at exactly the remaining automatic recovery budget", async () => {
    checkSshConnection.mockImplementation(() => new Promise<void>(() => {}));
    const store = useConnectionStore();
    const initial = store.connect("server", credentials);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await initial).toBe(false);
    const recoveryStarted = performance.now();
    await advanceAndTick(store, 2_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await advanceAndTick(store, 5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await advanceAndTick(store, 10_000);
    expect(checkSshConnection.mock.calls.map(call => call[1])).toEqual([15_000, 15_000, 15_000, 13_000]);
    await vi.advanceTimersByTimeAsync(12_999);
    expect(store.state("server").status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(performance.now() - recoveryStarted).toBe(60_000);
    expect(store.state("server")).toMatchObject({ status: "manual", attempt: 3 });
  });

  it("does not launch a probe if the remaining budget is below the backend minimum", async () => {
    checkSshConnection.mockRejectedValue(networkError());
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await advanceAndTick(store, 59_900);
    expect(store.state("server").status).toBe("manual");
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
  });

  it("ignores a successful bridge completion after its timeout", async () => {
    const gate = deferred();
    checkSshConnection.mockReturnValueOnce(gate.promise);
    const store = useConnectionStore();
    const pending = store.connect("server", credentials);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe(false);
    gate.resolve();
    await flush();
    expect(store.state("server").status).toBe("reconnecting");
    expect(store.connection("server")).toBeUndefined();
  });

  it("uses monotonic time for health checks despite forward and backward wall-clock changes", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    const original = Date.now();
    vi.setSystemTime(original + 86_400_000);
    store.tick(["server"]);
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    await advanceAndTick(store, 10_000);
    expect(checkSshConnection).toHaveBeenCalledTimes(2);
    vi.setSystemTime(original - 86_400_000);
    await advanceAndTick(store, 10_000);
    expect(checkSshConnection).toHaveBeenCalledTimes(3);
    expect(store.state("server").lastSuccessAt).toBe(Date.now());
  });

  it("does not prematurely retry or exhaust recovery after a wall-clock jump", async () => {
    checkSshConnection.mockRejectedValueOnce(networkError());
    const store = useConnectionStore();
    await store.connect("server", credentials);
    vi.setSystemTime(Date.now() + 86_400_000);
    store.tick(["server"]);
    expect(checkSshConnection).toHaveBeenCalledTimes(1);
    await advanceAndTick(store, 2_000);
    expect(store.state("server")).toMatchObject({ status: "connected", attempt: 1 });
  });

  it("does not replenish retry attempts when connections repeatedly succeed only briefly", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await failHealthTwice(store);
    for (const [index, delay] of [2_000, 5_000, 10_000].entries()) {
      await advanceAndTick(store, delay);
      expect(store.state("server")).toMatchObject({ status: "connected", attempt: index + 1 });
      await failHealthTwice(store);
    }
    expect(store.state("server")).toMatchObject({ status: "manual", attempt: 3 });
  });

  it("replenishes retry attempts only after a continuously stable connection", async () => {
    checkSshConnection.mockRejectedValueOnce(networkError());
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await advanceAndTick(store, 2_000);
    expect(store.state("server").attempt).toBe(1);
    await advanceAndTick(store, 60_000);
    expect(store.state("server").attempt).toBe(0);
    await failHealthTwice(store);
    await advanceAndTick(store, 2_000);
    expect(store.state("server")).toMatchObject({ status: "connected", attempt: 1 });
  });

  it("does not count a suspect period as continuously stable", async () => {
    checkSshConnection.mockRejectedValueOnce(networkError());
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await advanceAndTick(store, 2_000);
    await vi.advanceTimersByTimeAsync(59_000);
    checkSshConnection.mockRejectedValueOnce(networkError());
    await store.checkHealth("server");
    expect(store.state("server").status).toBe("suspect");
    await store.checkHealth("server");
    await advanceAndTick(store, 1_000);
    expect(store.state("server")).toMatchObject({ status: "connected", attempt: 1 });
  });

  it("does not let an older health success erase a newly reported transport failure", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    const old = deferred();
    checkSshConnection.mockReturnValueOnce(old.promise);
    const oldHealth = store.checkHealth("server");
    store.reportFailure("server", "SSH_NETWORK_ERROR: connection reset");
    old.resolve();
    expect(await oldHealth).toBe(false);
    expect(store.state("server").status).toBe("suspect");
    store.tick(["server"]);
    await flush();
    expect(checkSshConnection).toHaveBeenCalledTimes(3);
    expect(store.state("server").status).toBe("connected");
  });

  it("keeps sessions online and coalesces wake events with an in-flight health check", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    const old = deferred();
    checkSshConnection.mockReturnValueOnce(old.promise);
    const previousHealth = store.checkHealth("server");
    store.tick(["server"], true);
    store.tick(["server"], true);
    expect(store.state("server").status).toBe("connected");
    expect(checkSshConnection).toHaveBeenCalledTimes(2);
    old.resolve();
    expect(await previousHealth).toBe(true);
    await advanceAndTick(store, 0);
    expect(store.state("server").status).toBe("connected");
  });

  it("checks quietly on wake and only marks suspect after a real probe failure", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    const health = deferred();
    checkSshConnection.mockReturnValueOnce(health.promise);
    const generation = store.state("server").generation;
    store.tick(["server"], true);
    expect(checkSshConnection).toHaveBeenCalledTimes(2);
    expect(store.state("server").status).toBe("connected");
    health.reject(networkError());
    await flush();
    expect(store.state("server").status).toBe("suspect");
    expect(store.state("server").generation).toBe(generation);
  });

  it("exhausts an unstable recovery cycle on time even when a fresh health check is pending", async () => {
    checkSshConnection.mockRejectedValueOnce(networkError());
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await advanceAndTick(store, 2_000);
    await vi.advanceTimersByTimeAsync(57_000);
    const health = deferred();
    checkSshConnection.mockReturnValueOnce(health.promise);
    store.reportFailure("server", "SSH_NETWORK_ERROR: connection reset");
    expect(store.state("server").status).toBe("suspect");
    await advanceAndTick(store, 1_000);
    expect(store.state("server").status).toBe("manual");
    health.resolve();
    await flush();
    expect(store.state("server").status).toBe("manual");
  });

  it("isolates connection failures and pending checks between servers", async () => {
    const store = useConnectionStore();
    await store.connect("server", credentials);
    await store.connect("other", { ...credentials, host: "other.example.invalid" });
    await failHealthTwice(store);
    expect(store.state("server").status).toBe("reconnecting");
    expect(store.isConnected("other")).toBe(true);
    expect(store.connection("other")?.host).toBe("other.example.invalid");
  });
});

describe("terminal transport failure classification", () => {
  it.each([
    "终端输出读取失败：transport read",
    "终端输入发送失败：Failure while draining incoming flow",
  ])("recognizes %s so the coordinator can recover", (reason) => {
    expect(isConnectionTransportFailure(reason)).toBe(true);
  });
});
