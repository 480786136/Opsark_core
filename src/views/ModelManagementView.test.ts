// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import ModelManagementView from "./ModelManagementView.vue";
import { useAccountStore } from "@/features/account/accountStore";
import { backend } from "@/services/backend";
import { directCapabilities, newModelCapabilities } from "@/features/agent/modelCapabilities";
import { modelPresetConfiguration } from "@/features/agent/modelPresets";
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
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
  input.value = "Edited"; input.dispatchEvent(new Event("input")); await nextTick();
  expect(store.models[0].name).toBe("Example");
  document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextTick();
  expect(store.models[0].name).toBe("Example");
});
it("commits the editor draft through the existing save action", async () => {
  const store = await mount();
  const save = vi.spyOn(store, "saveModelProfile");
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  const check = vi.spyOn(backend, "checkModel");
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
  input.value = "Edited"; input.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await nextTick(); await nextTick();
  expect(save).toHaveBeenCalledOnce(); expect(store.models[0].name).toBe("Edited");
  expect(check).not.toHaveBeenCalled();
});

it("keeps the saved profile and credentials unchanged when keychain persistence fails", async () => {
  const store = await mount();
  vi.spyOn(backend, "saveCredential").mockRejectedValue(new Error("keychain unavailable"));
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
  input.value = "Not committed"; input.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await nextTick(); await nextTick(); await nextTick();
  expect(store.models[0].name).toBe("Example");
  expect(store.modelApiKeys.one).toBe("secret");
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("keychain unavailable"));
});

it("explicit testing only checks the draft, and an explicit save retains its result without another call", async () => {
  const store = await mount();
  const check = vi.spyOn(backend, "checkModel").mockResolvedValue({ available: true, reason: "JSON probe passed" });
  const save = vi.spyOn(store, "saveModelProfile");
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const test = [...document.querySelectorAll<HTMLButtonElement>('.drawer-footer button')].find(button => button.textContent?.includes("Test this model"))!;
  test.click(); await nextTick(); await nextTick();
  expect(check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "model", endpoint: "https://example.test/v1", capabilities: undefined, capabilitiesV2: undefined }), "structured");
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector('.test-success')?.textContent).toContain("JSON probe passed");
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.modelAvailability.one?.status).toBe("available"));
  expect(save).toHaveBeenCalledOnce();
  expect(check).toHaveBeenCalledOnce();
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
  const timeout = document.querySelector<HTMLInputElement>('input[aria-label="timeoutSeconds"]')!;
  timeout.value = "360"; timeout.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await nextTick(); await nextTick();
  expect(store.models[0].timeoutSeconds).toBe(360);
});

it("official models have no parameter editor", async () => {
  const store = await mount();
  useAccountStore().apply({ user: { id: "one", email: "one@example.test" }, balance: { available: 100, reserved: 0, revision: 1, unit: "tokens" }, models: [{ id: "model", name: "Official display" }], endpoint: "https://official.example.test/v1" });
  // The public catalog may be empty while the authenticated account is available.
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ id: "model", name: "Official display" }] });
  const { useOfficialCatalogStore } = await import("@/features/account/officialCatalogStore");
  await useOfficialCatalogStore().refresh(); await nextTick();
  const card = document.querySelector<HTMLElement>(".official-model-open")!;
  expect(card).not.toBeNull();
  expect(card.tagName).toBe("DIV");
  card.click(); await nextTick();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(card.textContent).toContain("No setup needed");
  expect(store.models.find(m => m.source === "official")?.requestParameters).toBeUndefined();
});

it("automatically lists public official models first and overlays login without granting execution", async () => {
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ id: "trial", name: "Official trial" }] });
  const store = await mount();
  expect(fetchOfficialCatalog).toHaveBeenCalledOnce();
  expect(document.querySelector(".model-grid > :first-child")?.textContent).toContain("Official trial");
  expect(document.querySelector("button.official-model-open")).toBeNull();
  expect(document.querySelector(".official-model-lock")?.textContent).toContain("Sign in to use");
  expect(document.querySelector(".official-model-lock")?.getAttribute("href")).toBe("/account");
  expect(document.body.textContent).not.toContain("Refresh official models");
  expect(document.body.textContent).not.toContain("sign in / view credits");
  expect(store.models.map(m => m.id)).toEqual(["one"]);
  expect(store.modelApiKeys).not.toHaveProperty("official:trial");
});

