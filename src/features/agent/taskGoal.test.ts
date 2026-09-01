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
