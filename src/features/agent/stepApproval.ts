import { requiresStepApproval } from "@/features/agent/approvalPolicy";
import { canonicalExecutionJson, executionDigest, executionIntentMatches } from "@/features/agent/planPreparation";
import { transitionStep } from "@/features/agent/stepMachine";
import type { ToolDefinition } from "@/features/tools/types";
import type { ExecutionApprovalGrant, PermissionLevel, PlanStep, PreparedPlan } from "@/types";

export interface StepApprovalRequest {
  taskStatus: "awaiting_step_approval";
  eventMessage: string;
}

export interface AcceptedStepApproval {
  taskStatus: "running";
  shouldExecute: true;
}

const RISK_LABEL: Record<PlanStep["risk"], string> = { low: "低", medium: "中", high: "高" };
const SNAPSHOT_VERSION = "step-safety@2";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const equal = (left: unknown, right: unknown) => left === undefined || right === undefined
  ? left === right : canonicalExecutionJson(left) === canonicalExecutionJson(right);

/** Presentation fields and runtime results deliberately do not convey authority. */
export function planSafetySnapshot(step: PlanStep) {
  return clone({
    snapshotVersion: SNAPSHOT_VERSION,
    id: step.id,
    action: step.action,
    risk: step.risk,
    kind: step.kind,
    expected: step.expected,
    command: step.command,
    validation: step.validation,
    validator: step.validator,
    executionScope: step.executionScope,
    validationScope: step.validationScope,
    sessionContextChange: step.sessionContextChange ?? undefined,
    runtimeClass: step.runtimeClass,
    protocolReplanApproval: step.protocolReplanApproval,
    retryBasis: step.retryBasis,
    retryAfterStepId: step.retryAfterStepId,
    failureDependencies: step.failureDependencies,
    recovery: step.recovery,
    recoveryRuleVersion: step.recoveryRuleVersion,
    executionIntent: step.executionIntent,
    planRevision: step.planRevision,
    stepRevision: step.stepRevision,
  });
}

/** Checks the live compatibility copy against the immutable prepared action. */
export function stepMatchesExecutionIntent(step: PlanStep): boolean {
  const intent = step.executionIntent;
  if (!intent || !executionIntentMatches(intent, intent)
    || !Number.isSafeInteger(step.planRevision) || Number(step.planRevision) < 1
    || !Number.isSafeInteger(step.stepRevision) || Number(step.stepRevision) < 1) return false;
  const semantic = intent.semantic;
  return semantic.stepId === step.id
    && equal(semantic.action, step.action)
    && (semantic.action.type === "shell" ? semantic.action.command === step.command : step.command === "")
    && semantic.kind === step.kind && semantic.risk === step.risk && semantic.expected === step.expected
    && (semantic.action.type === "tool" ? step.validation === "" : equal(semantic.validation, step.validation))
    && equal(semantic.validator, step.validator)
    && equal(semantic.executionScope, step.executionScope)
    && equal(semantic.validationScope, step.validationScope)
    && equal(semantic.sessionContextChange ?? undefined, step.sessionContextChange ?? undefined)
    && equal(semantic.runtimeClass, step.runtimeClass)
    && equal(semantic.dependencies.retryBasis, step.retryBasis)
    && equal(semantic.dependencies.retryAfterStepId, step.retryAfterStepId)
    && equal(semantic.dependencies.failureDependencies, step.failureDependencies)
    && equal(semantic.dependencies.recovery, step.recovery)
    && equal(semantic.dependencies.recoveryRuleVersion, step.recoveryRuleVersion)
    && equal(semantic.dependencies.protocolReplanApproval, step.protocolReplanApproval);
}

function currentStepGrant(step: PlanStep): boolean {
  const grant = step.approvalGrant;
  const intent = step.executionIntent;
  return Boolean(grant && intent && stepMatchesExecutionIntent(step)
    && grant.version === "execution-approval@1" && grant.scope === "step"
    && grant.taskId === intent.semantic.taskId
    && grant.planRevision === step.planRevision && grant.stepRevision === step.stepRevision
    && grant.executionDigest === intent.digest && grant.permission === intent.semantic.permission
    && grant.policyVersion === intent.semantic.policyVersion);
}

export function hasCurrentStepApproval(step: PlanStep) {
  const approved = step.approvedSafetySnapshot;
  if (!approved || !equal(approved, planSafetySnapshot(step))) return false;
  return !step.executionIntent || currentStepGrant(step);
}

