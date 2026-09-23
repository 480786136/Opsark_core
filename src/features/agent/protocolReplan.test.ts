import { describe, expect, it } from "vitest";
import { activeProtocolRepair, freshProtocolReplanSteps, protocolReplanContext } from "./protocolReplan";
import { buildAdjustmentContext, buildNextStageContext } from "./agentContext";
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
