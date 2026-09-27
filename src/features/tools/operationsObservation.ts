import type { PlanStep } from "@/types";
import type { OperationsInspectionResult } from "./operationsInspection";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";

const ids = new Set(["disk.inspect", "files.find_large", "services.inspect"]);
export function operationsObservation(step: PlanStep): OperationsInspectionResult | undefined {
  if (step.action?.type !== "tool" || !ids.has(step.action.toolId) || step.result?.executionStatus !== "success") return;
  try {
    const data = JSON.parse(step.output ?? "");
    if (!data || typeof data.request !== "object" || !data.request || !Array.isArray(data.items)
      || !Array.isArray(data.skipped)
      || data.items.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item))
      || data.skipped.some((item: { path?: unknown; reason?: unknown } | null) => !item || typeof item.path !== "string" || typeof item.reason !== "string")
      || typeof data.coverageComplete !== "boolean" || typeof data.status !== "string") return;
    // Read historical evidence with its original scope, without adding new catalog defaults.
    for (const key of ["path", "check", "service", "url"]) {
      if (data.request[key] !== step.action.arguments[key]) return;
    }
    return data;
  } catch { return; }
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

/** Used only for loop detection, never as freshness, acceptance or approval evidence. */
export function operationsProgressIdentity(step: PlanStep): string | undefined {
  const data = operationsObservation(step);
  if (!data) return;
  const { request } = data;
  const capacity = step.action?.type === "tool" && step.action.toolId === "disk.inspect" && request.check === "capacity";
  // Capacity polling can vary by a few blocks on every call. It is a baseline,
  // not new coverage of disk consumers. Preserve all exact values in evidence.
  const items = data.items.map(item => capacity ? {
    kind: item.kind, subject: item.subject, totalBytes: item.totalBytes, inodeTotal: item.inodeTotal,
  } : item).map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const skipped = data.skipped.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return textFingerprint(JSON.stringify(canonical({
    toolId: step.action?.type === "tool" ? step.action.toolId : undefined,
    scope: { path: request.path, check: request.check, service: request.service, url: request.url,
      sameFilesystem: request.sameFilesystem, excludePaths: request.excludePaths, minBytes: request.minBytes },
    status: data.status, coverageComplete: data.coverageComplete, truncated: data.truncated,
    items, skipped, skippedCount: data.skippedCount, matchedEntries: data.matchedEntries,
  })));
}
