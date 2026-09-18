import type { PlanStep } from "@/types";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";

export interface PlanRepairDiagnostic {
  code: string;
  stepIndex: number;
  stepId?: string;
  fieldPath: string;
  matchedToken?: string;
  expected: string;
  allowedRepairPaths: string[];
  ruleVersion: number;
}

export interface ProtocolRepairProgress {
  scopeFingerprint: string;
  attemptedFingerprints: string[];
  seenPlans: string[];
  attemptCount: number;
  /** Keep backend stop codes intact, including codes added by newer runtimes. */
  stopCode?: `PROTOCOL_REPAIR_${string}`;
  stopReason?: string;
}

export function protocolRepairStopMessage(progress: ProtocolRepairProgress) {
  const code = progress.stopCode ?? "PROTOCOL_REPAIR_FAILED";
  const reasons: Record<string, string> = {
    PROTOCOL_REPAIR_NO_PROGRESS: "该计划和错误没有变化，已停止重复请求",
    PROTOCOL_REPAIR_BUDGET_EXHAUSTED: "同一事故达到协议修复上限",
    PROTOCOL_REPAIR_SCOPE_UNKNOWN: "缺少明确修复字段，需要补充权威上下文或业务调整",
    PROTOCOL_REPAIR_SCOPE_VIOLATION: "修复改变了允许字段之外的步骤内容，需要生成业务调整方案并重新审批",
  };
  return `${code}：${progress.stopReason || reasons[code] || "局部协议修复已停止，可生成业务调整方案并重新审批"}`;
}

export function stableProtocolValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Omitted Rust Option fields and explicit safe defaults have the same contract. */
export function protocolFieldValue(step: PlanStep, field: keyof PlanStep) {
  if (field === "executionScope") return step.executionScope ?? "agent_session";
  if (field === "validationScope") return step.validationScope ?? "isolated_exec";
  if (field === "runtimeClass") return step.runtimeClass ?? "bounded";
  if (field === "status") return step.status ?? "pending";
  if (field === "sessionContextChange" || field === "recovery") return step[field] ?? null;
  return step[field];
}

/** Execution identity, not a proof that arbitrary shell programs are equivalent. */
export function planSemanticFingerprint(steps: PlanStep[]) {
  const ids = new Map(steps.map((step, index) => [step.id, index]));
  return textFingerprint(stableProtocolValue(steps.map(step => ({
    kind: step.kind, command: canonicalToolCommand(step.command), validation: step.validation,
    expected: step.expected, risk: step.risk, executionScope: step.executionScope ?? "agent_session",
    validationScope: step.validationScope ?? "isolated_exec", runtimeClass: step.runtimeClass ?? "bounded",
    sessionContextChange: step.sessionContextChange ?? null,
    recovery: step.recovery ? { ...step.recovery,
      failedStepId: ids.has(step.recovery.failedStepId)
        ? { planStepIndex: ids.get(step.recovery.failedStepId) } : step.recovery.failedStepId,
    } : null,
  }))));
}

