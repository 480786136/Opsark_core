import { afterEach, describe, expect, it } from "vitest";
import { createPosixFixture, posixFixtureFs as fs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildLogRotationCommand, normalizeLogRotationRequest, parseLogRotationOutput } from "./logRotationInspection";
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });
const root = () => { const value = createPosixFixture(); roots.push(value); return value; };
const inspect = args => {
  const request = normalizeLogRotationRequest(args);
  const receipt = runPosixShell(buildLogRotationCommand(request), { timeout: 20000 });
  expect(receipt.status, receipt.stderr).toBe(0);
  return parseLogRotationOutput(request, receipt.stdout);
};

describe("B05 真实POSIX命令传输与消费", () => {
  it("中文、引号、反斜杠和Shell样式名称保持精确，不执行文件名内容", () => {
    const base = root(), path = base + "/中文 ' \\ $(echo unsafe).log";
    fs.writeFileSync(path, '{"sequence":1}\n{"sequence":2}\n');
    const data = inspect({ activePaths: [path], sequenceCheck: { field: "sequence", first: 1, last: 2 } });
    expect(data.files[0].path).toBe(path);
    expect(data.sequence).toMatchObject({ status: "complete", missingCount: 0, duplicateCount: 0, parsedRecords: 2 });
  });
  it("真实gzip产物经过固定探针、schema及窗口消费者", () => {
    const base = root(), path = base + "/active.log", old = base + "/previous.log";
    fs.writeFileSync(path, '{"sequence":3}\n'); fs.writeFileSync(old, '{"sequence":1}\n{"sequence":2}\n');
    const result = runPosixShell(`gzip -- ${quote(old)}`); expect(result.status).toBe(0);
    const data = inspect({ activePaths: [path], archivePaths: [old + ".gz"], sequenceCheck: { field: "sequence", first: 1, last: 3 } });
    expect(data.files[1]).toMatchObject({ compression: "gzip", compressionValid: true });
    expect(data.sequence.status).toBe("complete");
  });
  it("末行未完成、重复JSON键与缺少压缩文件只形成partial", () => {
    const base = root(), path = base + "/active.log";
    fs.writeFileSync(path, '{"sequence":1,"sequence":2}\n');
    expect(inspect({ activePaths: [path], sequenceCheck: { field: "sequence", first: 1, last: 2 } }).sequence.status).toBe("partial");
    fs.writeFileSync(path, '{"sequence":1}\n{"sequence":');
    const result = inspect({ activePaths: [path], archivePaths: [base + "/missing.gz"] });
    expect(result.coverageComplete).toBe(false);
    expect(result.files.map(item => item.status)).toEqual(["partial", "missing"]);
  });
  it("链接路径不被跟随", () => {
    const base = root(), actual = base + "/actual.log", link = base + "/link.log";
    fs.writeFileSync(actual, '{"sequence":1}\n'); fs.symlinkSync(actual, link);
    const data = inspect({ activePaths: [link] });
    expect(data.coverageComplete).toBe(false);
    expect(data.files[0]).toMatchObject({ kind: "symlink", status: "unsupported" });
  });
});
