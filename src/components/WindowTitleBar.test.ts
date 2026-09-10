// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import WindowTitleBar from "./WindowTitleBar.vue";
const native = vi.hoisted(() => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: vi.fn().mockResolvedValue(true), isFocused: vi.fn().mockResolvedValue(true), onResized: vi.fn().mockResolvedValue(() => {}), onFocusChanged: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
let app: App;
afterEach(() => { app?.unmount(); vi.clearAllMocks(); });
async function mount(mac: boolean) {
  const host = document.createElement("div");
  app = createApp(WindowTitleBar, { mac }).use(createI18n({ legacy: false, locale: "zh-CN", messages: {} }));
  app.mount(host); await nextTick(); await nextTick(); return host;
}
it("routes Windows controls to native actions with restore state", async () => {
  const host = await mount(false);
  host.querySelector<HTMLButtonElement>('[aria-label="最小化窗口"]')!.click();
  host.querySelector<HTMLButtonElement>('[aria-label="还原窗口"]')!.click();
  host.querySelector<HTMLButtonElement>('[aria-label="关闭窗口"]')!.click();
  expect(native.minimize).toHaveBeenCalledOnce(); expect(native.toggleMaximize).toHaveBeenCalledOnce(); expect(native.close).toHaveBeenCalledOnce();
  expect(host.querySelector("button")?.hasAttribute("data-tauri-drag-region")).toBe(false);
});
it("reserves macOS native controls rather than duplicating them", async () => {
  const host = await mount(true);
  expect(host.querySelector(".mac")).not.toBeNull(); expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("[data-tauri-drag-region]")).not.toBeNull();
});
