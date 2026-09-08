import { buildPlanningToolContext, buildToolContext } from "@/features/tools/toolContext";
import {
  buildSkillDirectory,
  buildSkillContext,
  buildSkillEvidenceContext,
  collectSkillFacts,
  resolveTaskSkills,
} from "@/features/skills/skillRegistry";
import type { SkillDefinition } from "@/features/skills/types";
import type { ToolDefinition } from "@/features/tools/types";
import type {
  Metrics,
  OpsTask,
  PermissionLevel,
  PlanStep,
  SecretMetadata,
  ServerProfile,
} from "@/types";
import { credentialGroupContext } from "@/features/agent/serverCredentialGroup";
import { allTaskSteps, taskGoal } from "@/features/agent/taskGoal";
import { buildTaskDecisionSnapshot } from "@/features/agent/taskDecisionSnapshot";
import { compactReviewText, textFingerprint } from "@/features/agent/longRunningReviewOutput";
import type { StepReview } from "@/types";
import { planningSkills } from "@/features/skills/skillPlanning";
import { modelLogContext } from "./modelLogContext";
import { taskAttemptContext } from "@/features/agent/attemptState";
import { executionContextEvidence, EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION } from "@/features/agent/executionContextEvidence";

export function trimEvidence(value: string | undefined, limit = 3200) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

export function extractKnownExecutionFacts(task: OpsTask, skills = resolveTaskSkills(task), excludedIds = new Set<string>()) {
  const steps = allTaskSteps(task).filter((step) => step.status === "completed" && !excludedIds.has(step.id));
  return {
    skillFacts: collectSkillFacts(task, skills),
    completedSteps: steps.slice(-12).map((step) => ({
      stepId: step.id,
      title: step.title,
      command: step.command,
      result: step.result,
      ...executionContextEvidence(step, trimEvidence),
      targetContext: step.attemptContext,
      executionScope: step.executionScope,
      validationScope: step.validationScope,
    })),
    instruction: `这些记录来自同一任务的已完成执行证据；目标、凭据或资源变化后，历史观察不能证明当前状态。后续步骤必须优先复用仍适用的证据。${EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION}`,
  };
}

function planSafetyAdjustmentContext(task: OpsTask, failedStep: PlanStep) {
  const facts = failedStep.result?.facts ?? {};
  const rawIssues = Array.isArray(facts.issues) ? facts.issues : [{
    field: facts.field,
    ruleId: facts.ruleId,
    reason: facts.reason,
    snippet: facts.snippet,
    repairable: facts.repairable,
  }];
  const safetyIssues = rawIssues
    .filter((finding): finding is Record<string, unknown> => Boolean(finding) && typeof finding === "object")
    .map((finding) => ({
      field: finding.field === "validation" ? "validation" as const : "command" as const,
      ruleId: String(finding.ruleId ?? "UNKNOWN"),
      reason: String(finding.reason ?? "执行前安全检查未通过"),
      snippet: trimEvidence(String(finding.snippet ?? ""), 240),
      repairable: finding.repairable === true,
    }));
  const offendingFields = [...new Set(safetyIssues.map(({ field }) => field))];
  const field = offendingFields[0] ?? "command";
  const index = task.plan.findIndex((step) => step.id === failedStep.id);
  const offendingValues = Object.fromEntries(offendingFields.map((offendingField) => [
    offendingField,
    trimEvidence(failedStep[offendingField], 2_400),
  ]));
  const counterpart = offendingFields.length === 1
    ? (field === "command"
      ? { validation: trimEvidence(failedStep.validation, 1_600) }
      : { command: trimEvidence(failedStep.command, 1_600) })
    : {};
  return {
    previousPlan: task.plan.map((step, stepIndex) => ({
      stepIndex: stepIndex + 1,
      title: step.title,
      status: step.status,
    })),
    failedStep: {
      stepIndex: index >= 0 ? index + 1 : undefined,
      title: failedStep.title,
      description: failedStep.description,
      expected: failedStep.expected,
      risk: failedStep.risk,
      offendingField: field,
      offendingFields,
      offendingValue: offendingValues[field],
      offendingValues,
      ...counterpart,
      safetyIssue: safetyIssues[0],
      safetyIssues,
      previousStepTitle: index > 0 ? task.plan[index - 1]?.title : undefined,
      nextStepTitle: index >= 0 ? task.plan[index + 1]?.title : undefined,
      failureConclusion: failedStep.result?.failureReason,
    },
  };
}

function serverSnapshot(server?: ServerProfile) {
  return server ? {
    name: server.name,
    host: server.host,
    info: server.info,
    environment: server.environment,
  } : undefined;
}

