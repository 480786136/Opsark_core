import { describe, expect, it } from "vitest";
import type { ExecutionConstraints, OpsTask, TaskRequirementItem, TaskRequirementReview, TaskRequirementSource, TaskRequirementUpdate } from "@/types";
import {
  appendLegacyTaskRequirement,
  activateRequirementReviewForRetry,
  applyTaskRequirementReview,
  applyTaskRequirementUpdate,
  ensureTaskRequirementLifecycle,
  mergeRequirementExecutionConstraints,
  projectRequirementsContext,
} from "./taskRequirements";
import { modelTaskRequirementSnapshot, taskAcceptanceRequirement, taskRequirementSnapshot } from "./taskGoal";
import { prepareTaskDecision } from "./taskDecisionResolution";

const source: TaskRequirementSource = { content: "部署应用，只允许内网访问，并解决外部入口 502", relation: "new_goal",
  source: "user_message", sourceMessageId: "message-root", sourceRoundId: "round-1" };
function item(id: string, content: string, kind: TaskRequirementItem["kind"] = "goal"): TaskRequirementItem {
  return { id, kind, content, source, status: "active", evidenceIds: [] };
}
function task(): OpsTask {
  return { id: "task", serverId: "server", title: source.content, rootGoal: source.content,
    currentInstruction: source.content, currentRoundId: "round-1", lastRequirementRelation: "new_goal",
    status: "completed", permission: "managed", modelId: "model", createdAt: "2026-09-29", updatedAt: "2026-09-29",
    plan: [], messages: [{ id: source.sourceMessageId!, content: source.content, role: "user", kind: "message",
      createdAt: "2026-09-29", requirementRelation: "new_goal" }],
    requirementLifecycle: { version: 1, revision: 1,
      items: [item("deploy", "部署应用"), item("private", "只允许内网访问", "constraint"), item("entry", "解决外部入口 502")],
      focus: { roundId: "round-1", sourceMessageId: source.sourceMessageId, requirementIds: ["deploy"] } } };
}
function review(overrides: Partial<TaskRequirementReview> = {}): TaskRequirementReview {
  return { baseRevision: 1, roundId: "round-1", focusOutcome: "completed", overallOutcome: "pending",
    items: [{ requirementId: "deploy", outcome: "satisfied", evidenceIds: ["http-proof"], reason: "已取得目标服务的 HTTP 验收证据" },
      { requirementId: "private", outcome: "satisfied", evidenceIds: ["http-proof"], reason: "验收证据也证明本次部署符合内网访问范围" }],
    ...overrides };
}
const portSource: TaskRequirementSource = { content: "将端口改为 8081，暂缓外部入口排查", relation: "supplement",
  source: "user_message", sourceMessageId: "message-port", sourceRoundId: "round-2" };
function update(overrides: Partial<TaskRequirementUpdate> = {}): TaskRequirementUpdate {
  return { baseRevision: 1, sourceMessageId: portSource.sourceMessageId!,
    additions: [{ id: "port", kind: "goal", content: "将端口改为 8081", sourceQuote: "将端口改为 8081", supersedes: [] }],
    changes: [{ id: "entry", status: "deferred", sourceQuote: "暂缓外部入口排查", reason: "按用户最新指令暂缓" }],
    focusIds: ["port"], ...overrides };
}

