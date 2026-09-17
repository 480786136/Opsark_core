import type { OpsTask, PlanStep } from "@/types";
import { compactReviewText } from "./longRunningReviewOutput";

export function activeProtocolRepair(task: OpsTask) {
  const failure = task.protocolRepair;
  return failure && failure.roundId === task.currentRoundId
    && failure.serverId === (task.executionTargetServerId ?? task.serverId) ? failure : undefined;
}

/** A rejected proposal is planning feedback, not a failed command on the server. */
export function protocolReplanContext(task: OpsTask) {
  const failure = activeProtocolRepair(task);
  if (!failure) return undefined;
  const repair = failure.repair;
  const rejected = repair.previousModelOutput ?? [];
  const index = repair.diagnostic?.stepIndex;
  return {
    source: "business_replan_after_protocol_failure",
    rejectedPlanExecuted: false,
    errorCode: repair.diagnostic?.code ?? repair.errorCode,
    fieldPath: repair.fieldPath,
    reason: compactReviewText(failure.repairError, 600),
    rule: compactReviewText(repair.diagnostic?.expected ?? repair.validationError, 800),
    rejectedStep: index === undefined || !rejected[index] ? undefined : {
      kind: rejected[index].kind,
      title: rejected[index].title,
      command: compactReviewText(rejected[index].command, 1800),
      expected: compactReviewText(rejected[index].expected, 600),
    },
    rejectedStepCount: rejected.length,
    instruction: "原方案未执行，仅作拒绝原因参考，不是执行证据或必须保留的业务契约。允许为同一未完成目标生成新步骤、重新选择 kind、命令、顺序和风险；保留真实历史失败及其验收契约。新步骤必须重新通过协议、安全、授权和风险审批。进入业务重规划不代表新增操作授权；已确认输入中的明确拒绝仍有效，若新方案需要突破限制，先只返回一个 user.request_input 请求针对性授权并等待。",
  };
}

/** Model output cannot carry approval, runtime evidence, or a previously rejected ID. */
export function freshProtocolReplanSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map(step => ({
    id: `replan-step-${crypto.randomUUID()}`,
    kind: step.kind, title: step.title, description: step.description,
    command: step.command, expected: step.expected, validation: step.validation, risk: step.risk,
    executionScope: step.executionScope, validationScope: step.validationScope,
    runtimeClass: step.runtimeClass, sessionContextChange: step.sessionContextChange,
    recovery: step.recovery, recoveryRuleVersion: step.recoveryRuleVersion,
    status: "pending",
  }));
}
