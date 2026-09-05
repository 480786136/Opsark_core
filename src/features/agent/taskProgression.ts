import {
  isMutatingStepCommand,
  isReadOnlyDiagnosticStep,
  isReadOnlyStep,
} from "@/features/agent/evidenceReview";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolDefinition } from "@/features/tools/types";
import type { OpsTask, PlanStep } from "@/types";
import { taskGoal } from "@/features/agent/taskGoal";
import { mayHaveChangedState } from "@/features/agent/attemptState";

export type TaskProgression =
  | { kind: "execute-step"; step: PlanStep }
  | { kind: "refine-discovery" }
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
  const pendingStep = task.plan.find((step) => step.status === "pending");
  if (pendingStep) return { kind: "execute-step", step: pendingStep };

  const latestCompletedStep = [...task.plan].reverse().find((step) => step.status === "completed");
  if (latestCompletedStep) {
    try {
      const call = parseToolCommand(latestCompletedStep.command, `progress-${latestCompletedStep.id}`, tools);
      const definition = call ? tools.find((tool) => tool.id === call.toolId) : undefined;
      if (definition?.completionMode === "complete") return { kind: "complete" };
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
    !attemptInvalidated(step, index, existingPlan, context),
  ).map((step) => commandIdentity(step.command)));
  const selectedCommands = new Set<string>();
  return candidates.filter((step) => {
    const command = commandIdentity(step.command);
    if (!command || existingCommands.has(command) || selectedCommands.has(command)) return false;
    selectedCommands.add(command);
    return true;
  });
}

/**
 * Filters adjustment output against still-valid attempts in the active round.
 * A changed runtime context or intervening mutation permits fresh observations;
 * completed mutations remain protected in the same runtime context. A
 * validation-only repair for an ordinary shell step remains possible.
 */
export function selectAdjustmentSteps(existingPlan: PlanStep[], candidates: PlanStep[], context?: string) {
  existingPlan = existingPlan.filter((step, index, steps) => !attemptInvalidated(step, index, steps, context));
  const completedCommands = new Set(
    existingPlan
      .filter((step) => step.status === "completed")
      .map((step) => commandIdentity(step.command)),
  );
  const failedAttempts = new Set(
    existingPlan
      .filter((step) => step.status === "failed")
      .map((step) => `${commandIdentity(step.command)}\n${step.validation.trim()}`),
  );
  const selectedAttempts = new Set<string>();

  return candidates.filter((step) => {
    const command = commandIdentity(step.command);
    const attempt = `${command}\n${step.validation.trim()}`;
    if (!command
      || completedCommands.has(command)
      || failedAttempts.has(attempt)
      || selectedAttempts.has(attempt)) return false;
    selectedAttempts.add(attempt);
    return true;
  });
}

function attemptInvalidated(step: PlanStep, index: number, history: PlanStep[], context?: string) {
  if (context && step.attemptContext && step.attemptContext !== context) return true;
  if (step.status === "completed" && step.kind === "change") return false;
  return history.slice(index + 1).some(mayHaveChangedState);
}

function commandIdentity(command: string) {
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

/**
 * Returns the latest unresolved blocking step before a mutating step. A successful
 * intervening mutation clears the blocker only when it did not produce another signal.
 */
export function findUnresolvedBlockingStep(task: OpsTask, currentStep: PlanStep) {
  if (!isMutatingStepCommand(currentStep.command)) return undefined;
  const stepIndex = task.plan.indexOf(currentStep);
  if (stepIndex <= 0) return undefined;

  let blockerIndex = -1;
  for (let index = 0; index < stepIndex; index += 1) {
    const candidate = task.plan[index];
    if (candidate.status === "completed" && candidate.result?.facts.blockingSignal) {
      blockerIndex = index;
    }
  }
  if (blockerIndex < 0) return undefined;

  const blockerResolved = task.plan
    .slice(blockerIndex + 1, stepIndex)
    .some((candidate) =>
      candidate.status === "completed"
      && !isReadOnlyStep(candidate)
      && !candidate.result?.facts.blockingSignal
      && candidate.result?.executionStatus === "success",
    );
  return blockerResolved ? undefined : task.plan[blockerIndex];
}
