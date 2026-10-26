import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/types";
import { createMemoryExecutionLedgerRepository } from "@/services/executionLedger";
import { enforceToolResult } from "@/features/tools/toolResultContract";
import { fileManifestDigest } from "@/features/tools/fileManifestInspection";
import { httpDeliveryLimitations } from "@/features/tools/httpDeliveryContracts";
import { normalizeHttpDeliveryRequest, httpDeliveryTarget } from "@/features/tools/httpDeliveryInspection";
import { canonicalExecutionJson, preparePlanForApproval, sha256Utf8 } from "./planPreparation";
import { inspectNginxConfigurationFromLedger } from "./nginxConfigRuntime";
import { evaluateStaticSiteLedger, staticSiteApprovalBindings } from "./staticSiteAcceptance";
import { fixture, manifest, newFiles, oldFiles, server, sourceTime, start } from "./staticSiteAcceptance.fixtures";

// Independent review: only the remote observation is controlled. Every receipt
// passes the real tool contract and memory-ledger prepare/begin/complete APIs.
let sequence = 0;
async function record(f: Awaited<ReturnType<typeof fixture>>, toolId: string, args: Record<string, unknown>,
  data: (execution: string, normalized: Record<string, unknown>) => unknown, at: number) {
  const id = `review-${sequence++}`;
  const step: PlanStep = { id, title: toolId, description: "controlled review", action: { type: "tool", toolId, arguments: args },
    command: "", validation: "", kind: "observe", risk: "low", expected: "真实契约收据", status: "pending" };
  const prepared = preparePlanForApproval([step], { taskId: f.current.id, permission: f.current.permission,
    requirementRevision: f.current.requirementLifecycle!.revision, server, servers: [server], connectionGeneration: 1,
    inputBindings: staticSiteApprovalBindings(f.current) });
  const intent = prepared.steps[0]!.intent;
  if (intent.semantic.action.type !== "tool") throw new Error("not a tool");
  const result = { callId: id, toolId, success: true, data: data(id, intent.semantic.action.arguments) };
  const validated = enforceToolResult({ id, toolId, arguments: intent.semantic.action.arguments }, result);
  expect(validated.success, JSON.stringify(validated)).toBe(true);
  const repo = createMemoryExecutionLedgerRepository();
  await repo.prepare({ version: 1, operationId: id, taskId: f.current.id, stepId: id, roundId: f.current.currentRoundId,
    workflowEpoch: f.current.workflowEpoch!, planRevision: prepared.planRevision, stepRevision: 1, intentDigest: intent.digest,
    intent, phase: "tool", effect: "read", resourceKeys: ["server:server"], executionId: id });
  await repo.begin(id, id, id);
  await repo.complete({ operationId: id, attemptId: id, eventId: id, outcome: { status: "succeeded", evidenceRefs: [id], result } });
  await repo.acknowledge(id, id, false);
  const operation = (await repo.list())[0]!;
  Object.assign(operation.attempts[0]!, { startedAt: start + at * 1000, completedAt: start + (at + .5) * 1000 });
  f.records.push(operation);
  return operation;
}
async function alternatePeer(f: Awaited<ReturnType<typeof fixture>>, url: string, text: string, at: number) {
  return record(f, "http.inspect_delivery", { url, connectAddress: "203.0.113.9" }, (execution, args) => {
    const request = normalizeHttpDeliveryRequest(args);
    const binding = { executionId: execution, probeId: "opsark-12345678-1234-4234-8234-123456789abc", requestDigest: sha256Utf8(canonicalExecutionJson(request)) };
    return { request, binding, status: "complete", coverageComplete: true,
      target: { ...httpDeliveryTarget(request, binding), peerAddress: "203.0.113.9", peerPort: Number(new URL(url).port) },
      response: { httpStatus: 200, headers: {}, body: { mode: "sha256", readBytes: new TextEncoder().encode(text).length,
        eof: true, complete: true, encoding: "identity", sha256: sha256Utf8(text) }, status: "complete", reason: "complete" },
      correlation: null, sampledAt: sourceTime(at), finishedAt: sourceTime(at + .5), elapsedMs: 500,
      reason: "complete", limitations: [...httpDeliveryLimitations] };
  }, at);
}
async function deploy(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, string> = newFiles) {
  await f.change(10); await f.m(manifest("/tmp/backup", "directory", oldFiles), 12);
  await f.m(manifest("/tmp/site", "directory", oldFiles), 14); await f.change(16);
  await f.m(manifest("/tmp/site", "directory", files), 18);
  await f.http("http://127.0.0.1:18081/", "CONTROL", 24); await f.configuration(26);
  await f.m(manifest("/tmp/backup", "directory", oldFiles), 28);
}
const assessment = (f: Awaited<ReturnType<typeof fixture>>) => evaluateStaticSiteLedger(f.current, server, 1, f.records).assessments[0]!;

