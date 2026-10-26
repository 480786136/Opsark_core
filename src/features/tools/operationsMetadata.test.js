import { describe, expect, it, vi } from "vitest";
import { normalizeOperationsRequest, parseOperationsOutput, redactOperationsObservations } from "./operationsInspection";
import { defaultToolCatalog } from "./toolCatalog";
import { executeToolCall, prepareFinalToolArguments } from "./toolExecutor";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";
import { operationsObservation, operationsProgressIdentity } from "./operationsObservation";
import { operationsInputSchemas, operationsOutputSchemas } from "./operationsContracts";
import { compileToolSchema } from "./toolParameterSchema";
import corpus from "../../../contracts/schema-cases.json";

const toolId = "files.inspect";
const request = () => normalizeOperationsRequest(toolId, { path: "/srv/config.json", hash: true, maxHashBytes: 32 });
function observation(args = request()) {
  return { request: args, status: "complete", items: [{ kind: "file_metadata", subject: args.path,
    fileType: "regular", exists: true, metadata: { device: "1", inode: "18446744073709551615", mode: "0640", uid: 0, gid: 0,
      sizeBytes: 3, modifiedAtNs: "1791822000000000001", changedAtNs: "1791822000000000002" },
    stability: "stable", hashStatus: "complete", hashedBytes: 3, verifiedReadPasses: 2,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    sampleStartedAt: "2026-10-12T01:00:00Z", sampleFinishedAt: "2026-10-12T01:00:01Z",
    consistency: "metadata_checked", limitations: ["non_atomic_sample"],
  }], scannedEntries: 1, matchedEntries: 1, skippedCount: 0, skipped: [],
    coverageComplete: true, truncated: false, elapsedMs: 1, finishedAt: "2026-10-12T01:00:01Z" };
}
const parse = data => parseOperationsOutput(toolId, data.request, "OPSARK_RESULT " + JSON.stringify(data));
function envelope(data) {
  const call = { id: "metadata", toolId, arguments: data.request };
  const result = enforceToolResult(call, { callId: call.id, toolId, success: true, data });
  return { call, result, facts: buildToolEvidenceFacts(call, result) };
}

