import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/services/backend";
import type { KnowledgeConfig } from "./types";

export function normalizeEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("知识接口地址无效"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "") !== "/api/v1") {
    throw new Error("请填写 HTTPS /api/v1 地址；仅本机调试支持 HTTP，不支持查询参数或内嵌凭据");
  }
  return url.href.replace(/\/+$/, "");
}
export interface KnowledgeResponse { status: number; data: unknown; retryAfterSeconds?: number }
export class KnowledgeError extends Error {
  constructor(message: string, public retryAfterSeconds = 0) { super(message); }
}
export async function knowledgeRequest(config: KnowledgeConfig, operation: "bases" | "upload" | "status", extra: { body?: string; idempotencyKey?: string; recordId?: string } = {}): Promise<unknown> {
  if (!isTauri()) throw new Error("知识连接需要桌面版；浏览器预览不会保存 API Key 或发送资料");
  const response = await invoke<KnowledgeResponse>("knowledge_request", {
    endpoint: normalizeEndpoint(config.endpoint), credentialId: config.credentialId, operation, ...extra,
  });
  if (response.status < 200 || response.status >= 300) {
    const hints: Record<number, string> = {401:"知识 Key 无效或已过期",403:"知识 Key 没有操作或目标库权限",409:"上传幂等或来源修订冲突，请检查历史记录",410:"来源记录已删除或下架",413:"上传正文过大",422:"记录格式不符或仍含敏感内容",429:"请求过于频繁，请稍后重试"};
    throw new KnowledgeError(hints[response.status] ?? `知识服务返回 HTTP ${response.status}`, response.retryAfterSeconds ?? 0);
  }
  return response.data;
}
