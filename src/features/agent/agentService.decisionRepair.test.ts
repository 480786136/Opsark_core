import { describe, expect, it, vi } from "vitest";
import type { NextStageDecision, OpsTask, PlanStep } from "@/types";
import { decideTaskNextStage } from "./agentService";
import { ExecutionPolicyError } from "./recoveryContract";

const read = (id: string, command = "ss -lntp"): PlanStep => ({ id, title: "只读核对端口", description: "检查端口归属",
  kind: "observe", command, action: { type: "shell", command }, expected: "取得监听事实", validation: "", risk: "low", status: "pending" });
function setup() {
  const time = "2026-10-02T03:16:00.000Z";
  const task: OpsTask = { id: "task", serverId: "server", title: "部署站点", rootGoal: "部署站点", status: "needs_adjustment",
    permission: "managed", modelId: "model", currentRoundId: "round", messages: [], plan: [], createdAt: time, updatedAt: time,
    requirementLifecycle: { version: 1, revision: 8, focus: { roundId: "round", requirementIds: ["deployment"] },
      items: [{ id: "deployment", kind: "goal", content: "部署站点", status: "active", evidenceIds: [],
        source: { content: "部署站点", source: "user_message", relation: "new_goal", sourceMessageId: "message", createdAt: time } }] } };
  const candidate: NextStageDecision = { decision: "continue", source: "model", reason: "先只读核对服务", summary: "目标尚未完成", steps: [read("read")] };
  const repair: NextStageDecision = { ...structuredClone(candidate), steps: [read("new-id")],
    requirementReview: { baseRevision: 8, roundId: "round", focusOutcome: "pending", overallOutcome: "pending",
      items: [{ requirementId: "deployment", outcome: "unknown", reason: "先核对端口与服务", evidenceIds: [] }] } };
  const input = { task, model: { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true },
    apiKey: "fixture", tools: [], secretMetadata: [], skills: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } };
  return { task, candidate, repair, input };
}

describe("requirement correction through the actual stage decision service", () => {
  it("repairs missing requirementReview once and preserves the original read action", async () => {
    const { task, candidate, repair, input } = setup();
    const original = structuredClone(task);
    const decide = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(repair);
    const result = await decideTaskNextStage(input, decide);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.nextPlan[0].action).toEqual(candidate.steps[0].action);
    expect(result.complete).toBe(false);
    expect(task).toEqual(original);
    const context = JSON.parse(decide.mock.calls[1][1].context);
    expect(context.operationalRepair.reason).toContain("requirementReview");
    expect(context.operationalRepair.rejectedProposal.responseMode).toBe("metadata_fields");
    expect(context.operationalRepair.rejectedProposal.steps[0].expected).toBe(candidate.steps[0].expected);
    expect(context.operationalRepair.rejectedProposal.steps[0].action).toEqual(candidate.steps[0].action);
    expect(context.protocolRepairBudget.remainingModelCalls).toBe(1);
    expect(context._modelRecovery).toEqual(JSON.parse(decide.mock.calls[0][1].context)._modelRecovery);
  });

  it("rejects the actual incident pattern where metadata correction appends kill/restart", async () => {
    const { task, candidate, repair, input } = setup();
    repair.steps.push({ ...read("kill", "kill 68474\nsystemctl restart core-case-static.service"), kind: "change", risk: "medium" });
    const original = structuredClone(task);
    const decide = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(repair);
    await expect(decideTaskNextStage(input, decide)).rejects.toBeInstanceOf(ExecutionPolicyError);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(task).toEqual(original);
  });
});
