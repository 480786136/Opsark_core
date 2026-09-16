import { ensureStepValidator } from "@/services/validation";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { parseToolCommand } from "@/features/tools/toolExecutor";
import { ToolArgumentProtocolError } from "@/features/tools/toolArgumentProtocol";
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

export function normalizeSecretPlaceholders(value: string) {
  return value.replace(/\\+\$\{secret\.([A-Z0-9_]+)\}/g, "\${secret.$1}");
}

const PACKAGE_MANAGER_COMMAND = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:sudo(?:\s+-\S+)*\s+)?(?:dnf|yum|apt-get|apt|zypper|pacman)\b/;
const BUFFERING_TAIL_PIPE = /\s+(2>&1\s*)?\|\s*tail\s+(?:-\d+|-n\s*\d+|--lines(?:=|\s+)\d+)\s*$/;

export const READ_BATCH_STAGE_CONFLICT = "只读批次不能混入变更、Shell 或 standalone 工具；全部步骤必须为 observe 且参数已确定";

export class PlanStageConflictError extends Error {
  readonly conflict = "read_batch";
  constructor() { super(READ_BATCH_STAGE_CONFLICT); this.name = "PlanStageConflictError"; }
}

/** Select an unchanged, contiguous execution stage from tool policy, never business keywords. */
export function planStagePrefix(steps: PlanStep[], tools: ToolDefinition[] = defaultToolCatalog) {
  let mode: "read_batch" | "ordinary" | undefined;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.status !== "pending") continue;
    const call = parseToolCommand(normalizeToolCommandSyntax(step.command), `stage-${index}`, tools);
    const planMode = call ? tools.find(tool => tool.id === call.toolId)?.planMode : undefined;
    if (planMode === "standalone") return steps.slice(0, mode ? index : index + 1);
    const nextMode = planMode === "read_batch" ? "read_batch" : "ordinary";
    if (mode && mode !== nextMode) return steps.slice(0, index);
    mode = nextMode;
  }
  return steps.slice();
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

/** Canonicalizes the only recoverable tool-id typo without weakening argument validation. */
export function normalizeToolCommandSyntax(command: string) {
  return command.replace(
    /^(\s*opsark-tool\s+)--(?=[a-z0-9][a-z0-9_.-]*\s)/i,
    "$1",
  );
}

export function normalizePlanPreconditions(
  steps: PlanStep[],
  requirement = "",
  tools: ToolDefinition[] = defaultToolCatalog,
): PlanStep[] {
  let normalized = steps.map((step) => normalizePlanStepExecutionScope(normalizePlanStepSafety({
    ...step,
    // Preserve the previous execution contract for persisted plans. New model
    // plans always provide kind explicitly.
    kind: step.kind ?? "change",
    command: normalizeToolCommandSyntax(
      normalizeLongRunningCommandOutput(normalizeSecretPlaceholders(step.command)),
    ),
    validation: normalizeSecretPlaceholders(step.validation),
    // Rust versions that predate the omitted-Option wire format emitted null.
    // Keep persisted/backend plans canonical before approval snapshots are made.
    sessionContextChange: step.sessionContextChange ?? undefined,
  })));
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const pendingToolCalls: Array<{ index: number; toolId: string }> = [];
  normalized.forEach((step, index) => {
    validateRecoveryMetadata(step, index);
    if (step.status === "pending" && /^opsark-tool(?:\s|$)/i.test(step.command.trim())) {
      try {
        const call = parseToolCommand(step.command, `normalize-strict-${index}`, tools);
        if (call?.toolId === "user.request_input") {
          step.command = `opsark-tool ${call.toolId} ${JSON.stringify(call.arguments)}`;
        }
        if (call) pendingToolCalls.push({ index, toolId: call.toolId });
      } catch (error) {
        throw new ToolArgumentProtocolError(error, index, step.id);
      }
    }
  });
  for (const { index, toolId } of pendingToolCalls) {
    if (toolById.get(toolId)?.planMode === "read_batch" && normalized[index].kind !== "observe") {
      throw new Error(`第 ${index + 1} 个计划步骤调用 read_batch 工具 ${toolId}；只读批次工具的 kind 必须为 observe`);
    }
  }
  const standaloneCall = pendingToolCalls.find(({ toolId }) => toolById.get(toolId)?.planMode === "standalone");
  const pendingStepCount = normalized.filter((step) => step.status === "pending").length;
  const readBatch = pendingToolCalls.some(({ toolId }) => toolById.get(toolId)?.planMode === "read_batch");
  if (readBatch && pendingStepCount > 1 && (
    pendingToolCalls.length !== pendingStepCount
    || pendingToolCalls.some(({ toolId, index }) =>
      toolById.get(toolId)?.planMode !== "read_batch" || normalized[index].kind !== "observe")
  )) {
    throw new PlanStageConflictError();
  }
  if (standaloneCall && pendingStepCount > 1) {
    throw new Error(
      `第 ${standaloneCall.index + 1} 个计划步骤调用 standalone 工具 ${standaloneCall.toolId}；`
      + "standalone 工具必须是唯一待执行步骤，不能与其他 pending 步骤共存",
    );
  }
  const userExplicitlyRequestedCleanup = /清理|删除|移除|卸载|清空|purge|remove|delete|uninstall/i
    .test(requirement);
  if (requirement && !userExplicitlyRequestedCleanup) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const step = normalized[index];
      if (step.status !== "pending") continue;
      const speculativeCleanup = /清理|残留|删除.*(?:安装|目录|文件)|cleanup|remove residual/i
        .test(`${step.title}\n${step.description}`)
        && /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i.test(step.command);
      if (speculativeCleanup) normalized.splice(index, 1);
    }
  }
  const scoped = normalized.map((step) => {
    const scoped = validatePlanStepExecutionScope(step);
    validateShellStartupTransaction(scoped);
    const semanticRisk = semanticRiskForCommand(scoped.command);
    const risk: RiskLevel = semanticRisk === "high" || scoped.risk === "high"
      ? "high"
      : semanticRisk === "medium" || scoped.risk === "medium"
        ? "medium"
        : "low";
    const riskNormalized = { ...scoped, risk };
    return riskNormalized.kind === "observe" ? riskNormalized : ensureStepValidator(riskNormalized);
  });
  validateAuthorizedChangeOperations(scoped, requirement);
  return scoped;
}
