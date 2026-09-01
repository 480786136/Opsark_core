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
  return entries.slice(0, 8).map((entry) => ({
    ...entry,
    request: truncate(entry.request, 40_000),
    response: truncate(entry.response, 40_000),
    trace: truncate(entry.trace, 80_000),
    stack: truncate(entry.stack, 20_000),
  }));
}
