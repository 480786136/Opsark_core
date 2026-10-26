import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { deflateSync } from "node:zlib";
import { createPosixFixture, posixFixtureFs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildProbeDecoder, parseProbeDeliveryFailure } from "./probeDelivery";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput } from "./operationsInspection";
import operations from "./operations_probe.py?opsark-probe";
import packages from "./package_probe.py?opsark-probe";

const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const pack = value => {
  const source = Buffer.from(value);
  return { version: 1, encoding: "zlib-base64", sourceBytes: source.length,
    sourceSha256: createHash("sha256").update(source).digest("hex"), data: deflateSync(source).toString("base64") };
};
// Keep WSL launcher diagnostics distinct from the POSIX command's actual stderr.
// The production parser still requires an explicitly captured, completely empty stderr.
const capture = command => {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const driver = `import base64, json, subprocess
command = base64.b64decode(${JSON.stringify(encoded)}).decode("utf-8")
child = subprocess.run(["/bin/sh", "-c", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=15)
print(json.dumps({"stdout": child.stdout, "stderr": child.stderr, "status": child.returncode}, ensure_ascii=True))
`;
  const launched = runPosixShell(`python3 -I -B -u -c ${quote(driver)}`, { timeout: 20000 });
  expect(launched.status, launched.stderr).toBe(0);
  return { ...JSON.parse(launched.stdout), launcherStderr: launched.stderr };
};
const run = (source, argv = "{}") => capture(`python3 -I -B -u -c ${quote(source)} ${quote(argv)}`);
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) posixFixtureFs.rmSync(root); });
const removeSamplingTimes = value => Array.isArray(value) ? value.map(removeSamplingTimes)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["elapsedMs", "finishedAt", "observedAt", "sampleStartedAt", "sampleFinishedAt"].includes(key))
    .map(([key, item]) => [key, removeSamplingTimes(item)])) : value;