function secretVariableContext(secretMetadata: SecretMetadata[], serverId: string) {
  return secretMetadata
    .filter((item) => item.serverId === serverId)
    .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` }));
}

export interface AgentContextInput {
  task?: OpsTask;
  server?: ServerProfile;
  metrics: Metrics;
  permission: PermissionLevel;
  terminalReference?: string;
  terminalContext?: {
    source: "automatic" | "selection";
    totalLines: number;
    includedLines: number;
    hasMore: boolean;
    content?: string;
  };
  conversationHistory: unknown[];
  previousExecution?: unknown;
  knownExecutionFacts: unknown;
  tools: ToolDefinition[];
  skills?: SkillDefinition[];
  skillDirectory?: SkillDefinition[];
  secretMetadata: SecretMetadata[];
  serverId: string;
  taskGoal?: {
    rootGoal: string;
    currentInstruction?: string;
    status: string;
  };
}

export function buildAgentContext(input: AgentContextInput) {
  return {
    _log: input.task ? modelLogContext(input.task) : undefined,
    skillEvidence: input.task ? buildSkillEvidenceContext(planningSkills(input.task, input.skillDirectory ?? input.skills ?? [])) : undefined,
    server: serverSnapshot(input.server),
    metrics: input.metrics,
    permission: input.permission,
    terminalReference: input.terminalReference || undefined,
    terminalContext: input.terminalContext,
    conversationHistory: input.conversationHistory,
    taskGoal: input.taskGoal,
    previousExecution: input.previousExecution,
    knownExecutionFacts: input.knownExecutionFacts,
    tools: buildToolContext(input.tools),
    skillSelection: {
      mode: "model",
      multiple: true,
      allowEmpty: true,
      currentActiveSkillIds: (input.skills ?? []).map((skill) => skill.id),
    },
    skillDirectory: buildSkillDirectory(input.skillDirectory ?? []),
    activeSkills: [],
    secretVariables: secretVariableContext(input.secretMetadata, input.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.serverId),
  };
}

interface WorkflowContextInput {
  server?: ServerProfile;
  metrics: Metrics;
  task: OpsTask;
  tools: ToolDefinition[];
  secretMetadata: SecretMetadata[];
  skills?: SkillDefinition[];
}

export interface AdjustmentContextOptions {
  sharedSnapshot?: Record<string, unknown>;
  reviewDecision?: StepReview;
  adjustmentReason?: string;
}

function boundedPlanningTools(tools: ToolDefinition[], skills: SkillDefinition[]) {
  return buildPlanningToolContext(tools, skills).map((tool) => ({
    ...tool,
    name: compactReviewText(tool.name, 120),
    description: compactReviewText(tool.description, 240),
    usageInstructions: compactReviewText(tool.usageInstructions, 480),
    outputDescription: compactReviewText(tool.outputDescription, 240),
  }));
}

function boundedPlanningSkills(skills: SkillDefinition[]) {
  return buildSkillContext(skills);
}

export function buildAdjustmentContext(
  input: WorkflowContextInput,
  failedStep?: PlanStep,
  options: AdjustmentContextOptions = {},
) {
  const activeSkills = planningSkills(input.task, input.skills ?? resolveTaskSkills(input.task));
  const planSafetyRejection = failedStep?.result?.facts.category === "plan_safety_rejection";
  const focusedSafety = planSafetyRejection && failedStep
    ? planSafetyAdjustmentContext(input.task, failedStep)
    : undefined;
  return {
    workflowPhase: "adjust_after_failure",
    _log: modelLogContext(input.task, failedStep),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    // Keep policy content ahead of per-attempt evidence so providers can reuse
    // the longest stable request prefix across adjustments for the same goal.
    tools: boundedPlanningTools(input.tools, activeSkills),
    activeSkills: boundedPlanningSkills(activeSkills),
    instruction: planSafetyRejection
      ? "这是执行前确定性安全门禁，不是远端执行失败。命令尚未发送到服务器。只修复 failedStep.offendingFields 列出的字段，必须保留真实失败退出码；不要改写步骤标题、风险、预期结果、其他步骤或用户授权。只返回该步骤的一个完整替代步骤，它仍会重新经过统一安全门禁。"
      : "只根据 baseSnapshot、adjustmentTrigger 和尚未完成目标生成最少必要步骤。recentPhases 是最近两个阶段，historyCheckpoint 是更早历史的滚动摘要；不得要求重复其中已经完成的工作。计划描述和阶段总结不是成功证据，只有结构化 result/evidence 才能证明状态。失败方法必须有实质变化后才能重试。每步在独立非交互 Shell 中建立自身环境，并以 activeSkills 要求的独立验收结束。",
    server: serverSnapshot(input.server),
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
    // A deterministic safety-gate repair has its own deliberately narrow
    // payload below. Re-attaching the general task snapshot here would leak
    // unrelated commands and outputs into what must be a field-local rewrite.
    baseSnapshot: planSafetyRejection
      ? undefined
      : options.sharedSnapshot ?? buildTaskDecisionSnapshot(input.task, failedStep,
        buildPlanningToolContext(input.tools, activeSkills).some(tool => tool.id === "evidence.read")),
    adjustmentTrigger: {
      reason: options.adjustmentReason
        ? compactReviewText(options.adjustmentReason, 800)
        : failedStep?.result?.failureReason
          ? compactReviewText(failedStep.result.failureReason, 800)
          : "当前阶段结束但整体目标尚未完成",
      reviewDecision: options.reviewDecision ? {
        decision: options.reviewDecision.decision,
        reason: compactReviewText(options.reviewDecision.reason, 600),
        summary: compactReviewText(options.reviewDecision.summary, 600),
        source: options.reviewDecision.source,
      } : undefined,
    },
    metrics: input.metrics,
    previousPlan: focusedSafety?.previousPlan,
    failedStep: focusedSafety?.failedStep,
  };
}

/**
 * Identifies the policy inputs that make a cached next-stage plan valid. Live
 * execution evidence and terminal generations are tracked separately by the
 * adjustment incident fingerprint.
 */
export function nextStagePolicyFingerprint(input: WorkflowContextInput) {
  const activeSkills = input.skills ?? resolveTaskSkills(input.task);
  const planningTools = buildPlanningToolContext(input.tools, activeSkills);
  return textFingerprint(JSON.stringify({
    attemptContext: taskAttemptContext(input.task),
    planningProjection: planningSkills(input.task, activeSkills).map(({ instructions, allowedToolIds }) => ({ instructions, allowedToolIds })),
    rootGoal: taskGoal(input.task),
    currentRoundId: input.task.currentRoundId,
    permission: input.task.permission,
    modelId: input.task.modelId,
    executionConstraints: input.task.executionConstraints,
    skills: activeSkills.map((skill) => ({
      id: skill.id,
      version: skill.version,
      updatedAt: skill.updatedAt,
      instructions: textFingerprint(skill.instructions),
      planningContract: skill.planningContract,
      allowedToolIds: skill.allowedToolIds,
      forbiddenToolIds: skill.forbiddenToolIds,
    })),
    tools: planningTools,
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
  }));
}

/**
 * Builds the single payload used to decide overall completion and, only when
 * incomplete, generate the next bounded stage. Necessary Skill instructions
 * are intentionally not character-truncated in this combined quality gate.
 */
export function buildNextStageContext(input: WorkflowContextInput) {
  const activeSkills = planningSkills(input.task, input.skills ?? resolveTaskSkills(input.task));
  const policyFingerprint = nextStagePolicyFingerprint(input);
  return {
    workflowPhase: "decide_after_phase",
    _log: modelLogContext(input.task),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    tools: buildPlanningToolContext(input.tools, activeSkills),
    activeSkills: buildSkillContext(activeSkills),
    instruction: "先依据 baseSnapshot 的真实 result/evidence 和全部 activeSkills 验收要求判断整体目标。证据充分时返回 complete 且 steps 为空；尚未完成时在同一响应中只规划当前证据允许的最小下一阶段。不得重复已完成步骤，不得用计划描述或阶段摘要冒充成功证据。",
    server: serverSnapshot(input.server),
    executionConstraints: input.task.executionConstraints,
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
    policyFingerprint,
    baseSnapshot: buildTaskDecisionSnapshot(input.task, undefined,
      buildPlanningToolContext(input.tools, activeSkills).some(tool => tool.id === "evidence.read")),
    metrics: input.metrics,
  };
}

export function buildContinuationContext(input: WorkflowContextInput) {
  const activeSkills = planningSkills(input.task, input.skills ?? resolveTaskSkills(input.task));
  return {
    workflowPhase: "continue_after_discovery",
    _log: modelLogContext(input.task),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    tools: buildPlanningToolContext(input.tools, activeSkills),
    activeSkills: buildSkillContext(activeSkills),
    instruction: `只使用本轮已完成发现的真实证据，生成完成用户剩余目标所需的最少变更和最终验收。不得重复发现步骤或猜测路径、工具、端口和服务名。${EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION}`,
    taskGoal: {
      rootGoal: taskGoal(input.task),
      currentInstruction: input.task.currentInstruction,
      relation: input.task.lastRequirementRelation,
    },
    server: serverSnapshot(input.server),
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
    completedDiscovery: input.task.plan.map((step) => ({
      stepId: step.id,
      title: step.title,
      description: step.description,
      command: step.command,
      expected: step.expected,
      result: step.result,
      executionScope: step.executionScope,
      validationScope: step.validationScope,
      targetContext: step.attemptContext,
      ...executionContextEvidence(step, typeof step.result?.facts.toolId === "string"
        ? (value) => value : trimEvidence,
        buildPlanningToolContext(input.tools, activeSkills).some(tool => tool.id === "evidence.read")),
    })),
    knownExecutionFacts: extractKnownExecutionFacts(input.task, activeSkills, new Set(input.task.plan.map(({ id }) => id))),
  };
}
