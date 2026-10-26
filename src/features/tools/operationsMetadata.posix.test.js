import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { createPosixFixture, posixFixtureFs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput } from "./operationsInspection";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";

const roots = [];
const toolId = "files.inspect";
const fixture = () => { const root = createPosixFixture(); roots.push(root); return root; };
const probe = args => {
  const request = normalizeOperationsRequest(toolId, args);
  const execution = runPosixShell(buildOperationsCommand(toolId, request), { timeout: 10000 });
  expect(execution.status, execution.stderr).toBe(0);
  const data = parseOperationsOutput(toolId, request, execution.stdout);
  const call = { id: "real-metadata", toolId, arguments: request };
  const result = enforceToolResult(call, { callId: call.id, toolId, success: true, data });
  expect(result.success).toBe(true);
  return { data, facts: buildToolEvidenceFacts(call, result) };
};
afterEach(() => { for (const root of roots.splice(0)) posixFixtureFs.rmSync(root); });

describe("POSIX 真实探针到前端文件摘要证据", () => {
  it("真实 UTF-8/反斜杠/引号路径经过 shell 传输仍返回准确 SHA 与有界结果", () => {
    const root = fixture();
    const path = posix.join(root, "中文\\文件'$(literal)");
    const content = "已有配置\nUTF-8\n";
    posixFixtureFs.writeFileSync(path, content);
    const { data, facts } = probe({ path, hash: true });
    expect(data).toMatchObject({ status: "complete", scannedEntries: 1, coverageComplete: true });
    expect(data.items[0]).toMatchObject({ subject: path, verifiedReadPasses: 2,
      sha256: createHash("sha256").update(content).digest("hex"), consistency: "metadata_checked" });
    expect(facts).toMatchObject({ evidenceKind: "file_metadata", evidenceComplete: true, fileType: "regular" });
    expect(probe({ path, hash: true, maxHashBytes: 2 }).facts.evidenceComplete).toBe(false);
  }, 30000);

  it("目录仅自身、链接仅文本，缺失与禁止穿越都经消费者核验", () => {
    const root = fixture();
    const directory = posix.join(root, "release");
    posixFixtureFs.mkdirSync(directory);
    posixFixtureFs.writeFileSync(posix.join(directory, "app"), "version1");
    const current = posix.join(root, "current");
    posixFixtureFs.symlinkSync(directory, current);
    expect(probe({ path: current, hash: true }).data.items[0]).toMatchObject({ fileType: "symlink", linkTarget: directory,
      hashStatus: "not_applicable", limitations: ["non_atomic_sample", "target_not_followed"] });
    expect(probe({ path: posix.join(current, "app"), hash: true }).data).toMatchObject({ status: "unsupported", coverageComplete: false, items: [] });
    expect(probe({ path: directory, hash: true }).data.items[0]).toMatchObject({ fileType: "directory", limitations: ["non_atomic_sample", "self_metadata_only"] });
    expect(probe({ path: posix.join(root, "missing"), hash: true }).facts).toMatchObject({ pathExists: false, evidenceComplete: true });
  }, 30000);
});
