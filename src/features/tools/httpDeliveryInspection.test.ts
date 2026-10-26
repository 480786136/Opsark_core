import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "../agent/planPreparation";
import { buildHttpDeliveryCommand, createHttpDeliveryBinding, httpDeliveryEvidenceFacts, httpDeliveryResultIssue,
  httpDeliveryTarget, normalizeHttpDeliveryRequest, parseHttpDeliveryOutput, redactHttpDeliveryObservations,
  httpDeliveryInputSchema, httpDeliveryOutputSchema, httpDeliveryLimitations, type HttpDeliveryResult } from "./httpDeliveryInspection";
import { compileToolSchema } from "./toolParameterSchema";

async function receipt(args: Record<string, unknown> = {}) {
  const request = normalizeHttpDeliveryRequest({ url: "https://delivery.test:8443/a%2Fb?a=1&a=2", connectAddress: "127.0.0.1", bodyMode: "utf8", ...args });
  const binding = await createHttpDeliveryBinding("execution-1", request as unknown as Record<string, unknown>);
  const target = { ...httpDeliveryTarget(request, binding), tlsVerified: true, tlsServerName: "delivery.test", peerAddress: "127.0.0.1", peerPort: 8443 };
  const data: HttpDeliveryResult = { request, binding, target, status: "complete", coverageComplete: true,
    response: { httpStatus: 200, headers: { "content-type": "text/plain" }, status: "complete", reason: "entity_complete",
      body: { mode: "utf8", readBytes: 6, eof: true, complete: true, encoding: "identity", text: "中文", sha256: sha256Utf8("中文") } },
    correlation: null, sampledAt: "2026-10-12T00:00:00.000Z", finishedAt: "2026-10-12T00:00:00.100Z", elapsedMs: 100, reason: "requested_scope_complete", limitations: httpDeliveryLimitations };
  return { request, binding, data };
}
const encoded = (data: HttpDeliveryResult) => "OPSARK_HTTP_DELIVERY " + JSON.stringify(data) + "\n";
const argsOf = (value: object) => value as Record<string, unknown>;

describe("HTTP 交付规范化与私有执行绑定", () => {
  it("补有限默认值，不修改输入，保留编码和重复查询参数", async () => {
    const original = { url: "http://delivery.test/a/../b%2fc?a=1&a=2" };
    const request = normalizeHttpDeliveryRequest(original);
    expect(original).toEqual({ url: "http://delivery.test/a/../b%2fc?a=1&a=2" });
    expect(request).toMatchObject({ maxBodyBytes: 65536, timeoutSeconds: 15, bodyMode: "sha256" });
    const binding = await createHttpDeliveryBinding("execution-2", original);
    expect(httpDeliveryTarget(request, binding).requestTarget).toBe("/a/../b%2fc?a=1&a=2");
    expect(normalizeHttpDeliveryRequest({ url: "https://[::1]/", connectAddress: "::1" }).url).toBe("https://[::1]/");
  });
  it.each([
    { url: "http://user:password@delivery.test/" }, { url: "http://delivery.test/#fragment" },
    { url: "http://delivery.test/\r\nX-Test:a" }, { url: "http://delivery.test/%wrong" },
    { url: "http://delivery.test\\@other/" }, { url: "http://127.1/" }, { url: "http://0x7f000001/" },
    { url: "http://delivery.test:70000/" }, { url: "http://delivery.test:080/" },
    { connectAddress: "delivery.test" }, { connectAddress: "127.0.0.1:80" }, { connectAddress: "fe80::1%eth0" },
    { probeId: "model-chosen" }, { binding: { executionId: "x" } }, { maxBodyBytes: 131073 }, { timeoutSeconds: 0 },
  ])("拒绝模糊目标、权限字段或超限参数 %j", patch => {
    expect(() => normalizeHttpDeliveryRequest({ url: "https://delivery.test/", ...patch })).toThrow();
  });
  it("私有ID每次不同，摘要只绑定规范化参数，参数变化禁止旧绑定派发", async () => {
    const { request, binding, data } = await receipt();
    const next = await createHttpDeliveryBinding(binding.executionId, argsOf(request));
    expect(next.probeId).not.toBe(binding.probeId);
    expect(next.requestDigest).toBe(binding.requestDigest);
    expect(() => buildHttpDeliveryCommand({ ...request, maxBodyBytes: 9 }, binding)).toThrow("不属于");
    expect(httpDeliveryResultIssue(argsOf(request), { ...data, binding: { ...binding, requestDigest: "0".repeat(64) } }, binding)).toContain("摘要");
    expect(() => parseHttpDeliveryOutput(argsOf(request), encoded(data), next)).toThrow("绑定");
    expect(buildHttpDeliveryCommand(argsOf(request), binding)).toContain("-I -B -u -c");
  });
  const observation = () => ({ path: "/srv/backend.jsonl", injection: { kind: "query", name: "probe" }, probeIdPointer: "/query/probe",
    requestTargetPointer: "/target", expectedRequestTarget: "/api?a=1&a=2" });
  it("查询探针仅追加、不覆盖，JSON Pointer 与关联头均有限", async () => {
    const request = normalizeHttpDeliveryRequest({ url: "http://delivery.test/api?a=1&a=2", backendObservation: observation() });
    const binding = await createHttpDeliveryBinding("execution-3", argsOf(request));
    expect(httpDeliveryTarget(request, binding).requestTarget).toBe("/api?a=1&a=2&probe=" + binding.probeId);
    for (const patch of [{ path: "/srv/../log" }, { probeIdPointer: "/a~2b" }, { probeIdPointer: "/a/b/c/d/e/f/g/h/i" },
      { expectedAuthority: "host" }, { injection: { kind: "header", name: "Host" } }, { injection: { kind: "header", name: "X-Forwarded-Host" } },
      { expectedRequestTarget: "/api?probe=old" }]) {
      expect(() => normalizeHttpDeliveryRequest({ url: request.url, backendObservation: { ...observation(), ...patch } })).toThrow();
    }
    expect(() => normalizeHttpDeliveryRequest({ url: "http://delivery.test/?%70robe=old", backendObservation: observation() })).toThrow("覆盖");
  });
});

