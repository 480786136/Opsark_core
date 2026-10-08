import type { ExecutionEvidence, OpsTask, PlanStep } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { buildExecutionScopeEvidence } from "./executionScope";
import { executionDigest, executionIntentMatches } from "./planPreparation";
import { executionReceiptSteps } from "./executionLedgerRecovery";

/** Resolve the original dispatch identity without consulting the current target. */
export function commandExecutionScope(step: PlanStep, taskId: string) {
  const intent = step.executionIntent;
  if (!intent || !executionIntentMatches(intent, intent) || intent.semantic.taskId !== taskId
    || intent.semantic.stepId !== step.id || intent.semantic.action.type !== "shell"
    || step.action?.type === "tool"
    || intent.semantic.action.command !== step.command
    || (step.action && executionDigest(step.action) !== executionDigest(intent.semantic.action))) return undefined;
  let context: unknown;
  try { context = JSON.parse(step.attemptContext ?? "null"); } catch { return undefined; }
  if (!Array.isArray(context) || context.length !== 5 || typeof context[0] !== "string" || !context[0]) return undefined;
  const targets = intent.semantic.targets;
  if (targets.length !== 1 || targets[0].role !== "execution" || targets[0].serverId !== context[0]) return undefined;
  const target = targets[0], scope = intent.semantic.executionScope ?? "isolated_exec";
  const session = target.agentSession;
  if (scope === "agent_session" && (!session || session.id !== context[2] || session.generation !== context[3])) return undefined;
  return buildExecutionScopeEvidence({ targetId: context[0], scope,
    ...(session ? { sessionId: session.id, generation: session.generation, shell: session.shell, cwd: session.cwd } : {}) });
}

function matchesFailureReceipt(step: PlanStep, evidence: ExecutionEvidence, operation: ExecutionOperationRecord) {
  const reference = [...(step.executionLedgerAttempts ?? [])].reverse().find(ref => ref.phase === "command");
  const attempt = operation.attempts.find(item => item.id === reference?.attemptId);
  const result = attempt?.outcome?.result as { success?: boolean; exitCode?: number; output?: string } | undefined;
  return reference && operation.phase === "command" && operation.stepId === step.id
    && operation.operationId === reference.operationId && operation.intentDigest === step.executionIntent?.digest
    && executionIntentMatches(operation.intent, step.executionIntent!)
    && attempt?.executionId === reference.executionId && attempt.operationId === reference.operationId
    && attempt.status === "failed" && attempt.outcome?.status === "failed" && !attempt.late
    && attempt.outcome.evidenceRefs.length > 0 && step.ledgerAppliedAttemptIds?.includes(attempt.id)
    && Number.isFinite(attempt.projectionAppliedAt) && attempt.projectionAppliedAt! >= attempt.completedAt!
    && Number.isFinite(Date.parse(step.startedAt ?? "")) && attempt.startedAt >= Date.parse(step.startedAt!)
    && attempt.completedAt !== undefined && Date.parse(evidence.collectedAt) >= attempt.completedAt
    && result?.success === false && result.exitCode === step.result?.exitCode && result.output === evidence.rawOutput;
}

/** Restore target identity only after the persisted ledger and exact failed output
 * agree. This does not mark execution successful, verified, or safe to retry. */
export function restoreCommandEvidenceScopes(task: OpsTask, operations: readonly ExecutionOperationRecord[]): number {
  let restored = 0;
  for (const step of executionReceiptSteps(task)) {
    if (step.result?.executionStatus !== "failed" || step.result.facts.commandDispatched === false) continue;
    const scope = commandExecutionScope(step, task.id);
    if (!scope) continue;
    for (const evidence of step.evidence ?? []) {
      if (evidence.scope || evidence.source !== "main" || !step.result.evidenceIds.includes(evidence.id)
        || !Number.isFinite(Date.parse(evidence.collectedAt))) continue;
      if (!operations.some(operation => operation.taskId === task.id && matchesFailureReceipt(step, evidence, operation))) continue;
      evidence.scope = structuredClone(scope);
      restored += 1;
    }
  }
  return restored;
}
