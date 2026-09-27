import type { GeneratedSkillDraft } from "@/features/skills/types";
import type { ModelValidationResult, NextStageDecision, OperationResult, PlanProposal, PlanStep, RequirementProcessingResult, StepReview } from "@/types";

export interface ModelOperationValues {
  "plan.generate": PlanStep[];
  "plan.repair": PlanStep[];
  "requirement.classify": RequirementProcessingResult;
  "stage.decide": NextStageDecision;
  "result.review": StepReview;
  "summary.generate": string;
  "answer": string;
  "skill.draft": GeneratedSkillDraft;
  "model.probe": ModelValidationResult;
}
export type ModelOperation = keyof ModelOperationValues;
type ResultFor<K extends ModelOperation> = Extract<OperationResult, { operation: K }>;

/** An operation mismatch is terminal; it is not a request to generate another plan. */
export class ModelOperationBoundaryError extends Error {
  readonly code = "MODEL_OPERATION_INVALID";
  constructor(readonly operation: ModelOperation, detail: string) {
    super(`模型操作 ${operation} 的结果无效：${detail}`);
    this.name = "ModelOperationBoundaryError";
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(operation: ModelOperation, detail: string): never { throw new ModelOperationBoundaryError(operation, detail); }
function steps(operation: ModelOperation, value: unknown): asserts value is PlanStep[] {
  if (!Array.isArray(value) || !value.every(record)) fail(operation, "候选步骤必须是对象数组");
}
function review(operation: ModelOperation, value: unknown): asserts value is StepReview {
  if (!record(value) || !["continue", "adjust", "complete"].includes(String(value.decision))
    || typeof value.reason !== "string" || typeof value.summary !== "string"
    || !["model", "rules"].includes(String(value.source))) fail(operation, "缺少有效的决策、原因、摘要或来源");
}

/**
 * The application owns operation selection. This boundary neither prepares nor
 * approves actions; local plan/schema checks continue in their existing layer.
 */
export function modelOperationResult<K extends ModelOperation>(operation: K, input: ModelOperationValues[K]): ResultFor<K> {
  const value: unknown = input;
  let result: OperationResult;
  switch (operation) {
    case "plan.generate":
    case "plan.repair":
      steps(operation, value);
      result = { operation, proposal: { operation, steps: value } };
      break;
    case "requirement.classify": {
      if (!record(value) || !["answer", "execute", "terminal_context"].includes(String(value.intent))) fail(operation, "需求分类无效");
      const classified = value as unknown as RequirementProcessingResult;
      steps(operation, classified.plan);
      if (classified.intent !== "execute" && classified.plan.length) fail(operation, "非执行分类不能携带执行计划");
      const { plan, ...classification } = classified;
      result = { operation, classification,
        ...(classified.intent === "execute" && !classified.planError && plan.length ? { proposal: { operation: "plan.generate" as const, steps: plan } } : {}),
      };
      break;
    }
    case "stage.decide": {
      review(operation, value);
      const decision = value as NextStageDecision;
      steps(operation, decision.steps);
      if (decision.decision === "complete" && decision.steps.length) fail(operation, "完成决策不能携带待执行步骤");
      // Existing adjust+steps is a real correction plan, while adjust+[] remains blocked.
      result = { operation, decision,
        ...(decision.decision !== "complete" && decision.steps.length ? { proposal: { operation: "stage.decide" as const, steps: decision.steps } } : {}),
      };
      break;
    }
    case "result.review":
      review(operation, value);
      if (record(value) && ("steps" in value || "plan" in value || "proposal" in value)) fail(operation, "结果复核不能提交执行计划");
      result = { operation, review: value };
      break;
    case "summary.generate":
    case "answer":
      if (typeof value !== "string") fail(operation, "回答必须是文本");
      result = { operation, text: value };
      break;
    case "skill.draft": {
      if (!record(value) || ["name", "category", "description", "instructions"].some(key => typeof value[key] !== "string")
        || !Array.isArray(value.matchRules) || value.matchRules.some(rule => typeof rule !== "string")) fail(operation, "Skill 草稿结构无效");
      result = { operation, draft: value as unknown as GeneratedSkillDraft };
      break;
    }
    case "model.probe":
      if (!record(value) || typeof value.available !== "boolean" || typeof value.reason !== "string") fail(operation, "模型探测结果无效");
      result = { operation, result: value as { available: boolean; reason: string } };
      break;
    default: return fail(operation, "不支持的模型操作");
  }
  return result as ResultFor<K>;
}

/** Only explicit candidate-bearing branches can enter plan preparation. */
export function operationPlanProposal(result: OperationResult): PlanProposal | undefined {
  return "proposal" in result ? result.proposal : undefined;
}

/** Compatibility reader keeps existing public service method return shapes. */
export function legacyModelOperationValue<K extends ModelOperation>(operation: K, value: ModelOperationValues[K]): ModelOperationValues[K] {
  const result: OperationResult = modelOperationResult(operation, value);
  switch (result.operation) {
    case "plan.generate": case "plan.repair": return result.proposal.steps as ModelOperationValues[K];
    case "requirement.classify": return { ...result.classification, plan: result.proposal?.steps ?? [] } as ModelOperationValues[K];
    case "stage.decide": return result.decision as ModelOperationValues[K];
    case "result.review": return result.review as ModelOperationValues[K];
    case "skill.draft": return result.draft as ModelOperationValues[K];
    case "model.probe": return result.result as ModelOperationValues[K];
    case "answer": case "summary.generate": return result.text as ModelOperationValues[K];
  }
}
