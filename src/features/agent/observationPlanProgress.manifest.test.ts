import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import type { PlanStep, ServerProfile } from "@/types";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { executionDigest, preparePlanForApproval, sha256Utf8 } from "./planPreparation";
import { buildToolStepOutcome, applyToolStepOutcome } from "./toolStepResult";
import { taskAttemptContext } from "./attemptState";
import { assertObservationPlanProgress, ObservationPlanError } from "./observationPlanProgress";
import { observationIdentity, workflowProgress } from "./workflowProgress";
import { decideTaskNextStage } from "./agentService";
import { FILE_MANIFEST_LIMITATIONS, fileManifestDigest, normalizeFileManifestRequest, type FileManifestResult } from "@/features/tools/fileManifestInspection";

const server: ServerProfile = { id: "manifest-progress", host: "fixture.invalid", port: 22, username: "fixture", name: "目录证据复核",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-12T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const step = (id: string, toolId: string, args: Record<string, unknown>): PlanStep => ({ id, kind: "observe", title: "检查配置",
  description: "仅按实际动作建立依赖", command: "", validation: "", expected: "真实证据", risk: "low", status: "pending", action: { type: "tool", toolId, arguments: args } });
const manifest = (id: string) => step(id, "files.inspect_manifest", { source: "directory", path: "/etc/nginx/conf.d" });
const read = (id = "read-site", path = "/etc/nginx/conf.d/site.conf") => step(id, "files.read_content", { path, maxBytes: 262144 });
const consumer = () => step("configuration", "nginx.inspect_configuration", { entryPath: "/etc/nginx/nginx.conf", prefix: "/usr/share/nginx",
  target: { address: "127.0.0.1", port: 8080, serverName: "app.example", uriPath: "/" }, sourceStepIds: ["read-entry", "before", "read-site", "after"] });

beforeEach(() => { vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia()); });
afterEach(() => { const store = useOpsStore(); for (const task of store.tasks) task.cancelRequested = true; store.stopConnectionMonitor(); store.persist(true); store.$dispose(); vi.restoreAllMocks(); });
function setup() {
  const store = useOpsStore(); store.servers = [structuredClone(server)];
  const task = store.createTask(server.id, "managed", "model"); task.rootGoal = "读取 Nginx 现有站点配置并保留完整目录范围证据";
  task.currentRoundId = "round"; task.status = "planning";
  return { store, task };
}
const body = "server { listen 8080; server_name app.example; root /srv/app; }";
const stamp = "2026-10-12T12:00:00Z";
function manifestData(): FileManifestResult {
  const request = normalizeFileManifestRequest({ source: "directory", path: "/etc/nginx/conf.d" });
  const sizeBytes = new TextEncoder().encode(body).length;
  const identity = { device: "1", inode: "2", sizeBytes, mode: "0644", uid: 0, gid: 0, mtimeNs: "1", ctimeNs: "1" };
  const entries: FileManifestResult["entries"] = [{ path: "site.conf", kind: "regular", status: "complete", reason: "", sizeBytes,
    mode: "0644", uid: 0, gid: 0, sha256: sha256Utf8(body), identity }];
  return { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
    rootIdentity: { ...identity, inode: "10", mode: "0755" }, entries, issues: [], issueCount: 0, scannedEntries: 1,
    contentBytes: sizeBytes, readBytes: sizeBytes * 2, archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest(entries), archiveSha256: null,
    sampledAt: stamp, finishedAt: stamp, elapsedMs: 0, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
}
async function recordedPair() {
  const { store, task } = setup(), repository = createMemoryExecutionLedgerRepository();
  configureExecutionLedger(store, repository, async (_id, value) => executionDigest(value).slice(7));
  store.prepareTaskPlan(task, [manifest("before"), read(), manifest("after")]);
  const complete = async (index: number) => {
    const current = task.plan[index]!, action = current.action;
    if (action?.type !== "tool") throw new Error("fixture requires tool");
    const call = { id: `execution-${index}`, toolId: action.toolId, arguments: action.arguments };
    current.startedAt = new Date().toISOString(); current.attemptContext = taskAttemptContext(task);
    const bytes = new TextEncoder().encode(body).length;
    const data = action.toolId === "files.inspect_manifest" ? manifestData() : { path: action.arguments.path, content: body,
      encoding: "utf-8", totalBytes: bytes, returnedBytes: bytes, truncated: false };
    const value = await store.recordStepExecution(task, current, "tool", call.id, () => true,
      async () => ({ callId: call.id, toolId: call.toolId, success: true, data }));
    const outcome = buildToolStepOutcome({ call, result: value, evidenceId: `evidence-${index}`, completedAt: new Date().toISOString(),
      scope: { targetId: server.id, scope: "isolated_exec", persistence: "command", doesNotProve: [] } });
    applyToolStepOutcome(current, outcome); current.status = outcome.status;
    expect(current.result?.facts.evidenceComplete).toBe(true);
    expect(current.ledgerAppliedAttemptIds).toHaveLength(1);
  };
  await complete(0); await complete(1);
  return { store, task, repository, complete };
}
describe("真实store计划准备的目录前后复核", () => {
  it("接纳目录前清单、成员读取、后清单和本地配置消费，同时保持原计划原子性", () => {
    const { store, task } = setup();
    const plan = [read("read-entry", "/etc/nginx/nginx.conf"), manifest("before"), read(), manifest("after"), consumer()];
    const before = JSON.stringify(plan);
    expect(() => store.prepareTaskPlan(task, plan)).not.toThrow();
    expect(task.plan.map(item => item.id)).toEqual(plan.map(item => item.id));
    expect(JSON.stringify(plan)).toBe(before);
  });
  it("通用目录读取模式不依赖Nginx消费者、标题或业务编号", () => {
    const { store, task } = setup(); const plan = [manifest("before"), read(), manifest("after")];
    for (const item of plan) { item.title = "任意标题"; item.description = "无模型复核理由"; }
    expect(() => store.prepareTaskPlan(task, plan)).not.toThrow();
  });
  it.each(["adjacent", "outside", "prefix-collision", "metadata-only", "archive", "third", "repeated-content", "second-pair"])("仍拒无依赖或无进展重复：%s", kind => {
    const { store, task } = setup(); let plan = [manifest("before"), read(), manifest("after")];
    if (kind === "adjacent") plan = [manifest("before"), manifest("after")];
    if (kind === "outside") plan[1] = read("read-site", "/other/site.conf");
    if (kind === "prefix-collision") plan[1] = read("read-site", "/etc/nginx/conf.d-other/site.conf");
    if (kind === "metadata-only") plan[1] = step("metadata", "files.get_structure", { rootPath: "/etc/nginx/conf.d" });
    if (kind === "archive") for (const index of [0, 2]) { const action = plan[index]!.action; if (action?.type === "tool") action.arguments.source = "tar"; }
    if (kind === "third") plan.push(manifest("third"));
    if (kind === "repeated-content") plan.splice(2, 0, read("same-body"));
    if (kind === "second-pair") plan.push(read("another", "/etc/nginx/conf.d/another.conf"), manifest("third"));
    const original = JSON.stringify(plan);
    expect(() => store.prepareTaskPlan(task, plan)).toThrow(ObservationPlanError);
    expect(task.plan).toEqual([]); expect(JSON.stringify(plan)).toBe(original);
  });
  it("未证明同endpoint或借另一endpoint的内容读取不授予复核", () => {
    const { task } = setup(); const plan = [manifest("before"), read(), manifest("after")];
    expect(() => assertObservationPlanProgress(task, plan)).toThrow(ObservationPlanError);
    const prepare = (item: PlanStep, host: string) => preparePlanForApproval([item], { taskId: task.id, permission: "managed", server: { ...server, host }, servers: [{ ...server, host }] }).compatibilitySteps[0]!;
    const mixed = plan.map((item, i) => prepare(item, i === 1 ? "another.invalid" : server.host));
    expect(() => assertObservationPlanProgress(task, mixed)).toThrow(ObservationPlanError);
  });
  it.each(["after-generation", "member-generation", "missing-generation", "unbound-after"])("准备代际不一致不能借前后复核例外：%s", kind => {
    const { task } = setup(), plan = [manifest("before"), read(), manifest("after")];
    const prepared = structuredClone(preparePlanForApproval(plan, { taskId: task.id, permission: "managed", server, servers: [server], connectionGeneration: 4 }).compatibilitySteps);
    const index = kind === "member-generation" ? 1 : 2, intent = prepared[index]!.executionIntent!;
    if (kind === "unbound-after") delete prepared[index]!.executionIntent;
    else {
      if (kind === "missing-generation") delete intent.semantic.targets[0]!.connectionGeneration;
      else intent.semantic.targets[0]!.connectionGeneration = 5;
      intent.digest = executionDigest({ version: intent.version, semantic: intent.semantic });
    }
    expect(() => assertObservationPlanProgress(task, prepared, undefined, { target: server })).toThrow(ObservationPlanError);
  });
  it("生产落账和结果投影后，派发前再次准备仍允许唯一后清单", async () => {
    const { store, task, repository } = await recordedPair();
    expect((await repository.list()).every(operation => operation.state === "succeeded")).toBe(true);
    expect(() => store.prepareTaskPlan(task)).not.toThrow();
    expect(task.plan.map(item => item.status)).toEqual(["completed", "completed", "pending"]);
  });
  it("已落账前清单与内容跨阶段后保留一次复核，不能重新开第二对", async () => {
    const { store, task, complete } = await recordedPair();
    const previous = task.plan.slice(0, 2);
    task.phaseHistory = [{ id: "read-phase", roundId: "round", requirement: task.rootGoal!, reason: "adjustment", plan: previous, createdAt: stamp, completedAt: stamp }];
    task.plan = [task.plan[2]!];
    expect(() => store.prepareTaskPlan(task)).not.toThrow();
    // Restore the same referenced steps to complete the actual after operation.
    task.plan = [...previous, task.plan[0]!]; task.phaseHistory = [];
    await complete(2);
    expect(() => store.prepareTaskPlan(task, [read("another", "/etc/nginx/conf.d/new.conf"), manifest("third")])).toThrow(ObservationPlanError);
  });
  it("真实阶段服务接纳未准备的后清单，仍须由store准备检查当前连接代际", async () => {
    const { store, task } = await recordedPair();
    task.phaseHistory = [{ id: "read-phase", roundId: "round", requirement: task.rootGoal!, reason: "adjustment", plan: task.plan.slice(0, 2), createdAt: stamp, completedAt: stamp }];
    task.plan = []; task.status = "awaiting_continuation";
    const decide = vi.fn().mockResolvedValue({ decision: "continue", source: "model", reason: "补足成员范围后清单", summary: "正文读取结束后核对目录", steps: [manifest("after")] });
    const result = await decideTaskNextStage({ task, server, tools: store.tools, secretMetadata: [], skills: [],
      model: { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true }, apiKey: "fixture",
      generationSettings: { limitOutput: false, maxPlanSteps: 24, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } }, decide);
    expect(decide).toHaveBeenCalledOnce(); expect(result.nextPlan).toHaveLength(1);
    expect(result.nextPlan[0]!.executionIntent).toBeUndefined();
    // A proposal is not dispatch permission: an unprepared default check fails.
    expect(() => assertObservationPlanProgress(task, result.nextPlan, store.tools, { target: server })).toThrow(ObservationPlanError);
    expect(() => store.prepareTaskPlan(task, result.nextPlan)).not.toThrow();
    const changed = preparePlanForApproval([manifest("after-new-connection")], { taskId: task.id, permission: "managed", server, servers: [server], connectionGeneration: 100 }).compatibilitySteps;
    expect(() => assertObservationPlanProgress(task, changed, store.tools)).toThrow(ObservationPlanError);
  });
  it("候选预检也不能把缺代际或不完整历史当成可复核来源", async () => {
    const { task } = await recordedPair();
    const historical = JSON.parse(JSON.stringify(task.plan.slice(0, 2))) as PlanStep[];
    const intent = historical[1]!.executionIntent!;
    delete intent.semantic.targets[0]!.connectionGeneration;
    intent.digest = executionDigest({ version: intent.version, semantic: intent.semantic });
    task.phaseHistory = [{ id: "history", roundId: "round", requirement: task.rootGoal!, reason: "adjustment", plan: historical, createdAt: stamp, completedAt: stamp }]; task.plan = [];
    expect(() => assertObservationPlanProgress(task, [manifest("after")], undefined, { target: server, admission: "proposal" })).toThrow(ObservationPlanError);
  });
  it.each(["partial", "redacted", "bad-bytes", "unapplied", "latest-unapplied", "missing-output", "scope", "round", "overlap", "edited-action", "partial-before"])("历史%s不能被后清单升级为完整依据", async kind => {
    const { store, task } = await recordedPair(); const before = task.plan[0]!, member = task.plan[1]!;
    if (kind === "partial") { member.result!.facts.evidenceComplete = false; const data = JSON.parse(member.output!); data.truncated = true; member.output = JSON.stringify(data); }
    if (kind === "redacted") { const data = JSON.parse(member.output!); data.content = "[REDACTED]"; member.output = JSON.stringify(data); }
    if (kind === "bad-bytes") { const data = JSON.parse(member.output!); data.totalBytes++; member.output = JSON.stringify(data); }
    if (kind === "unapplied") member.ledgerAppliedAttemptIds = [];
    if (kind === "latest-unapplied") member.executionLedgerAttempts!.push({ operationId: "new", attemptId: "unapplied", executionId: "new", phase: "tool" });
    if (kind === "missing-output") delete member.output;
    if (kind === "scope") member.evidence![0]!.scope!.targetId = "other";
    if (kind === "round") member.attemptContext = JSON.stringify([server.id, "other-round", "", 0, 0]);
    if (kind === "overlap") member.startedAt = "2000-01-01T00:00:00Z";
    if (kind === "edited-action" && member.action?.type === "tool") member.action.arguments.path = "/etc/nginx/conf.d/edited.conf";
    if (kind === "partial-before") before.result!.facts.evidenceComplete = false;
    expect(() => store.prepareTaskPlan(task)).toThrow(ObservationPlanError);
    expect(task.plan[2]!.status).toBe("pending");
  });
  it("前后相同清单不因允许采样就计为新业务事实", async () => {
    const { task, complete } = await recordedPair(); await complete(2);
    expect(observationIdentity(task.plan[0]!)).toBe(observationIdentity(task.plan[2]!));
    task.phaseHistory = [{ id: "initial", roundId: "round", requirement: task.rootGoal!, reason: "adjustment", plan: task.plan.slice(0, 2), createdAt: stamp, completedAt: stamp }];
    task.plan = [task.plan[2]!];
    expect(workflowProgress(task)).toMatchObject({ evidenceCount: 2, stagnantPhases: 1 });
  });
});
