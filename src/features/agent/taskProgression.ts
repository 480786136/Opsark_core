import {
  isReadOnlyDiagnosticStep,
} from "@/features/agent/evidenceReview";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolDefinition } from "@/features/tools/types";
import type { OpsTask, PlanStep } from "@/types";
import { taskGoal } from "@/features/agent/taskGoal";
import { mayHaveChangedState } from "@/features/agent/attemptState";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { isNecessaryRecoveryVerification, unresolvedRecoveryBlockers } from "./recoveryContract";

export type TaskProgression =
  | { kind: "wait"; step: PlanStep }
  | { kind: "execute-step"; step: PlanStep }
  | { kind: "recovery-required"; step: PlanStep }
  | { kind: "refine-discovery"; afterUserInput?: true }
  | { kind: "complete" };

/** Returns the stable overall goal; follow-up instructions must not silently replace it. */
export function latestTaskRequirement(task: OpsTask) {
  return taskGoal(task);
}

/**
 * Determines the next orchestration branch without mutating task state. Tool metadata
 * and the active Skill decide whether another bounded evidence-driven stage is needed.
 */
export function resolveTaskProgression(
  task: OpsTask,
  tools: ToolDefinition[] = defaultToolCatalog,
): TaskProgression {
  // A pending step is not runnable while another step owns execution or awaits
  // a user decision. Check the entire plan before choosing a pending step so a
  // restored/out-of-order plan cannot start a second execution either. Failed
  // and skipped steps remain terminal: the existing goal review owns their
  // evidence and decides whether a later adjustment is needed.
  const waitingStep = task.plan.find((step) =>
    !["pending", "completed", "failed", "skipped"].includes(step.status),
  );
  if (waitingStep) return { kind: "wait", step: waitingStep };

  const pendingStep = task.plan.find((step) => step.status === "pending");
  if (pendingStep) return { kind: "execute-step", step: pendingStep };
  const blockers = unresolvedRecoveryBlockers(task);
  const blocker = blockers[blockers.length - 1];
  if (blocker) return { kind: "recovery-required", step: blocker };

  const latestCompletedStep = [...task.plan].reverse().find((step) => step.status === "completed");
  if (latestCompletedStep) {
    try {
      const call = parseToolCommand(latestCompletedStep.command, `progress-${latestCompletedStep.id}`, tools);
      const definition = call ? tools.find((tool) => tool.id === call.toolId) : undefined;
      if (definition?.completionMode === "complete") return { kind: "complete" };
      // A real user answer is new evidence, not an automatic refinement retry.
      if (definition?.completionMode === "refine" && definition.executionMode === "user-input") {
        return { kind: "refine-discovery", afterUserInput: true };
      }
      const refinementEnabled = definition?.refinementScope !== "active-skill"
        || Boolean(task.activeSkillIds?.length);
      if (definition?.completionMode === "refine" && refinementEnabled && (task.refinementCount ?? 0) < 8) {
        return { kind: "refine-discovery" };
      }
    } catch {
      // Invalid tool syntax is handled by step dispatch; progression remains generic.
    }
  }

  const discoveryOnly = task.plan.length > 0
    && task.plan.every((step) => step.status === "completed" && isReadOnlyDiagnosticStep(step));
  const changeStillExpected = ["requested_changes_only", "allow_necessary_changes"]
    .includes(task.executionConstraints?.changePolicy ?? "");
  if (discoveryOnly && changeStillExpected && !task.discoveryRefined) {
    return { kind: "refine-discovery" };
  }
  return { kind: "complete" };
}

/** Filters repeated commands so completed discovery work is not planned again. */
export function selectContinuationSteps(existingPlan: PlanStep[], candidates: PlanStep[], context?: string) {
  const existingCommands = new Set(existingPlan.filter((step, index) =>
    !continuationAttemptInvalidated(step, index, existingPlan, context),
  ).map((step) => planCommandIdentity(step.command)));
  const selected: PlanStep[] = [];
  return candidates.filter((step) => {
    const command = planCommandIdentity(step.command);
    const necessaryVerification = isNecessaryRecoveryVerification([...existingPlan, ...selected], step, context);
    if (!command || (existingCommands.has(command) && !necessaryVerification)
      || duplicateWithoutInterveningRepair(selected, step, necessaryVerification, candidate => planCommandIdentity(candidate.command))) return false;
    selected.push(step);
    return true;
  });
}

