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

function adjustmentExecutionFacts(task: OpsTask, skills: SkillDefinition[]) {
  const completed = allTaskSteps(task).filter((step) => step.status === "completed");
  return {
    skillFacts: collectSkillFacts(task, skills),
    completedSteps: completed.slice(-8).map((step) => ({
      title: step.title,
      expected: step.expected,
      result: step.result,
      output: trimEvidence(step.output, 800),
      evidenceFacts: step.evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
    })),
    instruction: "只保留已完成阶段的结构化结论和有界证据；不得要求重复已完成步骤。",
  };
}

function adjustmentPlanStep(step: PlanStep) {
  return {
    title: step.title,
    description: step.description,
    command: step.command,
    expected: step.expected,
    validation: step.validation,
    risk: step.risk,
    status: step.status,
    failureConclusion: step.status === "failed" ? {
      failureReason: step.result?.failureReason,
      facts: step.result?.facts,
      review: step.review,
    } : undefined,
  };
}

function adjustmentFailureStep(step?: PlanStep) {
  return step ? {
    ...adjustmentPlanStep(step),
    output: trimEvidence(step.output, 1_200),
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    evidence: step.evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
  } : undefined;
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

export function buildAdjustmentContext(input: WorkflowContextInput, failedStep?: PlanStep) {
  const activeSkills = input.skills ?? resolveTaskSkills(input.task);
  const planSafetyRejection = failedStep?.result?.facts.category === "plan_safety_rejection";
  const focusedSafety = planSafetyRejection && failedStep
    ? planSafetyAdjustmentContext(input.task, failedStep)
    : undefined;
  return {
    workflowPhase: "adjust_after_failure",
    taskGoal: {
      rootGoal: taskGoal(input.task),
      currentInstruction: input.task.currentInstruction,
      relation: input.task.lastRequirementRelation,
    },
    server: serverSnapshot(input.server),
    metrics: input.metrics,
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    knownExecutionFacts: adjustmentExecutionFacts(input.task, activeSkills),
    tools: buildToolContext(input.tools),
    activeSkills: buildSkillContext(activeSkills),
    previousPlan: focusedSafety?.previousPlan ?? allTaskSteps(input.task).map(adjustmentPlanStep),
    failedStep: focusedSafety?.failedStep ?? adjustmentFailureStep(failedStep),
    instruction: planSafetyRejection
      ? "这是执行前确定性安全门禁，不是远端执行失败。命令尚未发送到服务器。只修复 failedStep.offendingFields 列出的字段，必须保留真实失败退出码；不要改写步骤标题、风险、预期结果、其他步骤或用户授权。只返回该步骤的一个完整替代步骤，它仍会重新经过统一安全门禁。"
      : "仅根据已有证据和未完成目标生成最少必要的替代步骤。先确定上一步是执行失败、观察到有效异常，还是主命令与后置校验冲突。目标已被真实证据证明时不得再变更；未达成时必须更换有实质区别的方法，不得对已失败命令仅做表面改写后重复执行。发现步骤只验证证据可获得；可选信息缺失或目标不存在是有效观察。每步是独立非交互 Shell，必须在当步建立所需目录和环境。用户给出的命令、地址、标识符和协议必须保持语义不变。所有进程必须被执行器跟踪，不得脱离生命周期；不得重复输入、发现、变更或验收。不得预设技术栈、工具、路径、端口或服务名；存在 activeSkills 时继续遵循对应 Skill，并以其要求的独立验收结束。",
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
