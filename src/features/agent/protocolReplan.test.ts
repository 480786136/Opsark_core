import { describe, expect, it } from "vitest";
import { activeProtocolRepair, freshProtocolReplanSteps, protocolReplanContext } from "./protocolReplan";
import { buildAdjustmentContext, buildNextStageContext } from "./agentContext";
import { analyzePlanStepSafety } from "./planSafety";
import type { OpsTask, PlanStep } from "@/types";

const rejected: PlanStep = {
  id: "rejected", kind: "observe", command: "kubeadm init --dry-run",
  title: "预检", description: "预检", expected: "dry-run 输出", validation: "", risk: "low", status: "pending",
};
const fixture = (): OpsTask => ({
  id: "task", serverId: "server", currentRoundId: "round", title: "部署集群", rootGoal: "部署集群",
  status: "needs_adjustment", permission: "managed", modelId: "model", messages: [],
  plan: [], createdAt: "now", updatedAt: "now",
  protocolRepair: { serverId: "server", roundId: "round", repairError: "PROTOCOL_REPAIR_SCOPE_VIOLATION",
    repair: { errorCode: "plan_normalization_failed", fieldPath: "steps[0].command", instruction: "局部修复",
      validationError: "observe 必须只读", previousModelOutput: [rejected],
      diagnostic: { code: "OBSERVE_COMMAND_MUTATION", stepIndex: 0, fieldPath: "steps[0].command",
        expected: "observe 必须只读", allowedRepairPaths: ["steps[0].command"], ruleVersion: 1 } } },
});

