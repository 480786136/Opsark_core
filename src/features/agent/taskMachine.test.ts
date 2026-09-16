import { describe, expect, it } from "vitest";
import { beginRequirementPlanning, canTransitionTask, transitionTask } from "@/features/agent/taskMachine";
import type { OpsTask } from "@/types";

function task(status: OpsTask["status"]): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "任务",
    status,
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan: [],
    createdAt: "old",
    updatedAt: "old",
  };
}

describe("task machine", () => {
  it("allows documented state transitions", () => {
    expect(canTransitionTask("draft", "planning")).toBe(true);
    expect(canTransitionTask("running", "validating")).toBe(true);
    expect(canTransitionTask("validating", "needs_adjustment")).toBe(true);
    expect(canTransitionTask("running", "planning")).toBe(true);
    expect(canTransitionTask("planning", "needs_adjustment")).toBe(true);
    expect(canTransitionTask("failed", "needs_adjustment")).toBe(true);
  });

  it("rejects impossible transitions", () => {
    expect(canTransitionTask("draft", "completed")).toBe(false);
    expect(() => transitionTask(task("draft"), "completed")).toThrow("非法任务状态迁移");
  });

  it("allows planning and review to ask directly without weakening input waiting", () => {
    for (const status of ["planning", "validating", "awaiting_plan_approval"] as const) {
      expect(canTransitionTask(status, "awaiting_input")).toBe(true);
    }
    for (const status of ["planning", "validating", "completed", "needs_adjustment"] as const) {
      expect(canTransitionTask("awaiting_input", status)).toBe(false);
    }
  });

  it("only a classified execution requirement can replace an input/approval wait", () => {
    const current = task("awaiting_input");
    expect(() => beginRequirementPlanning(current, "side_question")).toThrow();
    expect(() => beginRequirementPlanning(current, "continue")).toThrow("必须由用户确认");
    expect(current.status).toBe("awaiting_input");
    beginRequirementPlanning(current, "supplement");
    expect(current.status).toBe("planning");
  });

  it("updates status and audit timestamp together", () => {
    const current = task("draft");
    transitionTask(current, "planning", "2026-08-14T01:00:00.000Z");
    expect(current.status).toBe("planning");
    expect(current.updatedAt).toBe("2026-08-14T01:00:00.000Z");
  });
});
