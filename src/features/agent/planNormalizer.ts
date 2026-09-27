import { ensureStepValidator } from "@/services/validation";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolAction } from "@/features/tools/toolExecutor";
import { ToolArgumentProtocolError } from "@/features/tools/toolArgumentProtocol";
import { assertShellToolBoundary } from "@/features/tools/toolShellBoundary";
import type { ToolDefinition } from "@/features/tools/types";
import type { PlanStep, RiskLevel } from "@/types";
import { normalizePlanStepSafety } from "@/features/agent/planSafety";
import {
  normalizePlanStepExecutionScope,
  validatePlanStepExecutionScope,
} from "@/features/agent/executionScope";
import { validateShellStartupTransaction } from "@/features/agent/shellStartupConfig";
import { semanticRiskForCommand, validateAuthorizedChangeOperations } from "@/features/agent/changeOperation";
import { validateRecoveryMetadata } from "./recoveryContract";
import { assertToolStepBoundary } from "./stepAction";

export function normalizeSecretPlaceholders(value: string) {
  return value.replace(/\\+\$\{secret\.([A-Z0-9_]+)\}/g, "\${secret.$1}");
}

const PACKAGE_MANAGER_COMMAND = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:sudo(?:\s+-\S+)*\s+)?(?:dnf|yum|apt-get|apt|zypper|pacman)\b/;
const BUFFERING_TAIL_PIPE = /\s+(2>&1\s*)?\|\s*tail\s+(?:-\d+|-n\s*\d+|--lines(?:=|\s+)\d+)\s*$/;

/** Legacy diagnostic retained solely to recognize persisted pre-upgrade failures. */
export const READ_BATCH_STAGE_CONFLICT = "只读批次不能混入变更、Shell 或 standalone 工具；全部步骤必须为 observe 且参数已确定";

export class PlanStageConflictError extends Error {
  readonly conflict = "read_batch";
  constructor() { super(READ_BATCH_STAGE_CONFLICT); this.name = "PlanStageConflictError"; }
}

/** 包管理器的整段 tail 管道会吞掉实时输出并遮蔽真实退出码。 */
export function normalizeLongRunningCommandOutput(command: string) {
  return command
    .split("\n")
    .map((line) => {
      if (!PACKAGE_MANAGER_COMMAND.test(line) || !BUFFERING_TAIL_PIPE.test(line)) return line;
      return line.replace(BUFFERING_TAIL_PIPE, (_match, redirect: string | undefined) => (
        redirect ? ` ${redirect.trim()}` : ""
      ));
    })
    .join("\n");
}

export function normalizePlanPreconditions(
  steps: PlanStep[],
  requirement = "",
  tools: ToolDefinition[] = defaultToolCatalog,
): PlanStep[] {
  steps.filter(step => ["pending", "awaiting_approval"].includes(step.status))
    .forEach(step => {
      if (step.action?.type === "tool") {
        assertToolStepBoundary(step);
      } else {
        if (step.action && (step.action.type !== "shell" || step.action.command !== step.command)) throw new Error("Shell action 与执行命令不一致");
        assertShellToolBoundary(step.command, step.validation);
      }
    });
  let normalized = steps.map((step) => normalizePlanStepExecutionScope(normalizePlanStepSafety({
    ...step,
    // Preserve the previous execution contract for persisted plans. New model
    // plans always provide kind explicitly.
    kind: step.kind ?? "change",
    command: step.action?.type === "tool" ? "" : normalizeLongRunningCommandOutput(normalizeSecretPlaceholders(step.command)),
    validation: normalizeSecretPlaceholders(step.validation),
    // Rust versions that predate the omitted-Option wire format emitted null.
    // Keep persisted/backend plans canonical before approval snapshots are made.
    sessionContextChange: step.sessionContextChange ?? undefined,
  })));
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const pendingToolCalls: Array<{ index: number; toolId: string }> = [];
  normalized.forEach((step, index) => {
    validateRecoveryMetadata(step, index);
    if (["pending", "awaiting_approval"].includes(step.status) && step.action?.type === "tool") {
      try {
        const call = parseToolAction(step.action, `normalize-strict-${index}`, tools);
        if (call) step.action = { type: "tool", toolId: call.toolId, arguments: call.arguments };
        if (call) pendingToolCalls.push({ index, toolId: call.toolId });
      } catch (error) {
        throw new ToolArgumentProtocolError(error, index, step.id);
      }
    }
  });
  for (const { index, toolId } of pendingToolCalls) {
    const definition = toolById.get(toolId);
    if (definition?.effect === "change" && normalized[index].kind !== "change") throw new Error(`工具 ${toolId} 会变更状态，kind 必须为 change`);
    if (definition?.effect === "change" && normalized[index].risk === "low") normalized[index].risk = "medium";
    if ((definition?.effect === "read" || definition?.planMode === "read_batch") && normalized[index].kind !== "observe") {
      throw new Error(`第 ${index + 1} 个计划步骤调用 read_batch 工具 ${toolId}；只读批次工具的 kind 必须为 observe`);
    }
  }
  const standaloneCall = pendingToolCalls.find(({ toolId }) => toolById.get(toolId)?.planMode === "standalone");
  const pendingStepCount = normalized.filter((step) => step.status === "pending").length;
  // read_batch describes eligible observations, not the whole plan. Mixed
  // plans execute in their original order; no prefix is extracted or reordered.
  // Standalone calls still end planning because they may change target/input.
  if (standaloneCall && pendingStepCount > 1) {
    throw new Error(
      `第 ${standaloneCall.index + 1} 个计划步骤调用 standalone 工具 ${standaloneCall.toolId}；`
      + "standalone 工具必须是唯一待执行步骤，不能与其他 pending 步骤共存",
    );
  }
  const scoped = normalized.map((step) => {
    if (step.action?.type === "tool") return step;
    const scoped = validatePlanStepExecutionScope(step);
    validateShellStartupTransaction(scoped);
    const semanticRisk = semanticRiskForCommand(scoped.command);
    const risk: RiskLevel = semanticRisk === "high" || scoped.risk === "high"
      ? "high"
      : semanticRisk === "medium" || scoped.risk === "medium"
        ? "medium"
        : "low";
    const riskNormalized = { ...scoped, risk, action: { type: "shell" as const, command: scoped.command } };
    return riskNormalized.kind === "observe" ? riskNormalized : ensureStepValidator(riskNormalized);
  });
  validateAuthorizedChangeOperations(scoped, requirement);
  return scoped;
}
