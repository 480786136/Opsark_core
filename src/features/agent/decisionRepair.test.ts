import { describe, expect, it } from "vitest";
import type { NextStageDecision, PlanStep } from "@/types";
import { assertDecisionRepairPreserved, decisionRepairContext, decisionRepairFingerprint } from "./decisionRepair";
import { ExecutionPolicyError } from "./recoveryContract";

const read = (id: string, command: string): PlanStep => ({ id, title: id, description: "只读核对，不修改服务",
  kind: "observe", command, action: { type: "shell", command }, validation: "", expected: "获得真实状态",
  executionScope: "isolated_exec", validationScope: "isolated_exec", runtimeClass: "bounded", risk: "low", status: "pending" });
const proposal = (): NextStageDecision => ({ decision: "continue", source: "model", reason: "根据状态继续诊断", summary: "部署尚未完成",
  steps: [read("unit", "systemctl show core-case-static.service -p MainPID -p ActiveState"), read("ports", "ss -lntp")] });

describe("decision metadata repair preserves execution", () => {
  it("accepts requirement metadata and display corrections while retaining executable fields", () => {
    const original = proposal(), repaired = structuredClone(original);
    repaired.reason = "补齐需求验收引用"; repaired.summary = "先保留已完成结果，再诊断";
    repaired.steps.forEach((step, index) => { step.id = `regenerated-${index}`; step.title = "修正标题"; step.description = "修正说明"; });
    repaired.requirementReview = { baseRevision: 8, roundId: "round", focusOutcome: "pending", overallOutcome: "pending",
      items: [{ requirementId: "deployment", outcome: "unknown", reason: "仍待检查", evidenceIds: [] }] };
    repaired.issueResolutions = [];
    expect(() => assertDecisionRepairPreserved(decisionRepairFingerprint(original), repaired)).not.toThrow();
  });

  it.each([
    ["append kill", (decision: NextStageDecision) => { decision.steps.push({ ...read("kill", "kill 68474"), kind: "change", risk: "medium" }); }],
    ["replace command", (decision: NextStageDecision) => { decision.steps[0].command = "kill 68474"; decision.steps[0].action = { type: "shell", command: "kill 68474" }; }],
    ["change action only", (decision: NextStageDecision) => { decision.steps[0].action = { type: "shell", command: "systemctl restart core-case-static.service" }; }],
    ["add question", (decision: NextStageDecision) => { decision.steps[0].action = { type: "tool", toolId: "user.request_input", arguments: {} }; }],
    ["change validation", (decision: NextStageDecision) => { decision.steps[0].validation = "kill 68474"; }],
    ["change scope", (decision: NextStageDecision) => { decision.steps[0].executionScope = "agent_session"; }],
    ["change validation scope", (decision: NextStageDecision) => { decision.steps[0].validationScope = "fresh_login_shell"; }],
    ["change expected", (decision: NextStageDecision) => { decision.steps[0].expected = "退出0即可视为部署成功"; }],
    ["change kind", (decision: NextStageDecision) => { decision.steps[0].kind = "change"; }],
    ["change runtime", (decision: NextStageDecision) => { decision.steps[0].runtimeClass = "persistent_service"; }],
    ["change risk", (decision: NextStageDecision) => { decision.steps[0].risk = "high"; }],
    ["change order", (decision: NextStageDecision) => { decision.steps.reverse(); }],
    ["remove step", (decision: NextStageDecision) => { decision.steps.pop(); }],
    ["change session", (decision: NextStageDecision) => { decision.steps[0].sessionContextChange = { cwd: "/other" }; }],
    ["add retry authority", (decision: NextStageDecision) => { decision.steps[0].retryBasis = { kind: "transient", failedStepId: "failed", evidenceIds: ["proof"], reason: "再试" }; }],
    ["add plan replacement", (decision: NextStageDecision) => { decision.planUpdate = { basePlanFingerprint: "plan", replaceStepIds: ["existing"], reason: "换动作" }; }],
    ["add reconciliation", (decision: NextStageDecision) => { decision.reconciliation = { incidentId: "incident", status: "safe_to_retry", reason: "可重试", evidenceIds: ["proof"] }; }],
  ] as const)("rejects %s during metadata correction", (_label, change) => {
    const original = proposal(), repaired = structuredClone(original);
    change(repaired);
    expect(() => assertDecisionRepairPreserved(decisionRepairFingerprint(original), repaired)).toThrow(ExecutionPolicyError);
  });

  it("rejects changing a structured tool's arguments", () => {
    const original = proposal();
    original.steps = [{ ...read("read", ""), action: { type: "tool", toolId: "files.read_content", arguments: { path: "/app/config" } } }];
    const repaired = structuredClone(original);
    if (repaired.steps[0].action?.type === "tool") repaired.steps[0].action.arguments.path = "/etc/shadow";
    expect(() => assertDecisionRepairPreserved(decisionRepairFingerprint(original), repaired)).toThrow(ExecutionPolicyError);
  });

  it("sends the candidate execution contract as repair context without claiming it executed", () => {
    const candidate = proposal();
    candidate.steps[0].output = "untrusted candidate output";
    const context = decisionRepairContext(candidate);
    expect(context.steps[0].action).toEqual(candidate.steps[0].action);
    expect(context.steps[0]).not.toHaveProperty("output");
    expect(context.steps[0]).not.toHaveProperty("status");
    expect(context.instruction).toContain("不能作为执行事实或授权");
    expect(context.instruction).toContain("不得新增");
  });
});
