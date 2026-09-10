// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import ModelManagementView from "./ModelManagementView.vue";

let app: App;
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
async function mount() {
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useOpsStore();
  store.models = [{ id: "one", name: "Example", model: "model", provider: "Compatible", endpoint: "https://example.test/v1", enabled: true, hasApiKey: true }];
  store.modelApiKeys.one = "secret";
  const host = document.createElement("div"); document.body.append(host);
  app = createApp(ModelManagementView).use(pinia).use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(host); await nextTick(); return store;
}
it("keeps cards compact and discards draft changes on Escape", async () => {
  const store = await mount();
  expect(document.querySelector(".model-card input")).toBeNull();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const input = document.querySelector<HTMLInputElement>(".connection-fields input")!;
  input.value = "Edited"; input.dispatchEvent(new Event("input")); await nextTick();
  expect(store.models[0].name).toBe("Example");
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextTick();
  expect(store.models[0].name).toBe("Example");
});
it("commits the editor draft through the existing save action", async () => {
  const store = await mount();
  const save = vi.spyOn(store, "saveModels").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const input = document.querySelector<HTMLInputElement>(".connection-fields input")!;
  input.value = "Edited"; input.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await nextTick(); await nextTick();
  expect(save).toHaveBeenCalledOnce(); expect(store.models[0].name).toBe("Edited");
});
it("opening and cancelling a new model does not persist an empty record", async () => {
  const store = await mount();
  document.querySelector<HTMLButtonElement>(".page-header button")!.click(); await nextTick();
  expect(store.models).toHaveLength(1);
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextTick();
  expect(store.models).toHaveLength(1);
});
