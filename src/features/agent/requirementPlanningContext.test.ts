import { describe, expect, it } from "vitest";
import type { RequirementProcessingResult, TaskRequirementLifecycle } from "@/types";
import { projectClassifiedRequirementContext } from "./requirementPlanningContext";

function setup() {
  const state: TaskRequirementLifecycle = { version: 1, revision: 2, items: [
    { id: "deploy", kind: "goal", content: "部署项目", status: "active", evidenceIds: [],
      source: { content: "部署项目，端口8080，仅内网访问", source: "user_message", relation: "new_goal", sourceMessageId: "initial" } },
    { id: "port", kind: "constraint", content: "端口8080", status: "active", evidenceIds: [],
      source: { content: "部署项目，端口8080，仅内网访问", source: "user_message", relation: "new_goal", sourceMessageId: "initial" } },
    { id: "private", kind: "constraint", content: "仅内网访问", status: "active", evidenceIds: [],
      source: { content: "部署项目，端口8080，仅内网访问", source: "user_message", relation: "new_goal", sourceMessageId: "initial" } },
  ], focus: { roundId: "previous-round", requirementIds: ["deploy", "port", "private"] } };
  const context = { taskGoal: { rootGoal: "部署项目", currentInstruction: "部署项目", currentRoundId: "previous-round", lifecycle: state },
    baseSnapshot: { taskRequirements: { lifecycle: state } },
    requirementSubmission: { sourceMessageId: "latest", baseRevision: 2, content: "端口改为8081", baseLifecycle: state } };
  const result: RequirementProcessingResult = { intent: "execute", relation: "supplement", plan: [],
    requirementUpdate: { baseRevision: 2, sourceMessageId: "latest", additions: [
      { id: "new-port", kind: "constraint", content: "端口8081", sourceQuote: "端口改为8081", supersedes: ["port"] },
    ], changes: [], focusIds: ["new-port"] } };
  return { context, result };
}

describe("classification planning projection", () => {
  it("uses the latest focus and surviving constraints without mutating the old task", () => {
    const { context, result } = setup();
    const original = structuredClone(context);
    const projected = projectClassifiedRequirementContext(context, result, "端口改为8081").context;
    expect(projected.taskGoal.currentInstruction).toBe("端口改为8081");
    expect(projected.taskGoal.lifecycle.revision).toBe(3);
    expect(projected.taskGoal.requirementContext.focus.map((item: { id: string }) => item.id)).toEqual(["new-port"]);
    expect(projected.taskGoal.requirementContext.activeConstraints.map((item: { content: string }) => item.content))
      .toEqual(["仅内网访问", "端口8081"]);
    expect(projected.baseSnapshot.taskRequirements).toEqual(projected.taskGoal);
    expect(projected.requirementSubmission).not.toHaveProperty("baseLifecycle");
    expect(context).toEqual(original);
  });

  it.each(["new_goal", "replace_goal"] as const)("isolates a %s from old goals", relation => {
    const { context, result } = setup();
    result.relation = relation;
    result.requirementUpdate!.additions[0].supersedes = [];
    const projected = projectClassifiedRequirementContext(context, result, "端口改为8081").context;
    expect(projected.taskGoal.rootGoal).toBe("端口改为8081");
    expect(projected.taskGoal.lifecycle.items.map((item: { id: string }) => item.id)).toEqual(["new-port"]);
  });

  it("reactivates a compressed historical goal from retained local provenance", () => {
    const { context, result } = setup();
    const past = { ...context.requirementSubmission.baseLifecycle.items[0], id: "past", content: "重新检查旧项目的完整约定",
      status: "satisfied" as const, evidenceIds: ["old-proof"] };
    context.requirementSubmission.baseLifecycle = { ...context.requirementSubmission.baseLifecycle,
      items: [...context.requirementSubmission.baseLifecycle.items, past] };
    context.requirementSubmission.content = "重新检查旧项目";
    result.requirementUpdate = { baseRevision: 2, sourceMessageId: "latest", additions: [],
      changes: [{ id: "past", status: "active", sourceQuote: "重新检查旧项目", reason: "用户要求重新检查" }], focusIds: ["past"] };
    const projected = projectClassifiedRequirementContext(context, result, "重新检查旧项目").context;
    expect(projected.taskGoal.requirementContext.focus[0]).toMatchObject({ id: "past", content: past.content,
      status: "active", evidenceIds: [] });
    expect(projected.requirementSubmission).not.toHaveProperty("baseLifecycle");
  });
});