it("saves a new connection without fabricating confirmed output capabilities or probing it", async () => {
  const store = await mount();
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  const check = vi.spyOn(backend, "checkModel");
  document.querySelector<HTMLButtonElement>(".page-header button")!.click(); await nextTick();
  expect(document.querySelector<HTMLDetailsElement>(".model-options")!.open).toBe(false);
  expect(document.querySelector<HTMLInputElement>('[aria-label="outputBudget"]')!.value).toBe("");
  const inputs = document.querySelectorAll<HTMLInputElement>(".basic-connection-fields input");
  expect(inputs).toHaveLength(3);
  for (const [index, value] of ["https://example.test/v1", "synthetic-key", "custom-model"].entries()) {
    inputs[index].value = value;
    inputs[index].dispatchEvent(new Event("input"));
  }
  await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.models).toHaveLength(2));
  expect(store.models[1]).toMatchObject({ name: "custom-model", model: "custom-model", timeoutSeconds: 90,
    capabilities: { parameterAdapter: "portable", structuredOutput: "unknown" },
    capabilitiesV2: { outputModes: { json_object: "unknown", json_schema: "unknown" } } });
  expect(check).not.toHaveBeenCalled();
});

it("preserves existing advanced overrides when saving only a basic field", async () => {
  const store = await mount();
  const capabilities = { protocol: "chat_completions" as const, version: "custom-v1", structuredOutput: "json_schema" as const,
    parameterAdapter: "portable" as const, tokenField: "max_completion_tokens" as const,
    defaultOutputTokens: 6000, maxOutputTokens: 20000 };
  store.models[0].capabilities = capabilities;
  store.models[0].requestParameters = { temperature: 0.3, max_completion_tokens: 7000 };
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const endpoint = document.querySelector<HTMLInputElement>('.basic-connection-fields input')!;
  endpoint.value = "https://other.example.test/v1"; endpoint.dispatchEvent(new Event("input")); await nextTick();
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.models[0].endpoint).toBe("https://other.example.test/v1"));
  expect(store.models[0]).toMatchObject({ name: "Example", timeoutSeconds: 180, capabilities,
    requestParameters: { temperature: 0.3, max_completion_tokens: 7000 } });
  expect(store.models[0].capabilitiesV2).toBeUndefined();
});

async function choose(label: string, value: string) {
  document.querySelector<HTMLElement>(`summary[aria-label="${label}"]`)!.click(); await nextTick();
  document.querySelector<HTMLButtonElement>(`.parameter-options [data-value="${value}"]`)!.click(); await nextTick();
}
const testButton = () => [...document.querySelectorAll<HTMLButtonElement>('.drawer-footer button')].find(button => button.textContent?.includes("Test this model"))!;
const previewButton = () => [...document.querySelectorAll<HTMLButtonElement>('.validation-controls button')].find(button => button.textContent?.includes("Validation request preview"))!;
const submit = () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

it("does not migrate legacy configuration or budgets merely by renaming a model", async () => {
  const store = await mount();
  store.models[0].requestParameters = { max_tokens: 7123 };
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  const check = vi.spyOn(backend, "checkModel");
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  const name = document.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
  name.value = "Renamed"; name.dispatchEvent(new Event("input")); await nextTick();
  submit(); await vi.waitFor(() => expect(store.models[0].name).toBe("Renamed"));
  expect(store.models[0].requestParameters).toEqual({ max_tokens: 7123 });
  expect(store.models[0].capabilities).toBeUndefined();
  expect(store.models[0].capabilitiesV2).toBeUndefined();
  expect(check).not.toHaveBeenCalled();
});

it("keeps Schema and strict declarations independent and saves without probing", async () => {
  const store = await mount();
  store.models[0].capabilitiesV2 = newModelCapabilities();
  store.models[0].capabilities = directCapabilities("openai");
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  const check = vi.spyOn(backend, "checkModel");
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  await choose("Structured output capability", "json_schema");
  expect(document.querySelector('summary[aria-label="Schema strict flag"]')?.textContent).toContain("Unknown");
  await choose("Schema strict flag", "unsupported");
  submit(); await vi.waitFor(() => expect(store.models[0].capabilitiesV2?.strictFlag).toBe("unsupported"));
  expect(store.models[0].capabilitiesV2?.outputModes.json_schema).toBe("supported");
  expect(store.models[0].capabilitiesV2?.evidence.source).toBe("user_declared");
  expect(check).not.toHaveBeenCalled();
});

it("allows an explicit connection probe for unknown capabilities without claiming structure validation", async () => {
  const store = await mount();
  store.models[0].capabilitiesV2 = newModelCapabilities();
  const check = vi.spyOn(backend, "checkModel").mockResolvedValue({ available: true, reason: "Access passed",
    validation: { modelAccess: "passed", structuredOutput: "not_tested", businessContract: "not_tested" } });
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  testButton().click(); await nextTick(); await nextTick();
  expect(check).not.toHaveBeenCalled();
  await choose("Validation scope", "parameters");
  testButton().click(); await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  expect(check).toHaveBeenCalledWith(expect.objectContaining({ capabilitiesV2: expect.objectContaining({ outputModes: { json_object: "unknown", json_schema: "unknown" } }) }), "parameters");
  await vi.waitFor(() => expect(document.querySelector('.validation-layers')?.textContent).toContain("Basic structure · Not tested"));
  expect(document.querySelector('.validation-layers')?.textContent).toContain("Business contract · Not tested");
});

