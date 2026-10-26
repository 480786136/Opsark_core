import { describe, expect, it } from "vitest";
import { nginxConfigTool, nginxConfigInputSchema, nginxConfigOutputSchema, normalizeNginxConfigRequest, nginxConfigResultIssue, type NginxConfigResult } from "./nginxConfigContracts";
import { validateSchemaValue } from "./toolParameterSchema";

const request = () => normalizeNginxConfigRequest({ entryPath: "/etc/nginx/nginx.conf", prefix: "/usr/local/nginx",
  target: { address: "127.0.0.1", port: 8080, serverName: "app.example", uriPath: "/api/" }, sourceStepIds: ["read-config"] });
const sha = "sha256:" + "a".repeat(64);
function complete(): NginxConfigResult {
  const args = request(), source = { path: args.entryPath, startByte: 0, endByte: 120 };
  return { request: args, sourceEvidenceIds: ["evidence-read-config"], analysis: { version: 1,
    binding: { taskId: "task", roundId: "round", workflowEpoch: 1, serverId: "server", connectionGeneration: 1 },
    target: { ...args.target }, entryPath: args.entryPath, prefix: args.prefix, status: "parsed", reasons: [],
    sources: [{ path: args.entryPath, stepId: "read-config", operationId: "operation", attemptId: "attempt", executionId: "execution", contentSha256: sha, bytes: 120, pathIdentity: "requested_path_only" }],
    includes: [], servers: [{ id: "server:0", source, fingerprint: sha, listens: [{ address: "0.0.0.0", port: 8080, defaultServer: false, tls: false, source }],
      serverNames: ["app.example"], directives: [], locations: [] }], selected: { serverId: "server:0", root: "/srv/site", proxySetHeaders: [] },
    globalFingerprint: sha, nonTargetFingerprint: sha, configurationLoaded: false, objectIdentityVerified: false,
    limitations: ["static_declarations_only", "not_nginx_syntax_or_load_acceptance", "requested_paths_not_inode_or_symlink_chain", "independent_reads_not_atomic_snapshot", "no_runtime_route_or_backend_delivery_proof"] } };
}
function unknown(): NginxConfigResult {
  const result = complete(); result.analysis.status = "unknown"; result.analysis.reasons = [{ code: "missing_current_source_step" }];
  result.analysis.sources = []; result.analysis.servers = []; result.sourceEvidenceIds = [];
  delete result.analysis.selected; delete result.analysis.globalFingerprint; delete result.analysis.nonTargetFingerprint;
  return result;
}