function canonicalToolCommand(command: string) {
  const tool = command.match(/^opsark-tool\s+(\S+)\s+([\s\S]+)$/);
  if (tool) {
    try { return { toolId: tool[1], arguments: JSON.parse(tool[2]) }; } catch { /* Preserve invalid source. */ }
  }
  return command;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function parseRepairContext(context: string): Record<string, any> {
  try { return record(JSON.parse(context)); } catch { return {}; }
}

/** No histories or outputs: a protocol compiler needs authority and the rejected fields. */
export function protocolRepairAuthority(context: string) {
  const source = parseRepairContext(context);
  const snapshot = record(source.baseSnapshot);
  const task = { ...record(snapshot.task), ...record(source.task) };
  return {
    _log: source._log ?? task._log,
    _requestParameters: source._requestParameters,
    taskGoal: source.taskGoal ?? snapshot.taskGoal ?? { rootGoal: snapshot.rootGoal ?? task.rootGoal },
    permission: source.permission ?? task.permission,
    executionConstraints: source.executionConstraints ?? snapshot.executionConstraints,
    confirmedUserInputs: source.confirmedUserInputs,
    server: source.server,
    secretVariables: source.secretVariables,
    serverCredentialGroups: source.serverCredentialGroups,
    activeSkills: source.activeSkills,
    recovery: source.recovery,
  };
}

export function protocolRepairScopeFingerprint(context: string, diagnostic?: PlanRepairDiagnostic) {
  const authority = protocolRepairAuthority(context);
  const goal = record(authority.taskGoal);
  return textFingerprint(stableProtocolValue({
    ruleVersion: diagnostic?.ruleVersion, rootGoal: goal.rootGoal,
    permission: authority.permission, executionConstraints: authority.executionConstraints,
    confirmedUserInputs: authority.confirmedUserInputs, activeSkills: authority.activeSkills,
    target: record(authority.recovery).currentTargetContext,
    server: record(authority.server).host,
  }));
}

export function repairStepIndices(fieldPath: string | undefined, steps: PlanStep[]) {
  const match = fieldPath?.match(/^steps\[(\d+)\]/);
  if (!match) return [];
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 && index < steps.length ? [index] : [];
}

/** Only the invalid step is sent. The full original plan is merged and checked locally. */
export function compactProtocolRepairContext<T extends {
  fieldPath?: string; diagnostic?: PlanRepairDiagnostic; previousModelOutput: PlanStep[]; progress?: ProtocolRepairProgress;
  nextStageDecision?: unknown;
}>(
  context: string,
  repair: T,
) {
  const source = parseRepairContext(context);
  const authority = protocolRepairAuthority(context);
  const indices = repairStepIndices(repair.fieldPath, repair.previousModelOutput);
  const steps = indices.map(index => repair.previousModelOutput[index]);
  const referencedTools = new Set(steps.flatMap(step => step.command.match(/^opsark-tool\s+(\S+)/)?.[1] ?? []));
  const failedIds = new Set(steps.flatMap(step => step.recovery?.failedStepId ?? []));
  const recovery = record(authority.recovery);
  const { previousModelOutput: _fullPlan, progress: _progress, nextStageDecision: _decision, ...feedback } = repair;
  return JSON.stringify({
    ...authority,
    workflowPhase: "protocol_repair",
    recovery: {
      currentTargetContext: recovery.currentTargetContext,
      blockers: Array.isArray(recovery.blockers)
        ? recovery.blockers.filter((blocker: Record<string, unknown>) => failedIds.has(String(blocker.failedStepId))) : [],
      instruction: recovery.instruction,
    },
    tools: Array.isArray(source.tools)
      ? source.tools.filter((tool: Record<string, unknown>) => referencedTools.has(String(tool.id))) : [],
    planGenerationRepair: {
      ...feedback,
      previousModelOutput: steps.map(step => ({
        kind: step.kind, title: step.title, description: step.description,
        command: step.command, expected: step.expected, validation: step.validation, risk: step.risk,
        executionScope: step.executionScope, validationScope: step.validationScope,
        runtimeClass: step.runtimeClass, sessionContextChange: step.sessionContextChange, recovery: step.recovery,
      })),
      originalStepIndices: indices,
      originalPlanMergedLocally: true,
      responseInstruction: "只返回 previousModelOutput 中被拒步骤的完整修正版，按原顺序排列；Core 在本地合并其他步骤并校验 allowedRepairPaths。",
    },
    // Rust must not start another independent repair loop for this attempt.
    protocolRepairBudget: { remainingModelCalls: 1 },
    repairPolicy: { scope: "rejected_fields", historyIntentionallyOmitted: true, originalPlanMergedLocally: true },
  });
}

export function mergeProtocolRepairSteps(original: PlanStep[], response: PlanStep[], fieldPath?: string) {
  const indices = repairStepIndices(fieldPath, original);
  if (response.length === original.length) return response;
  if (indices.length !== response.length) throw new Error("协议修复响应必须只含指定的被拒步骤，或保留原计划步骤数量");
  return original.map((step, index) => {
    const offset = indices.indexOf(index);
    return offset < 0 ? step : { ...response[offset], id: step.id };
  });
}
