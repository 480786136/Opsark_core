import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import operationsSource from "./operations_probe.py?opsark-probe";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput, parseOperationsCapabilities, redactOperationsBodies, redactOperationsObservations } from "./operationsInspection";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";

function output(request, overrides = {}) {
  return { request, status: "complete", items: [{ kind: "service", subject: "example.service",
    text: "Id=example.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=12\n", exitCode: 0 }],
  scannedEntries: 0, matchedEntries: 1, skippedCount: 0, skipped: [], coverageComplete: true, truncated: false,
  elapsedMs: 1, finishedAt: "2026-10-12T00:00:00Z", ...overrides };
}

describe("运维探针能力与覆盖边界", () => {
  it("健康正文完整性、编码和请求目标必须真实，截断不能满足完整证据", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "health", url: "http://127.0.0.1/health", maxResponseBytes: 12 });
    const data = output(request, { items: [{ kind: "health", subject: request.url, httpStatus: 503,
      body: "未就绪", returnedBytes: 9, bodyTruncated: false, bodyEncoding: "utf-8" }] });
    const parse = candidate => parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(candidate));
    expect(parse(data).items[0].httpStatus).toBe(503); // complete collection, not a healthy business result
    const patch = changes => ({ ...data, items: [{ ...data.items[0], ...changes }] });
    expect(() => parse(patch({ subject: "http://other/health" }))).toThrow("请求目标");
    expect(() => parse(patch({ returnedBytes: 3 }))).toThrow("字节");
    expect(() => parse(patch({ bodyTruncated: true }))).toThrow("完整性");
    expect(() => parse(patch({ bodyEncoding: "unavailable" }))).toThrow("编码");
    expect(() => parse(patch({ body: "a\u0000", returnedBytes: 2 }))).toThrow("编码");
    const partial = { ...patch({ bodyTruncated: true }), status: "partial", coverageComplete: false,
      truncated: true, skippedCount: 1, skipped: [{ path: request.url, reason: "output_limit" }] };
    expect(parse(partial).status).toBe("partial");
    const call = { id: "health", toolId: "services.inspect", arguments: request };
    expect(buildToolEvidenceFacts(call, { callId: call.id, toolId: call.toolId, success: true, data: partial }).evidenceComplete).toBe(false);
    const withoutBody = { ...data, items: [{ kind: "health", subject: request.url, httpStatus: 200 }] };
    expect(() => parse(withoutBody)).toThrow("正文");
    expect(() => normalizeOperationsRequest("services.inspect", { check: "ports", maxResponseBytes: 100 })).toThrow();
  });

  it("服务、端口、目录观测不能复用其他对象的成功", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "status", service: "example.service" });
    const bad = output(request, { items: [{ ...output(request).items[0], subject: "other.service" }] });
    expect(() => parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(bad))).toThrow("请求目标");
  });

  it("健康正文由Core脱敏，保留采样字节且不作为完整原文证据", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "health", url: "http://127.0.0.1/health", maxResponseBytes: 3 });
    const raw = output(request, { items: [{ kind: "health", subject: request.url, httpStatus: 200,
      body: "abc", returnedBytes: 3, bodyTruncated: false, bodyEncoding: "utf-8" }] });
    const data = parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(raw));
    redactOperationsBodies(data, text => text.replace("abc", "[REDACTED]"));
    expect(data.items[0]).toMatchObject({ body: "[REDACTED]", returnedBytes: 3, bodyRedacted: true });
    const call = { id: "health-redacted", toolId: "services.inspect", arguments: request };
    const result = enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data });
    expect(result.success).toBe(true);
    expect(buildToolEvidenceFacts(call, result).evidenceComplete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("abc");
    expect(() => parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(data))).toThrow("远端");
  });

  it("脱敏保持请求身份和目录前缀，仍屏蔽新增观测秘密", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "health", url: "http://example.invalid/root", maxResponseBytes: 20 });
    const data = output(request, { items: [{ kind: "health", subject: request.url, httpStatus: 200,
      body: "root-token", returnedBytes: 10, bodyTruncated: false, bodyEncoding: "utf-8" }] });
    redactOperationsObservations(data, text => text.replaceAll("root", "[REDACTED]").replaceAll("token", "[REDACTED]"));
    expect(data.items[0].subject).toBe(request.url);
    expect(data.items[0].body).toBe("[REDACTED]-[REDACTED]");
    const call = { id: "health", toolId: "services.inspect", arguments: request };
    expect(enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data }).success).toBe(true);

    const files = output({ path: "/root/logs" }, { items: [{ kind: "file", subject: "/root/logs/token-file" }],
      skipped: [{ path: "/root/logs/token-denied", reason: "permission_denied" }] });
    redactOperationsObservations(files, text => text.replaceAll("root", "[REDACTED]").replaceAll("token", "[REDACTED]"));
    expect(files.items[0].subject).toBe("/root/logs/[REDACTED]-file");
    expect(files.skipped[0].path).toBe("/root/logs/[REDACTED]-denied");
  });
  const runPosix = command => execFileSync(process.platform === "win32" ? "wsl.exe" : "/bin/sh",
    process.platform === "win32" ? ["-d", "Ubuntu-22.04", "--", "/bin/sh", "-s"] : ["-s"],
    { input: command, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  it.runIf(process.env.OPSARK_LOCAL_POSIX === "1")("在本地POSIX环境实际执行生成命令并解析原生能力报告", () => {
    const request = normalizeOperationsRequest("disk.inspect", { path: "/", timeoutSeconds: 3 });
    const raw = runPosix(buildOperationsCommand("disk.inspect", request));
    expect(parseOperationsOutput("disk.inspect", request, raw).coverageComplete).toBe(true);
    const capabilities = parseOperationsCapabilities(raw);
    expect(capabilities.facts.find(fact => fact.name === "python.runtime")).toMatchObject({ supported: true });
    expect(capabilities.facts.find(fact => fact.name === "python.runtime")?.version).toMatch(/^3\./);
  });
  it.runIf(process.env.OPSARK_LOCAL_POSIX === "1")("实际缺少可用Python时无业务探测且保持unsupported", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "ports" });
    const raw = runPosix("PATH=/opsark-no-programs\n" + buildOperationsCommand("services.inspect", request));
    expect(parseOperationsOutput("services.inspect", request, raw)).toMatchObject({ status: "unsupported", coverageComplete: false, items: [] });
    expect(parseOperationsCapabilities(raw)?.facts.find(fact => fact.name === "python.runtime")).toEqual({ name: "python.runtime", supported: false });
    expect(parseOperationsCapabilities(raw)?.facts.every(fact => fact.supported === false)).toBe(true);
  });
  it("选择已有兼容Python，不要求jq或执行安装；固定systemctl不用--value", () => {
    const command = buildOperationsCommand("services.inspect", { check: "status", service: "example.service" });
    expect(command).toContain("for opsark_candidate in python3 python");
    expect(command).toContain("sys.version_info >= (3, 6)");
    const originalSource = inflateSync(Buffer.from(operationsSource.data, "base64")).toString("utf8");
    expect(originalSource).toContain('"--property=Id,LoadState,ActiveState');
    expect(originalSource).not.toContain('"--value"');
    expect(command).not.toMatch(/(?:apt-get|yum|pip) install/);
    expect(command).toContain("OPSARK_CAPABILITIES");
  });

  it("成功外壳不能掩盖空服务属性、失败退出码和覆盖缺口", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "status", service: "example.service" });
    const parse = data => parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(data));
    expect(parse(output(request)).coverageComplete).toBe(true);
    expect(() => parse(output(request, { items: [], matchedEntries: 0 }))).toThrow("唯一观测");
    expect(() => parse(output(request, { items: [{ kind: "service", subject: "example.service", text: "", exitCode: 0 }] }))).toThrow("实际属性");
    expect(() => parse(output(request, { items: [{ ...output(request).items[0], exitCode: 7 }] }))).toThrow("退出失败");
    expect(() => parse(output(request, { skippedCount: 1, skipped: [{ path: "systemctl", reason: "unsupported" }] }))).toThrow("未覆盖");
  });

  it("unsupported和局部结果继续保留为不完整事实", () => {
    const request = normalizeOperationsRequest("services.inspect", { check: "status", service: "example.service" });
    const data = output(request, { status: "unsupported", items: [], matchedEntries: 0, skippedCount: 1,
      skipped: [{ path: "python>=3.6", reason: "unsupported" }], coverageComplete: false, truncated: true });
    expect(parseOperationsOutput("services.inspect", request, "OPSARK_RESULT " + JSON.stringify(data))).toEqual(data);
    const call = { id: "call", toolId: "services.inspect", arguments: request };
    expect(buildToolEvidenceFacts(call, { callId: call.id, toolId: call.toolId, success: true, data }))
      .toMatchObject({ inspectionStatus: "unsupported", evidenceComplete: false });
  });
});
