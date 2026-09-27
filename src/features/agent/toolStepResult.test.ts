import { describe, expect, it } from "vitest";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import type { ToolCall } from "@/features/tools/types";

const call: ToolCall = {
  id: "call-1",
  toolId: "files.get_structure",
  arguments: { rootPath: "/opt/app" },
};

describe("tool step result", () => {
  it("completes an absence observation without treating it as deployment completion", () => {
    const outcome = buildToolStepOutcome({ call, completedAt: "now", evidenceId: "missing-path",
      result: { callId: call.id, toolId: call.toolId, success: true,
        data: { rootPath: "/opt/app", pathStatus: "missing", tree: "", warnings: [], truncated: false } },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result.facts).toMatchObject({ evidenceKind: "path_state", pathExists: false });
    expect(outcome.review?.summary).toContain("不是目录内容或部署完成证据");
    expect(outcome.pauseReason).toBeUndefined();
  });

  it("builds complete structured evidence for a successful call", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true,
        data: { rootPath: "/opt/app", tree: "/opt/app/\n└── README.md", warnings: [], truncated: false } },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-1",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.observationStatus).toBe("matched");
    expect(outcome.result.evidenceIds).toEqual(["evidence-1"]);
    expect(outcome.evidence?.[0]).toMatchObject({
      id: "evidence-1",
      facts: {
        toolId: call.toolId,
        truncated: false,
        evidenceKind: "directory_structure",
        evidenceScope: "/opt/app",
        evidenceComplete: true,
      },
    });
    expect(outcome.review?.decision).toBe("continue");
  });

  it("does not promote a successful malformed response into a complete product", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true, data: {} },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-incomplete",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.result.facts).toMatchObject({ toolId: call.toolId, errorCode: "TOOL_OUTPUT_INVALID" });
    expect(outcome.evidence).toBeUndefined();
  });

  it("preserves a nested truncation marker in the execution result", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true,
        data: { rootPath: "/opt/app", tree: "/opt/app/", warnings: [], truncated: true } },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-partial",
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result.observationStatus).toBe("warning");
    expect(outcome.result.facts).toMatchObject({ truncated: true, evidenceComplete: false, evidenceKind: "directory_structure" });
  });

  it("marks truncated output as warning evidence", () => {
    const outcome = buildToolStepOutcome({
      call,
      result: { callId: call.id, toolId: call.toolId, success: true, data: { rootPath: "/opt/app", tree: "/opt/app/", warnings: [], truncated: true }, truncated: true },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "evidence-2",
    });

    expect(outcome.progressMessage).toBe("工具结果已截断");
    expect(outcome.result.observationStatus).toBe("warning");
    expect(outcome.result.warnings).toHaveLength(1);
    expect(outcome.eventMessage).toContain("部分结果");
  });

  it("keeps tool result copy generic instead of embedding a domain workflow", () => {
    const connectCall: ToolCall = {
      id: "connect-1",
      toolId: "server.connect",
      arguments: { host: "192.168.1.237" },
    };
    const outcome = buildToolStepOutcome({
      call: connectCall,
      result: { callId: connectCall.id, toolId: connectCall.toolId, success: true, data: { connected: true, host: "192.168.1.237", port: 22, serverId: "server", name: "server", username: "root", info: {} } },
      completedAt: "2026-08-14T01:00:00.000Z",
      evidenceId: "connect-evidence",
    });

    expect(outcome.review?.summary).toBe("工具已返回结构化证据。");
    expect(outcome.eventMessage).toContain("完整结果");
  });

  it("preserves only bounded non-secret partial connect facts through failure validation", () => {
    const connectionCall: ToolCall = { id: "partial", toolId: "server.connect", arguments: { host: "example.test" } };
    const outcome = buildToolStepOutcome({ call: connectionCall, completedAt: "now", evidenceId: "unused", result: {
      callId: connectionCall.id, toolId: connectionCall.toolId, success: false,
      error: { code: "TOOL_BUSINESS", message: "连接完成后任务取消", category: "business", dispatchState: "sent" },
      data: { serverId: "srv-123", connectionChecked: true, directoryUpdated: true, connected: true,
        taskTargetUpdated: false, agentSessionCreationDispatched: true, agentSessionPrepared: false, credentialStored: false,
        },
    } });
    expect(outcome.result.facts.partialEffects).toEqual({ serverId: "srv-123", connectionChecked: true, directoryUpdated: true,
      connected: true, taskTargetUpdated: false, agentSessionCreationDispatched: true, agentSessionPrepared: false, credentialStored: false });
    expect(outcome.result.facts.dispatchState).toBe("sent");
    expect(JSON.stringify(outcome)).not.toContain("must-not-leak");
    expect(outcome.result.executionStatus).toBe("failed");
    expect(outcome.evidence).toBeUndefined();
  });

  it("does not convert arbitrary failure data or untyped values into partial facts", () => {
    for (const toolId of ["server.connect", "files.get_structure"]) {
      const failureCall = { ...call, toolId };
      const outcome = buildToolStepOutcome({ call: failureCall, completedAt: "now", evidenceId: "unused", result: {
        callId: failureCall.id, toolId, success: false, error: { code: "TOOL_BUSINESS", message: "失败" },
        data: { serverId: "server\nsecret", connected: "true", directoryUpdated: 1, password: "must-not-leak" },
      } });
      expect(outcome.result.facts).not.toHaveProperty("partialEffects");
    }
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