/**
 * A new business proposal may inspect state again after a preceding proposed
 * change. Retaining that verification is not evidence the change has run: the
 * executor still owns ordering, authorization and the original recovery gate.
 * Completed writes, repeated user decisions and unchanged observations remain
 * de-duplicated, and the complete real history stays available for recovery.
 */
export function selectBusinessReplanSteps(existingPlan: PlanStep[], candidates: PlanStep[], context?: string) {
  const completedCommands = new Set(existingPlan.filter((step, index) => step.status === "completed"
    && !continuationAttemptInvalidated(step, index, existingPlan, context))
    .map(step => planCommandIdentity(step.command)));
  const selected: PlanStep[] = [];
  return candidates.filter(step => {
    const command = planCommandIdentity(step.command);
    const necessaryVerification = isNecessaryRecoveryVerification([...existingPlan, ...selected], step, context);
    const reobservable = isReobservableState(step);
    const afterProposedChange = reobservable && selected.some(candidate => candidate.kind === "change");
    let duplicateIndex = -1;
    selected.forEach((candidate, index) => {
      if (planCommandIdentity(candidate.command) === command) duplicateIndex = index;
    });
    const repeatAfterProposedChange = reobservable && duplicateIndex >= 0
      && selected.slice(duplicateIndex + 1).some(candidate => candidate.kind === "change");
    if (!command || (completedCommands.has(command) && !necessaryVerification && !afterProposedChange)
      || (duplicateWithoutInterveningRepair(selected, step, necessaryVerification,
        candidate => planCommandIdentity(candidate.command)) && !repeatAfterProposedChange)) return false;
    selected.push(step);
    return true;
  });
}

function isReobservableState(step: PlanStep) {
  if (!isReadOnlyDiagnosticStep(step) || step.sessionContextChange) return false;
  try {
    const call = parseToolCommand(step.command, `replan-observation-${step.id}`);
    // Terminal/user-input boundaries are not environment observations. A
    // proposed write must not invalidate an already answered form or SSH login.
    return !call || defaultToolCatalog.some(tool => tool.id === call.toolId && tool.planMode === "read_batch");
  } catch { return false; }
}

/**
 * Supplies the protocol splitter with the same non-secret identity ledger used
 * by continuation de-duplication. Raw commands and arguments never need to be
 * copied into the repair control context.
 */
export function completedContinuationCommandFingerprints(
  existingPlan: PlanStep[],
  context?: string,
) {
  return [...new Set(existingPlan.filter((step, index) => (
    step.status === "completed"
      && !continuationAttemptInvalidated(step, index, existingPlan, context)
  )).map((step) => textFingerprint(planCommandIdentity(step.command))))];
}

/**
 * Filters adjustment output against still-valid attempts in the active round.
 * A changed runtime context or intervening mutation permits fresh observations;
 * completed mutations remain protected in the same runtime context. A
 * validation-only repair for an ordinary shell step remains possible.
 */
export function selectAdjustmentSteps(existingPlan: PlanStep[], candidates: PlanStep[], context?: string) {
  const recoveryHistory = existingPlan;
  existingPlan = existingPlan.filter((step, index, steps) => !attemptInvalidated(step, index, steps, context));
  const completedCommands = new Set(
    existingPlan
      .filter((step) => step.status === "completed")
      .map((step) => planCommandIdentity(step.command)),
  );
  const failedAttempts = new Set(
    existingPlan
      .filter((step) => step.status === "failed")
      .map((step) => `${planCommandIdentity(step.command)}\n${step.validation.trim()}`),
  );
  const selected: PlanStep[] = [];

  return candidates.filter((step) => {
    const command = planCommandIdentity(step.command);
    const attempt = `${command}\n${step.validation.trim()}`;
    const necessaryVerification = isNecessaryRecoveryVerification([...recoveryHistory, ...selected], step, context);
    if (!command
      || (completedCommands.has(command) && !necessaryVerification)
      || (failedAttempts.has(attempt) && !necessaryVerification)
      || duplicateWithoutInterveningRepair(selected, step, necessaryVerification,
        candidate => `${planCommandIdentity(candidate.command)}\n${candidate.validation.trim()}`)) return false;
    selected.push(step);
    return true;
  });
}

