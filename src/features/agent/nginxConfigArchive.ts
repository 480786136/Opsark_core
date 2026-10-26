import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { restoreArchivedExecutionResult, type ExecutionReceiptReader } from "@/services/executionReceiptArchive";
import type { NginxConfigRequest } from "@/features/tools/nginxConfigContracts";
import type { NginxConfigBinding } from "./nginxConfigEvidence";
import { canonicalExecutionJson } from "./planPreparation";

/** Rehydrate only selected current receipts. Re-list after paging to include
 * concurrent changes and to reject a source whose state changed while reading.
 * The persisted ledger is never mutated; restored content remains historical. */
export async function loadNginxConfigurationLedger(request: NginxConfigRequest, binding: NginxConfigBinding, deps: {
  list: () => Promise<ExecutionOperationRecord[]>; read: ExecutionReceiptReader; assertCurrent: () => void;
}): Promise<ExecutionOperationRecord[]> {
  deps.assertCurrent();
  const initial = await deps.list();
  deps.assertCurrent();
  const replacements = new Map<string, { original: string; restored: ExecutionOperationRecord }>();
  let bytes = 0;
  for (const stepId of request.sourceStepIds) {
    const candidates = initial.filter(record => record.taskId === binding.taskId && record.roundId === binding.roundId
      && record.workflowEpoch === binding.workflowEpoch && record.stepId === stepId && record.phase === "tool");
    // The evidence analyzer reports missing/ambiguous/unusable sources. Never
    // select one arbitrarily or expand the user's source set while restoring.
    if (candidates.length !== 1) continue;
    const original = candidates[0]!, attempt = original.attempts[original.attempts.length - 1];
    const action = original.intent.semantic.action;
    if (!attempt?.outcome || attempt.status !== "succeeded" || original.state !== "succeeded"
      || action.type !== "tool" || !["files.read_content", "files.inspect_manifest"].includes(action.toolId)) continue;
    const restored = await restoreArchivedExecutionResult(original, attempt.id, deps.read, deps.assertCurrent);
    bytes += new TextEncoder().encode(JSON.stringify(restored.attempts[restored.attempts.length - 1]!.outcome!.result)).length;
    // Parser has separate 2 MiB content / 8 MiB manifest limits. Bound the
    // combined decoded receipts, including wrappers and unused selected sources.
    // Restoration checks one receipt at a time (at most 2 MiB); the rejected
    // receipt may be decoded before this check. This is not an I/O byte budget.
    if (bytes > 12 * 1024 * 1024) throw new Error("CONFIGURATION_ARCHIVE_SIZE_LIMIT");
    replacements.set(original.operationId, { original: canonicalExecutionJson(original), restored });
  }
  deps.assertCurrent();
  const current = await deps.list();
  deps.assertCurrent();
  for (const [id, source] of replacements) {
    const matches = current.filter(record => record.operationId === id);
    if (matches.length !== 1 || canonicalExecutionJson(matches[0]) !== source.original) {
      throw new Error("CONFIGURATION_SOURCE_CHANGED_DURING_READ");
    }
  }
  return current.map(record => replacements.get(record.operationId)?.restored ?? record);
}
