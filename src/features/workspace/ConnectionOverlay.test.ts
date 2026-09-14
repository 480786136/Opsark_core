// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import { i18n } from "@/features/preferences/i18n";
import ConnectionOverlay from "./ConnectionOverlay.vue";

let app: App | undefined;
let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "zh-CN";
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const pinia = createPinia();
  const ops = useOpsStore(pinia);
  ops.servers = [{
    id: "alpha", name: "Alpha", host: "alpha.test", port: 22, username: "ops", group: "test",
    status: "offline", environment: [], createdAt: new Date().toISOString(),
    info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
  }];
  const state = ops.serverConnection("alpha");
  Object.assign(state, { status: "manual", error: "连接超时", attempt: 3 });
  const active = ref(true);
  const onReadonlyChange = vi.fn();
  const onViewHistory = vi.fn();
  app = createApp(defineComponent(() => () => h(ConnectionOverlay, {
    serverId: "alpha", active: active.value, onReadonlyChange, onViewHistory,
  })));
  app.use(pinia).use(i18n).mount(host);
  return { ops, state, active, onReadonlyChange, onViewHistory };
}

function button(text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(text));
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}

describe("ConnectionOverlay", () => {
  it("keeps the same mask through retries, ignores backdrop/Escape, and shows the failure inline", async () => {
    const { ops, state } = setup();
    ops.serverPasswords.alpha = "saved-test-password";
    let resolve!: (value: boolean) => void;
    const reconnect = vi.spyOn(ops, "reconnectServer").mockImplementation(() => {
      Object.assign(state, { status: "reconnecting", phase: "正在验证 SSH 连接", startedAt: Date.now(), error: undefined });
      return new Promise<boolean>(done => { resolve = done; });
    });
    const original = host.querySelector(".connection-overlay");
    button("重新连接").click();
    await nextTick();
    expect(host.querySelector(".connection-overlay")).toBe(original);
    expect(button("正在连接").disabled).toBe(true);
    button("正在连接").click();
    original?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    original?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".connection-description")?.textContent).toBe("正在验证 SSH 连接");
    expect(host.textContent).not.toContain("SSH 握手");

    Object.assign(state, { status: "manual", error: "网络不可达，请检查网络" });
    resolve(false);
    await nextTick();
    await nextTick();
    expect(host.querySelector(".connection-overlay")).toBe(original);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("网络不可达");
    expect(button("重新连接").disabled).toBe(false);
    expect(host.querySelector(".is-busy")).toBeNull();
  });

  it("retains the entered password on authentication failure and clears it after success", async () => {
    const { ops, state } = setup();
    const connect = vi.spyOn(ops, "connectServer").mockImplementationOnce(async () => {
      Object.assign(state, { status: "auth_failed", error: "用户名或密码不正确" });
      return false;
    }).mockImplementationOnce(async () => {
      Object.assign(state, { status: "connected", error: undefined });
      return true;
    });
    button("修改凭据").click();
    await nextTick();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "typed-test-password";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(connect).toHaveBeenCalledWith("alpha", "typed-test-password", true);
    expect(input.value).toBe("typed-test-password");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("用户名或密码不正确");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);

    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(host.querySelector(".connection-overlay")).toBeNull();
    state.status = "disconnected";
    await nextTick();
    button("修改凭据").click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });

  it("uses a persistent read-only banner during reconnection and can reopen connection details", async () => {
    const { state, onReadonlyChange, onViewHistory } = setup();
    Object.assign(state, { status: "reconnecting", phase: "等待自动重连" });
    await nextTick();
    button("查看终端历史").click();
    await nextTick();
    expect(host.querySelector(".connection-overlay.is-readonly")).not.toBeNull();
    expect(onReadonlyChange).toHaveBeenLastCalledWith(true);
    expect(onViewHistory).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("等待自动重连");
    state.status = "manual";
    state.error = "连接超时";
    await nextTick();
    expect(host.querySelector(".connection-overlay.is-readonly")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("连接超时");
    button("连接详情").click();
    await nextTick();
    expect(host.querySelector(".is-readonly")).toBeNull();
    expect(onReadonlyChange).toHaveBeenLastCalledWith(false);
  });

  it("clears a submitted password after a later automatic recovery while preserving an unsent draft", async () => {
    const { ops, state } = setup();
    vi.spyOn(ops, "connectServer").mockImplementationOnce(async () => {
      Object.assign(state, { status: "reconnecting", phase: "等待自动重连", error: "连接超时" });
      return false;
    });
    button("修改凭据").click();
    await nextTick();
    let input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "submitted-test-password";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(host.querySelector(".connection-overlay.is-busy")).not.toBeNull();
    expect(input.value).toBe("submitted-test-password");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("连接超时");
    state.status = "connected";
    state.error = undefined;
    await nextTick();
    expect(host.querySelector(".connection-overlay")).toBeNull();
    state.status = "manual";
    await nextTick();
    button("修改凭据").click();
    await nextTick();
    input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.value).toBe("");
    input.value = "unsent-test-draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    state.status = "connected";
    await nextTick();
    state.status = "manual";
    await nextTick();
    button("修改凭据").click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("unsent-test-draft");
  });

  it("opens and focuses the credential form when there is no saved password", async () => {
    const { ops, state } = setup();
    state.status = "idle";
    vi.spyOn(ops, "reconnectServer").mockResolvedValue(false);
    button("重新连接").click();
    await nextTick();
    await nextTick();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("stops the elapsed-time clock for hidden server panels and after recovery", async () => {
    vi.useFakeTimers();
    const { state, active } = setup();
    Object.assign(state, { status: "reconnecting", startedAt: Date.now() });
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.textContent).toContain("已用时 3 秒");
    active.value = false;
    await nextTick();
    expect(vi.getTimerCount()).toBe(0);
    active.value = true;
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);
    state.status = "connected";
    await nextTick();
    expect(vi.getTimerCount()).toBe(0);
  });
});
