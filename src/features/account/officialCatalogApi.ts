import { invoke } from "@tauri-apps/api/core";
import { cloudRequest } from "./cloudClient";

export async function officialCatalogOrigin(): Promise<string> {
  if ("__TAURI_INTERNALS__" in window) {
    const config = await invoke<{ configured: boolean; origin?: string; message?: string }>("account_request", { operation: "config" });
    if (!config.configured || !config.origin) throw new Error(config.message || "官方平台尚未配置");
    return config.origin;
  }
  // Browser development uses a public-only same-origin proxy; credentials are never sent.
  if (import.meta.env.DEV) return window.location.origin;
  throw new Error("请在桌面客户端查看官方模型");
}

export async function fetchOfficialCatalog(): Promise<unknown> {
  if ("__TAURI_INTERNALS__" in window) return cloudRequest("official_models");
  if (!import.meta.env.DEV) throw new Error("请在桌面客户端查看官方模型");
  const response = await fetch("/api/core/v1/official-models", { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("官方模型目录暂时不可用");
  return response.json();
}
