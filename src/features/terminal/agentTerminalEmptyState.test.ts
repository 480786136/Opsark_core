import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep, TaskStatus } from "@/types";
import { agentTerminalEmptyState } from "./agentTerminalEmptyState";
import { i18n } from "@/features/preferences/i18n";

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "tool-step", action: { type: "tool", toolId: "server.resolve_connection", arguments: { host: "example.org" } },
    title: "Resolve connection", description: "", command: "", validation: "", expected: "", risk: "low",
    status: "running", ...overrides,
  };
}

function task(status: TaskStatus, overrides: Partial<OpsTask> = {}) {
  return { status, plan: [], ...overrides } as Pick<OpsTask, "status" | "plan" | "pauseReason" | "adjustmentInProgress">;
}

describe("Agent terminal empty state", () => {
  it("shows the actual planning failure instead of suggesting a command is queued", () => {
    const reason = "工具步骤不能夹带 Shell command、validation、validator 或会话变更";
    const state = agentTerminalEmptyState(task("planning_failed", {
      pauseReason: reason,
      plan: [step()],
    }));
    expect(state).toEqual({ messageKey: "terminal.agentEmpty.planningFailed", reason });
    expect(i18n.global.t(state.messageKey)).toContain("计划处理失败");
  });

  it.each([
    ["draft", "draft"],
    ["planning", "planning"],
    ["awaiting_plan_approval", "awaitingPlanApproval"],
    ["awaiting_step_approval", "awaitingStepApproval"],
    ["awaiting_input", "awaitingInput"],
    ["validating", "validating"],
    ["awaiting_continuation", "awaitingContinuation"],
    ["needs_adjustment", "needsAdjustment"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] satisfies Array<[TaskStatus, string]>)("uses task phase %s even if a stale tool step is marked running", (status, key) => {
    const state = agentTerminalEmptyState(task(status, { plan: [step()] }));
    expect(state.messageKey).toBe(`terminal.agentEmpty.${key}`);
    const message = i18n.global.t(state.messageKey);
    expect(message).not.toBe(state.messageKey);
    expect(message).not.toContain("发送命令");
    expect(state.toolId).toBeUndefined();
  });

  it("describes a running tool without implying SSH command dispatch", () => {
    const state = agentTerminalEmptyState(task("running", { plan: [step()] }));
    expect(state).toEqual({ messageKey: "terminal.agentEmpty.toolRunning", toolId: "server.resolve_connection" });
    expect(i18n.global.t(state.messageKey, { tool: state.toolId! })).toContain("正在执行工具 server.resolve_connection");
  });

  it("does not claim a pending tool has started", () => {
    expect(agentTerminalEmptyState(task("running", { plan: [step({ status: "pending" })] })).messageKey)
      .toBe("terminal.agentEmpty.running");
  });

  it("describes plan adjustment while one is actually in progress", () => {
    expect(agentTerminalEmptyState(task("needs_adjustment", { adjustmentInProgress: true, pauseReason: "previous failure" })))
      .toEqual({ messageKey: "terminal.agentEmpty.adjusting" });
  });

  it("falls back to the latest failed step reason without showing raw command output", () => {
    const failed = step({ status: "failed", output: "raw output that does not belong in the status" });
    failed.result = {
      executionStatus: "failed", observationStatus: "unknown", facts: {}, warnings: [], evidenceIds: [],
      failureReason: "Connection failed",
    };
    expect(agentTerminalEmptyState(task("failed", { pauseReason: "  ", plan: [failed] })).reason).toBe("Connection failed");
    expect(agentTerminalEmptyState(task("completed", { pauseReason: "old failure", plan: [failed] })).reason).toBeUndefined();
  });

  it("does not imply dispatch when the task is unavailable", () => {
    expect(agentTerminalEmptyState()).toEqual({ messageKey: "terminal.agentEmpty.unavailable" });
  });
});
