import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { findInvalidSecretPlaceholders, findSecretKeys } from "@/features/agent/secretTool";
import { parseToolAction, validatePreparedToolArguments } from "@/features/tools/toolExecutor";
import { effectiveOfficialTool } from "@/features/support/officialContent";
import { effectiveToolSemanticContract } from "@/features/tools/toolPreparation";
import { canonicalExecutionJson } from "./planPreparation";
import { stepMatchesExecutionIntent } from "./stepApproval";
import { assertShellToolBoundary } from "@/features/tools/toolShellBoundary";
import type { ToolCall, ToolDefinition } from "@/features/tools/types";
import type { PlanStep } from "@/types";
import { failureDependencyBlocker } from "./failureDisposition";
import { assertToolStepBoundary } from "./stepAction";

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
  step: Pick<PlanStep, "command" | "action"> & Partial<PlanStep>,
  confirmedSecretKeys: string[],
  toolCallId: string,
  tools?: ToolDefinition[],
  availableServerSecretKeys: string[] = [],
  allowedToolIds?: readonly string[],
): StepDispatchDecision {
  const dependencyBlocker = failureDependencyBlocker(step);
  if (dependencyBlocker) return { kind: "invalid", error: dependencyBlocker };
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
    assertToolStepBoundary(step);
    if (step.action?.type === "shell" && step.action.command !== step.command) throw new Error("Shell action 与执行命令不一致");
    assertShellToolBoundary(step.command, step.validation);
    if (step.executionIntent && !stepMatchesExecutionIntent(step as PlanStep)) {
      return { kind: "invalid", error: "步骤执行内容与准备快照不一致，请重新准备并评估授权" };
    }
    const toolId = step.action?.type === "tool" ? step.action.toolId : undefined;
    const registered = toolId ? (tools ?? defaultToolCatalog).find(tool => tool.id === toolId) : undefined;
    const definition = registered ? effectiveOfficialTool(registered) : undefined;
    if (step.action?.type === "tool" && !definition?.enabled) {
      return { kind: "invalid", error: `工具不存在、已禁用或不可用：${step.action.toolId}` };
    }
    let call: ToolCall | undefined;
    if (step.action?.type === "tool" && step.executionIntent && definition) {
      if (canonicalExecutionJson(step.executionIntent.semantic.toolContract)
        !== canonicalExecutionJson(effectiveToolSemanticContract(definition))) {
        return { kind: "invalid", error: "工具执行契约已变化，请重新准备并评估授权" };
      }
      validatePreparedToolArguments(definition, step.action.arguments);
      call = { id: toolCallId, toolId: step.action.toolId, arguments: JSON.parse(JSON.stringify(step.action.arguments)) };
    } else {
      call = parseToolAction(step.action, toolCallId, tools);
    }
    if (call) {
      if (definition?.effect === "change" && step.kind !== "change") return { kind: "invalid", error: "变更工具必须声明 kind=change 并通过审批" };
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
