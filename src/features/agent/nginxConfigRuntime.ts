import type { ExecutionAttemptRecord, ExecutionOperationRecord } from "@/services/executionLedger";
import { normalizeNginxConfigRequest, type NginxConfigRequest, type NginxConfigResult } from "@/features/tools/nginxConfigContracts";
import { analyzeNginxConfigEvidence, type NginxConfigBinding } from "./nginxConfigEvidence";
import { executionIntentMatches } from "./planPreparation";

const overlaps = (a: string, b: string) => a === b || a === "/" || b === "/" || a.startsWith(b.replace(/\/$/, "") + "/") || b.startsWith(a.replace(/\/$/, "") + "/");
const latestAttempt = (operation: ExecutionOperationRecord) => operation.attempts[operation.attempts.length - 1];
export function precisePaths(operation: ExecutionOperationRecord): string[] {
  const values = operation.intent.semantic.targets.map(target => target.path);
  const paths = values.filter((value): value is string => typeof value === "string" && value.startsWith("/")
    && !value.includes("//") && !value.split("/").some(segment => segment === "." || segment === "..") && !/[\u0000-\u001f]/.test(value));
  return paths.length === values.length ? paths : [];
}

/** Consume only a reconciliation already admitted by the ledger's operation-
 * specific contract. A model's success statement or a local error timestamp is
 * not a substitute. Recheck the retained proof's identity and source receipts;
 * this does not create a new reconciliation or rewrite the unknown attempt. */
export function reconciledAt(operation: ExecutionOperationRecord, attempt: ExecutionAttemptRecord, records: ExecutionOperationRecord[]): number | undefined {
  const proof = operation.reconciliation;
  if (!proof || proof.version !== 1 || proof.status !== "completed" || proof.reason !== "current_state_verified"
    || proof.attemptId !== attempt.id || latestAttempt(operation)?.id !== attempt.id
    || !Number.isFinite(proof.resolvedAt) || proof.resolvedAt < attempt.startedAt
    || Number.isFinite(attempt.completedAt) && proof.resolvedAt < attempt.completedAt!
    || !executionIntentMatches(operation.intent, operation.intent) || operation.intentDigest !== operation.intent.digest
    || !["file_transfer", "service", "bounded_file_append"].includes(proof.kind)
    || proof.readOperationIds.length !== (proof.kind === "file_transfer" ? 2 : 1)
    || new Set(proof.readOperationIds).size !== proof.readOperationIds.length || proof.readOperationId !== proof.readOperationIds[0]
    || !proof.evidenceRefs.length || new Set(proof.evidenceRefs).size !== proof.evidenceRefs.length) return;
  const references: string[] = [];
  for (const [index, id] of proof.readOperationIds.entries()) {
    const matches = records.filter(record => record.operationId === id);
    if (matches.length !== 1) return;
    const read = matches[0]!, receipt = latestAttempt(read);
    const originalTarget = operation.intent.semantic.targets.find(target => target.role === (proof.kind === "file_transfer" ? index === 0 ? "source" : "target" : "execution"));
    if (!originalTarget || read.taskId !== operation.taskId || read.intent.semantic.taskId !== operation.taskId
      || read.effect !== "read" || read.intent.semantic.effect !== "read" || read.state !== "succeeded" || read.cancelRequested
      || !executionIntentMatches(read.intent, read.intent) || read.intentDigest !== read.intent.digest
      || read.intent.semantic.action.type !== "shell" || !read.intent.semantic.targets.some(target => target.serverId === originalTarget.serverId
        && target.host.toLowerCase() === originalTarget.host.toLowerCase() && target.port === originalTarget.port && target.username === originalTarget.username)
      || !receipt || receipt.operationId !== read.operationId || receipt.status !== "succeeded" || receipt.outcome?.status !== "succeeded"
      || receipt.late || receipt.cancelRequested || !Number.isFinite(receipt.startedAt) || receipt.startedAt < attempt.startedAt
      || !Number.isFinite(receipt.completedAt) || receipt.completedAt! < receipt.startedAt || receipt.completedAt! > proof.resolvedAt
      || !receipt.outcome.evidenceRefs.length) return;
    references.push(...receipt.outcome.evidenceRefs);
  }
  if (references.length !== proof.evidenceRefs.length || new Set(references).size !== references.length
    || references.some(reference => !proof.evidenceRefs.includes(reference))) return;
  return proof.resolvedAt;
}

