import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests, runRecordedExecution,
  type ExecutionOutcomeStatus, type ExecutionOperationRecord } from "@/services/executionLedger";
import { preparePlanForApproval, executionDigest, sha256Utf8 } from "./planPreparation";
import { inspectNginxConfigurationFromLedger } from "./nginxConfigRuntime";
import { normalizeNginxConfigRequest, nginxConfigResultIssue } from "@/features/tools/nginxConfigContracts";
import { normalizeFileManifestRequest, fileManifestDigest, FILE_MANIFEST_LIMITATIONS, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";
import { isRemoteToolObservation } from "./toolEvidenceScope";
import type { NginxConfigBinding } from "./nginxConfigEvidence";
import type { PlanStep, ServerProfile } from "@/types";

const server: ServerProfile = { id: "nginx-runtime-review", host: "nginx-runtime.invalid", port: 22, username: "fixture", name: "review", group: "test", status: "online",
  environment: [], createdAt: "2026-10-12T00:00:00Z", info: { os: "fixture", kernel: "fixture", cpu: "fixture", cores: 1, memoryGb: 1, diskGb: 1, uptime: "fixture" } };
const other = { ...server, id: "other-server", host: "other.invalid" };
const alias = { ...server, id: "same-endpoint-alias", name: "alias" };
const binding: NginxConfigBinding = { taskId: "configuration-task", roundId: "round", workflowEpoch: 4, serverId: server.id, connectionGeneration: 9 };
const entryPath = "/etc/nginx/nginx.conf", includePath = "/etc/nginx/conf.d/app.conf";
const site = "server { listen 8080; server_name app.invalid; root /srv/app; }";
const config = (body = site) => `events { worker_connections 32; } http { ${body} }`;
let clock = 1000, serial = 0;
beforeEach(() => { resetExecutionLedgerForTests(); clock = 1000; serial = 0; vi.spyOn(Date, "now").mockImplementation(() => clock); });
afterEach(() => vi.restoreAllMocks());
function harness() {
  const repository = createMemoryExecutionLedgerRepository(), owner = {}, archived: Array<Record<string, unknown>> = [];
  configureExecutionLedger(owner, repository, async (_id, record) => { archived.push(record); return executionDigest(record).slice(7); });
  const prepare = async (stepId: string, action: PlanStep["action"], source = server, taskId = binding.taskId, persist = true, effect?: "read" | "change") => {
    const changing = effect ? effect === "change" : action?.type === "shell" || action?.type === "tool" && action.toolId === "files.transfer_between_servers";
    const step: PlanStep = { id: stepId, title: "受控真实执行记录", description: "只测试本地账本，不派发网络", kind: changing ? "change" : "observe", risk: changing ? "medium" : "low",
      status: "pending", command: action?.type === "shell" ? action.command : "", validation: "", expected: "保留真实动作与证据", action };
    const intent = preparePlanForApproval([step], { taskId, permission: "managed", server: source, servers: [server, other, alias], connectionGeneration: binding.connectionGeneration,
      connectionGenerations: { [server.id]: 9, [other.id]: 9, [alias.id]: 9 } }).steps[0]!.intent;
    const id = `review-${++serial}`;
    const input = { version: 1 as const, operationId: id, taskId, stepId, roundId: binding.roundId, workflowEpoch: binding.workflowEpoch, planRevision: 1, stepRevision: 1,
      intentDigest: intent.digest, intent, phase: action?.type === "shell" ? "command" as const : "tool" as const, effect: intent.semantic.effect,
      resourceKeys: [`endpoint:${source.host}:${source.port}`], executionId: id };
    if (persist) await repository.prepare(input); return { id, step: { ...step, executionIntent: intent }, input };
  };
  const complete = async (prepared: Awaited<ReturnType<typeof prepare>>, result: unknown, status: ExecutionOutcomeStatus = "succeeded") => {
    clock += 10; await repository.begin(prepared.id, prepared.id, prepared.id); clock += 10;
    await repository.complete({ operationId: prepared.id, attemptId: prepared.id, eventId: prepared.id,
      outcome: { status, result, evidenceRefs: [`evidence-${prepared.id}`] } });
    if (["succeeded", "failed", "not_dispatched"].includes(status)) await repository.acknowledge(prepared.id, prepared.id, false);
  };
  const read = async (stepId: string, path = entryPath, text = config()) => {
    const prepared = await prepare(stepId, { type: "tool", toolId: "files.read_content", arguments: { path, maxBytes: 262144 } });
    const bytes = new TextEncoder().encode(text).length;
    const result = { callId: prepared.id, toolId: "files.read_content", success: true,
      data: { path, content: text, encoding: "utf-8", totalBytes: bytes, returnedBytes: bytes, truncated: false } };
    await complete(prepared, result); return prepared;
  };
  const mutate = async (targetPath?: string, status: ExecutionOutcomeStatus | "dispatching" | "prepared" = "succeeded", source = other) => {
    const action: PlanStep["action"] = targetPath ? { type: "tool", toolId: "files.transfer_between_servers",
      arguments: { sourcePath: "/staging/new-file", targetServer: server.id, targetPath, overwrite: true } }
      : { type: "shell", command: "touch /etc/nginx/nginx.conf" };
    const prepared = await prepare(`change-${serial}`, action, source, "other-task");
    if (status === "prepared") return prepared;
    if (status === "dispatching") { clock += 10; await repository.begin(prepared.id, prepared.id, prepared.id); return prepared; }
    await complete(prepared, { success: status === "succeeded" }, status); return prepared;
  };
  const inspect = async (ids = ["entry"], override: Partial<NginxConfigBinding> = {}, records?: ExecutionOperationRecord[]) => {
    const request = normalizeNginxConfigRequest({ entryPath, prefix: "/usr/share/nginx", sourceStepIds: ids,
      target: { address: "127.0.0.1", port: 8080, serverName: "app.invalid", uriPath: "/" } });
    return inspectNginxConfigurationFromLedger(request, { ...binding, ...override }, records ?? await repository.list());
  };
  return { repository, owner, archived, prepare, complete, read, mutate, inspect };
}
const member = (content: string) => { const sizeBytes = new TextEncoder().encode(content).length; return { path: "app.conf", kind: "regular" as const, status: "complete" as const, reason: "",
  sizeBytes, mode: "0644", uid: 0, gid: 0, sha256: sha256Utf8(content), identity: { device: "1", inode: "2", sizeBytes, mode: "0644", uid: 0, gid: 0, mtimeNs: "1", ctimeNs: "1" } }; };
async function manifest(h: ReturnType<typeof harness>, stepId: string, content: string, changed = false) {
  const request = normalizeFileManifestRequest({ path: "/etc/nginx/conf.d", source: "directory" }), item = member(content);
  if (changed) item.identity.inode = "99";
  const data: FileManifestResult = { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
    rootIdentity: { ...item.identity, inode: "10", mode: "0755" }, entries: [item], issues: [], issueCount: 0, scannedEntries: 1, contentBytes: item.sizeBytes, readBytes: 2 * item.sizeBytes,
    archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest([item]), archiveSha256: null, sampledAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:00:01Z",
    elapsedMs: 1000, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
  const prepared = await h.prepare(stepId, { type: "tool", toolId: "files.inspect_manifest", arguments: { ...request } });
  await h.complete(prepared, { callId: prepared.id, toolId: "files.inspect_manifest", success: true, data }); return prepared;
}
async function reconcileTransfer(h: ReturnType<typeof harness>, change: Awaited<ReturnType<ReturnType<typeof harness>["mutate"]>>) {
  const ids: string[] = [];
  for (const role of ["source", "target"]) {
    const target = change.input.intent.semantic.targets.find(item => item.role === role)!;
    const path = target.path!, quoted = "'" + path.replace(/'/g, "'\"'\"'") + "'";
    const command = `test -f ${quoted} && LC_ALL=C stat -Lc '%s' -- ${quoted} && sha256sum -- ${quoted} && LC_ALL=C stat -Lc '%s' -- ${quoted}`;
    const prepared = await h.prepare(`proof-${role}`, { type: "shell", command }, role === "source" ? other : server, change.input.taskId, true, "read");
    const bytes = new TextEncoder().encode(config()).length;
    await h.complete(prepared, { success: true, exitCode: 0, stdout: `${bytes}\n${sha256Utf8(config())}  ${path}\n${bytes}\n`, stdoutTruncated: false });
    ids.push(prepared.id);
  }
  clock += 10;
  return h.repository.resolve(change.id, change.id, { version: 1, kind: "file_transfer", sourceReadOperationId: ids[0]!, targetReadOperationId: ids[1]! });
}

describe("Nginx本地配置组合真实台账只读交叉审", () => {
  it("真实准备/落账/已应用文件可组合，但不会生成新远程证据或配置加载事实", async () => {
    const h = harness(); await h.read("entry"); const result = await h.inspect();
    expect(result.analysis.status, JSON.stringify(result.analysis.reasons)).toBe("parsed");
    expect(nginxConfigResultIssue(result.request, result)).toBeUndefined();
    const call = { id: "local", toolId: "nginx.inspect_configuration", arguments: { ...result.request } };
    expect(buildToolEvidenceFacts(call, { callId: call.id, toolId: call.toolId, success: true, data: result })).toMatchObject({ freshRemoteObservation: false, configurationLoaded: false, evidenceComplete: false });
    expect(isRemoteToolObservation(call.toolId)).toBe(false);
  });
  it.each([{ taskId: "foreign" }, { roundId: "old-round" }, { workflowEpoch: 5 }, { serverId: other.id }, { connectionGeneration: 10 }])("不能跨作用域复用 %j", async override => {
    const h = harness(); await h.read("entry"); const result = await h.inspect(["entry"], override);
    expect(result.analysis.status).toBe("unknown"); expect(result.sourceEvidenceIds).toEqual([]);
    expect(nginxConfigResultIssue(result.request, result)).toBeUndefined();
  });
  it("原步骤最新失败不能回退使用同操作早先成功", async () => {
    const h = harness(), original = await h.read("entry"); clock += 10;
    await h.repository.begin(original.id, "retry", "retry"); clock += 10;
    await h.repository.complete({ operationId: original.id, attemptId: "retry", eventId: "retry", outcome: { status: "failed", evidenceRefs: ["failure"], result: { success: false } } });
    expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it("同轮次重用步骤ID有多个操作时拒绝任意挑选", async () => {
    const h = harness(); await h.read("entry"); await h.read("entry");
    expect((await h.inspect()).analysis.reasons).toContainEqual({ code: "ambiguous_source_step" });
  });
  it.each(["succeeded", "failed", "unknown", "dispatching"] as const)("其他任务后续%s变更阻止旧配置声明继续被当作可用", async status => {
    const h = harness(); await h.read("entry"); await h.mutate(entryPath, status);
    const result = await h.inspect(); expect(result.analysis.status).toBe("unknown"); expect(result.analysis.selected).toBeUndefined();
    expect(result.analysis.reasons).toContainEqual({ code: "configuration_sources_overlap_later_or_unresolved_change" });
  });
  it.each(["succeeded", "failed"] as const)("早于全部读取完成的已知%s变更不阻断新采样", async status => {
    const h = harness(); await h.mutate(entryPath, status); await h.read("entry"); expect((await h.inspect()).analysis.status).toBe("parsed");
  });
  it("未知变更的本地错误回执早于读取也不证明远端已经停止", async () => {
    const h = harness(); await h.mutate(entryPath, "unknown"); await h.read("entry");
    expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it("早期dispatching即使存在本地completedAt也不能充当远端退出", async () => {
    const h = harness(), change = await h.mutate(entryPath, "dispatching"); await h.read("entry");
    const records = await h.repository.list(); records.find(item => item.operationId === change.id)!.attempts[0]!.completedAt = 1001;
    expect((await h.inspect(["entry"], {}, records)).analysis.status).toBe("unknown");
  });
  it("真实既有文件传输核对后重新采集可解除屏障，unknown原历史保留", async () => {
    const h = harness(), change = await h.mutate(entryPath, "unknown"), resolved = await reconcileTransfer(h, change);
    expect(resolved.reconciliation?.kind).toBe("file_transfer"); expect(resolved.attempts[0]!.status).toBe("unknown");
    await h.read("entry"); const result = await h.inspect();
    expect(result.analysis.status, JSON.stringify(result.analysis.reasons)).toBe("parsed");
    expect(nginxConfigResultIssue(result.request, result)).toBeUndefined();
  });
  it("核对晚于原配置读取时必须重新采集，不能倒签旧配置", async () => {
    const h = harness(), change = await h.mutate(entryPath, "unknown"); await h.read("entry"); await reconcileTransfer(h, change);
    expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it.each(["wrong_attempt", "missing_read", "failed_read", "foreign_task", "late_read", "wrong_evidence", "missing_evidence", "dispatching"] as const)("核对证据%s不能为未知变更解除屏障", async kind => {
    const h = harness(), change = await h.mutate(entryPath, "unknown"); await reconcileTransfer(h, change); await h.read("entry");
    let records = await h.repository.list(); const operation = records.find(item => item.operationId === change.id)!, proof = operation.reconciliation!;
    const read = records.find(item => item.operationId === proof.readOperationIds[0])!;
    if (kind === "wrong_attempt") proof.attemptId = "other-attempt";
    if (kind === "missing_read") records = records.filter(item => item !== read);
    if (kind === "failed_read") { read.state = "failed"; read.attempts[0]!.status = "failed"; }
    if (kind === "foreign_task") read.taskId = "foreign-task";
    if (kind === "late_read") read.attempts[0]!.late = true;
    if (kind === "wrong_evidence") proof.evidenceRefs = ["not-the-proof"];
    if (kind === "missing_evidence") proof.evidenceRefs = [];
    if (kind === "dispatching") operation.attempts[0]!.status = "dispatching";
    expect((await h.inspect(["entry"], {}, records)).analysis.status).toBe("unknown");
  });
  it.each(["prepared", "not_dispatched"] as const)("已证实尚未派发的%s记录不会伪造后续副作用", async status => {
    const h = harness(); await h.read("entry"); await h.mutate(entryPath, status); expect((await h.inspect()).analysis.status).toBe("parsed");
  });
  it("精确不重叠路径和真正不同端点的变更不误伤", async () => {
    const h = harness(); await h.read("entry"); await h.mutate("/srv/unrelated/config"); await h.mutate(undefined, "succeeded", other);
    expect((await h.inspect()).analysis.status).toBe("parsed");
  });
  it("同端点另一个服务器别名的未决变更不能绕过屏障", async () => {
    const h = harness(); await h.read("entry"); await h.mutate(undefined, "dispatching", alias);
    expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it("含重复分隔符的同目标路径不能冒充精确不相关路径", async () => {
    const h = harness(); await h.read("entry"); await h.mutate("/etc//nginx/nginx.conf");
    expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it("没有精确路径的同服务器变更须保守阻断", async () => {
    const h = harness(); await h.read("entry"); await h.mutate(undefined, "succeeded", server); expect((await h.inspect()).analysis.status).toBe("unknown");
  });
  it("glob前后真实manifest及夹在中间的正文读取形成有限覆盖", async () => {
    const h = harness(); await h.read("entry", entryPath, config("include conf.d/*.conf;"));
    await manifest(h, "before", site); await h.read("include", includePath, site); await manifest(h, "after", site);
    const result = await h.inspect(["entry", "before", "include", "after"]);
    expect(result.analysis.status, JSON.stringify(result.analysis.reasons)).toBe("parsed"); expect(nginxConfigResultIssue(result.request, result)).toBeUndefined();
    expect(result.analysis.includes[0].directoryCoverage).toBeDefined(); expect(result.analysis.configurationLoaded).toBe(false);
  });
  it.each(["missing_after", "changed_inode", "read_before", "wrong_hash"] as const)("glob %s不能降级成猜测目录覆盖", async kind => {
    const h = harness(); await h.read("entry", entryPath, config("include conf.d/*.conf;"));
    if (kind === "read_before") await h.read("include", includePath, site);
    await manifest(h, "before", site);
    if (kind !== "read_before") await h.read("include", includePath, kind === "wrong_hash" ? site.replace("/srv/app", "/srv/new") : site);
    if (kind !== "missing_after") await manifest(h, "after", site, kind === "changed_inode");
    const result = await h.inspect(["entry", "before", "include", ...(kind === "missing_after" ? [] : ["after"])]);
    expect(result.analysis.status).toBe("unknown"); expect(result.analysis.selected).toBeUndefined(); expect(nginxConfigResultIssue(result.request, result)).toBeUndefined();
  });
  it("真实执行台账的大正文只有完整归档可重建，8192字符摘要不可充当回执", async () => {
    const h = harness(), text = "# " + "x".repeat(10000) + "\n" + config();
    const prepared = await h.prepare("entry", { type: "tool", toolId: "files.read_content", arguments: { path: entryPath, maxBytes: 262144 } }, server, binding.taskId, false);
    clock += 10;
    await runRecordedExecution({ owner: h.owner, task: { id: binding.taskId, currentRoundId: binding.roundId, workflowEpoch: binding.workflowEpoch },
      step: prepared.step, phase: "tool", executionId: "large-actual", execute: async () => ({ callId: "large-actual", toolId: "files.read_content", success: true,
        data: { path: entryPath, content: text, encoding: "utf-8", totalBytes: text.length, returnedBytes: text.length, truncated: false } }) });
    const records = await h.repository.list();
    const op = records[0], attempt = op.attempts[0]; await h.repository.acknowledge(op.operationId, attempt.id, false);
    expect(attempt.outcome?.result).toMatchObject({ truncated: true, archived: true });
    expect(JSON.parse(String(h.archived[0].text)).data.content).toBe(text);
    const result = await h.inspect(["entry"], {}, await h.repository.list());
    expect(result.analysis.status).toBe("unknown");
  });
});
