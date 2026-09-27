// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import ModelSettingsModal from "./ModelSettingsModal.vue";

vi.mock("@/features/account/officialCatalogApi", () => ({
  fetchOfficialCatalog: vi.fn().mockResolvedValue({ models: [] }),
  officialCatalogOrigin: vi.fn().mockResolvedValue("https://example.test"),
}));
let app: App | undefined;
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; vi.restoreAllMocks(); localStorage.clear(); });

async function mount() {
  localStorage.clear();
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useOpsStore();
  store.models = [{ id: "local", name: "Saved model", provider: "Compatible", model: "custom",
    endpoint: "https://example.test/v1", enabled: true, hasApiKey: false }];
  store.aiGenerationSettings.limitOutput = false;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { template: "<div/>" } }] });
  await router.push("/");
  const state = reactive({ open: true });
  const host = document.createElement("div"); document.body.append(host);
  app = createApp({ components: { ModelSettingsModal }, setup: () => ({ state }),
    template: '<ModelSettingsModal :open="state.open" @close="state.open = false"/>' })
    .use(pinia).use(router).use(createI18n({ legacy: false, locale: "zh-CN", missingWarn: false, fallbackWarn: false, messages: {} }));
  app.mount(host); await nextTick();
  return { store, state };
}

it("always exposes the budget and discards unsaved budget when closed", async () => {
  const { store, state } = await mount();
  const initial = store.aiGenerationSettings.maxOutputTokens;
  const input = document.querySelector<HTMLInputElement>('.budget-settings input[type="number"]')!;
  expect(input).not.toBeNull();
  input.value = "777"; input.dispatchEvent(new Event("input")); await nextTick();
  expect(store.aiGenerationSettings.maxOutputTokens).toBe(initial);
  document.querySelector('.shared-model-settings')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick(); expect(state.open).toBe(false);
  state.open = true; await nextTick();
  expect(document.querySelector<HTMLInputElement>('.budget-settings input[type="number"]')!.value).toBe(String(initial));
});

it("saves budget explicitly without testing any model", async () => {
  const { store } = await mount();
  const check = vi.spyOn(backend, "checkModel");
  const input = document.querySelector<HTMLInputElement>('.budget-settings input[type="number"]')!;
  input.value = "777"; input.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector('.budget-settings')!.dispatchEvent(new Event("submit", { cancelable: true })); await nextTick();
  expect(store.aiGenerationSettings.maxOutputTokens).toBe(777);
  expect(check).not.toHaveBeenCalled();
});

it("uses a separate model draft and makes the parent modal inert while editing", async () => {
  const { store } = await mount();
  document.querySelector<HTMLButtonElement>('button.model-card')!.click(); await nextTick(); await nextTick();
  expect(document.querySelector<HTMLElement>('.shared-model-settings')!.inert).toBe(true);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="显示名称"]')!;
  input.value = "Unsaved model"; input.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector('.drawer-overlay')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick(); await nextTick();
  expect(store.models[0].name).toBe("Saved model");
  expect(document.querySelector<HTMLElement>('.shared-model-settings')!.inert).toBe(false);
});
