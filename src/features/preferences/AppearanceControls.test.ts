// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp, nextTick, type App } from "vue";
import AppearanceControls from "./AppearanceControls.vue";
import { i18n } from "./i18n";

describe("AppearanceControls", () => {
  let app: App;
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    const pinia = createPinia();
    setActivePinia(pinia);
    app = createApp(AppearanceControls).use(pinia).use(i18n);
    app.mount(host);
  });

  afterEach(() => {
    app.unmount();
    host.remove();
  });

  it("为弹层和分组提供完整的语义", async () => {
    const trigger = host.querySelector<HTMLButtonElement>(".rail-action")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.click();
    await nextTick();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(3);
    expect(host.querySelectorAll<HTMLInputElement>('input[type="range"][aria-label]')).toHaveLength(2);
    expect(document.activeElement).toBe(dialog);
  });

  it("Escape 关闭弹层并把焦点返回触发按钮", async () => {
    const trigger = host.querySelector<HTMLButtonElement>(".rail-action")!;
    trigger.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
