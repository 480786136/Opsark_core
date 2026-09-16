// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createApp, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import ModelAdvancedParameters from "./ModelAdvancedParameters.vue";
import type { ModelProfile } from "@/types";

it("renders Chinese labels and keeps API enum values intact", async () => {
  const model = reactive({ id: "chinese" } as ModelProfile);
  const host = document.createElement("div");
  const localI18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {}, "en-US": {} } });
  const app = createApp(ModelAdvancedParameters, { model }).use(localI18n);
  app.mount(host);
  try {
    expect(host.textContent).toContain("高级请求参数");
    expect(host.textContent).toContain("0 项自定义");
    expect(host.textContent).toContain("恢复默认");
    expect(host.textContent).not.toMatch(/\?{2,}|\uFFFD|&#x30;/);
    expect(host.querySelector("input")?.placeholder).toBe("默认");
    const trigger = host.querySelector<HTMLElement>('summary[aria-label="reasoning_effort"]')!;
    trigger.click(); await nextTick();
    const high = document.querySelector<HTMLButtonElement>('.parameter-options [data-value="high"]')!;
    expect(high.textContent).toContain("高");
    high.click(); await nextTick();
    expect(model.requestParameters?.reasoning_effort).toBe("high");
    localI18n.global.locale.value = "en-US";
    await nextTick();
    expect(host.textContent).toContain("Advanced request parameters");
    expect(trigger.textContent).toContain("High");
  } finally { app.unmount(); }
});

it("edits, previews, validates and resets without changing another model", async () => {
  const model = reactive({ id: "one" } as ModelProfile);
  const other = { requestParameters: { temperature: 1 } };
  const host = document.createElement("div");
  const app = createApp(ModelAdvancedParameters, { model }).use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.mount(host);
  try {
    expect(host.querySelector("details")?.open).toBe(false);
    const input = host.querySelector<HTMLInputElement>('[aria-label="temperature"]')!;
    input.value = "0"; input.dispatchEvent(new Event("input")); await nextTick();
    expect(model.requestParameters?.temperature).toBe(0);
    expect(host.querySelector("pre")?.textContent).toContain('"temperature": 0');
    input.value = "3"; input.dispatchEvent(new Event("input")); await nextTick();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    input.value = ""; input.dispatchEvent(new Event("input")); await nextTick();
    expect(model.requestParameters?.temperature).toBeUndefined();
    host.querySelector("button")!.click(); await nextTick();
    expect(model.requestParameters).toBeUndefined();
    expect(other.requestParameters.temperature).toBe(1);
  } finally { app.unmount(); }
});
