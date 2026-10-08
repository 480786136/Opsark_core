import type { ExecutionEvidence, PlanStep } from "@/types";
import { buildExecutionScopeEvidence } from "./executionScope";
import { executionDigest, executionIntentMatches } from "./planPreparation";
import { operationsInputSchemas } from "@/features/tools/operationsContracts";

export function isRemoteToolObservation(toolId: string) {
  return ["files.get_structure", "files.read_content", "software.check"].includes(toolId)
    || Object.prototype.hasOwnProperty.call(operationsInputSchemas, toolId);
}

/** Use the dispatch identity, never the task's possibly changed current server. */
export function toolExecutionScope(step: PlanStep, toolId: string, taskId?: string) {
  // Local context/archive reads do not make a fresh observation of this server.
  if (!isRemoteToolObservation(toolId)) return undefined;
  const intent = step.executionIntent;
  if (!intent || !executionIntentMatches(intent, intent) || intent.semantic.stepId !== step.id
    || (taskId !== undefined && intent.semantic.taskId !== taskId) || intent.semantic.effect !== "read"
    || step.action?.type !== "tool" || intent.semantic.action.type !== "tool" || intent.semantic.action.toolId !== toolId
    || executionDigest(step.action) !== executionDigest(intent.semantic.action)) return undefined;
  let context: unknown;
  try { context = JSON.parse(step.attemptContext ?? "null"); } catch { return undefined; }
  if (!Array.isArray(context) || context.length !== 5 || typeof context[0] !== "string" || !context[0]) return undefined;
  const targets = intent.semantic.targets;
  // Interaction and cross-server receipts need their own target-specific contract.
  if (!targets.length || targets.some(target => target.role === "interaction" || target.serverId !== context[0])) return undefined;
  return buildExecutionScopeEvidence({ targetId: context[0], scope: "isolated_exec" });
}

/** Compatibility for receipts saved before tool scopes were persisted. Only a
 * verified, applied durable tool attempt can recover its original identity. */
export function scopedToolEvidence(taskId: string, step: PlanStep, evidence: ExecutionEvidence): ExecutionEvidence {
  if (evidence.scope || evidence.source !== "main" || step.action?.type !== "tool"
    || step.result?.executionStatus !== "success" || step.result.facts.toolId !== step.action.toolId
    || evidence.facts.toolId !== step.action.toolId || !step.result.evidenceIds.includes(evidence.id)
    || !Number.isFinite(Date.parse(step.startedAt ?? ""))
    || !(Date.parse(evidence.collectedAt) >= Date.parse(step.startedAt!))) return evidence;
  const attempt = [...(step.executionLedgerAttempts ?? [])].reverse().find(item => item.phase === "tool");
  if (!attempt?.operationId || !attempt.executionId || !step.ledgerAppliedAttemptIds?.includes(attempt.attemptId)
    || !step.ledgerVerifiedAttemptIds?.includes(attempt.attemptId)) return evidence;
  const scope = toolExecutionScope(step, step.action.toolId, taskId);
  return scope ? { ...evidence, scope } : evidence;
}