it("clears a previous successful validation when a same-configuration retest fails", async () => {
  const store = await mount();
  const check = vi.spyOn(backend, "checkModel").mockResolvedValueOnce({ available: true, reason: "All layers passed",
    validation: { modelAccess: "passed", structuredOutput: "passed", businessContract: "passed" } }).mockRejectedValueOnce(new Error("probe rejected"));
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  testButton().click(); await vi.waitFor(() => expect(document.querySelector('.test-success')?.textContent).toContain("All layers passed"));
  testButton().click(); await vi.waitFor(() => expect(document.querySelector('.drawer-footer [role="alert"]')?.textContent).toContain("probe rejected"));
  expect(document.querySelector('.validation-layers')).toBeNull();
  expect(document.querySelector('.test-success')).toBeNull();
  submit(); await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(store.models[0].validationSnapshot).toBeUndefined();
  expect(check).toHaveBeenCalledTimes(2);
});

it("keeps offline preview separate from paid validation and invalidates it when scope changes", async () => {
  await mount();
  const preview = vi.spyOn(backend, "previewModelRequest").mockResolvedValue({ apiProtocol: "chat_completions", endpoint: "https://example.test/v1/chat/completions", model: "model", request: { model: "model" }, effectiveOutputMode: "json_object" });
  const check = vi.spyOn(backend, "checkModel");
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  previewButton().click(); await vi.waitFor(() => expect(document.querySelector('.request-preview')).not.toBeNull());
  expect(preview).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }), "structured");
  expect(check).not.toHaveBeenCalled();
  expect(document.querySelector('.validation-layers')).toBeNull();
  expect(document.querySelector('.request-preview')?.textContent).toContain("not a task prompt");
  await choose("Validation scope", "business");
  expect(document.querySelector('.request-preview summary')?.textContent).toContain("Expired");
  preview.mockRejectedValueOnce(new Error("compile rejected"));
  previewButton().click(); await vi.waitFor(() => expect(document.querySelector('.drawer-footer [role="alert"]')?.textContent).toContain("compile rejected"));
  expect(document.querySelector('.request-preview')).toBeNull();
});

it("marks previous validation stale after a request change and does not persist its old success", async () => {
  const store = await mount();
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(backend, "checkModel").mockResolvedValue({ available: true, reason: "Access passed", validation: { modelAccess: "passed", structuredOutput: "passed", businessContract: "not_tested" } });
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  testButton().click(); await vi.waitFor(() => expect(document.querySelector('.validation-layers')).not.toBeNull());
  const key = document.querySelector<HTMLInputElement>('[aria-label="API Key"]')!;
  key.value = "changed-key"; key.dispatchEvent(new Event("input")); await nextTick();
  expect(document.querySelector('.validation-layers')?.textContent).toContain("Validation expired");
  submit(); await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(store.models[0].validationSnapshot).toBeUndefined();
});

it.each(["endpoint", "model", "protocol"])("downgrades exact preset capability when its %s changes without rewriting the budget or parameters", async field => {
  const store = await mount();
  const save = vi.spyOn(store, "saveModelProfile").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".page-header button")!.click(); await nextTick();
  await choose("Exact connection preset", "openai:gpt-4.1-mini:chat_completions");
  expect(document.querySelector<HTMLInputElement>('.basic-connection-fields input')!.value).toBe("https://api.openai.com/v1");
  const budget = document.querySelector<HTMLInputElement>('[aria-label="outputBudget"]')!;
  budget.value = "8192"; budget.dispatchEvent(new Event("input")); await nextTick();
  if (field === "protocol") await choose("API protocol", "responses");
  else {
    const inputs = document.querySelectorAll<HTMLInputElement>('.basic-connection-fields input');
    const input = inputs[field === "endpoint" ? 0 : 2];
    input.value = field === "endpoint" ? "https://custom.example/v1" : "my-alias";
    input.dispatchEvent(new Event("input")); await nextTick();
  }
  expect(document.querySelector('.effective-output')?.textContent).toContain("Unconfirmed");
  submit(); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({ requestParameters: { outputBudget: 8192 }, capabilitiesV2: {
    outputModes: { json_schema: "unknown", json_object: "unknown" }, evidence: { source: "unknown" }, maxOutputTokens: 32768,
  } });
  expect(save.mock.calls[0][0].model).toBe(field === "model" ? "my-alias" : "gpt-4.1-mini");
});

it("marks an edited documented capability as a user declaration", async () => {
  const store = await mount();
  Object.assign(store.models[0], modelPresetConfiguration("openai:gpt-4.1-mini:chat_completions"));
  const save = vi.spyOn(store, "saveModelProfile").mockResolvedValue();
  document.querySelector<HTMLButtonElement>(".model-card")!.click(); await nextTick();
  await choose("Schema strict flag", "optional");
  submit(); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].capabilitiesV2?.evidence.source).toBe("user_declared");
});