describe("精确路径身份与摘要契约", () => {
  it.each(corpus.cases.filter(item => item.toolId === toolId))("当前源契约：$name", item => {
    const schemas = item.contract === "inputSchema" ? operationsInputSchemas : operationsOutputSchemas;
    expect(compileToolSchema(schemas[toolId])(item.value)).toBe(item.valid);
  });
  it("复用只读批量工具执行链，准备与生产者结果受同一契约约束", async () => {
    const tool = defaultToolCatalog.find(item => item.id === toolId);
    expect(tool).toMatchObject({ effect: "read", implementation: "inspectOperations", planMode: "read_batch" });
    const args = prepareFinalToolArguments(tool, { path: "/srv/config.json", hash: true, maxHashBytes: 32 });
    const data = observation(args);
    const inspectOperations = vi.fn().mockResolvedValue(parse(data));
    const call = { id: "metadata", toolId, arguments: args };
    const result = await executeToolCall(call, defaultToolCatalog, { inspectOperations }, { prepared: true });
    expect(result.success).toBe(true);
    expect(inspectOperations).toHaveBeenCalledWith(toolId, args);
    expect(envelope(data).facts).toMatchObject({ evidenceKind: "file_metadata", evidenceComplete: true,
      evidenceScope: args.path, contentSha256: data.items[0].sha256, consistency: "metadata_checked", limitations: ["non_atomic_sample"] });
    expect(envelope(data).facts.evidenceFingerprint).not.toBe(data.items[0].sha256);
  });

  it.each([
    { path: "relative" }, { path: "/srv/../elsewhere" }, { path: "/srv/a", followSymlinks: true },
    { path: "/srv/a", command: "cat /etc/passwd" }, { path: "/srv/a", hash: "true" },
    { path: "/srv/a", maxHashBytes: 0 }, { path: "/srv/a", maxHashBytes: 1073741825 },
  ])("拒绝不明确范围、任意命令和越界预算：%j", args => {
    expect(() => normalizeOperationsRequest(toolId, args)).toThrow();
  });

  it("保留中文、反斜杠和超 JS 安全整数的身份时间", () => {
    const args = normalizeOperationsRequest(toolId, { path: "/目录/文件\\名", hash: true });
    const data = parse(observation(args));
    expect(data.items[0].subject).toBe("/目录/文件\\名");
    expect(data.items[0].metadata.inode).toBe("18446744073709551615");
    expect(data.items[0].metadata.modifiedAtNs).toBe("1791822000000000001");
  });

  it("不能返回其他路径、前缀摘要或虚假采样一致性", () => {
    for (const patch of [{ subject: "/srv/other" }, { hashedBytes: 2 }, { hashedBytes: 100 },
      { sha256: "prefix" }, { stability: "changed" }, { hashStatus: "limit_exceeded" },
      { consistency: "single_observation" }, { limitations: [] }, { sampleFinishedAt: "now" }]) {
      const data = observation(); Object.assign(data.items[0], patch);
      expect(() => parse(data)).toThrow();
      expect(envelope(data).result.success).toBe(false);
    }
  });

  it("元数据检查不能冒称已采集内容摘要", () => {
    const args = normalizeOperationsRequest(toolId, { path: "/srv/config.json" });
    const invalid = observation(args);
    expect(() => parse(invalid)).toThrow();
    const valid = observation(args);
    Object.assign(valid.items[0], { hashStatus: "not_requested", hashedBytes: 0, verifiedReadPasses: 0 }); delete valid.items[0].sha256;
    expect(envelope(parse(valid)).facts).toMatchObject({ evidenceComplete: true, hashStatus: "not_requested" });
    expect(envelope(valid).facts.contentSha256).toBeUndefined();
  });

  it.each(["limit_exceeded", "changed", "unavailable"])("%s 的采集缺口不产生完整证据或摘要事实", status => {
    const data = observation();
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true, skippedCount: 1,
      skipped: [{ path: data.request.path, reason: status === "changed" ? "changed" : status === "limit_exceeded" ? "output_limit" : "error" }] });
    Object.assign(data.items[0], { hashStatus: status, stability: status === "changed" ? "changed" : "unknown", consistency: "unverified", hashedBytes: 2 });
    delete data.items[0].sha256;
    const { facts, result } = envelope(parse(data));
    expect(result.success).toBe(true); expect(facts.evidenceComplete).toBe(false); expect(facts.contentSha256).toBeUndefined();
    const forged = structuredClone(data); forged.coverageComplete = true; forged.truncated = false; forged.status = "complete";
    expect(() => parse(forged)).toThrow();
  });

  it("缺失、目录和链接分别声明自己的有限观测范围", () => {
    const missing = observation();
    Object.assign(missing.items[0], { exists: false, fileType: "missing", hashStatus: "not_applicable", hashedBytes: 0, verifiedReadPasses: 0,
      consistency: "single_observation", limitations: ["non_atomic_sample", "absence_at_sample"] });
    delete missing.items[0].metadata; delete missing.items[0].sha256;
    expect(envelope(parse(missing)).facts).toMatchObject({ evidenceComplete: true, pathExists: false });
    const directory = observation();
    Object.assign(directory.items[0], { fileType: "directory", hashStatus: "not_applicable", hashedBytes: 0, verifiedReadPasses: 0, limitations: ["non_atomic_sample", "self_metadata_only"] });
    delete directory.items[0].sha256;
    expect(envelope(parse(directory)).facts).toMatchObject({ evidenceComplete: true, fileType: "directory" });
    directory.items[0].limitations = ["non_atomic_sample"];
    expect(() => parse(directory)).toThrow();
  });

  it("原始链接目标受脱敏但不能用替代文本充当精确路径证据", () => {
    const data = observation();
    Object.assign(data.items[0], { fileType: "symlink", linkTarget: "abc", hashStatus: "not_applicable", hashedBytes: 0, verifiedReadPasses: 0,
      limitations: ["non_atomic_sample", "target_not_followed"] }); delete data.items[0].sha256;
    const parsed = parse(data);
    redactOperationsObservations(parsed, text => text.replace("abc", "[REDACTED]"));
    expect(parsed.items[0]).toMatchObject({ linkTargetRedacted: true, linkTarget: "[REDACTED]" });
    expect(envelope(parsed).result.success).toBe(true);
    expect(envelope(parsed).facts.evidenceComplete).toBe(false);
    expect(() => parse(parsed)).toThrow("远端采集不能声明");
    data.items[0].linkTarget = "longer-than-stat";
    expect(() => parse(data)).toThrow("长度");
  });

  it("重复采样时间变化不算新进展，摘要和请求改变仍区分", () => {
    const data = observation();
    const step = { action: { type: "tool", toolId, arguments: data.request }, result: { executionStatus: "success" }, output: JSON.stringify(data) };
    const first = operationsProgressIdentity(step);
    expect(first).toBeTruthy();
    data.items[0].sampleStartedAt = "2026-10-13T01:00:00Z";
    data.items[0].sampleFinishedAt = "2026-10-13T01:00:01Z";
    const changedTime = { ...step, output: JSON.stringify(data) };
    expect(operationsProgressIdentity(changedTime)).toBe(first);
    data.items[0].sha256 = "a".repeat(64);
    expect(operationsProgressIdentity({ ...step, output: JSON.stringify(data) })).not.toBe(first);
    data.request.hash = false;
    expect(operationsObservation({ ...step, action: { ...step.action, arguments: request() }, output: JSON.stringify(data) })).toBeUndefined();
  });
});
