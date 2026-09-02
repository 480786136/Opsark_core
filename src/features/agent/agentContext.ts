import { buildToolContext } from "@/features/tools/toolContext";
import {
  buildSkillDirectory,
  buildSkillContext,
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
import { compactReviewText } from "@/features/agent/longRunningReviewOutput";
import type { StepReview } from "@/types";

export function trimEvidence(value: string | undefined, limit = 3200) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

export function extractKnownExecutionFacts(task: OpsTask, skills = resolveTaskSkills(task)) {
  const steps = allTaskSteps(task).filter((step) => step.status === "completed");
  return {
    skillFacts: collectSkillFacts(task, skills),
    completedSteps: steps.slice(-12).map((step) => ({
      title: step.title,
      command: step.command,
      result: step.result,
      output: trimEvidence(step.output),
      executionScope: step.executionScope,
      validationScope: step.validationScope,
      evidence: step.evidence?.map(({ type, source, facts, rawOutput, scope }) => ({
        type,
        source,
        facts,
        scope,
        rawOutput: trimEvidence(rawOutput),
      })),
    })),
    instruction: "这些事实来自同一任务的已完成执行证据。后续步骤必须优先复用，不得在无新证据时猜测或重复已完成工作。",
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

function boundedPlanningTools(tools: ToolDefinition[]) {
  return buildToolContext(tools).map((tool) => ({
    ...tool,
    name: compactReviewText(tool.name, 120),
    description: compactReviewText(tool.description, 240),
    usageInstructions: compactReviewText(tool.usageInstructions, 480),
    outputDescription: compactReviewText(tool.outputDescription, 240),
  }));
}

function boundedPlanningSkills(skills: SkillDefinition[]) {
  return buildSkillContext(skills).map((skill) => ({
    ...skill,
    name: compactReviewText(skill.name, 120),
    description: compactReviewText(skill.description, 280),
    instructions: compactReviewText(skill.instructions, 2_200),
  }));
}

export function buildAdjustmentContext(
  input: WorkflowContextInput,
  failedStep?: PlanStep,
  options: AdjustmentContextOptions = {},
) {
  const activeSkills = input.skills ?? resolveTaskSkills(input.task);
  const planSafetyRejection = failedStep?.result?.facts.category === "plan_safety_rejection";
  const focusedSafety = planSafetyRejection && failedStep
    ? planSafetyAdjustmentContext(input.task, failedStep)
    : undefined;
  return {
    workflowPhase: "adjust_after_failure",
    // A deterministic safety-gate repair has its own deliberately narrow
    // payload below. Re-attaching the general task snapshot here would leak
    // unrelated commands and outputs into what must be a field-local rewrite.
    baseSnapshot: planSafetyRejection
      ? undefined
      : options.sharedSnapshot ?? buildTaskDecisionSnapshot(input.task, failedStep),
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
    server: serverSnapshot(input.server),
    metrics: input.metrics,
    tools: boundedPlanningTools(input.tools),
    activeSkills: boundedPlanningSkills(activeSkills),
    previousPlan: focusedSafety?.previousPlan,
    failedStep: focusedSafety?.failedStep,
    instruction: planSafetyRejection
      ? "这是执行前确定性安全门禁，不是远端执行失败。命令尚未发送到服务器。只修复 failedStep.offendingFields 列出的字段，必须保留真实失败退出码；不要改写步骤标题、风险、预期结果、其他步骤或用户授权。只返回该步骤的一个完整替代步骤，它仍会重新经过统一安全门禁。"
      : "只根据 baseSnapshot、adjustmentTrigger 和尚未完成目标生成最少必要步骤。recentPhases 是最近两个阶段，historyCheckpoint 是更早历史的滚动摘要；不得要求重复其中已经完成的工作。计划描述和阶段总结不是成功证据，只有结构化 result/evidence 才能证明状态。失败方法必须有实质变化后才能重试。每步在独立非交互 Shell 中建立自身环境，并以 activeSkills 要求的独立验收结束。",
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
  };
}

export function buildContinuationContext(input: WorkflowContextInput) {
  const activeSkills = input.skills ?? resolveTaskSkills(input.task);
  return {
    workflowPhase: "continue_after_discovery",
    taskGoal: {
      rootGoal: taskGoal(input.task),
      currentInstruction: input.task.currentInstruction,
      relation: input.task.lastRequirementRelation,
    },
    server: serverSnapshot(input.server),
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    completedDiscovery: input.task.plan.map(({ title, description, command, expected, result, evidence, output, executionScope, validationScope }) => ({
      title,
      description,
      command,
      expected,
      result,
      executionScope,
      validationScope,
      evidence: evidence?.map(({ type, source, facts, rawOutput, scope }) => ({
        type,
        source,
        facts,
        scope,
        rawOutput: trimEvidence(rawOutput),
      })),
      output: trimEvidence(output),
    })),
    knownExecutionFacts: extractKnownExecutionFacts(input.task, activeSkills),
    tools: buildToolContext(input.tools),
    activeSkills: buildSkillContext(activeSkills),
    instruction: "只使用本轮已完成发现的真实证据，生成完成用户剩余目标所需的最少变更和最终验收。不得重复发现步骤或猜测路径、工具、端口和服务名。",
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
    serverCredentialGroups: credentialGroupContext(input.secretMetadata, input.task.serverId),
  };
}