function overlapsReadWindow(operation: ExecutionOperationRecord, attempt: ExecutionAttemptRecord, firstReadAt: number | undefined,
  records: ExecutionOperationRecord[]): boolean {
  if (attempt.status === "not_dispatched") return false;
  if (firstReadAt === undefined || attempt.status === "dispatching") return true;
  // completedAt on unknown records is when Core recorded uncertainty, not when
  // the remote mutation stopped. Only an existing verified reconciliation may
  // provide the lower bound for a subsequent independent configuration read.
  const settledAt = attempt.status === "unknown" ? reconciledAt(operation, attempt, records) : attempt.completedAt;
  return !Number.isFinite(settledAt) || settledAt! < attempt.startedAt || settledAt! >= firstReadAt;
}

/** This local derivation has no new remote observation. All source receipts and
 * the mutation barrier come from the controller's ledger, never model payloads. */
export function inspectNginxConfigurationFromLedger(
  args: NginxConfigRequest, binding: NginxConfigBinding, records: ExecutionOperationRecord[],
): NginxConfigResult {
  const request = normalizeNginxConfigRequest({ ...args });
  const problems: string[] = [];
  const receipts = request.sourceStepIds.flatMap(stepId => {
    const candidates = records.filter(record => record.taskId === binding.taskId && record.stepId === stepId
      && record.roundId === binding.roundId && record.workflowEpoch === binding.workflowEpoch && record.phase === "tool");
    if (candidates.length !== 1) { problems.push(candidates.length ? "ambiguous_source_step" : "missing_current_source_step"); return []; }
    const operation = candidates[0]!, attempt = latestAttempt(operation);
    if (!attempt) { problems.push("source_step_has_no_attempt"); return []; }
    return [{ operation, attemptId: attempt.id }];
  });
  const analysis = analyzeNginxConfigEvidence({ binding, entryPath: request.entryPath, prefix: request.prefix, target: request.target, receipts });
  const sourceEvidenceIds = [...new Set(receipts.flatMap(({ operation }) => latestAttempt(operation)!.outcome?.evidenceRefs ?? []))];
  if (sourceEvidenceIds.length > 256) problems.push("source_evidence_limit");
  const starts = receipts.map(({ operation }) => latestAttempt(operation)!.startedAt);
  const firstReadAt = starts.length && starts.every(Number.isFinite) ? Math.min(...starts) : undefined;
  const sourcePaths = [...new Set(receipts.flatMap(({ operation }) => precisePaths(operation)))];
  const sourceEndpoints = new Set(receipts.flatMap(({ operation }) => operation.intent.semantic.targets
    .filter(target => target.serverId === binding.serverId && target.connectionGeneration === binding.connectionGeneration)
    .map(target => JSON.stringify([target.host.toLowerCase(), target.port]))));
  for (const operation of records) {
    if (operation.effect !== "change" || !operation.intent.semantic.targets.some(target => target.serverId === binding.serverId
      || sourceEndpoints.has(JSON.stringify([target.host.toLowerCase(), target.port])))) continue;
    const changedPaths = precisePaths(operation);
    // No exact path means the effect may reach this configuration. An unrelated
    // precise file mutation does not invalidate a separately scoped site read.
    if (changedPaths.length && sourcePaths.length && !changedPaths.some(changed => sourcePaths.some(source => overlaps(source, changed)))) continue;
    if (operation.attempts.some(attempt => overlapsReadWindow(operation, attempt, firstReadAt, records))) {
      problems.push("configuration_sources_overlap_later_or_unresolved_change"); break;
    }
  }
  if (problems.length) {
    analysis.status = "unknown";
    analysis.reasons.unshift(...[...new Set(problems)].map(code => ({ code })));
    if (analysis.reasons.length > 129) analysis.reasons = [...analysis.reasons.slice(0, 128), { code: "more_reasons_omitted" }];
    delete analysis.selected; delete analysis.globalFingerprint; delete analysis.nonTargetFingerprint;
  }
  return { request, analysis, sourceEvidenceIds: analysis.status === "parsed" ? sourceEvidenceIds : [] };
}
