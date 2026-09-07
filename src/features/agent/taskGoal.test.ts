import { describe, expect, it } from "vitest";
import {
  activeRoundSteps,
  allTaskSteps,
  archiveActivePhase,
  capturePreviousRound,
  commitPreviousRound,
  mergeTaskSkillIds,
  normalizeRequirementRelation,
  taskGoal,
} from "@/features/agent/taskGoal";
import { buildTaskDecisionSnapshot } from "@/features/agent/taskDecisionSnapshot";
import type { OpsTask, PlanStep } from "@/types";

function step(id: string, status: PlanStep["status"] = "completed"): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command: `echo ${id}`,
    expected: id,
    validation: "true",
    risk: "low",
    status,
  };
}

function task(): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "部署 office",
    rootGoal: "帮我部署 office 项目",
    currentInstruction: "继续部署",
    currentRoundId: "round-1",
    status: "completed",
    permission: "managed",
    modelId: "model-1",
    messages: [
      { id: "m1", role: "user", kind: "message", content: "帮我部署 office 项目", createdAt: "2026-01-01" },
      { id: "m2", role: "user", kind: "message", content: "重试", createdAt: "2026-01-02" },
    ],
    plan: [step("composer")],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  };
}

describe("task goal lifecycle", () => {
<<<<<<< HEAD
=======
  it("retains all unresolved issues and never resolves a different target by command text", () => {
    const current = task();
    const closeRound = (date: string) => {
      const snapshot = capturePreviousRound(current, date)!;
      snapshot.history.id = date;
      commitPreviousRound(current, snapshot);
    };
    current.plan = Array.from({ length: 10 }, (_, index) => ({ ...step(`failure-${index}`, "failed"),
      attemptContext: "server-a", command: `check-${index}` }));
    closeRound("2026-01-03");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(10);
    current.plan = [{ ...step("recheck"), command: "check-0", attemptContext: "server-b",
      result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: ["proof"] },
      evidence: [{ id: "proof", type: "command-output", source: "main", facts: {}, rawOutput: "ok", collectedAt: "now" }],
    }];
    closeRound("2026-01-04");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(10);
    current.plan[0].attemptContext = "server-a";
    closeRound("2026-01-05");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(9);
    expect(buildTaskDecisionSnapshot(current).historyCheckpoint?.unresolvedIssues).toHaveLength(9);
  });
>>>>>>> origin/master
  it("keeps the root goal instead of replacing it with retry text", () => {
    expect(taskGoal(task())).toBe("帮我部署 office 项目");
  });

  it("preserves superseded adjustment phases in the complete evidence ledger", () => {
    const current = task();
    current.pauseReason = "依赖已安装，但服务尚未启动。";
    archiveActivePhase(current, "adjustment", "2026-01-03T00:00:00.000Z");
    current.plan = [step("web-server", "pending")];

    expect(current.phaseHistory?.[0]?.summary).toBe("依赖已安装，但服务尚未启动。");
    expect(activeRoundSteps(current).map(({ id }) => id)).toEqual(["composer", "web-server"]);
    expect(allTaskSteps(current).map(({ id }) => id)).toEqual(["composer", "web-server"]);

    const snapshot = capturePreviousRound(current, "2026-01-04T00:00:00.000Z");
    commitPreviousRound(current, snapshot);
    expect(current.planHistory?.[0]?.phases?.[0]).toMatchObject({
      reason: "adjustment",
      summary: "依赖已安装，但服务尚未启动。",
    });
    expect(current.planHistory?.[0]?.finalPlan?.map(({ id }) => id)).toEqual(["web-server"]);
    expect(current.phaseHistory).toEqual([]);
  });

  it("keeps two recent phases detailed and rolls older evidence into a bounded checkpoint", () => {
    const current = task();
    for (let index = 1; index <= 4; index += 1) {
      current.plan = [{
        ...step(`phase-step-${index}`),
        output: index === 1 ? "OLD_RAW_OUTPUT_MUST_NOT_REACH_MODEL" : `output-${index}`,
        result: {
          executionStatus: "success",
          observationStatus: "matched",
          exitCode: 0,
          facts: { category: "verified", value: index },
          warnings: [],
          evidenceIds: [],
        },
      }];
      archiveActivePhase(current, "adjustment", `2026-01-0${index + 2}T00:00:00.000Z`, `phase ${index}`);
    }
    current.plan = [step("current-pending", "pending")];

    expect(current.historyCheckpoint).toMatchObject({
      sourcePhaseCount: 2,
      sourceStepCount: 2,
    });
    expect(current.historyCheckpoint?.verifiedFacts.map(({ stepId }) => stepId))
      .toEqual(["phase-step-1", "phase-step-2"]);

    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.recentPhases.map(({ steps }) => steps[0]?.stepId))
      .toEqual(["phase-step-3", "phase-step-4"]);
    expect(snapshot.historyCheckpoint?.phaseSummaries.map(({ summary }) => summary))
      .toEqual(["phase 1", "phase 2"]);
    expect(snapshot.progress.totalSteps).toBe(5);
    expect(JSON.stringify(snapshot)).not.toContain("OLD_RAW_OUTPUT_MUST_NOT_REACH_MODEL");
  });

  it("uses model relation when available and has a safe continuation fallback", () => {
    expect(normalizeRequirementRelation({
      intent: "execute",
      relation: "supplement",
      plan: [],
    }, "数据库使用已有实例", true)).toBe("supplement");
    expect(normalizeRequirementRelation({ intent: "execute", plan: [] }, "继续部署", true)).toBe("continue");
  });

  it("uses the model's complete current Skill set so stale matches can be removed", () => {
    expect(mergeTaskSkillIds(["source", "build"], ["build", "deploy"], "continue"))
      .toEqual(["build", "deploy"]);
    expect(mergeTaskSkillIds(["ssh-terminal-jump"], [], "continue"))
      .toEqual([]);
    expect(mergeTaskSkillIds(["source", "build"], ["transfer"], "new_goal"))
      .toEqual(["transfer"]);
  });
});