describe("HTTP 交付回执与证据边界", () => {
  it("完整已绑定TLS/UTF8回执可解析，既有授权事实不由该工具推断", async () => {
    const { request, binding, data } = await receipt();
    expect(compileToolSchema(httpDeliveryOutputSchema)(data)).toBe(true);
    expect(parseHttpDeliveryOutput(argsOf(request), encoded(data), binding)).toEqual(data);
    expect(httpDeliveryEvidenceFacts(data)).toMatchObject({ evidenceComplete: true, backendSourceVerified: false, inspectionStatus: "complete" });
    expect(compileToolSchema(httpDeliveryInputSchema)({ url: request.url, probeId: binding.probeId })).toBe(false);
  });
  it.each(["request", "binding", "authority", "peer", "tls", "digest", "utf8", "truncated", "encoding"])("拒绝 %s 被替换或伪造的完整收据", async kind => {
    const { request, binding, data } = await receipt();
    if (kind === "request") data.request = { ...request, url: "https://other.test/" };
    if (kind === "binding") data.binding = { ...binding, executionId: "foreign" };
    if (kind === "authority") data.target.authority = "other.test";
    if (kind === "peer") data.target.peerAddress = "127.0.0.2";
    if (kind === "tls") data.target.tlsVerified = false;
    if (kind === "digest") data.response!.body.sha256 = "0".repeat(64);
    if (kind === "utf8") data.response!.body.text = "篡改";
    if (kind === "truncated") data.response!.body.eof = false;
    if (kind === "encoding") data.response!.headers["content-encoding"] = "gzip";
    expect(() => parseHttpDeliveryOutput(argsOf(request), encoded(data), binding)).toThrow();
  });
  it("拒绝远端伪称已脱敏、多收据和超过256KiB的结果", async () => {
    const { request, binding, data } = await receipt();
    expect(() => parseHttpDeliveryOutput(argsOf(request), encoded(data) + encoded(data), binding)).toThrow("唯一");
    expect(() => parseHttpDeliveryOutput(argsOf(request), "中".repeat(100000), binding)).toThrow("256KiB");
    data.observationsRedacted = true;
    expect(() => parseHttpDeliveryOutput(argsOf(request), encoded(data), binding)).toThrow("远端");
  });
  it("Core脱敏后保留原字节事实但不能再作完整正文交付证据", async () => {
    const { request, data } = await receipt();
    redactHttpDeliveryObservations(data, value => value.replace("中文", "[REDACTED]"));
    expect(data.response!.body).toMatchObject({ text: "[REDACTED]", textRedacted: true, readBytes: 6 });
    expect(httpDeliveryResultIssue(argsOf(request), data)).toBeUndefined();
    expect(httpDeliveryEvidenceFacts(data).evidenceComplete).toBe(false);
  });
  it("匹配必须有完整新增窗口、唯一新偏移且来源仍未认证", async () => {
    const spec = { path: "/srv/backend.jsonl", injection: { kind: "header", name: "X-Request-ID" }, probeIdPointer: "/probe", requestTargetPointer: "/target", expectedRequestTarget: "/backend", windowMs: 50, maxLogBytes: 1024 };
    const { request, binding, data } = await receipt({ backendObservation: spec });
    data.correlation = { status: "matched", reason: "window_complete", sourceVerified: false, path: spec.path, expectedRequestTarget: spec.expectedRequestTarget,
      probeId: binding.probeId, windowMs: 50, observedMs: 51, coverageComplete: true, matchedCount: 1, parsedRecords: 1,
      startOffset: 100, endOffset: 200, readBytes: 100, device: "2", inode: "3", matchedOffsets: [100], consistency: "inode_offset_and_bytes_rechecked" };
    expect(parseHttpDeliveryOutput(argsOf(request), encoded(data), binding).correlation!.status).toBe("matched");
    for (const patch of [{ sourceVerified: true }, { observedMs: 49 }, { startOffset: 101 }, { probeId: "opsark-11111111-1111-4111-8111-111111111111" },
      { endOffset: 199 }, { matchedCount: 0 }, { status: "unknown" }, { expectedRequestTarget: "/other" }]) {
      expect(() => parseHttpDeliveryOutput(argsOf(request), encoded({ ...data, correlation: { ...data.correlation, ...patch } }), binding)).toThrow();
    }
  });
});
