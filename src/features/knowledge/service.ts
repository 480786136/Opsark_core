import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/services/backend";
import { i18n } from "@/features/preferences/i18n";
import type { KnowledgeConfig } from "./types";

const tr = (key: string, params?: Record<string, unknown>) => String(i18n.global.t(key, params ?? {}));

export function normalizeEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(tr("knowledge.invalidEndpoint")); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "") !== "/api/v1") {
    throw new Error(tr("knowledge.endpointRequirements"));
  }
  return url.href.replace(/\/+$/, "");
}
export interface KnowledgeResponse { status: number; data: unknown; retryAfterSeconds?: number }
export class KnowledgeError extends Error {
  constructor(message: string, public retryAfterSeconds = 0) { super(message); }
}
export async function knowledgeRequest(config: KnowledgeConfig, operation: "bases" | "upload" | "status", extra: { body?: string; idempotencyKey?: string; recordId?: string } = {}): Promise<unknown> {
  if (!isTauri()) throw new Error(tr("knowledge.desktopConnectionRequired"));
  const response = await invoke<KnowledgeResponse>("knowledge_request", {
    endpoint: normalizeEndpoint(config.endpoint), credentialId: config.credentialId, operation, ...extra,
  });
  if (response.status < 200 || response.status >= 300) {
    const hints: Record<number, string> = {401:"knowledge.invalidKey",403:"knowledge.forbidden",409:"knowledge.conflict",410:"knowledge.gone",413:"knowledge.payloadTooLarge",422:"knowledge.invalidRecord",429:"knowledge.rateLimited"};
    throw new KnowledgeError(hints[response.status] ? tr(hints[response.status]) : tr("knowledge.httpError", { status: response.status }), response.retryAfterSeconds ?? 0);
  }
  return response.data;
}
