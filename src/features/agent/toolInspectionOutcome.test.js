import { describe, expect, it } from "vitest";
import { buildToolStepOutcome } from "./toolStepResult";
import { failedToolRetryBlocker, toolFailureFallback } from "./toolFallback";
import { logRotationLimitations, normalizeLogRotationRequest } from "../tools/logRotationInspection";

const timestamp = "2026-10-12T00:00:00Z";
function makeOutcome(unsupported = false) {
  const args = normalizeLogRotationRequest({ activePaths: ["/var/log/example.log"],
    sequenceCheck: { field: "sequence", first: 1, last: 2 } });
  const call = { id: "rotation-outcome", toolId: "logs.inspect_rotation", arguments: args };
  const data = { request: args, status: unsupported ? "unsupported" : "complete", coverageComplete: !unsupported,
    files: unsupported ? [] : [{ path: args.activePaths[0], role: "active", status: "complete", kind: "regular", compression: "none", compressionValid: null,
      readBytes: 100, expandedBytes: 100, lineCount: 2, partialLastLine: false, sampledAt: timestamp, finishedAt: timestamp,
      consistency: "prefix_rechecked", reason: "sampled", appendObserved: false, rawSha256: "a".repeat(64), contentSha256: "a".repeat(64),
      metadata: { device: "1", inode: "99", sizeBytes: 100, mode: "0640", uid: 99, gid: 99, mtimeNs: "1", ctimeNs: "1" } }],
    configs: [], writers: [], sequence: unsupported ? null : { field: "sequence", first: 1, last: 2, expectedCount: 2, observedUnique: 1, parsedRecords: 2,
      missingCount: 1, duplicateCount: 0, invalidRecords: 0, unscannedPaths: [], coverageComplete: true, status: "mismatch",
      sampling: "independent_file_prefixes", scope: "requested_sequence_window" },
    sampledAt: unsupported ? null : timestamp, finishedAt: unsupported ? null : timestamp, elapsedMs: 0, limitations: [...logRotationLimitations] };
  return { call, outcome: buildToolStepOutcome({ call, result: { callId: call.id, toolId: call.toolId, success: true, data },
    completedAt: timestamp, evidenceId: "rotation-outcome-evidence" }) };
}

describe("检查回执与实际验收结果分开投影", () => {
  it("完整采集发现序号缺失时保留真实回执，并向用户和模型标明未满足无损要求", () => {
    const { outcome } = makeOutcome();
    expect(outcome.result).toMatchObject({ executionStatus: "success", observationStatus: "warning",
      facts: { evidenceComplete: true, sequenceStatus: "mismatch", uninterruptedWritingVerified: false } });
    expect(outcome.result.warnings.join(" ")).toContain("缺失或重复");
    expect(outcome.review.summary).toContain("不能据此判定轮转无损");
    expect(outcome.eventMessage).not.toContain("完整结果");
  });

  it("环境不支持不会标为检查完成，也不能更换stepId无限重复同参数调用", () => {
    const { call, outcome } = makeOutcome(true);
    const old = { id: "old", status: outcome.status, action: { type: "tool", toolId: call.toolId, arguments: call.arguments },
      result: outcome.result, review: outcome.review, evidence: outcome.evidence, startedAt: timestamp,
      attemptContext: JSON.stringify(["server", "round", "", 0, 0]) };
    expect(outcome.status).toBe("failed");
    expect(outcome.review.recoveryAction.kind).toBe("replan");
    expect(toolFailureFallback(old)).toMatchObject({ category: "unsupported", toolId: call.toolId });
    const candidate = { ...old, id: "new", status: "pending", result: undefined };
    expect(failedToolRetryBlocker({ id: "task", serverId: "server", plan: [old], messages: [] }, candidate, [old])).toContain("同参数调用已失败");
    candidate.action = { ...candidate.action, arguments: { activePaths: ["/var/log/other.log"] } };
    expect(failedToolRetryBlocker({ id: "task", serverId: "server", plan: [old], messages: [] }, candidate, [old])).toBeUndefined();
  });
});