describe("requirement lifecycle", () => {
  it.each(["missing", "empty"])("enables required review for a %s initial planning lifecycle without changing the original task", mode => {
    const current = task();
    current.status = "planning_failed";
    current.title = "新任务";
    if (mode === "missing") delete current.requirementLifecycle;
    else current.requirementLifecycle = { version: 1, revision: 0, items: [], focus: { roundId: "round-1", requirementIds: [] } };
    const before = JSON.stringify(current);
    const state = activateRequirementReviewForRetry(current);
    expect(state.revision).toBe(1);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ content: source.content, status: "active", evidenceIds: [],
      source: { sourceMessageId: "message-root", content: source.content } });
    expect(state.focus).toMatchObject({ roundId: "round-1", requirementIds: [state.items[0].id] });
    expect(JSON.stringify(current)).toBe(before);
    const activated = { ...current, requirementLifecycle: state };
    expect(() => prepareTaskDecision(activated, { decision: "complete", reason: "done", summary: "done", source: "model", steps: [] }))
      .toThrow("缺少 requirementReview");
    expect(() => prepareTaskDecision(activated, { decision: "complete", reason: "done", summary: "done", source: "model", steps: [],
      requirementReview: { baseRevision: 1, roundId: "round-1", focusOutcome: "completed", overallOutcome: "completed", items: [] } }))
      .toThrow("仍有未满足");
  });

  it("uses the latest valid original user request when rootGoal is absent, excluding continuation and side questions", () => {
    const current = task(); delete current.rootGoal; delete current.requirementLifecycle;
    current.title = "新任务";
    current.messages = [
      { id: "original", role: "user", kind: "message", content: "检查服务器运行情况", createdAt: "2026-10-02T01:00:00Z" },
      { id: "continue", role: "user", kind: "message", content: "继续", requirementRelation: "continue", createdAt: "2026-10-02T01:01:00Z" },
      { id: "question", role: "user", kind: "message", content: "为什么慢", requirementRelation: "side_question", createdAt: "2026-10-02T01:02:00Z" },
    ];
    const state = activateRequirementReviewForRetry(current);
    expect(state.items.map(entry => entry.content)).toEqual(["检查服务器运行情况"]);
    expect(state.items[0].source.sourceMessageId).toBe("original");
    current.messages = [];
    expect(() => activateRequirementReviewForRetry(current)).toThrow("未找到原始用户要求");
  });

  it("preserves existing revision-zero items and all established lifecycle versions without adding completion", () => {
    const current = task();
    const established = activateRequirementReviewForRetry(current);
    expect(established).toEqual(current.requirementLifecycle);
    expect(established).not.toBe(current.requirementLifecycle);
    current.requirementLifecycle!.revision = 0;
    current.requirementLifecycle!.items[2].status = "deferred";
    const items = structuredClone(current.requirementLifecycle!.items);
    const activated = activateRequirementReviewForRetry(current);
    expect(activated.revision).toBe(1);
    expect(activated.items).toEqual(items);
    expect(activated.focus).toEqual(current.requirementLifecycle!.focus);
  });

  it("retains preserved source text and supplemental constraints when activating an empty projection", () => {
    const current = task();
    current.requirementLifecycle = { version: 1, revision: 0, items: [], focus: { requirementIds: [] } };
    current.persistedRequirements = { version: 1, sources: [source, { ...portSource, createdAt: "2026-10-02" }] };
    const state = activateRequirementReviewForRetry(current);
    expect(state.items.map(entry => entry.content)).toEqual([source.content, portSource.content]);
    expect(state.items.every(entry => entry.status === "active" && entry.evidenceIds.length === 0)).toBe(true);
    expect(state.focus.requirementIds).toEqual(state.items.map(entry => entry.id));
  });

  it("keeps the declared goal when only supplemental messages remain latest and prefers the preserved full original", () => {
    const current = task(); delete current.rootGoal; delete current.requirementLifecycle;
    current.messages.push({ id: portSource.sourceMessageId!, role: "user", kind: "message", content: portSource.content,
      requirementRelation: "supplement", createdAt: "2026-10-02" });
    expect(activateRequirementReviewForRetry(current).items.map(entry => entry.content)).toEqual([source.content, portSource.content]);
    const completeOriginal = `${source.content}。保留用户的全部原文约束。`;
    current.persistedRequirements = { version: 1, sources: [{ ...source, content: completeOriginal, createdAt: "2026-09-29" }] };
    expect(activateRequirementReviewForRetry(current).items[0].content).toBe(completeOriginal);
  });

  it("migrates completed legacy tasks conservatively and preserves full original text", () => {
    const current = task();
    delete current.requirementLifecycle;
    const supplement = { ...portSource, content: `精确限定范围${"完整原文".repeat(1000)}` };
    const before = JSON.stringify(current);
    const state = ensureTaskRequirementLifecycle(current, [source, supplement]);
    expect(state.revision).toBe(0);
    expect(state.items.map(entry => entry.status)).toEqual(["active", "active"]);
    expect(state.items[1].content).toBe(supplement.content);
    expect(state.items[1].source).toEqual(supplement);
    expect(state.focus.requirementIds).toEqual([state.items[1].id]);
    expect(JSON.stringify(current)).toBe(before);
    expect(ensureTaskRequirementLifecycle(JSON.parse(before), [source, supplement])).toEqual(state);
  });

  it("separates completing the current request from unresolved overall requirements", () => {
    const current = task();
    const before = JSON.stringify(current);
    const state = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    expect(state.items.find(entry => entry.id === "deploy")?.status).toBe("satisfied");
    expect(state.items.find(entry => entry.id === "entry")?.status).toBe("active");
    expect(state.lastReview).toMatchObject({ focusOutcome: "completed", overallOutcome: "pending", revision: 2 });
    expect(JSON.stringify(current)).toBe(before);
    expect(() => applyTaskRequirementReview(current, review({ overallOutcome: "completed" }), { evidenceIds: ["http-proof"] }))
      .toThrow("整体仍有未满足");
  });

  it("retains a satisfied constraint as binding when a later request changes the port", () => {
    const current = task();
    current.requirementLifecycle = applyTaskRequirementReview(current, review({ items: [
      ...review().items.filter(entry => entry.requirementId !== "private"),
      { requirementId: "private", outcome: "satisfied", evidenceIds: ["network-proof"], reason: "内网访问范围已验收" },
    ] }), { evidenceIds: ["http-proof", "network-proof"] });
    const constraint = current.requirementLifecycle.items.find(entry => entry.id === "private")!;
    expect(constraint.status).toBe("active");
    expect(constraint.lastReview?.outcome).toBe("satisfied");
    current.requirementLifecycle = applyTaskRequirementUpdate(current, update({ baseRevision: 2 }), { source: portSource, roundId: "round-2" });
    const context = projectRequirementsContext(current.requirementLifecycle);
    expect(context.activeConstraints.map(entry => entry.id)).toEqual(["private"]);
    expect(context.focus.map(entry => entry.id)).toEqual(["port"]);
    expect(context.historical.map(entry => entry.id)).toEqual(["deploy"]);
    expect(context.deferred.map(entry => entry.id)).toEqual(["entry"]);
    expect(taskAcceptanceRequirement(current)).toContain("持续生效的约束：\n[private] 只允许内网访问");
    expect(taskAcceptanceRequirement(current)).toContain("历史参考：[deploy] satisfied: 部署应用");
    expect(taskAcceptanceRequirement(current)).not.toContain("整体目标：部署应用");
  });

  it("only supersedes explicitly identified requirements, retaining every unrelated goal", () => {
    const current = task();
    current.requirementLifecycle!.items.push(item("old-port", "使用 8080", "constraint"));
    const result = applyTaskRequirementUpdate(current, update({ additions: [
      { ...update().additions[0], kind: "constraint", supersedes: ["old-port"] },
    ], changes: [] }), { source: portSource, roundId: "round-2" });
    expect(result.items.find(entry => entry.id === "old-port")).toMatchObject({ status: "superseded", supersededBy: "port" });
    expect(result.items.find(entry => entry.id === "deploy")?.status).toBe("active");
    expect(result.items.find(entry => entry.id === "entry")?.status).toBe("active");
    expect(result.items.find(entry => entry.id === "private")?.status).toBe("active");
  });

  it("can explicitly split a legacy source into goals and persistent constraints", () => {
    const current = task();
    delete current.requirementLifecycle;
    current.requirementLifecycle = ensureTaskRequirementLifecycle(current, [source]);
    const legacyId = current.requirementLifecycle.items[0].id;
    const result = applyTaskRequirementUpdate(current, { baseRevision: 0, sourceMessageId: source.sourceMessageId!, changes: [],
      additions: [
        { id: "new-deploy", kind: "goal", content: "部署应用", sourceQuote: "部署应用", supersedes: [legacyId] },
        { id: "new-private", kind: "constraint", content: "只允许内网访问", sourceQuote: "只允许内网访问", supersedes: [legacyId] },
        { id: "new-entry", kind: "goal", content: "解决外部入口 502", sourceQuote: "解决外部入口 502", supersedes: [legacyId] },
      ], focusIds: ["new-deploy", "new-private", "new-entry"] }, { source });
    expect(result.items.filter(entry => entry.status === "active")).toHaveLength(3);
    expect(result.items.find(entry => entry.id === legacyId)?.status).toBe("superseded");
    expect(result.items[0].source.content).toBe(source.content);
  });

  it("allows legacy models to append requirements without erasing a prior completion or constraint", () => {
    const current = task();
    current.requirementLifecycle = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    const state = appendLegacyTaskRequirement(current, portSource, "round-2");
    expect(state.items.find(entry => entry.id === "deploy")?.status).toBe("satisfied");
    expect(state.items.find(entry => entry.id === "private")?.status).toBe("active");
    expect(state.items.find(entry => entry.source.sourceMessageId === "message-port")?.content).toBe(portSource.content);
    expect(state.lastReview).toBeUndefined();
  });

  it("returns an immutable snapshot including exact sources and lifecycle context", () => {
    const current = task();
    const before = JSON.stringify(current);
    const snapshot = taskRequirementSnapshot(current);
    snapshot.lifecycle.items[0].content = "changed outside task";
    expect(JSON.stringify(current)).toBe(before);
    expect(snapshot.requirementContext.activeConstraints[0].content).toBe("只允许内网访问");
  });

  it("falls back safely when a persisted lifecycle is malformed instead of trusting completion", () => {
    const current = task();
    current.requirementLifecycle = { version: 1, revision: 3, items: null } as unknown as OpsTask["requirementLifecycle"];
    const state = ensureTaskRequirementLifecycle(current, [source, portSource]);
    expect(state.revision).toBe(0);
    expect(state.items.map(entry => entry.content)).toEqual([source.content, portSource.content]);
    expect(state.items.every(entry => entry.status === "active")).toBe(true);
  });

  it("compresses completed history without truncating stored exact requirements or constraints", () => {
    const current = task();
    const long = `部署结果${"完整原文".repeat(1000)}`;
    current.requirementLifecycle!.items[0].content = long;
    current.requirementLifecycle!.items[0].source = { ...source, content: long };
    current.requirementLifecycle = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    current.requirementLifecycle = applyTaskRequirementUpdate(current, update({ baseRevision: 2 }), { source: portSource, roundId: "round-2" });
    const context = projectRequirementsContext(current.requirementLifecycle);
    expect(context.historical[0].summary.length).toBeLessThanOrEqual(161);
    expect(context.historical[0]).not.toHaveProperty("source");
    expect(current.requirementLifecycle.items[0].content).toBe(long);
    expect(current.requirementLifecycle.items[0].source.content).toBe(long);
    expect(context.activeConstraints[0].content).toBe("只允许内网访问");
    const prompt = modelTaskRequirementSnapshot(current);
    expect(prompt.lifecycle.items.some(entry => entry.id === "deploy")).toBe(false);
    expect(JSON.stringify(prompt)).not.toContain(long);
    expect(prompt.requirementContext.activeConstraints[0].content).toBe("只允许内网访问");
  });

  it.each(["unknown", "unmet"] as const)("does not complete a request while a binding constraint is %s", outcome => {
    const current = task();
    expect(() => applyTaskRequirementReview(current, review({ items: [review().items[0],
      { requirementId: "private", outcome, evidenceIds: ["http-proof"], reason: "当前证据尚不能证明满足内网限制" },
    ] }), { evidenceIds: ["http-proof"] })).toThrow("仍生效的约束");
  });

  it("does not accept a stored success whose evidence is no longer applicable", () => {
    const current = task();
    current.requirementLifecycle = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    expect(() => applyTaskRequirementReview(current, review({ baseRevision: 2, items: [] }), { evidenceIds: [] }))
      .toThrow("本轮仍有未满足");
    expect(applyTaskRequirementReview(current, review({ baseRevision: 2, items: [] }), { evidenceIds: ["http-proof"] })
      .lastReview?.focusOutcome).toBe("completed");
  });

  it.each([
    ["stale revision", { baseRevision: 0 }],
    ["another round", { roundId: "round-old" }],
    ["invented evidence", { items: [{ ...review().items[0], evidenceIds: ["imagined"] }] }],
    ["missing evidence", { items: [{ ...review().items[0], evidenceIds: [] }] }],
    ["unknown requirement", { items: [{ ...review().items[0], requirementId: "not-here" }] }],
    ["duplicate verdict", { items: [review().items[0], review().items[0]] }],
  ])("rejects %s without mutating task", (_label, override) => {
    const current = task();
    const before = JSON.stringify(current);
    expect(() => applyTaskRequirementReview(current, review(override as Partial<TaskRequirementReview>), { evidenceIds: ["http-proof"] })).toThrow();
    expect(JSON.stringify(current)).toBe(before);
  });

  it.each([
    ["stale revision", { baseRevision: 0 }],
    ["wrong source", { sourceMessageId: "another-message" }],
    ["invented quote", { additions: [{ ...update().additions[0], sourceQuote: "开放到公网" }] }],
    ["reused identifier", { additions: [{ ...update().additions[0], id: "private" }] }],
    ["invented replacement", { additions: [{ ...update().additions[0], supersedes: ["not-here"] }] }],
    ["completion during classification", { changes: [{ ...update().changes[0], status: "satisfied" }] }],
    ["dropped focus", { focusIds: ["deploy"] }],
  ])("rejects %s in requirement update", (_label, override) => {
    const current = task();
    const before = JSON.stringify(current);
    expect(() => applyTaskRequirementUpdate(current, update(override as Partial<TaskRequirementUpdate>), { source: portSource, roundId: "round-2" })).toThrow();
    expect(JSON.stringify(current)).toBe(before);
  });

  it("reopens a previously satisfied goal only from explicit contrary review evidence", () => {
    const current = task();
    current.requirementLifecycle = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    current.requirementLifecycle = applyTaskRequirementReview(current, review({ baseRevision: 2, focusOutcome: "pending",
      items: [{ requirementId: "deploy", outcome: "unmet", evidenceIds: ["service-down"], reason: "最新检查已证明服务停止" }] }),
    { evidenceIds: ["service-down"] });
    expect(current.requirementLifecycle.items.find(entry => entry.id === "deploy")?.status).toBe("active");
    expect(current.requirementLifecycle.lastReview?.focusOutcome).toBe("pending");
  });

  it("finishes the whole task only when every effective goal and constraint has evidence", () => {
    const current = task();
    const state = applyTaskRequirementReview(current, review({ overallOutcome: "completed", items: [
      ...review().items,
      { requirementId: "entry", outcome: "satisfied", evidenceIds: ["external-http-proof"], reason: "原访问入口已返回预期页面" },
    ] }), { evidenceIds: ["http-proof", "external-http-proof"] });
    expect(state.lastReview).toMatchObject({ focusOutcome: "completed", overallOutcome: "completed" });
    expect(state.items.find(entry => entry.id === "private")?.status).toBe("active");
  });

  it("tracks reactivation time without rewriting the original user source or reusing its old evidence", () => {
    const current = task();
    current.requirementLifecycle = applyTaskRequirementReview(current, review(), { evidenceIds: ["http-proof"] });
    const latestSource: TaskRequirementSource = { ...portSource, content: "再检查现在的部署状态", createdAt: "2026-09-29T03:00:00Z" };
    const state = applyTaskRequirementUpdate(current, update({ baseRevision: 2, additions: [], changes: [
      { id: "deploy", status: "active", sourceQuote: "再检查现在的部署状态", reason: "用户要求取得当前状态" },
    ], focusIds: ["deploy"] }), { source: latestSource, roundId: "round-2" });
    expect(state.items.find(entry => entry.id === "deploy")).toMatchObject({
      status: "active", source, lastChangedAt: latestSource.createdAt, evidenceIds: [],
    });
    expect(state.items.find(entry => entry.id === "deploy")?.lastReview).toBeUndefined();
  });
});

