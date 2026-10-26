import { describe, expect, it, vi } from "vitest";
import type { NextStageDecision, OpsTask, PlanStep } from "@/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { decideTaskNextStage } from "./agentService";
import { ObservationPlanError } from "./observationPlanProgress";
import { taskAttemptContext } from "./attemptState";

function setup() {
  const task: OpsTask = { id: "task", serverId: "server", currentRoundId: "round", title: "按交接说明部署服务", status: "awaiting_continuation",
    permission: "managed", modelId: "model", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
  const probe = (id: string): PlanStep => ({ id, title: "读取目录与交接", description: "继续推进", expected: "得到交接说明",
    kind: "observe", risk: "low", status: "pending", command: "", validation: "",
    action: { type: "tool", toolId: "software.check", arguments: { names: ["unused"] } } });
  task.plan = [{ ...probe("before"), status: "completed", attemptContext: taskAttemptContext(task), output: "软件不存在",
    result: { executionStatus: "success", observationStatus: "not_found", facts: { commandDispatched: true }, warnings: [], evidenceIds: ["receipt"] } }];
  const candidate: NextStageDecision = { decision: "continue", source: "model", reason: "现在读取目录", summary: "准备读取交接", steps: [probe("duplicate")] };
  const corrected: NextStageDecision = { ...candidate, steps: [{ ...probe("actual-directory"),
    action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/opt/service" } } }] };
  const input = { task, model: { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true },
    apiKey: "fixture", tools: defaultToolCatalog, secretMetadata: [], skills: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 24, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } };
  return { task, input, candidate, corrected };
}

describe("observation progress admission through the stage service", () => {
  it("rejects an action repeating old evidence and regenerates once under the original budget", async () => {
    const { task, input, candidate, corrected } = setup();
    const original = structuredClone(task);
    const decide = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(corrected);
    const result = await decideTaskNextStage(input, decide);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.nextPlan[0].action).toMatchObject({ toolId: "files.get_structure", arguments: { rootPath: "/opt/service" } });
    expect(task).toEqual(original);
    const first = JSON.parse(decide.mock.calls[0][1].context);
    const second = JSON.parse(decide.mock.calls[1][1].context);
    expect(second._modelRecovery).toEqual(first._modelRecovery);
    expect(second.outputRecovery.rejectedCandidateExecuted).toBe(false);
    expect(second.outputRecovery.diagnostic).toMatchObject({ code: "OBSERVATION_PLAN_NO_PROGRESS", issues: [
      { code: "observation_already_available", previousStepId: "before", evidenceIds: ["receipt"] },
    ] });
    expect(result.outputRegenerated).toBe(true);
  });

  it("stops a repeated regenerated proposal without a third call or task mutation", async () => {
    const { task, input, candidate } = setup();
    const original = structuredClone(task);
    const decide = vi.fn().mockResolvedValue(candidate);
    await expect(decideTaskNextStage(input, decide)).rejects.toBeInstanceOf(ObservationPlanError);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(task).toEqual(original);
  });
});
