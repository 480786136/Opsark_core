import { describe, expect, it } from "vitest";
import { createMemoryExecutionLedgerRepository } from "@/services/executionLedger";
import type { PlanStep, ServerProfile } from "@/types";
import { preparePlanForApproval, executionDigest, sha256Utf8 } from "./planPreparation";
import { analyzeNginxConfigEvidence, type NginxConfigInput } from "./nginxConfigEvidence";
import { fileManifestDigest, fileManifestTool, normalizeFileManifestRequest, FILE_MANIFEST_LIMITATIONS, type FileManifestEntry, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { nginxConfigResultIssue } from "@/features/tools/nginxConfigContracts";

const server: ServerProfile = { id: "nginx-fixture", name: "test", host: "fixture.invalid", port: 22, username: "fixture", group: "test", status: "online", environment: [], createdAt: "",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const entry = "/etc/nginx/nginx.conf";
const site = (body = "root /srv/site;", name = "app.example") => `server { listen 8080; server_name ${name}; ${body} }`;
const conf = (body = site()) => `# 中文配置，注释里的 } server { 不构成语法\nworker_processes 1;\nevents { worker_connections 32; }\nhttp { ${body} }\n`;
async function fixture(contents: Record<string, string>): Promise<NginxConfigInput> {
  const repository = createMemoryExecutionLedgerRepository();
  const reads = Object.entries(contents).map(([path], i): PlanStep => ({ id: `step-${i}`, title: "读取配置", description: "完整文件读取", kind: "observe", risk: "low", status: "pending",
    command: "", validation: "", expected: "取得声明", action: { type: "tool", toolId: "files.read_content", arguments: { path, maxBytes: 262144 } } }));
  const prepared = preparePlanForApproval(reads, { taskId: "task", permission: "safe", server, servers: [server], connectionGeneration: 7 });
  for (const [i, [path, content]] of Object.entries(contents).entries()) {
    const intent = prepared.steps[i]!.intent, bytes = new TextEncoder().encode(content).length;
    await repository.prepare({ version: 1, operationId: `op-${i}`, taskId: "task", stepId: reads[i]!.id, roundId: "round", workflowEpoch: 3,
      planRevision: 1, stepRevision: 1, intentDigest: intent.digest, intent, phase: "tool", effect: "read", resourceKeys: [`server:${server.id}`], executionId: `execution-${i}` });
    await repository.begin(`op-${i}`, `attempt-${i}`, `execution-${i}`);
    await repository.complete({ operationId: `op-${i}`, attemptId: `attempt-${i}`, eventId: `event-${i}`, outcome: { status: "succeeded", evidenceRefs: [`evidence-${i}`],
      result: { callId: `execution-${i}`, toolId: "files.read_content", success: true, data: { path, content, encoding: "utf-8", totalBytes: bytes, returnedBytes: bytes, truncated: false } } } });
    await repository.acknowledge(`op-${i}`, `attempt-${i}`, false);
  }
  return { binding: { taskId: "task", roundId: "round", workflowEpoch: 3, serverId: server.id, connectionGeneration: 7 },
    entryPath: entry, prefix: "/usr/local/nginx", target: { address: "127.0.0.1", port: 8080, serverName: "app.example", uriPath: "/" },
    receipts: (await repository.list()).map(operation => ({ operation, attemptId: operation.attempts[0]!.id })) };
}
const analyze = async (text: string) => {
  const input = await fixture({ [entry]: text }), analysis = analyzeNginxConfigEvidence(input);
  const request = { entryPath: input.entryPath, prefix: input.prefix, target: input.target, sourceStepIds: input.receipts.map(receipt => receipt.operation.stepId) };
  expect(nginxConfigResultIssue(request, { request, analysis, sourceEvidenceIds: analysis.status === "parsed" ? ["evidence-0"] : [] })).toBeUndefined();
  return analysis;
};
function data(input: NginxConfigInput) { return (input.receipts[0]!.operation.attempts[0]!.outcome!.result as { data: Record<string, unknown> }).data; }
const identity = (sizeBytes = 0, inode = "1") => ({ device: "1", inode, sizeBytes, mode: "0644", uid: 1, gid: 1, mtimeNs: "100", ctimeNs: "100" });
const member = (path: string, content: string): FileManifestEntry => {
  const sizeBytes = new TextEncoder().encode(content).length;
  return { path, kind: "regular", status: "complete", reason: "", sizeBytes, mode: "0644", uid: 1, gid: 1, sha256: sha256Utf8(content), identity: identity(sizeBytes) };
};
async function withManifests(input: NginxConfigInput, entries: FileManifestEntry[], directory = "/etc/nginx/conf.d") {
  for (const receipt of input.receipts) Object.assign(receipt.operation.attempts[0]!, { startedAt: 20, completedAt: 25 });
  const repository = createMemoryExecutionLedgerRepository();
  const request = normalizeFileManifestRequest({ path: directory, source: "directory" });
  const bytes = entries.filter(item => item.kind === "regular").reduce((sum, item) => sum + item.sizeBytes, 0);
  const data: FileManifestResult = { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: entries.every(item => ["regular", "directory"].includes(item.kind)),
    rootIdentity: { ...identity(), mode: "0755" }, entries, issues: [], issueCount: 0, scannedEntries: entries.length, contentBytes: bytes, readBytes: bytes * 2, archiveReadBytes: 0, expandedBytes: 0,
    manifestSha256: fileManifestDigest(entries), archiveSha256: null, sampledAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:00:01Z", elapsedMs: 1000,
    consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
  for (let i = 0; i < 2; i++) {
    const step: PlanStep = { id: `manifest-${i}`, title: "目录完整范围", description: "前后目录清单", kind: "observe", risk: "low", status: "pending", command: "", validation: "", expected: "真实完整范围",
      action: { type: "tool", toolId: "files.inspect_manifest", arguments: { ...request } } };
    const intent = preparePlanForApproval([step], { taskId: "task", permission: "safe", server, servers: [server], connectionGeneration: 7 }, [fileManifestTool]).steps[0]!.intent;
    const id = `manifest-${i}`;
    await repository.prepare({ version: 1, operationId: id, taskId: "task", stepId: step.id, roundId: "round", workflowEpoch: 3, planRevision: 1, stepRevision: 1,
      intentDigest: intent.digest, intent, phase: "tool", effect: "read", resourceKeys: [`server:${server.id}`], executionId: id });
    await repository.begin(id, id, id);
    await repository.complete({ operationId: id, attemptId: id, eventId: id, outcome: { status: "succeeded", evidenceRefs: [id], result: { callId: id, toolId: "files.inspect_manifest", success: true, data } } });
    await repository.acknowledge(id, id, false);
  }
  const records = await repository.list();
  records.forEach((operation, i) => {
    Object.assign(operation.attempts[0]!, { startedAt: i === 0 ? 10 : 30, completedAt: i === 0 ? 15 : 35 });
    input.receipts.push({ operation, attemptId: operation.attempts[0]!.id });
  });
  return input;
}

describe("B02 有执行身份的 Nginx 静态配置证据", () => {
  it("回放AG33原始字面return站点，旧页面是终止响应而不是后端代理", async () => {
    // Verbatim site content from the archived independent receipt; never used
    // to branch production behavior or read mutable historical docs at runtime.
    const archived = 'server {\n listen 18033;\n server_name _;\n location / { return 200 "OPSARK-AGENT33-OLD-FRONTEND\\n"; }\n}\nserver {\n listen 18034;\n server_name _;\n location / { return 200 "OPSARK-AGENT33-CONTROL-UNCHANGED\\n"; }\n}\n';
    const input = await fixture({ [entry]: conf(archived) });
    input.target = { address: "127.0.0.1", port: 18033, serverName: "_", uriPath: "/" };
    const result = analyzeNginxConfigEvidence(input);
    expect(result.status, JSON.stringify(result.reasons)).toBe("parsed");
    expect(result.selected).toMatchObject({ terminalResponse: { kind: "literal_return", statusCode: 200,
      declaredText: "OPSARK-AGENT33-OLD-FRONTEND\n", context: "location", terminatesRequest: true }, proxySetHeaders: [] });
    expect(result.selected?.proxyPass).toBeUndefined();
    expect(result.configurationLoaded).toBe(false);
    const request = { entryPath: input.entryPath, prefix: input.prefix, target: input.target, sourceStepIds: ["step-0"] };
    expect(nginxConfigResultIssue(request, { request, analysis: result, sourceEvidenceIds: ["evidence-0"] })).toBeUndefined();
  });
  it.each(["return 200;", 'return 201 "created";', 'return 404 "";', 'return 503 "维护中\\n";', 'return 204 "declared, not observed";'])("有限字面终止声明：%s", async returned => {
    const result = await analyze(conf(site(`root /srv/site; location / { ${returned} proxy_pass http://127.0.0.1:9000; proxy_set_header Host $host; }`)));
    expect(result.status, JSON.stringify(result.reasons)).toBe("parsed");
    expect(result.selected?.terminalResponse?.terminatesRequest).toBe(true);
    expect(result.selected?.proxyPass).toBeUndefined(); expect(result.selected?.root).toBeUndefined();
    expect(result.selected?.alias).toBeUndefined(); expect(result.selected?.proxySetHeaders).toEqual([]);
    expect(result.limitations).toContain("return_text_is_declaration_not_observed_response");
  });
  it("server阶段return先于location，不把声明位置的先后误当代理处理顺序", async () => {
    const result = await analyze(conf(site('location / { proxy_pass http://127.0.0.1:9000; return 200 "location"; } return 403 "server";')));
    expect(result.status).toBe("parsed");
    expect(result.selected?.terminalResponse).toMatchObject({ statusCode: 403, declaredText: "server", context: "server" });
    expect(result.selected?.locationId).toBeUndefined(); expect(result.selected?.proxyPass).toBeUndefined();
  });
  it("顺序包括展开的include，第一条return终止后不再运行第二条", async () => {
    const input = await fixture({ [entry]: conf(site('location / { include first.conf; return 503 "second"; }')),
      "/etc/nginx/first.conf": 'return 200 "first";' });
    const result = analyzeNginxConfigEvidence(input);
    expect(result.status).toBe("parsed");
    expect(result.selected?.terminalResponse).toMatchObject({ statusCode: 200, declaredText: "first", source: { path: "/etc/nginx/first.conf" } });
  });
  it("精确和最长前缀选择决定return，仅其他location有return不覆盖当前proxy", async () => {
    const input = await fixture({ [entry]: conf(site('location / { return 200 "root"; } location /api/ { proxy_pass http://127.0.0.1:9000; } location = /api/status { return 503 "status"; }')) });
    input.target.uriPath = "/api/order";
    expect(analyzeNginxConfigEvidence(input).selected).toMatchObject({ proxyPass: "http://127.0.0.1:9000" });
    expect(analyzeNginxConfigEvidence(input).selected?.terminalResponse).toBeUndefined();
    input.target.uriPath = "/api/status";
    expect(analyzeNginxConfigEvidence(input).selected?.terminalResponse).toMatchObject({ statusCode: 503, declaredText: "status" });
    input.target.uriPath = "/other";
    expect(analyzeNginxConfigEvidence(input).selected?.terminalResponse).toMatchObject({ statusCode: 200, declaredText: "root" });
  });
  it("字面响应保留UTF8/换行和来源，代理声明在return之前仍不可达", async () => {
    const result = await analyze(conf(site('location / { alias /srv/a/; proxy_pass http://127.0.0.1:9000; return 200 "中文;#{}\\n"; }')));
    expect(result.status).toBe("parsed");
    expect(result.selected?.terminalResponse).toMatchObject({ declaredText: "中文;#{}\n", context: "location", source: { path: entry } });
    expect(result.selected?.alias).toBeUndefined(); expect(result.selected?.proxyPass).toBeUndefined();
  });
  it("修改目标return不影响其他location指纹，修改对照return仍能识别", async () => {
    const original = conf(site('location / { return 200 "target"; } location /control { return 200 "control"; }'));
    const first = await analyze(original), changed = await analyze(original.replace('"target"', '"new-target"'));
    expect(changed.nonTargetFingerprint).toBe(first.nonTargetFingerprint);
    expect(changed.globalFingerprint).toBe(first.globalFingerprint);
    expect((await analyze(original.replace('"control"', '"changed-control"'))).nonTargetFingerprint).not.toBe(first.nonTargetFingerprint);
  });
  it.each(['return;', 'return $status;', 'return 200 "$host";', 'return 200 "${host}";',
    'return 301 "https://example.test/";', 'return 302;', 'return 303 /new;', 'return 307 /new;', 'return 308 /new;',
    'return 444;', 'return 494;', 'return 495;', 'return 496;', 'return 497;', 'return 498;', 'return 499;',
    'return 600;', 'return 199;', 'return 0200 "old";', 'return https://example.test/;',
    'return 200 one two;', 'if ($host) { return 200 "conditional"; }', 'return 200 "first"; return 200 "$uri";',
    'rewrite ^ /other; return 200 "done";', 'error_page 404 /error; return 404;', 'break; return 200;'])
    ("动态/未覆盖return或控制流保持unknown：%s", async declaration => {
      const result = await analyze(conf(site(`location / { ${declaration} proxy_pass http://127.0.0.1:9000; }`)));
      expect(result.status).toBe("unknown"); expect(result.selected).toBeUndefined();
    });
  it("return不允许出现在http上下文，即使目标location合法", async () => {
    const result = await analyze(conf('return 200 "http"; ' + site()));
    expect(result.status).toBe("unknown"); expect(result.reasons.some(reason => reason.code === "directive_context_mismatch")).toBe(true);
  });
  it("字面正文按UTF8字节有界，字符数量不能掩盖超过4096字节", async () => {
    const accepted = await analyze(conf(site('return 200 "' + "中".repeat(1365) + 'a";')));
    expect(accepted.status).toBe("parsed");
    const refused = await analyze(conf(site('return 200 "' + "中".repeat(1366) + '";')));
    expect(refused.status).toBe("unknown");
    expect(refused.reasons).toContainEqual({ code: "token_byte_limit" });
  });
  it.each(["missing", "status", "text", "source", "context", "proxy", "root", "alias", "headers", "limitation"] as const)
    ("结果消费者拒绝被篡改或矛盾的终止响应：%s", async kind => {
      const input = await fixture({ [entry]: conf(site('location / { return 200 "answer"; }')) });
      const analysis = analyzeNginxConfigEvidence(input), selected = analysis.selected!;
      if (kind === "missing") delete selected.terminalResponse;
      if (kind === "status") selected.terminalResponse!.statusCode = 201;
      if (kind === "text") selected.terminalResponse!.declaredText = "changed";
      if (kind === "source") selected.terminalResponse!.source = { ...selected.terminalResponse!.source, startByte: 0 };
      if (kind === "context") selected.terminalResponse!.context = "server";
      if (kind === "proxy") selected.proxyPass = "http://127.0.0.1:9000";
      if (kind === "root") selected.root = "/srv/a";
      if (kind === "alias") selected.alias = "/srv/a";
      if (kind === "headers") selected.proxySetHeaders = [{ name: "X-Test", value: "literal", expression: { kind: "literal" } }];
      if (kind === "limitation") analysis.limitations = analysis.limitations.filter(item => item !== "return_text_is_declaration_not_observed_response");
      const request = { entryPath: input.entryPath, prefix: input.prefix, target: input.target, sourceStepIds: ["step-0"] };
      expect(nginxConfigResultIssue(request, { request, analysis, sourceEvidenceIds: ["evidence-0"] })).toBeDefined();
    });
  it("从实际准备和内存账本收据解析静态站点，保留UTF8来源且不证明已加载", async () => {
    const text = conf(); const evidence = await analyze(text);
    expect(evidence.status, JSON.stringify(evidence.reasons)).toBe("parsed");
    expect(evidence.selected).toMatchObject({ root: "/srv/site", proxySetHeaders: [] });
    expect(evidence).toMatchObject({ configurationLoaded: false, objectIdentityVerified: false });
    expect(evidence.sources[0]).toMatchObject({ operationId: "op-0", attemptId: "attempt-0", executionId: "execution-0", pathIdentity: "requested_path_only" });
    const range = evidence.servers[0]!.source, bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(range.startByte, range.endByte))).toBe(site());
    expect(evidence.globalFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it("字面引号、分号、井号和花括号不制造虚假server或location", async () => {
    const evidence = await analyze(conf(site('root "/srv/站点;#{}"; proxy_set_header X-Label "literal;#{}"; location / { proxy_pass http://127.0.0.1:9000/base/; }')));
    expect(evidence.status, JSON.stringify(evidence.reasons)).toBe("parsed");
    expect(evidence.servers).toHaveLength(1);
    expect(evidence.selected).toMatchObject({ root: "/srv/站点;#{}", proxyPass: "http://127.0.0.1:9000/base/", proxySetHeaders: [{ name: "X-Label", value: "literal;#{}" }] });
  });
  it("未加引号的词内井号为字面字符，不能当行注释抹掉实际根目录", async () => {
    const evidence = await analyze(conf(site("root /srv/site#release;")));
    expect(evidence.status).toBe("parsed"); expect(evidence.selected?.root).toBe("/srv/site#release");
  });
  it("精确include按主配置目录展开，root相对路径按运行prefix解析", async () => {
    const input = await fixture({ [entry]: conf("include snippets/site.conf;"), "/etc/nginx/snippets/site.conf": site("include defaults.conf;"), "/etc/nginx/defaults.conf": "root html;" });
    const evidence = analyzeNginxConfigEvidence(input);
    expect(evidence.status, JSON.stringify(evidence.reasons)).toBe("parsed");
    expect(evidence.selected?.root).toBe("/usr/local/nginx/html");
    expect(evidence.includes.map(item => item.resolvedPath)).toEqual(["/etc/nginx/snippets/site.conf", "/etc/nginx/defaults.conf"]);
    expect(evidence.includes.every(item => item.covered)).toBe(true);
  });
  it("server_name选择先受listen地址限制，错误Host不能直接选第一站", async () => {
    const input = await fixture({ [entry]: conf(site("root /srv/a;", "app.example") + site("root /srv/b;", "other.example")) });
    input.target.serverName = "absent.example";
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
    expect(analyzeNginxConfigEvidence(input).selected).toBeUndefined();
    const explicit = await fixture({ [entry]: conf(site().replace("8080;", "8080 default_server;") + site("root /srv/b;", "other.example")) });
    explicit.target.serverName = "absent.example";
    expect(analyzeNginxConfigEvidence(explicit).selected?.root).toBe("/srv/site");
  });
  it("精确地址优先于通配监听，IPv6使用同一规范身份", async () => {
    const input = await fixture({ [entry]: conf(site("root /srv/wild;") + site("root /srv/exact;").replace("listen 8080;", "listen 127.0.0.1:8080;")) });
    expect(analyzeNginxConfigEvidence(input).selected?.root).toBe("/srv/exact");
    const ipv6 = await fixture({ [entry]: conf(site().replace("listen 8080;", "listen [::1]:8080;")) });
    ipv6.target.address = "0:0:0:0:0:0:0:1";
    expect(analyzeNginxConfigEvidence(ipv6).selected?.root).toBe("/srv/site");
  });
  it("精确和最长前缀location及alias覆盖继承root，子级headers整组覆盖", async () => {
    const input = await fixture({ [entry]: conf(site('root /srv/site; proxy_set_header X-Parent old; location / { root /srv/fallback; } location /assets/ { alias /srv/assets/; proxy_set_header X-Child new; } location = /assets/a { root /srv/exact; }')) });
    input.target.uriPath = "/assets/a"; expect(analyzeNginxConfigEvidence(input).selected?.root).toBe("/srv/exact");
    input.target.uriPath = "/assets/b";
    expect(analyzeNginxConfigEvidence(input).selected).toMatchObject({ alias: "/srv/assets/", proxySetHeaders: [{ name: "X-Child", value: "new" }] });
    expect(analyzeNginxConfigEvidence(input).selected?.root).toBeUndefined();
  });
  it("只改目标块时非目标/全局指纹保持，改第二站或全局字节则能识别", async () => {
    const original = await analyze(conf(site() + "\n" + site("root /srv/control;", "control.example")));
    const changed = await analyze(conf(site("root /srv/new-release-with-longer-name;") + "\n" + site("root /srv/control;", "control.example")));
    expect(changed.nonTargetFingerprint).toBe(original.nonTargetFingerprint);
    expect(changed.globalFingerprint).toBe(original.globalFingerprint);
    expect(changed.servers[0]?.fingerprint).not.toBe(original.servers[0]?.fingerprint);
    const control = await analyze(conf(site() + "\n" + site("root /srv/unwanted;", "control.example")));
    expect(control.nonTargetFingerprint).not.toBe(original.nonTargetFingerprint);
    const global = await analyze(conf(site() + "\n" + site("root /srv/control;", "control.example")).replace("worker_processes 1", "worker_processes 2"));
    expect(global.globalFingerprint).not.toBe(original.globalFingerprint);
  });
  it.each([
    conf("include conf.d/*.conf;"), conf("include missing.conf;"), conf(site("location ~ /api { proxy_pass http://127.0.0.1:9000; }")),
    conf(site("location / { rewrite ^ /other; proxy_pass http://127.0.0.1:9000; }")), conf(site("root $document_root;")),
    conf(site("location / { proxy_pass http://$backend; }")), conf(site("location / { proxy_set_header Host $unproven_variable; }")),
    conf(site("root /srv/a;", "*.example")), conf(site() + site()), conf(site("location / { root /a; } location / { root /b; }")),
    conf(site("third_party_handler on;")), conf(site("location / { location /nested { root /a; } }")),
    conf(site("root '/srv/a'junk;")), conf(site("root /srv/with\\ space;")), conf(site()).slice(0, -3),
  ])("复杂、未覆盖、歧义或破损配置保持unknown，不挑选一个成功结果：%s", async text => {
    const evidence = await analyze(text); expect(evidence.status).toBe("unknown"); expect(evidence.reasons.length).toBeGreaterThan(0); expect(evidence.selected).toBeUndefined();
  });
  it("include循环有界停止，共享include中非目标变动不能消失", async () => {
    const cycle = await fixture({ [entry]: conf("include cycle.conf;"), "/etc/nginx/cycle.conf": "include nginx.conf;" });
    expect(analyzeNginxConfigEvidence(cycle).reasons).toContainEqual({ code: "include_cycle" });
    const first = await fixture({ [entry]: conf(site("include common.conf;") + site("include common.conf;", "other.example")), "/etc/nginx/common.conf": "root /srv/a;" });
    const second = await fixture({ [entry]: conf(site("include common.conf;") + site("include common.conf;", "other.example")), "/etc/nginx/common.conf": "root /srv/b;" });
    expect(analyzeNginxConfigEvidence(first).nonTargetFingerprint).not.toBe(analyzeNginxConfigEvidence(second).nonTargetFingerprint);
    const commentOnly = await fixture({ [entry]: conf(site("include common.conf;") + site("include common.conf;", "other.example")), "/etc/nginx/common.conf": "# non-target comment changed\nroot /srv/a;" });
    expect(analyzeNginxConfigEvidence(first).nonTargetFingerprint).not.toBe(analyzeNginxConfigEvidence(commentOnly).nonTargetFingerprint);
  });
  it("通配地址default_server不能授予另一明确地址的默认身份", async () => {
    const input = await fixture({ [entry]: conf(site().replace("listen 8080;", "listen 8080 default_server; listen 127.0.0.1:8080;")) });
    input.target.serverName = "absent.example";
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
  });
  it("glob即使恰好给了一份匹配读取也不证明目录枚举完整", async () => {
    const input = await fixture({ [entry]: conf("include conf.d/*.conf;"), "/etc/nginx/conf.d/site.conf": site() });
    const result = analyzeNginxConfigEvidence(input);
    expect(result.status).toBe("unknown"); expect(result.includes[0]?.covered).toBe(false);
  });
  it("解析深度和词法总量有固定上限", async () => {
    expect((await analyze("http {".repeat(34) + "}".repeat(34))).reasons).toContainEqual({ code: "nesting_limit" });
    expect((await analyze("x;".repeat(26000))).reasons).toContainEqual({ code: "token_limit" });
  });
  it.each([
    conf(site('location @fallback { root /a; }')), conf(site('location ~* "\\\\.php$" { root /a; }')),
    conf('include "bad\\npath";'), conf(site('"" ignored;')), conf(site('"bad\\nname" ignored;')),
    conf(site('root /' + 'a'.repeat(4100) + ';')), conf(site('index ' + Array(129).fill('a').join(' ') + ';')),
  ])("未知复杂配置仍产生有界合法工具回执：%s", async text => {
    const evidence = await analyze(text); expect(evidence.status).toBe("unknown"); expect(evidence.selected).toBeUndefined();
  });
  it.each(["host", "http_host", "remote_addr", "proxy_add_x_forwarded_for", "scheme"])("标准header变量$%s保留表达式，不伪造运行值", async variable => {
    const result = await analyze(conf(site(`location / { proxy_pass http://127.0.0.1:9000; proxy_set_header X-Proof $${variable}; }`)));
    expect(result.status, JSON.stringify(result.reasons)).toBe("parsed");
    expect(result.selected?.proxySetHeaders).toEqual([{ name: "X-Proof", value: `$${variable}`, expression: { kind: "nginx_variables", variables: [variable], runtimeValueKnown: false } }]);
    expect(result.limitations).toContain("header_expressions_are_not_observed_runtime_values");
  });
  it("目标是location时，同server其他location及上层声明都属于保护范围", async () => {
    const baseline = conf(site("root /srv/main; location / { proxy_pass http://127.0.0.1:9000; } location /control { root /srv/control; }"));
    const first = await analyze(baseline);
    const allowed = await analyze(baseline.replace(":9000", ":9001"));
    expect(allowed.nonTargetFingerprint).toBe(first.nonTargetFingerprint);
    expect((await analyze(baseline.replace("/srv/control", "/srv/wrong"))).nonTargetFingerprint).not.toBe(first.nonTargetFingerprint);
    expect((await analyze(baseline.replace("/srv/main", "/srv/wrong"))).nonTargetFingerprint).not.toBe(first.nonTargetFingerprint);
  });
  it("标准glob只在前后目录身份/清单及每个命中文件收据一致时展开", async () => {
    const text = site("location / { proxy_pass http://127.0.0.1:9000; proxy_set_header Host $host; }");
    const input = await withManifests(await fixture({ [entry]: conf("include conf.d/*.conf;"), "/etc/nginx/conf.d/app.conf": text }), [member("app.conf", text)]);
    const result = analyzeNginxConfigEvidence(input);
    expect(result.status, JSON.stringify(result.reasons)).toBe("parsed");
    expect(result.includes[0]).toMatchObject({ covered: true, resolvedPaths: ["/etc/nginx/conf.d/app.conf"], directoryCoverage: { beforeOperationId: "manifest-0", afterOperationId: "manifest-1" } });
    expect(result.configurationLoaded).toBe(false); expect(result.objectIdentityVerified).toBe(false);
  });
  it("完整空目录glob不要求虚构文件；点文件遵循显式点前缀", async () => {
    const empty = await withManifests(await fixture({ [entry]: conf("include conf.d/*.conf; " + site()) }), []);
    expect(analyzeNginxConfigEvidence(empty).includes[0]).toMatchObject({ covered: true, resolvedPaths: [] });
    const hidden = await withManifests(await fixture({ [entry]: conf("include conf.d/*.conf; " + site()) }), [member(".hidden.conf", "arbitrary hidden text")]);
    expect(analyzeNginxConfigEvidence(hidden).status).toBe("parsed");
  });
  it.each(["one_manifest", "extra_member", "wrong_hash", "changed_inode", "changed_root", "read_before", "read_after", "late_manifest", "partial_manifest", "symlink", "directory"] as const)("glob的%s反例保持unknown", async kind => {
    const text = site(), input = await withManifests(await fixture({ [entry]: conf("include conf.d/*.conf;"), "/etc/nginx/conf.d/app.conf": text }), [member("app.conf", text)]);
    const manifestReceipts = input.receipts.filter(item => item.operation.phase === "tool" && item.operation.intent.semantic.action.type === "tool" && item.operation.intent.semantic.action.toolId === "files.inspect_manifest");
    const after = manifestReceipts[1]!.operation.attempts[0]!;
    const afterData = (after.outcome!.result as { data: FileManifestResult }).data;
    if (kind === "one_manifest") input.receipts = input.receipts.filter(item => item !== manifestReceipts[1]);
    if (kind === "extra_member") {
      for (const receipt of manifestReceipts) {
        const current = (receipt.operation.attempts[0]!.outcome!.result as { data: FileManifestResult }).data;
        current.entries.push(member("unread.conf", text)); current.scannedEntries++;
        current.contentBytes *= 2; current.readBytes *= 2; current.manifestSha256 = fileManifestDigest(current.entries);
      }
    }
    if (kind === "wrong_hash") {
      for (const receipt of manifestReceipts) {
        const current = (receipt.operation.attempts[0]!.outcome!.result as { data: FileManifestResult }).data;
        current.entries[0]!.sha256 = "a".repeat(64); current.manifestSha256 = fileManifestDigest(current.entries);
      }
    }
    if (kind === "changed_inode") afterData.entries[0]!.identity!.inode = "2";
    if (kind === "changed_root") afterData.rootIdentity!.inode = "2";
    if (kind === "read_before") input.receipts[1]!.operation.attempts[0]!.startedAt = 12;
    if (kind === "read_after") input.receipts[1]!.operation.attempts[0]!.completedAt = 32;
    if (kind === "late_manifest") after.late = true;
    if (kind === "partial_manifest") Object.assign(afterData, { status: "partial", coverageComplete: false, safeForDeployment: false, manifestSha256: null });
    if (kind === "symlink" || kind === "directory") {
      for (const receipt of manifestReceipts) {
        const current = (receipt.operation.attempts[0]!.outcome!.result as { data: FileManifestResult }).data;
        const item = current.entries[0]!; item.kind = kind; item.sizeBytes = 0; delete item.sha256;
        if (kind === "symlink") item.linkTarget = "/etc/nginx/elsewhere.conf";
        Object.assign(current, { contentBytes: 0, readBytes: 0, safeForDeployment: kind === "directory", manifestSha256: fileManifestDigest(current.entries) });
      }
    }
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
  });
  it.each(["task", "round", "epoch", "server", "connection", "late", "cancel", "unapplied", "unknown", "call", "path", "digest", "no_evidence"] as const)("拒绝%s不匹配的收据，不能由模型粘贴配置代替真实执行", async kind => {
    const input = await fixture({ [entry]: conf() }), receipt = input.receipts[0]!, operation = receipt.operation, attempt = operation.attempts[0]!;
    if (kind === "task") input.binding.taskId = "other";
    if (kind === "round") input.binding.roundId = "other";
    if (kind === "epoch") input.binding.workflowEpoch++;
    if (kind === "server") input.binding.serverId = "other";
    if (kind === "connection") input.binding.connectionGeneration++;
    if (kind === "late") attempt.late = true;
    if (kind === "cancel") operation.cancelRequested = true;
    if (kind === "unapplied") delete attempt.projectionAppliedAt;
    if (kind === "unknown") attempt.status = "unknown";
    if (kind === "call") (attempt.outcome!.result as { callId: string }).callId = "model-made-up";
    if (kind === "path") data(input).path = "/etc/other.conf";
    if (kind === "digest") operation.intent.semantic.expected = "tampered";
    if (kind === "no_evidence") attempt.outcome!.evidenceRefs = [];
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
  });
  it.each(["truncated", "bytes", "redacted", "replacement", "duplicate", "plain_text"] as const)("%s不能升级为完整可解析配置", async kind => {
    const input = await fixture({ [entry]: conf() });
    if (kind === "truncated") Object.assign(data(input), { truncated: true, totalBytes: 9999 });
    if (kind === "bytes") data(input).returnedBytes = 1;
    if (kind === "redacted" || kind === "replacement") {
      const content = conf(site(`root /srv/${kind === "redacted" ? "••••••••" : "\uFFFD"};`));
      Object.assign(data(input), { content, totalBytes: new TextEncoder().encode(content).length, returnedBytes: new TextEncoder().encode(content).length });
    }
    if (kind === "duplicate") input.receipts.push(structuredClone(input.receipts[0]!));
    if (kind === "plain_text") input.receipts[0]!.operation.attempts[0]!.outcome!.result = conf();
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
  });
  it("同一连接的未知后续attempt不能复用旧成功；修订后的意图摘要也必须一致", async () => {
    const input = await fixture({ [entry]: conf() }), operation = input.receipts[0]!.operation;
    operation.attempts.push({ ...operation.attempts[0]!, id: "new", status: "unknown" });
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
    operation.attempts.pop(); operation.intent.semantic.effect = "change";
    operation.intent.digest = executionDigest({ version: operation.intent.version, semantic: operation.intent.semantic }); operation.intentDigest = operation.intent.digest;
    expect(analyzeNginxConfigEvidence(input).status).toBe("unknown");
  });
  it("即使serverId和generation相同，也不能混合实际SSH端点不同的配置收据", async () => {
    const input = await fixture({ [entry]: conf("include site.conf;"), "/etc/nginx/site.conf": site() });
    const operation = input.receipts[1]!.operation;
    operation.intent.semantic.targets.forEach(target => { target.host = "different.invalid"; });
    operation.intent.digest = executionDigest({ version: operation.intent.version, semantic: operation.intent.semantic }); operation.intentDigest = operation.intent.digest;
    expect(analyzeNginxConfigEvidence(input).reasons).toContainEqual({ code: "endpoint_identity_mismatch" });
  });
});
