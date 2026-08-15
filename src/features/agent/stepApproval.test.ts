import { describe, expect, it } from "vitest";
import {
  acceptStepApproval,
  requestStepApproval,
} from "@/features/agent/stepApproval";
import type { PlanStep } from "@/types";

function step(risk: PlanStep["risk"], status: PlanStep["status"] = "pending"): PlanStep {
  return {
    id: "step-1",
    title: "部署服务",
    description: "部署服务",
    command: "systemctl restart app",
    risk,
    expected: "服务运行",
    validation: "systemctl is-active app",
    status,
  };
}

describe("step approval", () => {
  it("moves a step requiring approval into the waiting state", () => {
    const pending = step("medium");
    const request = requestStepApproval("safe", pending);

    expect(pending.status).toBe("awaiting_approval");
    expect(request).toEqual({
      taskStatus: "awaiting_step_approval",
      eventMessage: "步骤“部署服务”为中风险，需要单独确认。",
    });
  });

  it("leaves an automatically allowed step unchanged", () => {
    const pending = step("low");

    expect(requestStepApproval("safe", pending)).toBeUndefined();
    expect(pending.status).toBe("pending");
  });

  it("accepts only a step currently waiting for approval", () => {
    const waiting = step("high", "awaiting_approval");

    expect(acceptStepApproval(waiting)).toEqual({ taskStatus: "running", shouldExecute: true });
    expect(waiting.status).toBe("awaiting_approval");
  });

  it("rejects approval for a step that is not waiting", () => {
    expect(acceptStepApproval(step("high"))).toBeUndefined();
  });
});
