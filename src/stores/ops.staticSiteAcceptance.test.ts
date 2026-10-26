import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, resetExecutionLedgerForTests,
  type ExecutionLedgerRepository, type ExecutionOperationRecord } from "@/services/executionLedger";
import { executionDigest } from "@/features/agent/planPreparation";
import { assertStaticSiteRequirementComplete, staticSiteAcceptanceContext } from "@/features/agent/staticSiteAcceptance";
import { deliveredFixture, fixture, request, server, sourceTime, update } from "@/features/agent/staticSiteAcceptance.fixtures";
import { applyTaskRequirementUpdate } from "@/features/agent/taskRequirements";
import type { NginxConfigResult } from "@/features/tools/nginxConfigContracts";
import type { OpsTask, PlanStep, RequirementProcessingResult } from "@/types";
import { useOpsStore } from "./ops";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const credentials = { host: server.host, port: server.port, username: server.username, password: "private-fixture" };
const probe = (): PlanStep => ({ id: "store-read", title: "读取部署交接", description: "只读发现部署前置条件", command: "", validation: "",
  expected: "完整交接正文", kind: "observe", risk: "low", status: "pending",
  action: { type: "tool", toolId: "files.read_content", arguments: { path: "/tmp/handover.txt" } } });

beforeEach(async () => {
  vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
  const store = useOpsStore(); store.servers = [copy(server)];
  store.models = [{ id: "model", name: "本地集成夹具", provider: "Test", model: "fixture", endpoint: "https://model.invalid",
    enabled: true, hasApiKey: true }];
  store.modelApiKeys.model = "private-fixture";
  vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  vi.spyOn(backend, "saveCredential").mockResolvedValue();
  vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
  vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
  vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("本地接线测试不得发送远程命令"));
  vi.spyOn(backend, "readTaskEvidence").mockRejectedValue(new Error("本组夹具没有归档正文，不应请求外部证据"));
  await useConnectionStore().connect(server.id, credentials);
});
afterEach(async () => {
  const store = useOpsStore(); for (const task of store.tasks) task.cancelRequested = true;
  store.stopConnectionMonitor(); await store.persist(true); store.$dispose(); vi.restoreAllMocks();
});

/** Replay validated fixture receipts through the real in-memory repository APIs.
 * The only adaptations are the actual store connection generation and the clock;
 * this is local integration evidence, never an SSH or real-model test. */
async function replay(repository: ExecutionLedgerRepository, records: ExecutionOperationRecord[], generation: number) {
  const clock = vi.spyOn(Date, "now");
  try {
    for (const original of records) {
      const record = copy(original);
      record.intent.semantic.targets.forEach(target => { target.connectionGeneration = generation; });
      record.intent.digest = executionDigest({ version: "execution-intent@1", semantic: record.intent.semantic });
      record.intentDigest = record.intent.digest;
      if (record.intent.semantic.action.type === "tool" && record.intent.semantic.action.toolId === "nginx.inspect_configuration") {
        for (const attempt of record.attempts) {
          const result = attempt.outcome?.result as { data: NginxConfigResult } | undefined;
          if (result) result.data.analysis.binding.connectionGeneration = generation;
        }
      }
      clock.mockReturnValue(record.createdAt);
      await repository.prepare({ version: record.version, operationId: record.operationId, taskId: record.taskId,
        stepId: record.stepId, roundId: record.roundId, workflowEpoch: record.workflowEpoch, planRevision: record.planRevision,
        stepRevision: record.stepRevision, intentDigest: record.intentDigest, intent: record.intent, phase: record.phase,
        effect: record.effect, resourceKeys: record.resourceKeys, executionId: record.executionId });
      for (const attempt of record.attempts) {
        clock.mockReturnValue(attempt.startedAt); await repository.begin(record.operationId, attempt.id, attempt.executionId);
        if (attempt.outcome) {
          clock.mockReturnValue(attempt.completedAt!);
          await repository.complete({ operationId: record.operationId, attemptId: attempt.id, eventId: `replay-${attempt.id}`,
            outcome: attempt.outcome, late: attempt.late });
          await repository.acknowledge(record.operationId, attempt.id, false);
        }
      }
    }
  } finally { clock.mockRestore(); }
}