describe("静态交付独立审查：实际契约及落账边界", () => {
  it("完整有效基线及部署可满足，反例不是无效fixture造成", async () => {
    const f = await fixture(); expect(assessment(f).baselineReady).toBe(true);
    await deploy(f); await f.http("http://127.0.0.1:18080/", newFiles["index.html"], 20);
    await f.http("http://127.0.0.1:18080/style.css", newFiles["style.css"], 22);
    expect(assessment(f).state).toBe("met");
  });
  it("同URL经connectAddress访问其他IP的同内容响应不能证明目标入口", async () => {
    const f = await fixture(); await deploy(f);
    await alternatePeer(f, "http://127.0.0.1:18080/", newFiles["index.html"], 20);
    await alternatePeer(f, "http://127.0.0.1:18080/style.css", newFiles["style.css"], 22);
    expect(assessment(f).conditions.find(c => c.id === "http_content")?.state).not.toBe("met");
  });
  it("用不同监听地址选择的配置不能授权当前入口部署基线", async () => {
    const f = await fixture();
    f.records.splice(f.records.findIndex(o => o.intent.semantic.action.type === "tool" && o.intent.semantic.action.toolId === "nginx.inspect_configuration"), 1);
    const body = f.records.find(o => o.intent.semantic.action.type === "tool" && o.intent.semantic.action.toolId === "files.read_content")!;
    const args = { entryPath: "/etc/nginx/nginx.conf", prefix: "/etc/nginx", target: { address: "127.0.0.2", port: 18080, serverName: "127.0.0.1", uriPath: "/" }, sourceStepIds: [body.stepId] };
    await record(f, "nginx.inspect_configuration", args, () => inspectNginxConfigurationFromLedger(args,
      { taskId: f.current.id, roundId: f.current.currentRoundId!, workflowEpoch: 1, serverId: server.id, connectionGeneration: 1 }, f.records), 4);
    expect(assessment(f).baselineReady).toBe(false);
  });
  it("合法归档省略隐式父目录时，部署出的相同成员不应永久判内容不一致", async () => {
    const f = await fixture(), files = { "index.html": '<link rel="stylesheet" href="assets/style.css">', "assets/style.css": "body{}" };
    const original = f.records.find(o => o.intent.semantic.action.type === "tool" && o.intent.semantic.action.toolId === "files.inspect_manifest")!;
    f.records.splice(f.records.indexOf(original), 1);
    const archive = manifest("/tmp/site-v2.tar.gz", "tar_gzip", files);
    await record(f, "files.inspect_manifest", { ...archive.request }, () => archive, 1);
    await deploy(f, files);
    const directory = manifest("/tmp/site", "directory", files);
    directory.entries.push({ path: "assets", kind: "directory", status: "complete", reason: "", sizeBytes: 0, mode: "0755", uid: 1, gid: 1,
      identity: { ...directory.rootIdentity!, sizeBytes: 4096 } });
    directory.scannedEntries++; directory.manifestSha256 = fileManifestDigest(directory.entries);
    await record(f, "files.inspect_manifest", { ...directory.request }, () => directory, 19);
    expect(assessment(f).conditions.find(c => c.id === "deployed_content")?.state).toBe("met");
  });
  it.each([
    '<video src="missing.mp4"></video>',
    '<audio><source src="missing.ogg"></audio>',
    '<meta http-equiv="refresh" content="0;url=/missing.html">',
  ])("有限HTML不能忽略未支持的活动依赖并宣称公开资源完整：%s", async html => {
    const f = await fixture(), files = { "index.html": html };
    const original = f.records.find(o => o.intent.semantic.action.type === "tool" && o.intent.semantic.action.toolId === "files.inspect_manifest")!;
    f.records.splice(f.records.indexOf(original), 1);
    const archive = manifest("/tmp/site-v2.tar.gz", "tar_gzip", files);
    await record(f, "files.inspect_manifest", { ...archive.request }, () => archive, 1);
    await deploy(f, files); await f.readText("/tmp/site/index.html", html, 19);
    await f.http("http://127.0.0.1:18080/", html, 20);
    expect(assessment(f).conditions.find(c => c.id === "public_resources")?.state).not.toBe("met");
    expect(assessment(f).state).not.toBe("met");
  });
  it("stylesheet没有.css扩展名时仍须检查其额外资源依赖", async () => {
    const f = await fixture(), files = { "index.html": '<link rel="stylesheet" href="theme">', "theme": 'body{background:url("missing.png")}' };
    const original = f.records.find(o => o.intent.semantic.action.type === "tool" && o.intent.semantic.action.toolId === "files.inspect_manifest")!;
    f.records.splice(f.records.indexOf(original), 1);
    const archive = manifest("/tmp/site-v2.tar.gz", "tar_gzip", files);
    await record(f, "files.inspect_manifest", { ...archive.request }, () => archive, 1);
    await deploy(f, files); await f.readText("/tmp/site/index.html", files["index.html"], 19);
    await f.readText("/tmp/site/theme", files.theme, 20);
    await f.http("http://127.0.0.1:18080/", files["index.html"], 21);
    await f.http("http://127.0.0.1:18080/theme", files.theme, 22);
    expect(assessment(f).conditions.find(c => c.id === "public_resources")?.state).not.toBe("met");
    expect(assessment(f).state).not.toBe("met");
  });
  it("较新目标目录采样发现变化且partial时，不得倒选旧完整清单授予完成", async () => {
    const f = await fixture(); await deploy(f);
    await f.http("http://127.0.0.1:18080/", newFiles["index.html"], 20);
    await f.http("http://127.0.0.1:18080/style.css", newFiles["style.css"], 22);
    expect(assessment(f).state).toBe("met");
    const changed = manifest("/tmp/site", "directory", newFiles);
    changed.status = "partial"; changed.coverageComplete = false; changed.safeForDeployment = false;
    changed.manifestSha256 = null; changed.issueCount = 1; changed.issues = [{ path: "index.html", reason: "changed" }];
    const index = changed.entries.find(e => e.path === "index.html")!;
    index.status = "partial"; index.reason = "changed"; delete index.sha256;
    await record(f, "files.inspect_manifest", { ...changed.request }, () => changed, 30);
    expect(assessment(f).conditions.find(c => c.id === "deployed_content")?.state).not.toBe("met");
    expect(assessment(f).state).not.toBe("met");
  });
  it("派生配置分析的源文件出现较新截断观察时，不能仍用旧分析完成保护验收", async () => {
    const f = await fixture(); await deploy(f);
    await f.http("http://127.0.0.1:18080/", newFiles["index.html"], 20);
    await f.http("http://127.0.0.1:18080/style.css", newFiles["style.css"], 22);
    expect(assessment(f).state).toBe("met");
    await record(f, "files.read_content", { path: "/etc/nginx/nginx.conf", maxBytes: 128 }, () => ({
      path: "/etc/nginx/nginx.conf", content: "events {}", encoding: "utf-8", returnedBytes: 9, totalBytes: 1000, truncated: true,
    }), 30);
    expect(assessment(f).conditions.find(c => c.id === "other_sites")?.state).not.toBe("met");
    expect(assessment(f).state).not.toBe("met");
  });
});
