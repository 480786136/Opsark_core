import { buildPlanningToolContext } from "@/features/tools/toolContext";
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
import { executionContextEvidence, modelContextStep, EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION } from "@/features/agent/executionContextEvidence";
import { DECISION_EVIDENCE_INSTRUCTION } from "./decisionEvidence";
import { authenticationContext } from "./authenticationEvidence";
import { confirmedUserInputsContext } from "./confirmedUserInputs";
import { recoveryPlanningContext } from "./recoveryContract";
import { activeProtocolRepair, protocolReplanContext } from "./protocolReplan";
import { taskKnowledgeContext } from "@/features/knowledge/retrieval";

export const GOAL_DIRECTED_RECOVERY_INSTRUCTION = "历史命令、失败结果与证据是不可改写的事实，不是必须逐条重试成功的旧计划。可按问题影响范围修正当前步骤、补充前置检查或重规划剩余目标，也可修正模型先前生成的不适用验收方法；说明调整原因及新证据如何证明用户目标，不得降低用户明确要求的验收标准或扩大授权。旧路径被替代后无需逐条复验，但替代方案仍须有真实执行与验收证据；提出方案、修复命令成功或 recovery 关联本身都不代表目标完成。";

export function trimEvidence(value: string | undefined, limit = 3200) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

