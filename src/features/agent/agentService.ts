import { backend } from "@/services/backend";
import type { RuntimeModel } from "@/services/backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import {
  buildAdjustmentContext,
  buildContinuationContext,
} from "@/features/agent/agentContext";
import { latestTaskRequirement, selectContinuationSteps } from "@/features/agent/taskProgression";
import type { ToolDefinition } from "@/features/tools/types";
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

/**
 * Generates the one allowed continuation after read-only discovery. Existing and
 * duplicate commands are removed so evidence collection is not repeated.
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
  }));
  const candidates = await generatePlan(
    `${input.requirement}\n\n发现阶段已完成，请仅规划尚未完成的变更与最终验收。`,
    input.model.provider === "Built-in"
      ? undefined
      : createRuntimeModel(input.model, input.apiKey, context, input.generationSettings),
  );
  const continuation = selectContinuationSteps(input.task.plan, candidates);
  if (!continuation.length) throw new Error("模型未返回可执行的后续步骤");
  return continuation;
}

/**
 * Generates a replacement plan from preserved failure evidence. Only the latest
 * completed steps are retained to keep context without re-queuing old work.
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
  }, input.failedStep);
  const replacement = await generatePlan(
    `${requirement}\n\n上次执行未达到预期，请生成安全的调整计划。`,
    input.model.provider === "Built-in"
      ? undefined
      : createRuntimeModel(input.model, input.apiKey, JSON.stringify(context), input.generationSettings),
  );
  if (!replacement.length) throw new Error("模型未返回可执行的调整步骤");
  const completed = input.task.plan.filter((step) => step.status === "completed").slice(-4);
  return {
    requirement,
    context,
    replacement,
    plan: [...completed, ...replacement],
  };
}

/** Generates a completion summary and exposes only the already-redacted request snapshot for audit. */
export async function summarizeTaskExecution(
  input: SummarizeTaskExecutionInput,
  generateSummary: SummaryGenerator = backend.generateSummary.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const model = createRuntimeModel(input.model, input.apiKey, "");
  if (model) {
    input.onModelRequest?.({
      requirement,
      results: input.task.plan.map(({ title, command, expected, status, output }) => ({
        title,
        command,
        expected,
        status,
        output,
      })),
    });
  }
  const summary = await generateSummary(requirement, input.task.plan, model);
  return { summary, requirement, usedModel: model !== undefined };
}

/** Combines a deterministic failure headline with an optional model-generated execution summary. */
export async function summarizeFailedTask(
  input: SummarizeFailedTaskInput,
  generateSummary: SummaryGenerator = backend.generateSummary.bind(backend),
) {
  const requirement = latestTaskRequirement(input.task);
  const model = createRuntimeModel(input.model, input.apiKey, "");
  const generated = await generateSummary(requirement, input.task.plan, model);
  const headline = `本轮任务未完成：${input.reason}`;
  const summary = generated && !headline.includes(generated)
    ? `${headline}\n\n${generated}`
    : headline;
  return { summary, requirement, usedModel: model !== undefined };
}