function duplicateWithoutInterveningRepair(
  selected: PlanStep[], candidate: PlanStep, necessaryVerification: boolean, identity: (step: PlanStep) => string,
) {
  let duplicateIndex = -1;
  selected.forEach((step, index) => { if (identity(step) === identity(candidate)) duplicateIndex = index; });
  if (duplicateIndex < 0) return false;
  return !necessaryVerification || !selected.slice(duplicateIndex + 1).some(step => step.recovery?.purpose === "repair"
    && step.recovery.failedStepId === candidate.recovery?.failedStepId
    && step.recovery.targetContext === candidate.recovery?.targetContext);
}

function attemptInvalidated(step: PlanStep, index: number, history: PlanStep[], context?: string) {
  if (context && step.attemptContext && step.attemptContext !== context) return true;
  if (step.status === "completed" && step.kind === "change") return false;
  return history.slice(index + 1).some(mayHaveChangedState);
}

function continuationAttemptInvalidated(
  step: PlanStep,
  index: number,
  history: PlanStep[],
  context?: string,
) {
  // server.connect records the context before switching to its target. During
  // refinement, a successful switch to the current target is the consumed
  // boundary itself, not stale target evidence that may be planned again.
  let latestCompletedIndex = -1;
  history.forEach((candidate, candidateIndex) => {
    if (candidate.status === "completed") latestCompletedIndex = candidateIndex;
  });
  if (step.status === "completed" && step.result?.executionStatus !== "failed") {
    const resultToolId = typeof step.result?.facts.toolId === "string"
      ? step.result.facts.toolId
      : undefined;
    let call: ReturnType<typeof parseToolCommand> = undefined;
    try { call = parseToolCommand(step.command, `continuation-${step.id}`); } catch { /* Invalid syntax is not reusable. */ }
    if ((resultToolId ?? call?.toolId) === "server.connect") {
      let targetServerId: string | undefined;
      try {
        const output = JSON.parse(step.output ?? "{}") as { serverId?: unknown };
        if (typeof output.serverId === "string") targetServerId = output.serverId;
      } catch { /* Legacy tool output may not be JSON. */ }
      const credentialRef = call?.arguments.credentialRef;
      if (!targetServerId && typeof credentialRef === "string" && credentialRef.startsWith("managed-server:")) {
        targetServerId = credentialRef.slice("managed-server:".length);
      }
      let currentServerId: string | undefined;
      try {
        const parsedContext = JSON.parse(context ?? "null") as unknown;
        if (Array.isArray(parsedContext) && typeof parsedContext[0] === "string") currentServerId = parsedContext[0];
      } catch { /* Missing attempt context falls back to the immediate boundary. */ }
      if ((targetServerId && targetServerId === currentServerId)
        || (!currentServerId && index === latestCompletedIndex)
        || (!targetServerId && index === latestCompletedIndex)) return false;
    }
  }
  return attemptInvalidated(step, index, history, context);
}

export function planCommandIdentity(command: string) {
  try {
    const call = parseToolCommand(command, "identity");
    if (call) {
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)])) : value;
      return JSON.stringify([call.toolId, canonical(call.arguments)]);
    }
  } catch { /* Invalid syntax is rejected by the protocol boundary. */ }
  return command.trim();
}

/** No business step crosses a failed prerequisite until its original contract is rechecked. */
export function findUnresolvedBlockingStep(task: OpsTask, currentStep: PlanStep) {
  const blockers = unresolvedRecoveryBlockers(task, currentStep);
  return blockers.find(step => step.id === currentStep.recovery?.failedStepId) ?? blockers[blockers.length - 1];
}
