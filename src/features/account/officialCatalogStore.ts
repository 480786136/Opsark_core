import { defineStore } from "pinia";
import { fetchOfficialCatalog, officialCatalogOrigin } from "./officialCatalogApi";

export interface OfficialModelListing { id: string; name: string }
export const officialCatalogCacheKey = (origin: string) => `opsark.officialModelCatalog.v1:${origin}`;

function project(value: unknown): OfficialModelListing[] {
  const items = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(items) || items.length > 100) throw new Error("官方模型目录格式无效");
  const ids = new Set<string>();
  return items.map(item => {
    if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 128 || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim() || item.name.length > 128) throw new Error("官方模型目录格式无效");
    ids.add(item.id);
    return { id: item.id, name: item.name }; // Never cache provider configuration or credentials.
  });
}

/** Display-only catalogue. Never adds entries to executable models or restores account authority. */
export const useOfficialCatalogStore = defineStore("officialModelCatalog", {
  state: () => ({ models: [] as OfficialModelListing[], origin: "", fetchedAt: 0, loaded: false, loading: false, error: "" }),
  actions: {
    async refresh() {
      if (this.loading) return;
      this.loading = true; this.error = "";
      try {
        const origin = await officialCatalogOrigin();
        if (origin !== this.origin) {
          this.origin = origin; this.models = []; this.fetchedAt = 0; this.loaded = false;
          try {
            const saved = JSON.parse(localStorage.getItem(officialCatalogCacheKey(origin)) || "null");
            if (saved?.schema === 1 && Number.isFinite(saved.fetchedAt) && saved.fetchedAt > 0 && saved.fetchedAt <= Date.now()) {
              this.models = project(saved); this.fetchedAt = saved.fetchedAt; this.loaded = true;
            }
          } catch { /* Invalid cache never prevents the authoritative fetch. */ }
        }
        const models = project(await fetchOfficialCatalog());
        this.models = models; this.fetchedAt = Date.now(); this.loaded = true;
        try { localStorage.setItem(officialCatalogCacheKey(origin), JSON.stringify({ schema: 1, models, fetchedAt: this.fetchedAt })); }
        catch { /* A storage failure still permits fresh results to be displayed. */ }
      } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      finally { this.loading = false; }
    },
  },
});
