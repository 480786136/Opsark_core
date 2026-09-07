import { redactExecutionOutput } from "@/features/agent/secretTool";
import type { DeveloperLogEntry } from "@/types";

export const MAX_DEVELOPER_LOGS = 100;

export type DeveloperLogDraft = Omit<DeveloperLogEntry,
  "id" | "createdAt" | "request" | "response" | "trace" | "error" | "stack"
> & {
  request?: unknown;
  response?: unknown;
  trace?: unknown;
  error?: unknown;
  stack?: unknown;
};

function serialize(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function estimatedTokens(value: unknown) {
  const text = serialize(value) ?? "";
  // CJK text is usually close to one token per character; latin/json text is
  // commonly around four characters per token. This is deliberately labelled
  // as an estimate in the UI rather than presented as billing data.
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  return Math.max(0, Math.ceil(cjk + (text.length - cjk) / 4));
}

function apiTokenUsage(value: unknown) {
  let input = 0;
  let output = 0;
  let found = false;
  const visit = (current: unknown) => {
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    const usage = record.usage;
    if (usage && typeof usage === "object") {
      const item = usage as Record<string, unknown>;
      const prompt = Number(item.prompt_tokens ?? item.input_tokens ?? item.promptTokenCount);
      const completion = Number(item.completion_tokens ?? item.output_tokens ?? item.candidatesTokenCount);
      if (Number.isFinite(prompt) || Number.isFinite(completion)) {
        input += Number.isFinite(prompt) ? prompt : 0;
        output += Number.isFinite(completion) ? completion : 0;
        found = true;
      }
    }
    Object.entries(record).forEach(([key, child]) => {
      if (key !== "usage") visit(child);
    });
  };
  visit(value);
  return found ? { input, output, total: input + output, source: "api" as const } : undefined;
}

function redactDeveloperText(value: string, secretValues: Record<string, string>) {
  const exactRedacted = Object.values(secretValues).reduce(
    (current, secret) => secret ? current.split(secret).join("••••••••") : current,
    value,
  );
  if (!/(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)/iu.test(exactRedacted)) {
    return exactRedacted;
  }
  return redactExecutionOutput(exactRedacted, {});
}

export function safeDeveloperEndpoint(endpoint?: string) {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return endpoint.replace(/\/\/[^/@\s]+@/u, "//••••••••@").replace(/[?#].*$/u, "");
  }
}

export function createDeveloperLog(
  draft: DeveloperLogDraft,
  id: string,
  createdAt: string,
  secretValues: Record<string, string>,
): DeveloperLogEntry {
  const redact = (value: unknown) => {
    const serialized = serialize(value);
    return serialized === undefined ? undefined : redactDeveloperText(serialized, secretValues);
  };
  const exactUsage = apiTokenUsage(draft.trace) ?? apiTokenUsage(draft.response);
  const tokenUsage = exactUsage ?? {
    input: estimatedTokens(draft.request),
    output: estimatedTokens(draft.response ?? draft.trace ?? draft.error),
    total: 0,
    source: "estimated" as const,
  };
  tokenUsage.total = tokenUsage.input + tokenUsage.output;
  return {
    ...draft,
    id,
    createdAt,
    endpoint: safeDeveloperEndpoint(draft.endpoint),
    title: draft.title.trim() || "未命名开发者事件",
    summary: redactDeveloperText(draft.summary.trim(), secretValues),
    request: redact(draft.request),
    response: redact(draft.response),
    trace: redact(draft.trace),
    error: redact(draft.error),
    stack: redact(draft.stack),
    tokenUsage,
  };
}

export function prependDeveloperLog(entries: DeveloperLogEntry[], entry: DeveloperLogEntry) {
  return [entry, ...entries].slice(0, MAX_DEVELOPER_LOGS);
}

function truncate(value: string | undefined, maxChars: number) {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[持久化空间不足，已截断 ${value.length - maxChars} 个字符]`;
}

export function compactDeveloperLogs(entries: DeveloperLogEntry[]) {
  return entries.slice(0, 30).map((entry) => ({
    ...entry,
    request: truncate(entry.request, 40_000),
    response: truncate(entry.response, 40_000),
    trace: truncate(entry.trace, 80_000),
    stack: truncate(entry.stack, 20_000),
  }));
}