async function harness(delivered = false) {
  const data = await (delivered ? deliveredFixture() : fixture()), store = useOpsStore();
  store.tasks.push(copy(data.current)); const task = store.tasks.find(item => item.id === data.current.id)!;
  const repository = createMemoryExecutionLedgerRepository();
  await replay(repository, data.records, store.serverConnection(server.id).generation);
  configureExecutionLedger(store, repository, async () => { throw new Error("本测试不应创建新的执行收据"); });
  return { store, task, repository };
}

async function approveLocally(store: ReturnType<typeof useOpsStore>, task: OpsTask) {
  task.plan = [probe()]; task.status = "awaiting_plan_approval";
  const prepared = store.prepareTaskPlan(task);
  vi.spyOn(store, "advanceTask").mockResolvedValue();
  await store.approvePlan(task.id);
  expect(task.planApproval?.executionDigest).toBe(prepared.executionDigest);
  return { prepared, step: task.plan[0]! };
}

describe("静态站点业务验收的真实 store 接线", () => {
  it("实际提交需求声明强制策略覆盖版本，保存契约并绑定准备后的计划", async () => {
    const store = useOpsStore();
    vi.spyOn(backend, "processRequirement").mockImplementation(async (content, runtime): Promise<RequirementProcessingResult> => {
      expect(content).toBe(request);
      const submission = JSON.parse(runtime.context).requirementSubmission;
      expect(submission).toMatchObject({ content: request, acceptanceContractVersion: 1, baseRevision: 0 });
      const requirementUpdate = update();
      requirementUpdate.sourceMessageId = submission.sourceMessageId;
      requirementUpdate.baseRevision = submission.baseRevision;
      return { intent: "execute", relation: "new_goal", requirementUpdate, plan: [probe()] };
    });
    await store.submitRequirement(server.id, request, "safe", "model");
    const task = store.activeTask!;
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.requirementLifecycle?.items.find(item => item.id === "deploy")?.acceptance).toMatchObject({
      strategy: "static_site", staticSite: { artifactPath: "/tmp/site-v2.tar.gz", entryUrl: "http://127.0.0.1:18080/",
        preserveExisting: true, preserveOtherSites: true } });
    expect(task.preparedPlan?.steps[0]?.intent.semantic.inputBindings).toContainEqual(expect.objectContaining({
      key: "core.static-site.acceptance", reference: `acceptance:${task.id}`, target: server.id }));
    expect(backend.processRequirement).toHaveBeenCalledOnce(); expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("实际账本基线进入批准摘要，基线改变后原批准失效", async () => {
    const { store, task } = await harness();
    const { prepared, step } = await approveLocally(store, task);
    const oldBinding = prepared.steps[0]!.intent.semantic.inputBindings!.find(binding => binding.key === "core.static-site.acceptance");
    await store.refreshTaskBusinessAcceptance(task);
    expect(staticSiteAcceptanceContext(task).assessment?.assessments[0]?.baselineReady).toBe(true);
    expect(() => store.assertPreparedStep(task, step)).toThrow("授权条件已变化");
    const refreshed = store.prepareTaskPlan(task);
    expect(refreshed.steps[0]!.intent.semantic.inputBindings!.find(binding => binding.key === "core.static-site.acceptance")?.version)
      .not.toBe(oldBinding?.version);
    expect(task.planApproval).toBeUndefined(); expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("新增真实用户约束后原批准不能继续执行，重新准备绑定新需求修订", async () => {
    const { store, task } = await harness(); await store.refreshTaskBusinessAcceptance(task);
    const { prepared, step } = await approveLocally(store, task);
    const content = "备份至少保留七天";
    task.requirementLifecycle = applyTaskRequirementUpdate(task, { baseRevision: task.requirementLifecycle!.revision,
      sourceMessageId: "supplement", additions: [{ id: "retain", kind: "constraint", content, sourceQuote: content, supersedes: [] }],
      changes: [], focusIds: ["deploy", "protect", "retain"], acceptanceCoverage: [{ requirementId: "retain", strategy: "general_review",
        sourceQuote: content, reason: "新增保留期限，现有静态交付契约继续生效" }] }, { roundId: task.currentRoundId!,
      source: { content, sourceMessageId: "supplement", source: "user_message", relation: "supplement", createdAt: sourceTime(60) } });
    expect(() => store.assertPreparedStep(task, step)).toThrow();
    const next = store.prepareTaskPlan(task);
    expect(next.requirementRevision).toBe(prepared.requirementRevision! + 1);
    expect(next.executionDigest).not.toBe(prepared.executionDigest);
    expect(task.planApproval).toBeUndefined();
    expect(staticSiteAcceptanceContext(task).assessment).toBeUndefined(); expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("完整备份、内容与HTTP收据由实际 store 读取账本，才授予确定性业务完成", async () => {
    const { store, task, repository } = await harness(true);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).toThrow("缺少当前执行账本核验");
    const list = vi.spyOn(repository, "list");
    await store.refreshTaskBusinessAcceptance(task);
    expect(list).toHaveBeenCalledTimes(2); expect(list.mock.calls.every(args => args[0] === undefined)).toBe(true);
    expect(staticSiteAcceptanceContext(task).assessment).toMatchObject({ serverId: server.id,
      connectionGeneration: store.serverConnection(server.id).generation, assessments: [{ requirementId: "deploy", state: "met" }] });
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).not.toThrow();
    expect(backend.readTaskEvidence).not.toHaveBeenCalled(); expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("账本丢失时不沿用此前通过状态或任务投影", async () => {
    const { store, task } = await harness(true); await store.refreshTaskBusinessAcceptance(task);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).not.toThrow();
    configureExecutionLedger(store, createMemoryExecutionLedgerRepository(), async () => { throw new Error("本测试不应创建新的执行收据"); });
    await store.refreshTaskBusinessAcceptance(task);
    expect(staticSiteAcceptanceContext(task).assessment?.assessments[0]?.state).not.toBe("met");
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).toThrow("尚未取得确定性业务验收");
  });

  it("账本读取失败清除之前的完成授权，保留错误供流程处理", async () => {
    const { store, task, repository } = await harness(true); await store.refreshTaskBusinessAcceptance(task);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).not.toThrow();
    vi.spyOn(repository, "list").mockRejectedValueOnce(new Error("测试账本不可用"));
    await expect(store.refreshTaskBusinessAcceptance(task)).rejects.toThrow("无法读取持久执行记录");
    expect(staticSiteAcceptanceContext(task).assessment).toBeUndefined();
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).toThrow("缺少当前执行账本核验");
  });

  it("实际重连代际变化后，旧代际收据不能代表当前完成", async () => {
    const { store, task } = await harness(true); await store.refreshTaskBusinessAcceptance(task);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).not.toThrow();
    const prior = store.serverConnection(server.id).generation;
    useConnectionStore().disconnect(server.id); await useConnectionStore().connect(server.id, credentials);
    expect(store.serverConnection(server.id).generation).toBeGreaterThan(prior);
    await store.refreshTaskBusinessAcceptance(task);
    expect(staticSiteAcceptanceContext(task).assessment?.assessments[0]?.baselineReady).toBe(false);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).toThrow("尚未取得确定性业务验收");
  });

  it("读取账本期间连接代际变化，旧异步结果不能安装完成授权", async () => {
    const { store, task, repository } = await harness(true); await store.refreshTaskBusinessAcceptance(task);
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).not.toThrow();
    const original = repository.list.bind(repository);
    vi.spyOn(repository, "list").mockImplementationOnce(async id => {
      const records = await original(id); useConnectionStore().disconnect(server.id); return records;
    });
    await expect(store.refreshTaskBusinessAcceptance(task)).rejects.toThrow("所属任务或连接已变化");
    expect(staticSiteAcceptanceContext(task).assessment).toBeUndefined();
    expect(() => assertStaticSiteRequirementComplete(task, "deploy")).toThrow("缺少当前执行账本核验");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
