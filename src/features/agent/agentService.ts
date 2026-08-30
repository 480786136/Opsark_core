import { backend } from "@/services/backend";
import type { RuntimeModel } from "@/services/backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import {
  buildAdjustmentContext,
  buildContinuationContext,
} from "@/features/agent/agentContext";
import { latestTaskRequirement, selectContinuationSteps } from "@/features/agent/taskProgression";
import { activeRoundSteps, allTaskSteps, taskGoal } from "@/features/agent/taskGoal";
import { buildSkillContext } from "@/features/skills/skillRegistry";
import type { ToolDefinition } from "@/features/tools/types";
import type { SkillDefinition } from "@/features/skills/types";
import type {
  AiGenerationSettings,
  Metrics,
  ModelProfile,
  OpsTask,
  PlanStep,
  SecretMetadata,
  ServerProfile,
} from "@/types";

type PlanGenerator = (requirement: string, runtimeModel?: RuntimeModel) => Promise<PlanStep[]>;
type SummaryGenerator = (
  requirement: string,
  steps: PlanStep[],
  runtimeModel?: RuntimeModel,
) => Promise<string>;
type GoalReviewer = (
  requirement: string,
  reviewContext: string,
  runtimeModel?: RuntimeModel,
) => Promise<import("@/types").StepReview>;

export interface PlanDiscoveryContinuationInput {
  task: OpsTask;
  requirement: string;
  server?: ServerProfile;
  metrics: Metrics;
  tools: ToolDefinition[];
  secretMetadata: SecretMetadata[];
  model: ModelProfile;
  apiKey?: string;
  generationSettings: AiGenerationSettings;
  skills?: SkillDefinition[];
}

export interface PlanTaskAdjustmentInput {
  task: OpsTask;
  failedStep?: PlanStep;
  server?: ServerProfile;
  metrics: Metrics;
  tools: ToolDefinition[];
  secretMetadata: SecretMetadata[];
  model: ModelProfile;
  apiKey?: string;
  generationSettings: AiGenerationSettings;
  skills?: SkillDefinition[];
}

export interface CompletionSummaryRequest {
  requirement: string;
  results: Array<Pick<PlanStep, "title" | "command" | "expected" | "status" | "output">>;
}

export interface SummarizeTaskExecutionInput {
  task: OpsTask;
  model?: ModelProfile;
  apiKey?: string;
  onModelRequest?(request: CompletionSummaryRequest): void;
}

export interface SummarizeFailedTaskInput {
  task: OpsTask;
  reason: string;
  model?: ModelProfile;
  apiKey?: string;
}

export interface ReviewTaskGoalInput {
  task: OpsTask;
  model?: ModelProfile;
  apiKey?: string;
  skills?: SkillDefinition[];
}

export interface FailedTaskSummaryContext {
  deterministicFinalReason: string;
  latestBlocker: {
    stepTitle?: string;
    reason: string;
    category?: string;
    executionStatus?: string;
    exitCode?: number;
  };
  confirmedFacts: Array<{
    stepTitle: string;
    executionStatus: string;
    observationStatus: string;
    exitCode?: number;
    facts: Record<string, unknown>;
  }>;
  unconfirmedFacts: Array<{
    stepTitle: string;
    status: PlanStep["status"];
    expected: string;
    reason?: string;
  }>;
  authority: string;
}

const FAILURE_SUMMARY_STEP_LIMIT = 20;
const FAILURE_SUMMARY_TEXT_LIMIT = 240;
const FAILURE_SUMMARY_REASON_LIMIT = 480;
const FAILURE_SUMMARY_REQUIREMENT_LIMIT = 1_200;