describe("Nginx 本地声明工具的有界契约", () => {
  it("仅消费现有步骤并注册本地只读派生工具，不授予验收完成", () => {
    expect(nginxConfigTool).toMatchObject({ id: "nginx.inspect_configuration", implementation: "inspectNginxConfiguration", effect: "read", executionMode: "local", completionMode: "continue" });
    expect(() => validateSchemaValue(nginxConfigInputSchema, request(), "request", "")).not.toThrow();
    expect(nginxConfigResultIssue(request(), complete())).toBeUndefined();
  });
  it("正常克隆参数，不改调用方目标和证据步骤", () => {
    const args = request(), before = JSON.stringify(args), result = normalizeNginxConfigRequest(args);
    result.sourceStepIds.push("another"); result.target.port = 80;
    expect(JSON.stringify(args)).toBe(before);
  });
  it.each([
    { sourceStepIds: [] }, { sourceStepIds: ["read", "read"] }, { sourceStepIds: Array.from({ length: 65 }, (_, i) => `read-${i}`) },
    { sourceStepIds: ["\n"] }, { receipts: [] }, { content: "http { server { } }" }, { arbitraryCommand: "nginx -s reload" },
    { entryPath: "relative" }, { entryPath: "/a/../nginx.conf" }, { prefix: "/a//b" }, { entryPath: "/\ud800" },
  ])("拒绝伪造正文、收据或无界/含糊参数 %j", patch => {
    expect(() => normalizeNginxConfigRequest({ ...request(), ...patch })).toThrow();
  });
  it.each([
    { address: "host.example" }, { address: "127.000.0.1" }, { address: "[::1]" }, { address: "999.0.0.1" },
    { port: 0 }, { port: 65536 }, { port: 80.5 }, { serverName: "*.example" }, { serverName: "app.example:80" }, { serverName: "\ud800" },
    { uriPath: "/a%2fb" }, { uriPath: "/a?token=secret" }, { uriPath: "/a/../b" }, { uriPath: "//b" },
  ])("目标保持明确地址与有限静态请求范围 %j", patch => {
    const args = request(); expect(() => normalizeNginxConfigRequest({ ...args, target: { ...args.target, ...patch } })).toThrow();
  });
  it("IPv6明确目标和空Host均可表达而非虚构一个Host", () => {
    const args = request(); expect(normalizeNginxConfigRequest({ ...args, prefix: "/", target: { ...args.target, address: "::1", serverName: "" } }).target.address).toBe("::1");
  });
  it("缺来源的unknown合法且不能保留有效证据引用或selected", () => {
    const result = unknown(); expect(() => validateSchemaValue(nginxConfigOutputSchema, result, "output", "")).not.toThrow();
    expect(nginxConfigResultIssue(request(), result)).toBeUndefined();
    result.sourceEvidenceIds = ["unproven"]; expect(nginxConfigResultIssue(request(), result)).toBeDefined();
    result.sourceEvidenceIds = []; result.analysis.selected = { serverId: "server:0", proxySetHeaders: [] };
    expect(nginxConfigResultIssue(request(), result)).toBeDefined();
  });
  it.each<[string, (value: NginxConfigResult) => void]>([
    ["缺底层引用", result => { result.sourceEvidenceIds = []; }],
    ["重复底层引用", result => { result.sourceEvidenceIds.push(result.sourceEvidenceIds[0]!); }],
    ["过多底层引用", result => { result.sourceEvidenceIds = Array.from({ length: 257 }, (_, i) => `e-${i}`); }],
    ["变更请求端口", result => { result.request.target.port = 80; }],
    ["变更分析目标", result => { result.analysis.target.serverName = "other.example"; }],
    ["变更来源步骤", result => { result.analysis.sources[0]!.stepId = "not-requested"; }],
    ["重复来源路径", result => { result.analysis.sources.push({ ...result.analysis.sources[0]! }); }],
    ["范围超过真实字节", result => { result.analysis.servers[0]!.source.endByte = 121; }],
    ["字节范围倒置", result => { result.analysis.servers[0]!.source.startByte = 121; }],
    ["范围来自别的文件", result => { result.analysis.servers[0]!.source.path = "/unread.conf"; }],
    ["parsed同时有未知原因", result => { result.analysis.reasons.push({ code: "uncovered" }); }],
    ["选择不存在server", result => { result.analysis.selected!.serverId = "server:9"; }],
    ["选择不存在location", result => { result.analysis.selected!.locationId = "location:9"; }],
    ["非唯一server身份", result => { result.analysis.servers.push({ ...result.analysis.servers[0]! }); }],
    ["root和alias冲突", result => { result.analysis.selected!.alias = "/other"; }],
    ["缺全局保护摘要", result => { delete result.analysis.globalFingerprint; }],
    ["缺非目标保护摘要", result => { delete result.analysis.nonTargetFingerprint; }],
    ["缺运行时限制", result => { result.analysis.limitations.pop(); }],
    ["覆盖include没有读取", result => { result.analysis.includes.push({ source: { ...result.analysis.servers[0]!.source }, requested: "other.conf", resolvedPath: "/etc/nginx/other.conf", covered: true }); }],
    ["空glob没有前后目录", result => { result.analysis.includes.push({ source: { ...result.analysis.servers[0]!.source }, requested: "conf.d/*.conf", resolvedPaths: [], covered: true }); }],
    ["一个扫描冒充前后扫描", result => { result.analysis.includes.push({ source: { ...result.analysis.servers[0]!.source }, requested: "conf.d/*.conf", resolvedPaths: [], covered: true,
      directoryCoverage: { beforeOperationId: "same", afterOperationId: "same", manifestSha256: "a".repeat(64) } }); }],
  ])("拒绝不一致输出：%s", (_, mutate) => { const result = complete(); mutate(result); expect(nginxConfigResultIssue(request(), result)).toBeDefined(); });
  it("明确false字段不可升格成加载/对象身份成功", () => {
    for (const field of ["configurationLoaded", "objectIdentityVerified"]) {
      const value = complete(); (value.analysis as unknown as Record<string, unknown>)[field] = true;
      expect(nginxConfigResultIssue(request(), value)).toBeDefined();
    }
  });
  it("标准header表达式可保留，但不提供运行观测值", () => {
    const result = complete(); result.analysis.selected!.proxySetHeaders = [{ name: "Host", value: "$host", expression: { kind: "nginx_variables", variables: ["host"], runtimeValueKnown: false } }];
    expect(nginxConfigResultIssue(request(), result)).toBeDefined();
    result.analysis.limitations.push("header_expressions_are_not_observed_runtime_values");
    expect(nginxConfigResultIssue(request(), result)).toBeUndefined();
    (result.analysis.selected!.proxySetHeaders[0]!.expression as { variables: string[] }).variables = ["unproven"];
    expect(nginxConfigResultIssue(request(), result)).toBeDefined();
  });
});
