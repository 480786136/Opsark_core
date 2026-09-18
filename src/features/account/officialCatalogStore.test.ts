import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { fetchOfficialCatalog, officialCatalogOrigin } from "./officialCatalogApi";
import { officialCatalogCacheKey, useOfficialCatalogStore } from "./officialCatalogStore";
vi.mock("./officialCatalogApi", () => ({ fetchOfficialCatalog: vi.fn(), officialCatalogOrigin: vi.fn() }));
const origin = "https://platform.example.test", models = [{ id: "trial", name: "Official trial" }];
beforeEach(() => {
  localStorage.clear(); setActivePinia(createPinia()); vi.restoreAllMocks();
  vi.mocked(officialCatalogOrigin).mockReset().mockResolvedValue(origin);
  vi.mocked(fetchOfficialCatalog).mockReset().mockResolvedValue({ models });
});
function cache(items = models) {
  localStorage.setItem(officialCatalogCacheKey(origin), JSON.stringify({ schema: 1, models: items, fetchedAt: Date.now() - 10000 }));
}
it("fetches on every page entry and caches only public identity/name fields", async () => {
  const store = useOfficialCatalogStore();
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ ...models[0], provider: "private", api_key: "private", endpoint: "private" }] });
  await store.refresh(); await store.refresh();
  expect(fetchOfficialCatalog).toHaveBeenCalledTimes(2); expect(store.models).toEqual(models);
  const saved = localStorage.getItem(officialCatalogCacheKey(origin))!;
  expect(saved).not.toContain("private"); expect(store.fetchedAt).toBeGreaterThan(0);
});
it("shows cached models while revalidating and preserves them if offline", async () => {
  cache(); const store = useOfficialCatalogStore();
  let reject!: (reason: string) => void;
  vi.mocked(fetchOfficialCatalog).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const refreshing = store.refresh(); await Promise.resolve();
  expect(store.models).toEqual(models); expect(store.loading).toBe(true);
  reject("offline"); await refreshing;
  expect(store.error).toBe("offline"); expect(store.models).toEqual(models); expect(store.loading).toBe(false);
});
it("a successful empty catalogue removes old cache entries instead of resurrecting withdrawn models", async () => {
  cache(); vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [] });
  const store = useOfficialCatalogStore(); await store.refresh();
  expect(store.models).toEqual([]); expect(store.loaded).toBe(true);
  expect(JSON.parse(localStorage.getItem(officialCatalogCacheKey(origin))!).models).toEqual([]);
});
it("isolates cache by platform origin and ignores malformed cached data", async () => {
  cache(); const store = useOfficialCatalogStore(); await store.refresh();
  vi.mocked(officialCatalogOrigin).mockResolvedValue("https://other.example.test");
  vi.mocked(fetchOfficialCatalog).mockRejectedValue("offline"); await store.refresh();
  expect(store.models).toEqual([]); expect(store.loaded).toBe(false);
  localStorage.setItem(officialCatalogCacheKey(origin), "{broken");
  vi.mocked(officialCatalogOrigin).mockResolvedValue(origin); vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models });
  await store.refresh(); expect(store.models).toEqual(models);
});
it("deduplicates concurrent fetches and does not replace good data with invalid responses", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(fetchOfficialCatalog).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const store = useOfficialCatalogStore(); const first = store.refresh();
  await store.refresh(); await Promise.resolve();
  expect(fetchOfficialCatalog).toHaveBeenCalledOnce(); finish({ models }); await first;
  vi.mocked(fetchOfficialCatalog).mockResolvedValue({ models: [{ id: "bad" }] }); await store.refresh();
  expect(store.models).toEqual(models); expect(store.error).not.toBe("");
});
