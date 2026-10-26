import type { PlanStep } from "@/types";
import type { OperationsInspectionResult } from "./operationsInspection";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { operationsInputSchemas } from "./operationsContracts";
import { enforceToolResult } from "./toolResultContract";

const ids = new Set(Object.keys(operationsInputSchemas));
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
    if (step.action.toolId === "files.inspect") {
      const args = step.action.arguments;
      if (["hash", "maxHashBytes"].some(key => data.request[key] !== args[key])) return;
    }
    if (step.action.toolId === "packages.inspect" && JSON.stringify(data.request.packages) !== JSON.stringify(step.action.arguments.packages)) return;
    return data;
  } catch { return; }
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

/** Used only for loop detection, never as freshness, acceptance or approval evidence. */
export function operationsProgressIdentity(step: PlanStep): string | undefined {
  if (step.action?.type === "tool" && ["files.inspect_manifest", "http.inspect_delivery"].includes(step.action.toolId)
    && step.result?.executionStatus === "success") {
    try {
      const data = JSON.parse(step.output ?? "");
      const call = { id: step.action.toolId === "http.inspect_delivery" ? data.binding.executionId : "manifest-progress",
        toolId: step.action.toolId, arguments: step.action.arguments };
      if (!enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data }).success) return;
      // A fresh probe ID, response Date, or newly appended diagnostic line is
      // not deployment progress. Keep exact values in the original receipt.
      const observations = call.toolId === "http.inspect_delivery" ? {
        request: data.request, status: data.status, coverageComplete: data.coverageComplete,
        target: { hostname: data.target.hostname, authority: data.target.authority, connectAddress: data.target.connectAddress,
          peerAddress: data.target.peerAddress, peerPort: data.target.peerPort, tlsVerified: data.target.tlsVerified },
        response: data.response ? { ...data.response, headers: Object.fromEntries(Object.entries(data.response.headers)
          .filter(([name]) => name.toLowerCase() !== "date")) } : null,
        correlation: data.correlation ? { status: data.correlation.status, coverageComplete: data.correlation.coverageComplete,
          reason: data.correlation.reason, sourceVerified: false } : null,
        observationsRedacted: data.observationsRedacted === true,
      } : { ...Object.fromEntries(Object.entries(data).filter(([key]) => !["sampledAt", "finishedAt", "elapsedMs"].includes(key))),
        entries: [...data.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        issues: [...data.issues].sort((a, b) => JSON.stringify([a.path, a.reason]).localeCompare(JSON.stringify([b.path, b.reason]))),
      };
      return textFingerprint(JSON.stringify(canonical({ toolId: call.toolId, observations })));
    } catch { return; }
  }
  if (step.action?.type === "tool" && ["logs.inspect_rotation", "database.inspect_postgres"].includes(step.action.toolId) && step.result?.executionStatus === "success") {
    try {
      const call = { id: "progress", toolId: step.action.toolId, arguments: step.action.arguments };
      const result = enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data: JSON.parse(step.output ?? "") });
      if (!result.success) return;
      const content = (value: unknown): unknown => Array.isArray(value) ? value.map(content)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
          .filter(([key]) => !["sampledAt", "finishedAt", "elapsedMs", "observedAt", "snapshot"].includes(key)).map(([key, item]) => [key, content(item)])) : value;
      return textFingerprint(JSON.stringify(canonical({ toolId: call.toolId, data: content(result.data) })));
    } catch { return; }
  }
  const data = operationsObservation(step);
  if (!data) return;
  const { request } = data;
  const capacity = step.action?.type === "tool" && step.action.toolId === "disk.inspect" && request.check === "capacity";
  // Capacity polling can vary by a few blocks on every call. It is a baseline,
  // not new coverage of disk consumers. Preserve all exact values in evidence.
  const items = data.items.map(item => capacity ? {
    kind: item.kind, subject: item.subject, totalBytes: item.totalBytes, inodeTotal: item.inodeTotal,
  } : item.kind === "package_environment" ? Object.fromEntries(Object.entries(item).filter(([key]) => !["observedAt", "waitedMs", "sampleCount", "waitOutcome"].includes(key)))
    : item.kind === "file_metadata" ? Object.fromEntries(Object.entries(item).filter(([key]) => !["sampleStartedAt", "sampleFinishedAt"].includes(key)))
    : item.kind === "service" && item.processIdentity && typeof item.processIdentity === "object" ? { ...item,
      processIdentity: Object.fromEntries(Object.entries(item.processIdentity).filter(([key]) => !["sampleStartedAt", "sampleFinishedAt"].includes(key))) }
    : item).map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const skipped = data.skipped.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return textFingerprint(JSON.stringify(canonical({
    toolId: step.action?.type === "tool" ? step.action.toolId : undefined,
    scope: { path: request.path, check: request.check, service: request.service, url: request.url,
      sameFilesystem: request.sameFilesystem, excludePaths: request.excludePaths, minBytes: request.minBytes },
    hash: request.hash, maxHashBytes: request.maxHashBytes,
    packages: request.packages,
    status: data.status, coverageComplete: data.coverageComplete, truncated: data.truncated,
    items, skipped, skippedCount: data.skippedCount, matchedEntries: data.matchedEntries,
  })));
}
