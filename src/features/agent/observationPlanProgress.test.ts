import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { taskAttemptContext } from "./attemptState";
import { preparePlanForApproval } from "./planPreparation";
import { assertObservationPlanProgress, observationActionIdentity, ObservationPlanError, type ObservationRefreshGrant } from "./observationPlanProgress";

function task(): OpsTask {
  return { id: "task", serverId: "host-a", currentRoundId: "round", title: "处理真实运维需求", status: "awaiting_continuation",
    permission: "managed", modelId: "model", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
}
function probe(id: string, name = "python3"): PlanStep {
  return { id, title: `阶段 ${id}`, description: "获取所需环境事实", command: "", validation: "", expected: "取得软件状态",
    kind: "observe", risk: "low", status: "pending", action: { type: "tool", toolId: "software.check", arguments: { names: [name] } } };
}
function completed(current: OpsTask, step = probe("before")): PlanStep {
  return { ...step, status: "completed", attemptContext: taskAttemptContext(current), startedAt: "2026-10-12T00:00:00Z",
    output: "可用", result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: ["proof-before"] } };
}

describe("observation plan admission", () => {
  it("rejects an entire 22-step repeated probe plan without deleting or rewriting steps", () => {
    const current = task();
    const plan = Array.from({ length: 22 }, (_, index) => probe(`probe-${index}`));
    plan[5].title = "现在开始部署";
    plan[6].description = "读取交接说明";
    const original = structuredClone(plan);
    let captured: ObservationPlanError | undefined;
    try { assertObservationPlanProgress(current, plan); } catch (error) { captured = error as ObservationPlanError; }
    expect(captured).toBeInstanceOf(ObservationPlanError);
    expect(captured?.issues).toHaveLength(21);
    expect(captured?.issues[0]).toMatchObject({ code: "duplicate_observation_in_plan", stepIndex: 1, previousStepId: "probe-0" });
    expect(plan).toEqual(original);
    expect(current.plan).toEqual([]);
  });

  it("compares actual arguments with schema defaults, not key order or titles", () => {
    const current = task();
    const first = probe("first");
    const same = probe("same");
    same.action = { type: "tool", toolId: "software.check", arguments: { includeVersions: true, names: ["python3"] } };
    expect(() => assertObservationPlanProgress(current, [first, same])).toThrow(ObservationPlanError);
    same.action.arguments.names = ["python3", "python3"];
    expect(() => assertObservationPlanProgress(current, [first, same])).toThrow(ObservationPlanError);
    expect(() => assertObservationPlanProgress(current, [first, probe("different", "perl")])).not.toThrow();
    const otherVersion = probe("no-version");
    otherVersion.action = { type: "tool", toolId: "software.check", arguments: { names: ["python3"], includeVersions: false } };
    expect(() => assertObservationPlanProgress(current, [first, otherVersion])).not.toThrow();
  });

  it("allows a real software name unused and distinguishes file resources", () => {
    const current = task();
    expect(() => assertObservationPlanProgress(current, [probe("one", "unused")])).not.toThrow();
    const read = (id: string, path: string): PlanStep => ({ ...probe(id), action: { type: "tool", toolId: "files.read_content", arguments: { path } } });
    expect(() => assertObservationPlanProgress(current, [read("a", "/opt/a/README"), read("b", "/opt/b/README")])).not.toThrow();
    expect(() => assertObservationPlanProgress(current, [read("a", "/opt/a/README"), read("b", "/opt/a/README")])).toThrow();
  });

  it("rejects a cross-stage identical successful observation with receipt references", () => {
    const current = task();
    current.plan = [completed(current)];
    const prior = structuredClone(current);
    try {
      assertObservationPlanProgress(current, [probe("after")]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationPlanError);
      expect((error as ObservationPlanError).issues[0]).toMatchObject({ code: "observation_already_available",
        previousStepId: "before", evidenceIds: ["proof-before"] });
    }
    expect(current).toEqual(prior);
  });

  it("does not borrow another target, round or failed observation", () => {
    const current = task();
    const first = completed(current);
    current.executionTargetServerId = "host-b";
    current.plan = [first];
    expect(() => assertObservationPlanProgress(current, [probe("other-host")])).not.toThrow();
    delete current.executionTargetServerId;
    current.currentRoundId = "new-round";
    expect(() => assertObservationPlanProgress(current, [probe("other-round")])).not.toThrow();
    current.currentRoundId = "round";
    current.plan = [{ ...first, status: "failed", result: { ...first.result!, executionStatus: "failed" } }];
    expect(() => assertObservationPlanProgress(current, [probe("failure-recovery")])).not.toThrow();
  });

  it("permits new observations after a planned or dispatched change without reordering", () => {
    const current = task();
    const change: PlanStep = { ...probe("change"), kind: "change", action: { type: "shell", command: "perform-authorized-change" } };
    expect(() => assertObservationPlanProgress(current, [probe("a"), change, probe("b")])).not.toThrow();
    current.plan = [completed(current), { ...completed(current, change), result: { ...completed(current).result!, facts: { commandDispatched: true } } }];
    expect(() => assertObservationPlanProgress(current, [probe("verify")])).not.toThrow();
  });

  it("does not let an observation renamed as change bypass intra-plan checks", () => {
    expect(() => assertObservationPlanProgress(task(), [probe("a"), { ...probe("fake-change"), kind: "change" }, probe("b")]))
      .toThrow(ObservationPlanError);
  });

  it("does not classify conflicting change/read_batch metadata as a read-only action", () => {
    const conflicting = defaultToolCatalog.map(tool => tool.id === "software.check" ? { ...tool, effect: "change" as const } : tool);
    expect(observationActionIdentity(probe("conflict"), taskAttemptContext(task()), conflicting)).toBeUndefined();
  });

  it("distinguishes actual endpoints even when a saved server ID is reused", () => {
    const current = task();
    const server = (host: string): ServerProfile => ({ id: current.serverId, name: "target", host, port: 22, username: "deploy",
      group: "", status: "online", environment: [], createdAt: "", info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } });
    const prepare = (id: string, target: ServerProfile) => preparePlanForApproval([probe(id)], {
      taskId: current.id, permission: "managed", server: target, servers: [target],
    }).compatibilitySteps[0];
    const firstTarget = server("first.example"), secondTarget = server("second.example");
    current.plan = [completed(current, prepare("before", firstTarget))];
    expect(() => assertObservationPlanProgress(current, [prepare("same-host", firstTarget)])).toThrow(ObservationPlanError);
    expect(() => assertObservationPlanProgress(current, [prepare("new-host", secondTarget)])).not.toThrow();
    expect(() => assertObservationPlanProgress(current, [probe("raw-same-host")], defaultToolCatalog, { target: firstTarget })).toThrow(ObservationPlanError);
    expect(() => assertObservationPlanProgress(current, [probe("raw-new-host")], defaultToolCatalog, { target: secondTarget })).not.toThrow();
  });

  it("honors only a scoped, timed refresh grant and never uses it for a duplicate plan list", () => {
    const current = task();
    const before = completed(current);
    current.plan = [before];
    const now = Date.parse("2026-10-12T00:00:10Z");
    const actionIdentity = observationActionIdentity(probe("after"), taskAttemptContext(current), defaultToolCatalog)!;
    const grant: ObservationRefreshGrant = { taskId: current.id, roundId: current.currentRoundId,
      targetContext: taskAttemptContext(current), actionIdentity, previousStepId: before.id, reason: "用户要求十秒间隔，观察一分钟",
      kind: "bounded_poll", intervalMs: 10_000, notBefore: now, deadlineAt: now + 50_000 };
    expect(() => assertObservationPlanProgress(current, [probe("after")], defaultToolCatalog, { now, refreshGrants: [grant] })).not.toThrow();
    for (const patch of [{ taskId: "other" }, { roundId: "other" }, { targetContext: "other" },
      { previousStepId: "other" }, { actionIdentity: "other" }, { deadlineAt: now }, { notBefore: now + 1 }, { intervalMs: 20_000 }, { reason: "" }]) {
      expect(() => assertObservationPlanProgress(current, [probe("after")], defaultToolCatalog,
        { now, refreshGrants: [{ ...grant, ...patch }] })).toThrow(ObservationPlanError);
    }
    expect(() => assertObservationPlanProgress(current, [probe("after"), probe("again")], defaultToolCatalog,
      { now, refreshGrants: [grant] })).toThrow(ObservationPlanError);
  });

  it("preserves a finite observation loop within a single controlled shell action", () => {
    const loop: PlanStep = { ...probe("poll"), command: "for i in 1 2 3; do read_health; sleep 10; done",
      action: { type: "shell", command: "for i in 1 2 3; do read_health; sleep 10; done" } };
    expect(() => assertObservationPlanProgress(task(), [loop])).not.toThrow();
  });
});