describe("execution constraints projected from requirement changes", () => {
  const previous: ExecutionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
    requiredConditions: ["只允许内网访问", "使用 8080", "未关联到生命周期的历史条件"],
    prohibitedActions: ["不得删除数据"], userDirectives: ["使用 8080"] };
  const classified: ExecutionConstraints = { changePolicy: "requested_changes_only", environmentPolicy: "unspecified", failurePolicy: "unspecified",
    requiredConditions: ["将端口改为 8081"], prohibitedActions: [], userDirectives: ["将端口改为 8081"] };
  function changedLifecycle() {
    const current = task();
    current.requirementLifecycle!.items.push(item("old-port", "使用 8080", "constraint"));
    const next = applyTaskRequirementUpdate(current, update({ additions: [
      { ...update().additions[0], kind: "constraint", supersedes: ["old-port"] },
    ], changes: [] }), { source: portSource, roundId: "round-2" });
    return { previousLifecycle: current.requirementLifecycle, nextLifecycle: next };
  }

  it("drops only explicitly retired exact bindings and preserves unmapped legacy conditions", () => {
    const result = mergeRequirementExecutionConstraints({ previous, classified, relation: "supplement", ...changedLifecycle() })!;
    expect(result.requiredConditions).toEqual(["只允许内网访问", "未关联到生命周期的历史条件", "将端口改为 8081"]);
    expect(result.prohibitedActions).toEqual(["不得删除数据"]);
    expect(result.userDirectives).toEqual(["将端口改为 8081"]);
    expect(result.environmentPolicy).toBe("preserve");
    expect(result.failurePolicy).toBe("strict");
    expect(result.changePolicy).toBe("requested_changes_only");
    expect(previous.requiredConditions).toContain("使用 8080");
  });

  it("does not guess that differently worded legacy restrictions mean the same thing", () => {
    const retained = { ...previous, requiredConditions: [...previous.requiredConditions, "监听端口必须为 8080"] };
    const result = mergeRequirementExecutionConstraints({ previous: retained, classified, relation: "supplement", ...changedLifecycle() })!;
    expect(result.requiredConditions).not.toContain("使用 8080");
    expect(result.requiredConditions).toContain("监听端口必须为 8080");
  });

  it("keeps a text restriction if another effective requirement still owns the same content", () => {
    const states = changedLifecycle();
    states.nextLifecycle.items.push(item("another-port-obligation", "使用 8080", "constraint"));
    expect(mergeRequirementExecutionConstraints({ previous, classified, relation: "supplement", ...states })?.requiredConditions).toContain("使用 8080");
  });

  it("preserves exact continuation policies without treating continue as new authorization", () => {
    const result = mergeRequirementExecutionConstraints({ previous, classified, relation: "continue", ...changedLifecycle() });
    expect(result).toEqual(previous);
    expect(result).not.toBe(previous);
  });

  it("keeps legacy merging when no explicit lifecycle protocol exists", () => {
    const result = mergeRequirementExecutionConstraints({ previous, classified, relation: "supplement" })!;
    expect(result.requiredConditions).toEqual([...previous.requiredConditions, ...classified.requiredConditions]);
    expect(result.environmentPolicy).toBe("unspecified");
  });

  it("does not inherit an unrelated task's constraints for an independent goal", () => {
    const current = task();
    current.requirementLifecycle!.items = [item("new", "新目标")];
    expect(mergeRequirementExecutionConstraints({ previous, classified, relation: "new_goal", nextLifecycle: current.requirementLifecycle })).toEqual(classified);
  });
});
