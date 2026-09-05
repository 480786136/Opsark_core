import { findInvalidSecretPlaceholders, findSecretKeys } from "@/features/agent/secretTool";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import type { ToolCall, ToolDefinition } from "@/features/tools/types";
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
  step: Pick<PlanStep, "command"> & Partial<Pick<PlanStep, "validation" | "executionScope">>,
  confirmedSecretKeys: string[],
  toolCallId: string,
  tools?: ToolDefinition[],
  availableServerSecretKeys: string[] = [],
  forbiddenToolIds: readonly string[] = [],
  allowedToolIds?: readonly string[],
): StepDispatchDecision {
  if (step.executionScope === "user_action") {
    return {
      kind: "invalid",
      error: "user_action 只能由用户在自己的 Shell 中完成，Agent 拒绝自动执行",
    };
  }
  const secretTemplates = `${step.command}\n${step.validation ?? ""}`;
  const invalidPlaceholders = findInvalidSecretPlaceholders(secretTemplates);
  if (invalidPlaceholders.length) {
    return { kind: "invalid", error: `敏感变量占位符格式不合法：${invalidPlaceholders.join("、")}；仅支持 \${secret.NAME}` };
  }
  try {
    const call = parseToolCommand(step.command, toolCallId, tools);
    if (call) {
      if (forbiddenToolIds.includes(call.toolId)) {
        return { kind: "invalid", error: `当前激活 Skill 禁止调用工具：${call.toolId}` };
      }
      if (allowedToolIds && !allowedToolIds.includes(call.toolId)) {
        return { kind: "invalid", error: `当前规划上下文未开放工具：${call.toolId}` };
      }
      return { kind: "tool", call };
    }
  } catch (error) {
    return { kind: "invalid", error: String(error) };
  }

  const reusableKeys = new Set([...confirmedSecretKeys, ...availableServerSecretKeys]);
  const key = findSecretKeys(secretTemplates)
    .find((candidate) => !reusableKeys.has(candidate));
  return key ? { kind: "await-secret", key } : { kind: "command" };
}
