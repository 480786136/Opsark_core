import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests } from "@/services/executionLedger";
import { executionDigest, preparePlanForApproval, sha256Utf8 } from "@/features/agent/planPreparation";
import { FILE_MANIFEST_LIMITATIONS, fileManifestDigest, normalizeFileManifestRequest, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import type { NginxConfigResult } from "@/features/tools/nginxConfigContracts";
import type { PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "nginx-store", host: "nginx-store.invalid", port: 22, username: "fixture", name: "fixture", group: "test",
  status: "offline", environment: [], createdAt: "2026-10-12T00:00:00Z", info: { os: "fixture", kernel: "fixture", cpu: "fixture", cores: 1, memoryGb: 1, diskGb: 1, uptime: "fixture" } };
const entry = "/etc/nginx/nginx.conf", child = "/etc/nginx/conf.d/app.conf";
const site = "server { listen 8080; server_name app.invalid; root /srv/app; }";
const config = (body = site) => `events { worker_connections 32; } http { ${body} }`;
const readStep = (id: string, path: string): PlanStep => ({ id, title: "读取配置", description: "采集当前配置正文", command: "", validation: "", expected: "完整正文",
  risk: "low", kind: "observe", status: "pending", action: { type: "tool", toolId: "files.read_content", arguments: { path, maxBytes: 262144 } } });

beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  useOpsStore().servers = [structuredClone(server)];
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue(); vi.spyOn(backend, "loadCredential").mockResolvedValue(null); vi.spyOn(backend, "saveCredential").mockResolvedValue();
  await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "private-fixture" });
});
afterEach(async () => { const store = useOpsStore(); store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks(); });

function harness(text = config(), extraSteps: PlanStep[] = []) {
  const store = useOpsStore(), task = store.createTask(server.id, "safe", "fixture");
  const repository = createMemoryExecutionLedgerRepository(), saved = new Map<string, Record<string, unknown>>();
  configureExecutionLedger(store, repository, async (_task, record) => { const id = executionDigest(record).slice(7); saved.set(id, structuredClone(record)); return id; });
  task.rootGoal = "读取Nginx配置并确认目标站点的配置声明"; task.currentRoundId = "round"; task.workflowEpoch = 3;
  const sources = [readStep("entry", entry), ...extraSteps];
  task.plan = [...sources, { id: "inspect", title: "解析配置证据", description: "关联当前任务原始读取", command: "", validation: "", expected: "取得声明或明确缺口",
    risk: "low", kind: "observe", status: "pending", action: { type: "tool", toolId: "nginx.inspect_configuration", arguments: {
      entryPath: entry, prefix: "/usr/share/nginx", target: { address: "127.0.0.1", port: 8080, serverName: "app.invalid", uriPath: "/" }, sourceStepIds: sources.map(step => step.id),
    } } }];
  task.status = "awaiting_plan_approval"; store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  store.prepareTaskPlan(task); task.status = "running";
  vi.spyOn(store, "advanceTask").mockResolvedValue(); vi.spyOn(store, "routeAutomaticAdjustment").mockResolvedValue();
  const read = vi.spyOn(backend, "readSftpFilePrefix").mockImplementation(async (_connection, path) => {
    const data = [...new TextEncoder().encode(path === entry ? text : site)]; return { data: new Uint8Array(data), totalBytes: data.length };
  });
  const execute = vi.spyOn(backend, "executeCommand");
  const page = (taskId: string, evidenceId: string, offset: number, limit: number) => {
    expect(taskId).toBe(task.id); const record = saved.get(evidenceId); if (!record) throw new Error("missing archive");
    const { text, ...metadata } = record, scalars = [...String(text)], end = Math.min(scalars.length, offset + limit);
    return { evidenceId, historical: true, metadata, text: scalars.slice(offset, end).join(""), offset, totalCharacters: scalars.length, nextOffset: end < scalars.length ? end : null };
  };
  const archive = vi.spyOn(backend, "readTaskEvidence").mockImplementation(async (...args) => page(...args));
  const run = async (id: string) => {
    const step = task.plan.find(item => item.id === id)!;
    if (step.action?.type !== "tool") throw new Error("fixture tool missing");
    await store.runToolStep(task.id, step.id, { id: `call-${id}`, toolId: step.action.toolId, arguments: step.action.arguments });
    return step;
  };
  const inspect = () => JSON.parse(task.plan[task.plan.length - 1]!.output!) as NginxConfigResult;
  return { store, task, repository, saved, read, execute, archive, page, run, inspect };
}
const large = () => "# " + "中文🚀".repeat(5000) + "\n" + config();

