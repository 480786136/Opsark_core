import { describe, expect, it } from "vitest";
import { activeProtocolRepair, freshProtocolReplanSteps, protocolReplanContext } from "./protocolReplan";
import { buildAdjustmentContext } from "./agentContext";
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
  it("only an explicit business transition discards the local field repair contract", () => {
    const task = fixture();
    const input = { task, tools: [], secretMetadata: [] };
    const local = buildAdjustmentContext(input);
    expect(local.planGenerationRepair).toBe(task.protocolRepair!.repair);
    expect(local.baseSnapshot).toBeUndefined();

    const business = buildAdjustmentContext(input, undefined, {
      replanAfterProtocolFailure: true, sharedSnapshot: { staleCachedPlan: "must-not-reuse" },
    });
    expect(business.planGenerationRepair).toBeUndefined();
    expect(business.workflowPhase).toBe("business_replan_after_protocol_failure");
    expect(business.protocolReplan).toMatchObject({ source: "business_replan_after_protocol_failure",
      rejectedPlanExecuted: false, rejectedStepCount: 1,
      rejectedStep: { command: rejected.command }, errorCode: "OBSERVE_COMMAND_MUTATION" });
    expect(business.baseSnapshot).toBeDefined();
    expect(JSON.stringify(business)).not.toContain("must-not-reuse");
    expect(business.instruction).toContain("重新选择 kind");
    expect(business.instruction).not.toContain("用户点击");
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
