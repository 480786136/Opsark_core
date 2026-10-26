import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";
import { DECISION_OUTPUT_BUDGET } from "./decisionEvidence";

function step(id: string, output: string, target = "target-a"): PlanStep {
  return { id, title: id, description: "读取已有证据", command: "inspect", validation: "", expected: "返回实际状态",
    kind: "observe", risk: "low", status: "completed", output, attemptContext: target,
    result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: [id] },
    evidence: [{ id, source: "main", type: "command-output", rawOutput: output, facts: {}, collectedAt: "2026-10-22T01:00:00Z" }] };
}
function task(plan: PlanStep[]): OpsTask {
  return { id: "scope-task", serverId: "server-a", currentRoundId: "round-a", title: "核对已有状态", status: "needs_adjustment",
    permission: "safe", modelId: "fixture", plan, messages: [], createdAt: "now", updatedAt: "now" };
}
const moderate = "first\n" + "ordinary line\n".repeat(100) + "MIDDLE_VALUE=actual\n" + "ordinary line\n".repeat(100) + "last\n";

describe("跨阶段证据分配", () => {
  it("全局预算足够时保留中等长度的完整原文，而不是固定截取头尾", () => {
    const source = step("source", moderate), current = task([step("latest", "LATEST=ok")]);
    current.phaseHistory = [{ id: "earlier", roundId: "round-a", reason: "adjustment", requirement: "核对状态",
      plan: [source], createdAt: "now", completedAt: "now" }];
    const output = buildTaskDecisionSnapshot(current).recentPhases[0].steps[0].output;
    expect(output).toMatchObject({ content: moderate, contentState: "complete", omittedCharacters: 0 });
    expect(source.output).toBe(moderate);
  });
  it("早期阶段进入checkpoint后仍能展示同一执行的完整正文", () => {
    const source = step("source", moderate), current = task([]);
    current.phaseHistory = [source, ...Array.from({ length: 4 }, (_, i) => step(`next-${i}`, `NEXT=${i}`))].map((s, i) => ({
      id: `phase-${i}`, roundId: "round-a", reason: "adjustment", requirement: "核对状态", plan: [s], createdAt: "now", completedAt: "now" }));
    const output = buildTaskDecisionSnapshot(current).historyCheckpoint?.verifiedFacts[0].output;
    expect(output).toMatchObject({ content: moderate, contentState: "complete" });
  });
  it("不同目标和不同执行保留身份，不能因正文相同而串用", () => {
    const current = task([step("shared", moderate, "target-b")]);
    current.phaseHistory = [{ id: "a", roundId: "round-a", reason: "adjustment", requirement: "旧目标",
      plan: [step("shared", moderate)], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.currentPlan.steps[0].targetContext).toBe("target-b");
    expect(snapshot.recentPhases[0].steps[0].targetContext).toBe("target-a");
    expect(snapshot.recentPhases[0].steps[0].output?.contentRef).toBeUndefined();
  });
  it("完整优先仍服从既有全局输出上限", () => {
    const current = task(Array.from({ length: 20 }, (_, i) => step(`${i}`, moderate)));
    const snapshot = buildTaskDecisionSnapshot(current);
    const bodies = snapshot.currentPlan.steps.map(s => s.output?.content ?? "");
    expect(bodies.join("").length).toBeLessThanOrEqual(DECISION_OUTPUT_BUDGET);
    expect(snapshot.currentPlan.steps[0].output?.contentState).toBe("omitted");
  });
  it("展开中间正文前遮蔽敏感字段，保留正常事实", () => {
    const raw = moderate.replace("MIDDLE_VALUE=actual", "MIDDLE_VALUE=actual\npassword=PRIVATE_FIXTURE_SECRET\napi_key=PRIVATE_FIXTURE_KEY");
    const snapshot = buildTaskDecisionSnapshot(task([step("secret", raw)]));
    const text = JSON.stringify(snapshot);
    expect(text).toContain("MIDDLE_VALUE=actual");
    expect(text).not.toContain("PRIVATE_FIXTURE_SECRET"); expect(text).not.toContain("PRIVATE_FIXTURE_KEY");
  });
  it.each(["taskId", "stepId", "sourceEvidenceId", "targetContext"] as const)("拒绝指纹相同但%s不匹配的引用", field => {
    const source = step("source", moderate);
    source.evidence![0].archive = { evidenceId: "b".repeat(64), characters: moderate.length,
      fingerprint: "", capturedPartial: false, [field]: "wrong-identity" };
    // Obtain the real original-text fingerprint without mutating captured content.
    source.evidence![0].archive!.fingerprint = buildTaskDecisionSnapshot(task([source])).currentPlan.steps[0].output!.fingerprint;
    const output = buildTaskDecisionSnapshot(task([source]), undefined, true).currentPlan.steps[0].output;
    expect(output?.references).toBeUndefined();
  });
});