function sanitizeSummaryText(value: string) {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/'"`:@]+:)[^@\s/'"`]+@/gi, "$1••••••••@")
    .replace(/([?&](?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)=)[^&#\s]+/gi, "$1••••••••")
    .trim();
}

/** Builds an authoritative, output-free failure ledger for the summary model. */
export function buildFailedTaskSummaryContext(
  task: OpsTask,
  deterministicFinalReason: string,
): FailedTaskSummaryContext {
  const steps = activeRoundSteps(task);
  // The complete ledger remains local and is used only to locate the newest
  // blocker. The model-facing fact snapshot is deliberately bounded.
  const contextSteps = steps.slice(-FAILURE_SUMMARY_STEP_LIMIT);
  const latestFailedStep = [...steps].reverse().find((step) => (
    step.status === "failed"
    || step.result?.executionStatus === "failed"
    || step.result?.executionStatus === "blocked"
  ));
  const latestReason = latestFailedStep?.result?.failureReason
    || latestFailedStep?.review?.reason
    || task.lastAdjustmentBlocker
    || task.pauseReason
    || deterministicFinalReason;
  return {
    deterministicFinalReason: sanitizeSummaryText(deterministicFinalReason).slice(0, FAILURE_SUMMARY_REASON_LIMIT),
    latestBlocker: {
      stepTitle: latestFailedStep?.title
        ? sanitizeSummaryText(latestFailedStep.title).slice(0, FAILURE_SUMMARY_TEXT_LIMIT)
        : undefined,
      reason: sanitizeSummaryText(latestReason).slice(0, FAILURE_SUMMARY_REASON_LIMIT),
      category: typeof latestFailedStep?.result?.facts.category === "string"
        ? sanitizeSummaryText(latestFailedStep.result.facts.category).slice(0, 80)
        : undefined,
      executionStatus: latestFailedStep?.result?.executionStatus,
      exitCode: latestFailedStep?.result?.exitCode,
    },
    confirmedFacts: contextSteps.filter((step) => step.status === "completed" && step.result).map((step) => ({
      stepTitle: sanitizeSummaryText(step.title).slice(0, FAILURE_SUMMARY_TEXT_LIMIT),
      executionStatus: step.result!.executionStatus,
      observationStatus: step.result!.observationStatus,
      exitCode: step.result!.exitCode,
      facts: typeof step.result!.facts.category === "string"
        ? { category: sanitizeSummaryText(step.result!.facts.category).slice(0, 80) }
        : {},
    })),
    unconfirmedFacts: contextSteps.filter((step) => step.status !== "completed").map((step) => ({
      stepTitle: sanitizeSummaryText(step.title).slice(0, FAILURE_SUMMARY_TEXT_LIMIT),
      status: step.status,
      expected: sanitizeSummaryText(step.expected).slice(0, FAILURE_SUMMARY_TEXT_LIMIT),
      reason: step.result?.failureReason
        ? sanitizeSummaryText(step.result.failureReason).slice(0, FAILURE_SUMMARY_REASON_LIMIT)
        : undefined,
    })),
    authority: "以上程序结论不可被模型改写；模型只能解释原因，不得将未完成、失败、阻断或未验证事实总结为成功。",
  };
}

function renderDeterministicFailureSummary(context: FailedTaskSummaryContext) {
  const confirmed = context.confirmedFacts.length
    ? context.confirmedFacts.map((fact) => {
      const exit = fact.exitCode === undefined ? "" : `，退出码 ${fact.exitCode}`;
      return `“${fact.stepTitle}”已形成程序证据（${fact.executionStatus}/${fact.observationStatus}${exit}）`;
    }).join("；")
    : "暂无足以证明整体目标完成的已确认事实";
  const unconfirmed = context.unconfirmedFacts.length
    ? context.unconfirmedFacts.map((fact) => `“${fact.stepTitle}”（${fact.status}）`).join("；")
    : "整体目标仍未通过最终验收";
  const blockerTitle = context.latestBlocker.stepTitle ? `步骤“${context.latestBlocker.stepTitle}”：` : "";
  return [
    `本轮任务未完成：${context.deterministicFinalReason}`,
    `最新阻断：${blockerTitle}${context.latestBlocker.reason}`,
    `已确认事实：${confirmed}。`,
    `尚未确认：${unconfirmed}。`,
  ].join("\n");
}

function contradictsDeterministicFailure(value: string) {
  return /(?:本轮成功总结|任务(?:已)?(?:成功)?完成|目标已(?:完成|达成)|(?:部署|克隆|拉取)已?成功|task (?:has been |was )?successfully completed|goal (?:has been |was )?(?:completed|achieved))/i.test(value);
}

/**
 * Prevents the generic summary adapter from reopening the full execution
 * ledger. Failure summaries already carry an authoritative compact fact split
 * in modelRequirement, so this channel contains plan labels and the latest
 * bounded failure conclusion only—never command/output/evidence payloads.
 */
export function buildCompactFailedSummarySteps(steps: PlanStep[]): PlanStep[] {
  return steps.slice(-FAILURE_SUMMARY_STEP_LIMIT).map((step) => {
    const failureReason = step.result?.failureReason
      ? sanitizeSummaryText(step.result.failureReason).slice(0, FAILURE_SUMMARY_TEXT_LIMIT)
      : undefined;
    const category = typeof step.result?.facts.category === "string"
      ? sanitizeSummaryText(step.result.facts.category).slice(0, 80)
      : undefined;
    return {
      id: step.id,
      title: sanitizeSummaryText(step.title).slice(0, FAILURE_SUMMARY_TEXT_LIMIT),
      description: "",
      command: "",
      risk: step.risk,
      expected: sanitizeSummaryText(step.expected).slice(0, FAILURE_SUMMARY_TEXT_LIMIT),
      validation: "",
      status: step.status,
      result: step.result ? {
        executionStatus: step.result.executionStatus,
        observationStatus: step.result.observationStatus,
        exitCode: step.result.exitCode,
        facts: category ? { category } : {},
        warnings: [],
        evidenceIds: [],
        failureReason,
      } : undefined,
    };
  });
}

/**
 * Applies an explicit overall-goal gate after the active queue is exhausted.
 * Finishing the current plan is only phase completion; the model must compare all
 * preserved evidence with rootGoal and every active Skill's final acceptance rules.
 */
export async function reviewTaskGoal(
  input: ReviewTaskGoalInput,
  review: GoalReviewer = backend.reviewGoal.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const steps = activeRoundSteps(input.task);
  const currentIds = new Set(steps.map(({ id }) => id));
  const priorVerifiedFacts = allTaskSteps(input.task)
    .filter((step) => !currentIds.has(step.id) && step.status === "completed" && step.result)
    .slice(-12)
    .map((step) => ({
      title: step.title,
      result: step.result,
      scopes: step.evidence?.map(({ scope }) => scope),
    }));
  const context = {
    trigger: "overall_goal_completion",
    rootGoal: taskGoal(input.task),
    currentRoundRequirement: input.task.currentInstruction || requirement,
    currentInstruction: input.task.currentInstruction,
    executionConstraints: input.task.executionConstraints,
    activeSkills: buildSkillContext(input.skills ?? []),
    currentRoundLedger: steps.map(({ title, description, command, expected, status, output, result, evidence, executionScope, validationScope }) => ({
      title,
      description,
      command,
      expected,
      status,
      output,
      result,
      executionScope,
      validationScope,
      evidence: evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
    })),
    priorVerifiedFacts,
    instruction: "只能用 currentRoundLedger 回答当前轮问题；priorVerifiedFacts 仅能用于避免重复工作，不得把旧状态当成当前轮结果。只有 rootGoal 必要结果和 activeSkills 最终验收都有作用域匹配的真实证据时才可 complete。",
  };
  const decision = await review(
    requirement,
    JSON.stringify(context),
    createRuntimeModel(input.model, input.apiKey, ""),
  );
  const complete = decision.decision === "complete";
  return { requirement, context, decision, complete };
}

/**
 * Generates the next bounded continuation after a discovery or standalone Skill stage.
 * Existing and duplicate commands are removed so evidence collection is not repeated.
 */
export async function planDiscoveryContinuation(
  input: PlanDiscoveryContinuationInput,
  generatePlan: PlanGenerator = backend.generatePlan.bind(backend),
) {
  const context = JSON.stringify(buildContinuationContext({
    server: input.server,
    metrics: input.metrics,
    task: input.task,
    tools: input.tools,
    secretMetadata: input.secretMetadata,
    skills: input.skills,
  }));
  const candidates = await generatePlan(
    `整体目标：${latestTaskRequirement(input.task)}\n当前指令：${input.requirement}\n\n发现阶段已完成，请仅规划尚未完成的变更与最终验收。`,
    input.model.provider === "Built-in"
      ? undefined
      : createRuntimeModel(input.model, input.apiKey, context, input.generationSettings),
  );
  const continuation = selectContinuationSteps(allTaskSteps(input.task), candidates);
  if (!continuation.length) throw new Error("模型未返回可执行的后续步骤");
  return continuation;
}

/**
 * Generates a replacement plan from preserved failure evidence. Previous steps
 * stay in the adjustment context and audit log; they are not re-queued in the
 * active plan or counted as newly processed work.
 */
export async function planTaskAdjustment(
  input: PlanTaskAdjustmentInput,
  generatePlan: PlanGenerator = backend.generatePlan.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const context = buildAdjustmentContext({
    server: input.server,
    metrics: input.metrics,
    task: input.task,
    tools: input.tools,
    secretMetadata: input.secretMetadata,
    skills: input.skills,
  }, input.failedStep);
  const safetyFacts = input.failedStep?.result?.facts.category === "plan_safety_rejection"
    ? input.failedStep.result.facts
    : undefined;
  const safetyFields = safetyFacts
    ? [...new Set((Array.isArray(safetyFacts.issues) ? safetyFacts.issues : [safetyFacts])
      .map((finding) => (finding as Record<string, unknown>)?.field)
      .filter((field): field is "command" | "validation" => field === "command" || field === "validation"))]
    : [];
  const adjustmentInstruction = safetyFields.length
    ? `上一步在发送服务器前被安全门禁拦截。只修复该步骤的 ${safetyFields.join("、")} 字段并且只返回一个完整替代步骤；不得改写其他字段或扩大任务范围。`
    : input.failedStep
    ? "上次执行未达到预期，请仅为未完成目标生成安全的调整计划。"
    : "当前阶段已成功完成，但整体目标尚未验收；请仅规划剩余目标，不得将已成功步骤改写为失败或重复执行。";
  const replacement = await generatePlan(
    `${requirement}\n\n${adjustmentInstruction}`,
    input.model.provider === "Built-in"
      ? undefined
      : createRuntimeModel(input.model, input.apiKey, JSON.stringify(context), input.generationSettings),
  );
  if (safetyFields.length && input.failedStep) {
    if (replacement.length !== 1) {
      throw new Error("安全门禁局部调整只能返回一个替代步骤");
    }
    const candidate = replacement[0];
    const immutableFields = ["title", "description", "expected", "risk"] as const;
    const changedImmutable = immutableFields.find((field) => candidate[field] !== input.failedStep![field]);
    if (changedImmutable) {
      throw new Error(`安全门禁局部调整不得改写 ${changedImmutable} 字段`);
    }
    for (const field of ["command", "validation"] as const) {
      if (!safetyFields.includes(field) && candidate[field] !== input.failedStep[field]) {
        throw new Error(`安全门禁局部调整只允许修改 ${safetyFields.join("、")} 字段`);
      }
    }
  }
  const completed = allTaskSteps(input.task).filter((step) => step.status === "completed");
  const selected = selectContinuationSteps(completed, replacement);
  if (!selected.length) throw new Error("模型未返回新的可执行调整步骤");
  return {
    requirement,
    context,
    replacement: selected,
    plan: selected,
  };
}

/** Generates a completion summary and exposes only the already-redacted request snapshot for audit. */
export async function summarizeTaskExecution(
  input: SummarizeTaskExecutionInput,
  generateSummary: SummaryGenerator = backend.generateSummary.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const steps = activeRoundSteps(input.task);
  const model = createRuntimeModel(input.model, input.apiKey, "");
  if (model) {
    input.onModelRequest?.({
      requirement,
      results: steps.map(({ title, command, expected, status, output }) => ({
        title,
        command,
        expected,
        status,
        output,
      })),
    });
  }
  const summary = await generateSummary(requirement, steps, model);
  return { summary, requirement, usedModel: model !== undefined };
}

/** Combines a deterministic failure headline with an optional model-generated execution summary. */
export async function summarizeFailedTask(
  input: SummarizeFailedTaskInput,
  generateSummary: SummaryGenerator = backend.generateSummary.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const steps = activeRoundSteps(input.task);
  const model = createRuntimeModel(input.model, input.apiKey, "");
  const failureContext = buildFailedTaskSummaryContext(input.task, input.reason);
  const modelGoal = sanitizeSummaryText(requirement).slice(0, FAILURE_SUMMARY_REQUIREMENT_LIMIT);
  const modelRequirement = [
    `用户整体目标：${modelGoal}`,
    `程序确定的失败上下文：${JSON.stringify(failureContext)}`,
    "请只补充解释上述结论；不得改写 deterministicFinalReason、latestBlocker、confirmedFacts 或 unconfirmedFacts。",
  ].join("\n\n");
  const compactSteps = buildCompactFailedSummarySteps(steps);
  const generated = sanitizeSummaryText(await generateSummary(modelRequirement, compactSteps, model));
  const deterministic = renderDeterministicFailureSummary(failureContext);
  const supplement = generated && !contradictsDeterministicFailure(generated)
    ? `\n\n补充说明（不改变以上程序结论）：${generated}`
    : "";
  return {
    summary: `${deterministic}${supplement}`,
    requirement,
    usedModel: model !== undefined,
    failureContext,
  };
}
