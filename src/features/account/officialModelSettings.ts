import type { ModelProfile } from "@/types";
import { validateRequestParameters } from "@/features/agent/modelParameters";
type Preferences = Pick<ModelProfile, "timeoutSeconds" | "requestParameters">;
const storageKey = "opsark.officialModelSettings";
export function officialPreferences(id: string): Partial<Preferences> {
  try {
    const item = JSON.parse(localStorage.getItem(storageKey) || "{}")[id];
    if (!item || !Number.isInteger(item.timeoutSeconds) || item.timeoutSeconds < 10 || item.timeoutSeconds > 900) return {};
    validateRequestParameters(item.requestParameters);
    return { timeoutSeconds: item.timeoutSeconds, requestParameters: item.requestParameters };
  } catch { return {}; }
}
export function saveOfficialPreferences(model: ModelProfile) {
  validateRequestParameters(model.requestParameters);
  if (typeof model.timeoutSeconds !== "number" || !Number.isInteger(model.timeoutSeconds)
    || model.timeoutSeconds < 10 || model.timeoutSeconds > 900) throw new Error("请求超时不正确");
  let saved: Record<string, Preferences> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) saved = raw;
  } catch { /* recover metadata */ }
  saved[model.id] = { timeoutSeconds: model.timeoutSeconds, requestParameters: model.requestParameters };
  localStorage.setItem(storageKey, JSON.stringify(saved));
}
