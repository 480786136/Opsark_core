import { describe, expect, it } from "vitest";
import { applyCommandFailureReview, applyExecutionEvidenceReview } from "./reviewCoordination";
import { applyFailureDisposition, failureDependencyBlocker, holdFailureDependents } from "./failureDisposition";
import { resolveStepDispatch } from "./executionDispatch";
import { classifyStepResult } from "@/services/validation";
import type { PlanStep, StepReview } from "@/types";

function step(id: string): PlanStep {
  return { id, title: id, description: id, command: "npm run build:prod", validation: "test -f dist/index.html",
    expected: "静态产物可用", risk: "medium", kind: "change", status: "pending" };
}
function independent(ids: string[]): StepReview {
  return { decision: "continue", source: "model", reason: "已有明确依据", summary: "继续独立检查",
    recoveryAction: { kind: "continue_independent", reason: "与失败结果独立",
      steps: ids.map(stepId => ({ stepId, relation: "independent", reason: "读取另一独立组件的已有状态" })) } };
}

describe("failure disposition and semantic acceptance", () => {
  it("replays the map-link failure: prose repair + legacy continue cannot start build", () => {
    const failed = { ...step("map-link"), status: "failed" as const };
    const build = step("ui-build");
    const review: StepReview = { decision: "continue", source: "model", reason: "应先修复链接再继续，不应跳过", summary: "先修复" };
    expect(applyCommandFailureReview(failed, [build], review).shouldAdvance).toBe(false);
    const restored = JSON.parse(JSON.stringify(build));
    expect(resolveStepDispatch(restored, [], "call").kind).toBe("invalid");
    expect(failed.status).toBe("failed");
  });

  it("allows an independent prefix then stops at the dependent step", () => {
    const failed = step("link");
    const steps = [step("backend-check"), step("ui-build")];
    const review = independent(steps.map(s => s.id));
    review.recoveryAction!.steps[1] = { stepId: "ui-build", relation: "dependent", reason: "需要地图链接成功" };
    expect(applyFailureDisposition(failed, steps, review)).toBe(true);
    expect(failureDependencyBlocker(steps[0])).toBeUndefined();
    expect(failureDependencyBlocker(steps[1])).toContain("需要地图链接成功");
    steps[0].status = "validating";
    applyExecutionEvidenceReview({ step: steps[0], remainingSteps: [steps[1]],
      review: { decision: "complete", source: "model", reason: "检查完成", summary: "检查完成" }, reviewWasRequired: true });
    expect(steps[1].status).toBe("pending");
    expect(resolveStepDispatch(steps[1], [], "later").kind).toBe("invalid");
  });

  it.each(["missing", "duplicate", "unknown_id", "no_reason", "dependent", "unknown"])("fails closed on %s judgments", mode => {
    const steps = [step("a"), step("b")];
    const review = independent(["a", "b"]);
    const entries = review.recoveryAction!.steps;
    if (mode === "missing") entries.pop();
    if (mode === "duplicate") entries[1].stepId = "a";
    if (mode === "unknown_id") entries[1].stepId = "ghost";
    if (mode === "no_reason") entries[0].reason = " ";
    if (mode === "dependent" || mode === "unknown") entries[0].relation = mode;
    expect(applyFailureDisposition(step("failed"), steps, review)).toBe(false);
    expect(failureDependencyBlocker(steps[0])).toBeTruthy();
  });

  it.each(["repair", "retry", "replan", "request_input"] as const)("routes %s to planning without executing explanatory text", kind => {
    const review = independent(["build"]);
    review.recoveryAction!.kind = kind;
    expect(applyCommandFailureReview(step("failed"), [step("build")], review).shouldAdvance).toBe(false);
  });

  it("does not clear an earlier unresolved dependency with a later independent judgment", () => {
    const pending = step("build");
    holdFailureDependents(step("earlier"), [pending]);
    expect(applyFailureDisposition(step("later"), [pending], independent(["build"]))).toBe(false);
    expect(pending.failureDependencies?.[0].failedStepId).toBe("earlier");
  });

  it("invalidates an independent judgment after changing the executable step", () => {
    const pending = step("build");
    expect(applyFailureDisposition(step("failed"), [pending], independent(["build"]))).toBe(true);
    expect(resolveStepDispatch(pending, [], "before").kind).toBe("command");
    pending.command = "npm run deploy";
    expect(resolveStepDispatch(pending, [], "after").kind).toBe("invalid");
  });

  it.each(["missing", "forged", "not_met", "unknown", "proven"])("handles %s acceptance separately from exit zero", status => {
    const current = { ...step("map-package"), command: "npm install --no-save echarts-map-collection" };
    const classified = classifyStepResult(current, { success: true, exitCode: 0, output: "added 1 package" },
      { passed: true, exitCode: 0, detail: "", output: status === "proven"
        ? "PROVINCE_DIR=/opt/report/maps/province\nGUIZHOU_MAP_FILE_PRESENT"
        : "PROVINCE_DIR=\nls: 无法访问 '': 没有那个文件或目录" });
    expect(classified.needsModelReview).toBe(true);
    current.result = classified.result;
    current.evidence = classified.evidence;
    current.status = "validating";
    const review: StepReview = { decision: "continue", reason: "解释当前结果", summary: "检查结果", source: "model" };
    if (status !== "missing") review.acceptance = { status: status === "forged" ? "proven" : status as "proven" | "not_met" | "unknown",
      reason: "验收依据", evidenceIds: [status === "forged" ? "invented" : classified.evidence[1].id] };
    const next = step("build");
    const outcome = applyExecutionEvidenceReview({ step: current, remainingSteps: [next], review, reviewWasRequired: true });
    expect(current.status).toBe(status === "proven" ? "completed" : "failed");
    expect(outcome.shouldAdvance).toBe(status === "proven");
    expect(current.result.exitCode).toBe(0);
  });

  it.each(["failed_validation", "rules_fallback"])("cannot promote %s into proven acceptance", mode => {
    const current = step("change");
    const classified = classifyStepResult(current, { success: true, exitCode: 0, output: "changed" },
      { passed: mode !== "failed_validation", exitCode: mode === "failed_validation" ? 1 : 0, detail: "checked" });
    current.result = classified.result;
    current.evidence = classified.evidence;
    current.status = "validating";
    const outcome = applyExecutionEvidenceReview({ step: current, remainingSteps: [], reviewWasRequired: true,
      review: { decision: "complete", reason: "finished", summary: "finished",
        source: mode === "rules_fallback" ? "rules" : "model",
        acceptance: { status: "proven", reason: "claimed", evidenceIds: [classified.evidence[1].id] },
      },
    });
    expect(outcome.shouldAdvance).toBe(false);
    expect(current.result.facts.semanticAcceptanceStatus).toBe("unknown");
    expect(current.result.executionStatus).toBe("success");
  });
});