describe("Nginx配置在真实任务与归档入口组合", () => {
  it("小正文引用已应用回执，不发SSH也不宣称配置已加载", async () => {
    const h = harness(); await h.run("entry"); const step = await h.run("inspect");
    expect(step.status, h.task.pauseReason).toBe("completed"); expect(h.inspect().analysis.status).toBe("parsed");
    expect(step.result?.facts).toMatchObject({ evidenceKind: "nginx_configuration", evidenceComplete: false, freshRemoteObservation: false, configurationLoaded: false });
    expect(h.read).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled(); expect(h.archive).not.toHaveBeenCalled();
  });
  it("实际大正文台账摘要通过分页归档恢复，原持久台账保持摘要", async () => {
    const h = harness(large()); await h.run("entry");
    const before = (await h.repository.list(h.task.id))[0]!;
    expect(before.attempts[0]!.outcome!.result).toMatchObject({ archived: true, truncated: true });
    const step = await h.run("inspect"); expect(step.status, h.task.pauseReason).toBe("completed");
    expect(h.inspect().analysis.status).toBe("parsed"); expect(h.archive.mock.calls.length).toBeGreaterThan(1);
    expect(h.inspect().sourceEvidenceIds).toEqual(before.attempts[0]!.outcome!.evidenceRefs);
    expect((await h.repository.list(h.task.id)).find(record => record.operationId === before.operationId)).toEqual(before);
    expect(h.read).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["missing", "metadata", "prefix", "partial_page"])("归档%s失败不重读服务器、不产生完整配置证据", async kind => {
    const h = harness(large()); await h.run("entry");
    h.archive.mockImplementation(async (...args) => {
      if (kind === "missing") throw new Error("private missing path");
      const page = h.page(...args);
      if (kind === "metadata") page.metadata.attemptId = "other-attempt";
      if (kind === "prefix") page.text = "x" + page.text.slice(1);
      if (kind === "partial_page") page.text = page.text.slice(1);
      return page;
    });
    const step = await h.run("inspect");
    expect(step.result?.executionStatus).toBe("failed"); expect(step.output).not.toContain("private missing path");
    expect(step.result?.facts.evidenceComplete).not.toBe(true); expect(h.read).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["cancel", "round", "epoch"])("分页期间%s改变后旧结果不能应用", async kind => {
    const h = harness(large()); await h.run("entry");
    h.archive.mockImplementation(async (...args) => {
      const page = h.page(...args);
      if (kind === "cancel") h.task.cancelRequested = true;
      if (kind === "round") h.task.currentRoundId = "replacement";
      if (kind === "epoch") h.task.workflowEpoch = (h.task.workflowEpoch ?? 0) + 1;
      return page;
    });
    const step = await h.run("inspect"); expect(step.status).not.toBe("completed");
    expect(h.archive).toHaveBeenCalledOnce(); expect(h.read).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
  it("分页期间来源记录变化会拒绝先前快照", async () => {
    const h = harness(large()); await h.run("entry"); const source = (await h.repository.list(h.task.id))[0]!;
    h.archive.mockImplementation(async (...args) => {
      const page = h.page(...args); await h.repository.cancel(source.operationId, source.attempts[0]!.id); return page;
    });
    const step = await h.run("inspect"); expect(step.result?.executionStatus).toBe("failed"); expect(h.read).toHaveBeenCalledOnce();
  });
  it("分页期间另一个任务新增未决变更，重新读取全台账后阻断旧配置", async () => {
    const h = harness(large()); await h.run("entry"); let added = false;
    h.archive.mockImplementation(async (...args) => {
      const page = h.page(...args);
      if (!added) {
        added = true;
        const step: PlanStep = { id: "change", title: "受控变更记录", description: "不实际执行", command: "touch /etc/nginx/nginx.conf", validation: "", expected: "记录未决",
          risk: "medium", kind: "change", status: "pending", action: { type: "shell", command: "touch /etc/nginx/nginx.conf" } };
        const intent = preparePlanForApproval([step], { taskId: "other-task", permission: "managed", server, servers: [server], connectionGeneration: 1 }).steps[0]!.intent;
        await h.repository.prepare({ version: 1, operationId: "concurrent", taskId: "other-task", stepId: step.id, roundId: "other-round", workflowEpoch: 1,
          planRevision: 1, stepRevision: 1, intentDigest: intent.digest, intent, phase: "command", effect: "change", resourceKeys: ["configuration"], executionId: "concurrent" });
        await h.repository.begin("concurrent", "attempt", "concurrent");
      }
      return page;
    });
    await h.run("inspect"); const result = h.inspect();
    expect(result.analysis.status).toBe("unknown"); expect(result.analysis.reasons).toContainEqual({ code: "configuration_sources_overlap_later_or_unresolved_change" });
    expect(result.sourceEvidenceIds).toEqual([]); expect(h.read).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
  it("300成员前后清单经实际任务归档补读形成glob覆盖", async () => {
    const request = normalizeFileManifestRequest({ path: "/etc/nginx/conf.d", source: "directory" });
    const manifest = (id: string): PlanStep => ({ ...readStep(id, entry), title: "目录覆盖采样", action: { type: "tool", toolId: "files.inspect_manifest", arguments: { ...request } } });
    const h = harness(config("include conf.d/*.conf;"), [manifest("before"), readStep("child", child), manifest("after")]);
    const entries: FileManifestResult["entries"] = Array.from({ length: 300 }, (_, index) => {
      const content = index === 0 ? site : "x", sizeBytes = new TextEncoder().encode(content).length;
      return { path: index === 0 ? "app.conf" : `ignored-${index}.txt`, kind: "regular", status: "complete", reason: "", sizeBytes, mode: "0644", uid: 0, gid: 0, sha256: sha256Utf8(content),
        identity: { device: "1", inode: String(index + 10), sizeBytes, mode: "0644", uid: 0, gid: 0, mtimeNs: "1", ctimeNs: "1" } };
    });
    const bytes = entries.reduce((sum, item) => sum + item.sizeBytes!, 0);
    const data: FileManifestResult = { request, entries, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
      rootIdentity: { ...entries[0]!.identity!, inode: "1", mode: "0755" }, issues: [], issueCount: 0, scannedEntries: 300, contentBytes: bytes, readBytes: bytes * 2,
      archiveReadBytes: 0, expandedBytes: 0, manifestSha256: fileManifestDigest(entries), archiveSha256: null, sampledAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:00:01Z",
      elapsedMs: 1000, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
    h.execute.mockResolvedValue({ success: true, simulated: true, exitCode: 0, output: "", stdout: "OPSARK_FILE_MANIFEST " + JSON.stringify(data), stdoutTruncated: false });
    for (const id of ["entry", "before", "child", "after", "inspect"]) { const step = await h.run(id); expect(step.status, h.task.pauseReason).toBe("completed"); }
    expect(h.inspect().analysis.status).toBe("parsed"); expect(h.inspect().analysis.includes[0]!.directoryCoverage).toBeDefined();
    expect(h.archive.mock.calls.length).toBeGreaterThan(2); expect(h.read).toHaveBeenCalledTimes(2); expect(h.execute).toHaveBeenCalledTimes(2);
  });
});
