import { describe, expect, it } from "vitest";
import type { OpsTask } from "@/types";
import { buildAgentContext, buildAdjustmentContext, buildContinuationContext, buildNextStageContext } from "./agentContext";
import { duplicateTerminalReference } from "./decisionEvidence";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const build = (reference: string, content = reference) => buildAgentContext({ permission: "safe", conversationHistory: [],
  knownExecutionFacts: {}, tools: [], secretMetadata: [], serverId: "server", terminalReference: reference,
  terminalContext: { source: "selection", totalLines: 300, includedLines: 80, hasMore: true, content } });

describe("G09 lossless context sharing before native wire preparation", () => {
  it("keeps selected terminal content once with its capture boundary and exact same-request reference", () => {
    const text = "数据库备份校验\nROW_COUNT=80\n禁止修改源库\n".repeat(120);
    const projected = build(text);
    const previous = { ...projected, terminalReference: text, terminalReferenceRef: undefined, contextReferenceInstruction: undefined };
    expect(projected.terminalContext).toEqual({ source: "selection", totalLines: 300, includedLines: 80, hasMore: true, content: text });
    expect(projected.terminalReference).toBeUndefined();
    expect(projected.terminalReferenceRef).toBe("terminalContext.content");
    expect(projected.contextReferenceInstruction).toContain("不代表完整采集或当前状态");
    expect(bytes(projected)).toBeLessThan(bytes(previous));
    const restored = { ...projected, terminalReference: projected.terminalContext?.content,
      terminalReferenceRef: undefined, contextReferenceInstruction: undefined };
    expect(JSON.stringify(restored)).toBe(JSON.stringify(previous));
    console.info(JSON.stringify({ experiment: "G09-合成终端上下文", unit: "UTF8字节（不是token或费用）",
      beforeBytes: bytes(previous), afterBytes: bytes(projected), savedBytes: bytes(previous) - bytes(projected) }));
  });

  it("retains differing raw terminal text even when prefixes, lengths or final newline look alike", () => {
    const reference = "server=a\n".repeat(100);
    for (const content of [reference.slice(0, -1), reference.replace("server=a", "server=b"), "", undefined]) {
      expect(duplicateTerminalReference(reference, content)).toBe(false);
      if (content !== undefined) {
        const context = build(reference, content);
        expect(context.terminalReference).toBe(reference);
        expect(context.terminalContext?.content).toBe(content);
        expect(context.terminalReferenceRef).toBeUndefined();
      }
    }
  });

  it("does not expand short requests or manufacture a reference when content was not supplied", () => {
    for (const reference of ["", "ok", "进程未就绪\n", "\\u005c\"quoted\""]) {
      const context = build(reference);
      expect(context.terminalReferenceRef).toBeUndefined();
      expect(context.contextReferenceInstruction).toBeUndefined();
      expect(duplicateTerminalReference(reference, undefined)).toBe(false);
    }
  });

  it("keeps complete goal, prohibition and unknown execution in every decision input for native admission", () => {
    const requirement = "回退当前版本，保留所有业务数据；禁止触碰对照站点。".repeat(180);
    const task: OpsTask = { id: "task-g09", serverId: "server", currentRoundId: "round", title: "回退版本",
      rootGoal: requirement, currentInstruction: requirement, status: "needs_adjustment", permission: "safe", modelId: "model",
      createdAt: "now", updatedAt: "now", messages: [],
      executionConstraints: { changePolicy: "confirm_changes", environmentPolicy: "preserve", failurePolicy: "strict",
        prohibitedActions: ["不得删除业务数据", "不得修改对照站点"], requiredConditions: ["先核对原未知操作"], userDirectives: [requirement] },
      plan: [{ id: "unknown-write", title: "原替换操作", description: "回执丢失", action: { type: "shell", command: "replace-release" },
        command: "replace-release", validation: "check-release", expected: "原版本运行且数据不变", risk: "medium", kind: "change", status: "failed",
        result: { executionStatus: "failed", observationStatus: "unknown",
          facts: { dispatchCertainty: "may_have_dispatched", capturedPartial: true }, failureReason: "原结果未知，不能重发", warnings: ["核对原操作"], evidenceIds: [] } }] };
    const input = { task, tools: [], secretMetadata: [] };
    for (const context of [buildNextStageContext(input), buildAdjustmentContext(input, task.plan[0]), buildContinuationContext(input)]) {
      expect(context.taskGoal.rootGoal).toBe(requirement);
      expect(context.executionConstraints).toEqual(task.executionConstraints);
      expect(context.permission).toBe("safe");
      const serialized = JSON.stringify(context);
      expect(serialized).toContain("unknown");
      expect(serialized).toContain("原结果未知，不能重发");
      expect(serialized).toContain("capturedPartial");
    }
    expect(task.plan[0].result?.observationStatus).toBe("unknown");
    expect(task.plan[0].result?.facts.dispatchCertainty).toBe("may_have_dispatched");
    expect(task.executionConstraints?.prohibitedActions).toEqual(["不得删除业务数据", "不得修改对照站点"]);
  });
});