describe("protocol failure to business plan boundary", () => {
  it("exposes a rejected protocol proposal to the joint business decision without treating it as execution", () => {
    const task = fixture();
    const input = { task, tools: [], secretMetadata: [] };
    const local = buildAdjustmentContext(input);
    expect(local.planGenerationRepair).toBe(task.protocolRepair!.repair);
    expect(local.baseSnapshot).toBeUndefined();

    const business = buildNextStageContext(input);
    expect(business).not.toHaveProperty("planGenerationRepair");
    expect(business.workflowPhase).toBe("decide_after_protocol_failure");
    expect(business.protocolReplan).toMatchObject({ source: "business_replan_after_protocol_failure",
      rejectedPlanExecuted: false, rejectedStepCount: 1,
      rejectedStep: { command: rejected.command }, errorCode: "OBSERVE_COMMAND_MUTATION" });
    expect(business.baseSnapshot).toBeDefined();
    expect(business.instruction).toContain("根据整体目标和真实证据决定 complete、continue 或 adjust");
    expect(business.instruction).toContain("该方案未执行");
    expect(business.protocolReplan!.instruction).toContain("不是执行证据");
    expect(business.protocolReplan!.instruction).toContain("重新选择 kind");
    expect(business.protocolReplan!.instruction).toContain("可修正模型先前生成的不适用验收方法");
    expect(business.protocolReplan!.instruction).toContain("保留真实历史命令、失败结果与证据");
    expect(business.protocolReplan!.instruction).not.toContain("保留真实历史失败及其验收契约");
    expect(business.protocolReplan!.instruction).toContain("不得降低用户明确要求的验收标准");
    expect(business.protocolReplan!.instruction).not.toContain("用户点击");
    expect(task.protocolRepair!.repair.previousModelOutput).toEqual([rejected]);
  });

  it("a different round or execution target cannot reuse the rejected proposal", () => {
    const task = fixture();
    task.currentRoundId = "different-round";
    expect(activeProtocolRepair(task)).toBeUndefined();
    expect(protocolReplanContext(task)).toBeUndefined();
    task.currentRoundId = "round";
    task.executionTargetServerId = "other-server";
    expect(activeProtocolRepair(task)).toBeUndefined();
  });

  it.each([
    "curl -fsS -o /tmp/fixture-index.html http://localhost:8082/; rc=$?; grep -q 'fixture-marker' /tmp/fixture-index.html && echo matched || echo missing; exit $rc",
    'ok=1; ss -ltn | grep -q ":8082 " && echo listening=yes || echo listening=no; [ "$ok" = "1" ]',
    'code=200; ss -ltn | grep -q ":8082 " && echo listening=yes || echo listening=no; [ "$code" = "200" ]; rc=$?; exit "$rc"',
  ])("retains the rejected validation and precise safety rule for the phase-9-shaped proposal", validation => {
    const task = fixture();
    const step = { ...rejected, kind: "change" as const, command: "npm run preview -- --port 8082 --strictPort",
      expected: "服务由执行器跟踪，HTTP、内容与监听均通过验收", validation };
    task.protocolRepair!.repair = {
      errorCode: "plan_normalization_failed", fieldPath: "steps[0]", previousModelOutput: [step],
      validationError: "第 1 个计划步骤的 validation 未通过执行前安全检查（VALIDATION_FAILURE_ECHOED：后置校验失败后仅输出提示，无法证明预期结果）；必须修复该安全问题且保留真实退出状态",
      instruction: "重新规划",
    };
    const context = protocolReplanContext(task)!;
    expect(context).toMatchObject({ fieldPath: "steps[0].validation", ruleId: "VALIDATION_FAILURE_ECHOED",
      rejectedPlanExecuted: false, rejectedStep: { command: step.command, validation } });
    expect(context.correctionInstruction).toContain("即使末尾另有 exit 或断言");
    expect(context.correctionInstruction).toContain("只读、无落盘");
    expect(context.correctionInstruction).toContain("不要仅为消除此错误改变部署动作、端口或增加步骤");
    expect(context.correctionInstruction).toContain("完整校验与审批");
    expect(analyzePlanStepSafety(step.command, validation)).toMatchObject({ safe: false,
      issue: { field: "validation", ruleId: "VALIDATION_FAILURE_ECHOED" } });
    expect(task.protocolRepair!.repair.previousModelOutput[0]).toEqual(step);
  });

  it("keeps the offending validator intact even when its failed branch is in the middle of long text", () => {
    const task = fixture();
    const validation = `printf '%s' '${"fixture".repeat(350)}'; test -f fixture || echo missing; printf '%s' '${"fixture".repeat(400)}'; exit "$rc"`;
    task.protocolRepair!.repair = { errorCode: "plan_normalization_failed", fieldPath: "steps[0]",
      validationError: "第 1 个计划步骤的 validation 未通过执行前安全检查（VALIDATION_FAILURE_ECHOED：失败状态丢失）",
      instruction: "重新规划", previousModelOutput: [{ ...rejected, kind: "change", validation }] };
    expect(protocolReplanContext(task)!.rejectedStep!.validation).toBe(validation);
  });

  it("does not replace a structured diagnostic or invent one from unmatched prose", () => {
    const task = fixture();
    task.protocolRepair!.repair.previousModelOutput = [{ ...rejected, validation: "test -f fixture || echo missing" }];
    task.protocolRepair!.repair.validationError = "第 1 个计划步骤的 validation 未通过执行前安全检查（VALIDATION_FAILURE_ECHOED：失败状态丢失）";
    expect(protocolReplanContext(task)).toMatchObject({ fieldPath: "steps[0].command", ruleId: "OBSERVE_COMMAND_MUTATION" });
    expect(protocolReplanContext(task)!.correctionInstruction).toBeUndefined();
    delete task.protocolRepair!.repair.diagnostic;
    task.protocolRepair!.repair.validationError = "模型文字提到 VALIDATION_FAILURE_ECHOED，但实际拒绝原因为另一协议错误";
    expect(protocolReplanContext(task)!.ruleId).toBeUndefined();
    expect(protocolReplanContext(task)!.fieldPath).toBe("steps[0].command");
  });

  it("allocates fresh pending attempts and never copies approval or execution claims", () => {
    const dirty = { ...rejected, kind: "change" as const, status: "completed" as const,
      authenticationGate: { fingerprint: "old", reason: "old", approved: true },
      protocolReplanApproval: { inputFingerprint: "fake", decisionSummary: "model supplied" },
      safetyApprovalSnapshot: { command: rejected.command }, approvedSafetySnapshot: { command: rejected.command },
      startedAt: "old", attemptContext: "old-target", output: "success", validator: { type: "fake" },
      result: { executionStatus: "success" } } as unknown as PlanStep;
    const steps = freshProtocolReplanSteps([dirty, dirty]);
    expect(steps[0].id).not.toBe(steps[1].id);
    for (const candidate of steps) {
      expect(candidate).toMatchObject({ status: "pending", kind: "change", command: rejected.command });
      for (const key of ["approvedSafetySnapshot", "safetyApprovalSnapshot", "authenticationGate", "protocolReplanApproval",
        "startedAt", "attemptContext", "output", "result", "validator"]) expect(candidate).not.toHaveProperty(key);
    }
    expect(dirty.status).toBe("completed");
  });
});
