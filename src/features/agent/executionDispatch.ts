import { findSecretKeys } from "@/features/agent/secretTool";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolCall } from "@/features/tools/types";
import type { PlanStep } from "@/types";

export type StepDispatchDecision =
  | { kind: "tool"; call: ToolCall }
  | { kind: "await-secret"; key: string }
  | { kind: "command" }
  | { kind: "invalid"; error: string };

/**
 * Resolves the next execution boundary without mutating task state. Tool protocol
 * validation runs before secret discovery because tool arguments are not shell input.
 */
export function resolveStepDispatch(
  step: Pick<PlanStep, "command">,
  confirmedSecretKeys: string[],
  toolCallId: string,
): StepDispatchDecision {
  try {
    const call = parseToolCommand(step.command, toolCallId);
    if (call) return { kind: "tool", call };
  } catch (error) {
    return { kind: "invalid", error: String(error) };
  }

  const key = findSecretKeys(step.command)
    .find((candidate) => !confirmedSecretKeys.includes(candidate));
  return key ? { kind: "await-secret", key } : { kind: "command" };
}

