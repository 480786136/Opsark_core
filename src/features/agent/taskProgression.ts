import {
  isMutatingStepCommand,
  isReadOnlyDiagnosticStep,
  isReadOnlyStep,
} from "@/features/agent/evidenceReview";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolDefinition } from "@/features/tools/types";
import type { OpsTask, PlanStep } from "@/types";

export type TaskProgression =
  | { kind: "execute-step"; step: PlanStep }
  | { kind: "refine-discovery" }
  | { kind: "complete" };

/** Returns the latest user requirement while ignoring user-triggered event records. */
export function latestTaskRequirement(task: OpsTask) {
  return [...task.messages]
    .reverse()
    .find((message) => message.role === "user" && message.kind === "message")?.content
    ?? task.title;
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
      const call = parseToolCommand(latestCompletedStep.command, `progress-${latestCompletedStep.id}`);
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
export function selectContinuationSteps(existingPlan: PlanStep[], candidates: PlanStep[]) {
  const existingCommands = new Set(existingPlan.map((step) => step.command.trim()));
  const selectedCommands = new Set<string>();
  return candidates.filter((step) => {
    const command = step.command.trim();
    if (!command || existingCommands.has(command) || selectedCommands.has(command)) return false;
    selectedCommands.add(command);
    return true;
  });
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
