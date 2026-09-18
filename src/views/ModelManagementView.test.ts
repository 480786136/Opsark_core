// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import ModelManagementView from "./ModelManagementView.vue";
import { useAccountStore } from "@/features/account/accountStore";
import { fetchOfficialCatalog, officialCatalogOrigin } from "@/features/account/officialCatalogApi";
vi.mock("@/features/account/officialCatalogApi", () => ({ fetchOfficialCatalog: vi.fn(), officialCatalogOrigin: vi.fn() }));

let app: App;
beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear();
  vi.mocked(fetchOfficialCatalog).mockReset().mockResolvedValue({ models: [] });
  vi.mocked(officialCatalogOrigin).mockReset().mockResolvedValue("https://platform.example.test");
});
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
async function mount() {
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useOpsStore();
  vi.spyOn(useAccountStore(), "refresh").mockResolvedValue();
  store.models = [{ id: "one", name: "Example", model: "model", provider: "Compatible", endpoint: "https://example.test/v1", enabled: true, hasApiKey: true, timeoutSeconds: 180 }];
  store.modelApiKeys.one = "secret";
  const host = document.createElement("div"); document.body.append(host);
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", component: ModelManagementView }, { path: "/account", component: { template: "<p>Account</p>" } },
  ] });
  await router.push("/");
  app = createApp(ModelManagementView).use(pinia).use(router).use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(host); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); return store;
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
it("keeps the editor open on backdrop clicks and saves the per-model timeout", async () => {
  const store = await mount();
  vi.spyOn(store, "saveModels").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  document.querySelector<HTMLElement>(".drawer-overlay")!.click(); await nextTick();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const timeout = document.querySelector<HTMLInputElement>('input[type="number"]')!;
  timeout.value = "360"; timeout.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await nextTick(); await nextTick();
  expect(store.models[0].timeoutSeconds).toBe(360);
});

it("official model editor exposes only timeout and advanced parameters, with the Admin name read-only", async () => {
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ id: "model", name: "Official display" }] });
  const store = await mount();
  useAccountStore().apply({ user: { id: "one", email: "one@example.test" }, balance: { available: 100, reserved: 0, revision: 1, unit: "tokens" }, models: [{ id: "model", name: "Official display" }], endpoint: "https://official.example.test/v1" });
  await nextTick();
  expect(document.querySelector(".model-card")?.textContent).not.toContain("example.test");
  document.querySelector<HTMLButtonElement>(".official-model-open")!.click(); await nextTick();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll(".connection-fields input")).toHaveLength(1);
  expect(dialog.textContent).not.toContain("settings.configName");
  expect(dialog.querySelector('input[type="password"]')).toBeNull();
  expect(dialog.querySelector("select")).toBeNull();
  const timeout = dialog.querySelector<HTMLInputElement>('input[type="number"]')!;
  timeout.value = "240"; timeout.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await nextTick();
  expect(store.models.find(m => m.source === "official")).toMatchObject({ name: "Official display", timeoutSeconds: 240, endpoint: "https://official.example.test/v1" });
  expect(localStorage.getItem("opsark.officialModelSettings")).not.toContain("endpoint");
  expect(localStorage.getItem("opsark.officialModelSettings")).not.toContain('"name"');
});

it("automatically lists public official models first and overlays login without granting execution", async () => {
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ id: "trial", name: "Official trial" }] });
  const store = await mount();
  expect(fetchOfficialCatalog).toHaveBeenCalledOnce();
  expect(document.querySelector(".model-grid > :first-child")?.textContent).toContain("Official trial");
  expect(document.querySelector<HTMLButtonElement>(".official-model-open")?.disabled).toBe(true);
  expect(document.querySelector(".official-model-lock")?.textContent).toContain("Sign in to use");
  expect(document.querySelector(".official-model-lock")?.getAttribute("href")).toBe("/account");
  expect(document.body.textContent).not.toContain("Refresh official models");
  expect(document.body.textContent).not.toContain("sign in / view credits");
  expect(store.models.map(m => m.id)).toEqual(["one"]);
  expect(store.modelApiKeys).not.toHaveProperty("official:trial");
});