/** Moves a pending step into approval wait and captures exactly what is shown. */
export function requestStepApproval(
  permission: PermissionLevel,
  step: PlanStep,
  tools?: ToolDefinition[],
): StepApprovalRequest | undefined {
  if (!requiresStepApproval(permission, step, tools)) return undefined;

  transitionStep(step, "awaiting_approval");
  step.safetyApprovalSnapshot = planSafetySnapshot(step);
  step.approvedSafetySnapshot = undefined;
  step.approvalGrant = undefined;
  return {
    taskStatus: "awaiting_step_approval",
    eventMessage: step.protocolReplanApproval
      ? `后续方案包含一项具体变更。步骤“${step.title}”将修改目标状态，请核对已确认决定：${step.protocolReplanApproval.decisionSummary}。本次确认仅授权本步骤展示的具体变更，不撤销任务级禁止事项；如与原决定冲突，请先补充授权或调整方案。`
      : `步骤“${step.title}”为${RISK_LABEL[step.risk]}风险，需要单独确认。`,
  };
}

/** Never approve edits made while the original approval dialog was waiting. */
export function acceptStepApproval(step: PlanStep, plan?: PreparedPlan): AcceptedStepApproval | undefined {
  if (step.status !== "awaiting_approval" || !step.safetyApprovalSnapshot
    || !equal(step.safetyApprovalSnapshot, planSafetySnapshot(step))) return undefined;
  if (step.executionIntent) {
    if (!stepMatchesExecutionIntent(step)) return undefined;
    const intent = step.executionIntent;
    if (plan && (plan.taskId !== intent.semantic.taskId || plan.planRevision !== step.planRevision
      || !plan.steps.some(prepared => prepared.id === step.id && prepared.stepRevision === step.stepRevision
        && executionIntentMatches(prepared.intent, intent)))) return undefined;
    step.approvalGrant = {
      version: "execution-approval@1", source: "user", scope: "step",
      taskId: intent.semantic.taskId, planRevision: step.planRevision!, stepRevision: step.stepRevision!,
      executionDigest: intent.digest, permission: intent.semantic.permission,
      policyVersion: intent.semantic.policyVersion, grantedAt: new Date().toISOString(),
    };
  }
  step.approvedSafetySnapshot = clone(step.safetyApprovalSnapshot);
  return { taskStatus: "running", shouldExecute: true };
}

function samePreparedPlan(requested: PreparedPlan, current: PreparedPlan): boolean {
  const digest = (plan: PreparedPlan) => executionDigest({ version: "prepared-plan@1", taskId: plan.taskId,
    steps: plan.steps.map(step => ({ id: step.id, intent: step.intent.digest })) });
  return requested.version === "prepared-plan@1" && current.version === "prepared-plan@1"
    && requested.taskId === current.taskId && requested.planRevision === current.planRevision
    && requested.executionDigest === current.executionDigest && requested.steps.length > 0
    && requested.executionDigest === digest(requested) && current.executionDigest === digest(current)
    && requested.steps.length === current.steps.length
    && requested.steps.every((step, index) => {
      const candidate = current.steps[index];
      return candidate?.id === step.id && candidate.stepRevision === step.stepRevision
        && executionIntentMatches(step.intent, candidate.intent);
    });
}

/** The caller supplies the frozen displayed plan and a freshly verified current plan. */
export function acceptPreparedPlanApproval(
  requested: PreparedPlan,
  current: PreparedPlan,
  source: ExecutionApprovalGrant["source"] = "user",
): ExecutionApprovalGrant | undefined {
  if (!samePreparedPlan(requested, current)) return undefined;
  const semantic = current.steps[0]!.intent.semantic;
  return {
    version: "execution-approval@1", source, scope: "plan", taskId: current.taskId,
    planRevision: current.planRevision, executionDigest: current.executionDigest,
    permission: semantic.permission, policyVersion: semantic.policyVersion, grantedAt: new Date().toISOString(),
  };
}

export function hasCurrentPlanApproval(plan: PreparedPlan, grant?: ExecutionApprovalGrant): boolean {
  const semantic = plan.steps[0]?.intent.semantic;
  return Boolean(grant && semantic && samePreparedPlan(plan, plan)
    && grant.version === "execution-approval@1" && grant.scope === "plan"
    && grant.taskId === plan.taskId && grant.planRevision === plan.planRevision
    && grant.executionDigest === plan.executionDigest && grant.permission === semantic.permission
    && grant.policyVersion === semantic.policyVersion);
}

/** Uses the same frozen snapshot when existing policy can authorize without a dialog. */
export function authorizePreparedPlan(plan: PreparedPlan, tools?: ToolDefinition[]): ExecutionApprovalGrant | undefined {
  if (!plan.steps.length || plan.steps.some(prepared => {
    const step = plan.compatibilitySteps.find(candidate => candidate.id === prepared.id);
    return !step || !stepMatchesExecutionIntent(step)
      || requiresStepApproval(step.executionIntent!.semantic.permission, step, tools);
  })) return undefined;
  return acceptPreparedPlanApproval(plan, plan, "policy");
}