describe("POSIX探针解码与原始执行对照", () => {
  it("保留-c全局键/值和flags/argv，Unicode引号美元反引号均原样进入", () => {
    const source = `import sys, json
print(json.dumps({"keys": sorted(globals()), "name": __name__, "doc": __doc__, "package": __package__, "spec": __spec__, "has_file": "__file__" in globals(), "argv": sys.argv, "isolated": sys.flags.isolated, "dont_write_bytecode": sys.flags.dont_write_bytecode}, ensure_ascii=True))
`;
    const argv = JSON.stringify({ path: "/中文'`$(never)\\文件\nnext", literal: "$HOME", quoted: 'a"b' });
    const direct = run(source, argv), decoded = run(buildProbeDecoder(pack(source)), argv);
    expect(direct.status, direct.stderr).toBe(0); expect(decoded.status, decoded.stderr).toBe(0);
    expect(JSON.parse(decoded.stdout)).toEqual(JSON.parse(direct.stdout));
    expect(JSON.parse(decoded.stdout)).toMatchObject({ argv: ["-c", argv], name: "__main__", has_file: false,
      isolated: 1, dont_write_bytecode: 1 });
  }, 30000);

  it("缺base64/zlib/hashlib受控模拟只返回固定sent失败，原采集从未进入", () => {
    const decoder = buildProbeDecoder(pack('raise RuntimeError("PROBE_MUST_NOT_EXECUTE")'));
    for (const missing of ["base64", "zlib", "hashlib"]) {
      const source = `import builtins
_original_import = builtins.__import__
def _controlled_import(name, *args, **kwargs):
    if name == ${JSON.stringify(missing)}:
        raise ImportError("controlled missing stdlib")
    return _original_import(name, *args, **kwargs)
builtins.__import__ = _controlled_import
${decoder}
`;
      const result = run(source);
      expect(result.status).toBe(125); expect(result.stderr).toBe("");
      expect(parseProbeDeliveryFailure(result.stdout, result.stderr, result.status)).toEqual({ version: 1,
        code: "PROBE_DECODER_UNAVAILABLE", stage: "decoder_import" });
      expect(result.stdout).not.toContain("PROBE_MUST_NOT_EXECUTE");
    }
  }, 30000);

  it("损坏SHA/长度/压缩流、尾随数据、超界展开与编译失败都在采集前终止", () => {
    const source = pack('raise RuntimeError("PROBE_MUST_NOT_EXECUTE")');
    const compressed = Buffer.from(source.data, "base64");
    for (const bad of [
      { ...source, sourceSha256: "0".repeat(64) }, { ...source, sourceBytes: source.sourceBytes - 1 },
      { ...source, sourceBytes: source.sourceBytes + 1 }, { ...source, data: compressed.subarray(0, -1).toString("base64") },
      { ...source, data: Buffer.concat([compressed, Buffer.from("trailing")]).toString("base64") },
      { ...source, data: Buffer.concat([compressed, compressed]).toString("base64") },
      { ...pack("x".repeat(1024 * 1024)), sourceBytes: 10 }, pack("this is invalid python ???"),
    ]) {
      const result = run(buildProbeDecoder(bad));
      expect(result.status, result.stderr).toBe(125); expect(result.stderr).toBe("");
      expect(parseProbeDeliveryFailure(result.stdout, result.stderr, result.status)).toEqual({ version: 1,
        code: "PROBE_SOURCE_INVALID", stage: "source_decode" });
    }
  }, 60000);

  it("真实operations原始collector与打包版在相同POSIX目录逐项同结果", () => {
    const root = createPosixFixture(); roots.push(root);
    const path = posix.join(root, "中文'`$(literal)"); posixFixtureFs.mkdirSync(path);
    posixFixtureFs.writeFileSync(posix.join(path, "payload"), "abc".repeat(100));
    const request = normalizeOperationsRequest("disk.inspect", { path, check: "directory", timeoutSeconds: 10 });
    const command = buildOperationsCommand("disk.inspect", request);
    const raw = readFileSync(join(process.cwd(), "src/features/tools/operations_probe.py"), "utf8");
    const originalCommand = command.replace(quote(buildProbeDecoder(operations)), quote(raw));
    expect(originalCommand).not.toBe(command);
    const original = runPosixShell(originalCommand), delivered = runPosixShell(command);
    expect(original.status, original.stderr).toBe(0); expect(delivered.status, delivered.stderr).toBe(0);
    const before = parseOperationsOutput("disk.inspect", request, original.stdout);
    const after = parseOperationsOutput("disk.inspect", request, delivered.stdout);
    expect(after).toMatchObject({ status: "complete", coverageComplete: true });
    expect(removeSamplingTimes(after)).toEqual(removeSamplingTimes(before));
    expect(Buffer.byteLength(command, "utf8")).toBeLessThan(Buffer.byteLength(originalCommand, "utf8"));
  }, 30000);

  it("真实package原始collector与打包版查询同一bash包，业务字段逐项同结果", () => {
    const request = normalizeOperationsRequest("packages.inspect", { packages: ["bash"], timeoutSeconds: 15 });
    const command = buildOperationsCommand("packages.inspect", request);
    const raw = readFileSync(join(process.cwd(), "src/features/tools/package_probe.py"), "utf8");
    const originalCommand = command.replace(quote(buildProbeDecoder(packages)), quote(raw));
    expect(originalCommand).not.toBe(command);
    const original = runPosixShell(originalCommand, { timeout: 20000 }), delivered = runPosixShell(command, { timeout: 20000 });
    expect(original.status, original.stderr).toBe(0); expect(delivered.status, delivered.stderr).toBe(0);
    const before = parseOperationsOutput("packages.inspect", request, original.stdout);
    const after = parseOperationsOutput("packages.inspect", request, delivered.stdout);
    expect(after.items[0].packages[0]).toMatchObject({ name: "bash", installedStatus: "installed" });
    expect(removeSamplingTimes(after)).toEqual(removeSamplingTimes(before));
  }, 60000);

  it("缺Python保留原unsupported结果和能力事实，不声明python.zlib或安装依赖", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "ports" });
    const result = capture("PATH=/opsark-no-programs\n" + buildOperationsCommand("services.inspect", request));
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(parseOperationsOutput("services.inspect", request, result.stdout)).toMatchObject({ status: "unsupported", coverageComplete: false });
    expect(result.stdout).not.toContain("python.zlib");
    expect(parseProbeDeliveryFailure(result.stdout, result.stderr, result.status)).toBeUndefined();
  }, 30000);
});
