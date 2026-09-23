import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/services/backend";
import { i18n } from "@/features/preferences/i18n";
import type { KnowledgeConfig, KnowledgeDocumentVersion, KnowledgeHit, KnowledgeSearchResult } from "./types";

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
export async function knowledgeRequest(config: KnowledgeConfig, operation: "bases" | "upload" | "status" | "search" | "citation", extra: { body?: string; idempotencyKey?: string; recordId?: string; documentId?: string; version?: number } = {}): Promise<unknown> {
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

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, limit: number): value is string => typeof value === "string" && Array.from(value).length <= limit;

export function parseKnowledgeSearch(data: unknown, baseId: string): KnowledgeSearchResult {
  const invalid = () => new Error(tr("knowledge.invalidSearchResponse"));
  if (!object(data) || !["keyword_only", "hybrid"].includes(String(data.retrieval_mode))
    || !shortText(data.index_version, 200) || typeof data.truncated !== "boolean"
    || !Array.isArray(data.hits) || data.hits.length > 5
    || !Array.isArray(data.warnings) || data.warnings.length > 10
    || !data.warnings.every(value => shortText(value, 500))) throw invalid();
  let chars = 0;
  const chunks = new Set<string>();
  const hits = data.hits.map((value, index): KnowledgeHit => {
    if (!object(value) || !identifier(value.chunk_id) || chunks.has(value.chunk_id)
      || !identifier(value.document_id) || !positiveInteger(value.document_version)
      || value.knowledge_base_id !== baseId || !shortText(value.title, 200)
      || !shortText(value.content, 6000) || !object(value.citation)) throw invalid();
    const citation = value.citation;
    if (!positiveInteger(citation.line_start) || !positiveInteger(citation.line_end)
      || citation.line_end < citation.line_start || !Array.isArray(citation.source_record_ids)
      || citation.source_record_ids.length > 30 || !citation.source_record_ids.every(identifier)) throw invalid();
    chars += Array.from(value.content).length;
    if (chars > 6000) throw invalid();
    chunks.add(value.chunk_id);
    return {
      chunk_id: value.chunk_id, document_id: value.document_id, document_version: value.document_version,
      knowledge_base_id: baseId, title: value.title, content: value.content, rank: index + 1,
      // Returned URLs and labels are data, never navigation targets or authority.
      citation: { label: `K${index + 1}`, line_start: citation.line_start, line_end: citation.line_end,
        source_record_ids: [...citation.source_record_ids],
        document_url: `/api/v1/knowledge/documents/${value.document_id}/versions/${value.document_version}` },
    };
  });
  return { retrieval_mode: data.retrieval_mode as KnowledgeSearchResult["retrieval_mode"], index_version: data.index_version,
    hits, truncated: data.truncated, warnings: data.warnings as string[] };
}

export async function searchKnowledge(config: KnowledgeConfig, query: string): Promise<KnowledgeSearchResult> {
  if (!config.searchEnabled || !config.hasApiKey || !identifier(config.knowledgeBaseId)) throw new Error(tr("knowledge.enableNeedsConfiguration"));
  const trimmed = query.trim();
  if (!trimmed || Array.from(trimmed).length > 2000) throw new Error(tr("knowledge.invalidSearchQuery"));
  const data = await knowledgeRequest(config, "search", { body: JSON.stringify({
    query: trimmed, knowledge_base_ids: [config.knowledgeBaseId], top_k: 5, max_content_chars: 6000,
  }) });
  return parseKnowledgeSearch(data, config.knowledgeBaseId);
}

export async function readKnowledgeCitation(config: KnowledgeConfig, hit: KnowledgeHit): Promise<KnowledgeDocumentVersion> {
  if (!config.searchEnabled || !config.hasApiKey || hit.knowledge_base_id !== config.knowledgeBaseId
    || !identifier(hit.document_id) || !positiveInteger(hit.document_version)) throw new Error(tr("knowledge.destinationChanged"));
  const data = await knowledgeRequest(config, "citation", { documentId: hit.document_id, version: hit.document_version });
  if (!object(data) || data.document_id !== hit.document_id || data.version !== hit.document_version
    || !shortText(data.title, 200) || !shortText(data.content, 500000)) throw new Error(tr("knowledge.invalidSearchResponse"));
  return { document_id: data.document_id, version: data.version, title: data.title, content: data.content };
}
