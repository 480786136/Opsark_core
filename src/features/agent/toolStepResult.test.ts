import { describe, expect, it } from "vitest";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import type { ToolCall } from "@/features/tools/types";

const call: ToolCall = {
  id: "call-1",
  toolId: "files.get_structure",
  arguments: { rootPath: "/opt/app" },
};

describe("tool step result", () => {
  it("builds complete structured evidence for a successful call", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true, data: { totalNodes: 3 } },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-1",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.observationStatus).toBe("matched");
    expect(outcome.result.evidenceIds).toEqual(["evidence-1"]);
    expect(outcome.evidence?.[0]).toMatchObject({
      id: "evidence-1",
      facts: { toolId: call.toolId, truncated: false },
    });
    expect(outcome.review?.decision).toBe("continue");
  });

  it("marks truncated output as warning evidence", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true, data: [], truncated: true },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-2",
    });

    expect(outcome.progressMessage).toBe("工具结果已截断");
    expect(outcome.result.observationStatus).toBe("warning");
    expect(outcome.result.warnings).toHaveLength(1);
    expect(outcome.eventMessage).toContain("部分结果");
  });

  it("builds a deterministic failure without evidence", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: { code: "TOOL_DISABLED", message: "工具未启用" },
      },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "unused",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toMatchObject({
      executionStatus: "failed",
      facts: { toolId: call.toolId, errorCode: "TOOL_DISABLED" },
      failureReason: "工具未启用",
    });
    expect(outcome.evidence).toBeUndefined();
    expect(outcome.pauseReason).toContain("工具未启用");
  });
});