export function extractKnownExecutionFacts(task: OpsTask, skills = resolveTaskSkills(task), excludedIds = new Set<string>()) {
  const steps = allTaskSteps(task).filter((step) => step.status === "completed" && !excludedIds.has(step.id));
  return {
    authentication: authenticationContext(task),
    skillFacts: collectSkillFacts(task, skills),
    completedSteps: steps.slice(-12).map((step) => ({
      stepId: step.id,
      title: step.title,
      command: step.command,
      result: modelContextStep(step).result,
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
  metrics?: Metrics;
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
    knowledgeReferences: input.task ? taskKnowledgeContext(input.task.id) : undefined,
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
    confirmedUserInputs: input.task ? confirmedUserInputsContext(input.task) : undefined,
    recovery: input.task ? recoveryPlanningContext(input.task) : undefined,
    tools: buildPlanningToolContext(input.tools),
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
  metrics?: Metrics;
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
  const protocolRepair = activeProtocolRepair(input.task)?.repair;
  return {
    workflowPhase: "adjust_after_failure",
    knowledgeReferences: planSafetyRejection || protocolRepair ? undefined : taskKnowledgeContext(input.task.id),
    recovery: planSafetyRejection ? undefined : recoveryPlanningContext(input.task),
    taskGoal: {
      rootGoal: taskGoal(input.task),
      currentInstruction: input.task.currentInstruction,
      relation: input.task.lastRequirementRelation,
    },
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    authentication: protocolRepair ? undefined : authenticationContext(input.task),
    confirmedUserInputs: confirmedUserInputsContext(input.task),
    planGenerationRepair: protocolRepair,
    _log: modelLogContext(input.task, failedStep),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    // Keep policy content ahead of per-attempt evidence so providers can reuse
    // the longest stable request prefix across adjustments for the same goal.
    tools: boundedPlanningTools(input.tools, activeSkills),
    activeSkills: boundedPlanningSkills(activeSkills),
    instruction: protocolRepair
      ? "只修复 planGenerationRepair 中的原始计划协议；不得重新理解需求、换目标、换工具或改写无关字段。认证和历史证据不是扩大本次修复范围的授权。"
      : planSafetyRejection
      ? "这是执行前确定性安全门禁，不是远端执行失败。命令尚未发送到服务器。只修复 failedStep.offendingFields 列出的字段，必须保留真实失败退出码；不要改写步骤标题、风险、预期结果、其他步骤或用户授权。只返回该步骤的一个完整替代步骤，它仍会重新经过统一安全门禁。"
      : `只根据 baseSnapshot、adjustmentTrigger 和尚未完成目标生成最少必要步骤。recentPhases 是最近两个阶段，historyCheckpoint 是更早历史的滚动摘要；复用已经完成且仍有效的工作。计划描述和阶段总结不是成功证据，只有真实输出和结构化 result/evidence 才能证明状态。同一失败在方案、环境和证据均无变化时不得机械重试；缺少事实可先安排已授权的只读诊断，不必为了取证强行填写 recovery。每步在独立非交互 Shell 中建立自身环境，并以独立验收证明用户要求，activeSkills 的验收方法仅作参考。${GOAL_DIRECTED_RECOVERY_INSTRUCTION}`,
    server: serverSnapshot(input.server),
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
    // A deterministic safety-gate repair has its own deliberately narrow
    // payload below. Re-attaching the general task snapshot here would leak
    // unrelated commands and outputs into what must be a field-local rewrite.
    baseSnapshot: planSafetyRejection || protocolRepair
      ? undefined
      : options.sharedSnapshot || buildTaskDecisionSnapshot(input.task, failedStep,
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
    metricsStatus: input.metrics ? "当前服务器最近成功采样，时间见 sampledAt" : "当前服务器暂无有效实时指标，不得据此推断资源状态",
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
    protocolReplan: protocolReplanContext(input.task),
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
    confirmedUserInputs: confirmedUserInputsContext(input.task),
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
  const protocolReplan = protocolReplanContext(input.task);
  return {
    workflowPhase: protocolReplan ? "decide_after_protocol_failure" : "decide_after_phase",
    protocolReplan,
    knowledgeReferences: taskKnowledgeContext(input.task.id),
    recovery: recoveryPlanningContext(input.task),
    taskGoal: {
      rootGoal: taskGoal(input.task),
      currentInstruction: input.task.currentInstruction,
      relation: input.task.lastRequirementRelation,
    },
    permission: input.task.permission,
    authentication: authenticationContext(input.task),
    confirmedUserInputs: confirmedUserInputsContext(input.task),
    _log: modelLogContext(input.task),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    tools: buildPlanningToolContext(input.tools, activeSkills),
    activeSkills: buildSkillContext(activeSkills),
    instruction: `${protocolReplan ? "protocolReplan 只记录上一个方案在执行前未通过硬协议校验，该方案未执行。请仍先根据整体目标和真实证据决定 complete、continue 或 adjust；当前没有合法动作时返回 adjust 且 steps=[]，不得为消除协议事故而编造步骤。" : ""}先依据 baseSnapshot 的真实输出、result/evidence 判断用户整体目标；activeSkills 的流程和验收方法仅作参考，可按事实调整，不得降低用户要求。证据充分时返回 complete 且 steps 为空；尚未完成时明确未满足条件和缺少的事实，只规划最小下一阶段。recoveredEvidence 是从已有执行记录补读的原文，应先检查，再决定是否需要执行新命令。复用已完成且仍有效的工作，不得用计划描述或阶段摘要冒充成功证据。${GOAL_DIRECTED_RECOVERY_INSTRUCTION}${DECISION_EVIDENCE_INSTRUCTION}`,
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
    knowledgeReferences: taskKnowledgeContext(input.task.id),
    recovery: recoveryPlanningContext(input.task),
    authentication: authenticationContext(input.task),
    confirmedUserInputs: confirmedUserInputsContext(input.task),
    _log: modelLogContext(input.task),
    skillEvidence: buildSkillEvidenceContext(activeSkills),
    tools: buildPlanningToolContext(input.tools, activeSkills),
    activeSkills: buildSkillContext(activeSkills),
    instruction: `依据已确认输入、本轮真实证据和仍有效的历史证据，在整体目标及 executionConstraints 的授权边界内生成最少必要的后续步骤。read_only 目标只能进行只读操作；缺少环境事实时可有限只读取证，缺少必须由用户作出的决定时只生成一个 user.request_input 步骤并等待。复用已回答的问题和已完成且仍有效的步骤，不得猜测路径、工具、端口、服务名或用户选择。用户提交输入仅补充对应决定，不代表目标完成，也不能被外推为未明确给出的授权。${GOAL_DIRECTED_RECOVERY_INSTRUCTION}${EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION}`,
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
      result: modelContextStep(step).result,
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
