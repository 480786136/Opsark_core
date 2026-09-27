import { describe, expect, it } from "vitest";
import { canonicalExecutionJson, executionDigest, executionIntentMatches, preparePlanForApproval, sha256Utf8, type PlanPreparationContext } from "./planPreparation";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { AgentSessionRef, PlanStep, ServerProfile } from "@/types";

const server = (id = "s1"): ServerProfile => ({ id, name: id, host: id + ".example", port: 22, username: "deploy",
  group: "", status: "online", environment: [], createdAt: "", info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } });
const shell = (id = "one"): PlanStep => ({ id, action: { type: "shell", command: "uptime" }, kind: "observe", command: "uptime",
  title: "查看运行时间", description: "只读查看", risk: "low", expected: "记录真实运行时间", validation: "", status: "pending" });
const tool = (id = "one"): PlanStep => ({ ...shell(id), action: { type: "tool", toolId: "files.read_content", arguments: { path: "/srv/README" } }, command: "" });
const context = (): PlanPreparationContext => { const target = server(); return { taskId: "task", permission: "safe", server: target, servers: [target], connectionGeneration: 1 }; };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("J1 plan preparation", () => {
  it("does not accept an earlier or model-supplied execution deadline as dispatch authority", () => {
    const step = { ...shell(), executionPolicy: { version: 1 as const, executionId: "old-attempt",
      kind: "persistent_service" as const, startedAt: 1 } };
    const prepared = preparePlanForApproval([step], context());
    expect(prepared.compatibilitySteps[0]?.executionPolicy).toBeUndefined();
    expect(JSON.stringify(prepared.steps[0]?.intent)).not.toContain("old-attempt");
    expect(step.executionPolicy.executionId).toBe("old-attempt");
  });
  it("uses verified SHA-256 UTF-8 vectors and stable typed serialization", () => {
    // Fixed vectors independently verified against Node crypto and Python hashlib.
    for (const [value, digest] of [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["a".repeat(1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"],
      ["执行快照😀\n", "6cb2920516dcc5d74ec81ad27ab1ad514fa670c203b086aa5c157241cd080ace"],
    ]) {
      expect(sha256Utf8(value!)).toBe(digest);
    }
    expect(executionDigest({ a: 1, b: "2", c: [null, false] })).toBe(executionDigest({ c: [null, false], b: "2", a: 1 }));
    expect(executionDigest({ a: 1 })).not.toBe(executionDigest({ a: "1" }));
    expect(executionDigest([1, 2])).not.toBe(executionDigest([2, 1]));
    expect(executionDigest("a\nb")).not.toBe(executionDigest("a\r\nb"));
    expect(() => canonicalExecutionJson({ invalid: NaN })).toThrow("非 JSON");
  });

  it("freezes final defaults without mutating the proposal and is idempotent", () => {
    const proposal = [tool()];
    const first = preparePlanForApproval(proposal, context());
    expect(proposal[0]!.action).toEqual({ type: "tool", toolId: "files.read_content", arguments: { path: "/srv/README" } });
    expect(first.steps[0]).toMatchObject({ type: "tool", action: { arguments: { maxBytes: 65536 } } });
    expect(first.steps[0]).not.toHaveProperty("validator");
    expect(first.compatibilitySteps[0]).not.toHaveProperty("validator");
    expect(first.compatibilitySteps[0]).not.toHaveProperty("executionScope");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.steps[0]!.intent.semantic.action)).toBe(true);
    const second = preparePlanForApproval(first.compatibilitySteps, { ...context(), previous: first });
    expect(second.executionDigest).toBe(first.executionDigest);
    expect(second.planRevision).toBe(first.planRevision);
    expect(second.steps[0]!.stepRevision).toBe(1);
    expect(second.changes).toEqual([]);
  });

  it("keeps display changes out of authorization while tracking changed expected acceptance", () => {
    const first = preparePlanForApproval([shell()], context());
    const display = copy(first.compatibilitySteps);
    display[0]!.title = "新标题"; display[0]!.description = "新语言与排版";
    const second = preparePlanForApproval(display, { ...context(), previous: first });
    expect(second.executionDigest).toBe(first.executionDigest);
    expect(second.displayDigest).not.toBe(first.displayDigest);
    display[0]!.expected = "运行时间须超过 1 天";
    const changed = preparePlanForApproval(display, { ...context(), previous: first });
    expect(changed.executionDigest).not.toBe(first.executionDigest);
    expect(changed.planRevision).toBe(2);
    expect(changed.steps[0]!.stepRevision).toBe(2);
  });

  it.each(["command", "validation", "validator", "sessionContextChange"])("rejects tool Shell contamination in %s without clearing it", field => {
    const input = tool();
    Object.assign(input, { [field]: field === "validator" ? { type: "command", command: "true", validStates: ["matched"] }
      : field === "sessionContextChange" ? { cwd: "/etc" } : "touch /tmp/polluted" });
    const before = copy(input);
    expect(() => preparePlanForApproval([input], context())).toThrow("Shell 字段");
    expect(input).toEqual(before);
  });

  it("rejects foreign action/step fields and model observe labels on mutations", () => {
    expect(() => preparePlanForApproval([{ ...tool(), extra: "ignored?" } as PlanStep], context())).toThrow("未声明字段");
    const input = shell(); input.command = "touch /tmp/new"; input.action = { type: "shell", command: input.command };
    expect(() => preparePlanForApproval([input], context())).toThrow("OBSERVE_COMMAND_MUTATION");
  });

  it("keeps executed and even polluted historical records unchanged instead of normalizing them", () => {
    const history = { ...tool("old"), status: "completed" as const, command: "historical bad field", validator: { type: "command" as const, command: "historic", validStates: [] },
      output: "real output", result: { executionStatus: "success" as const, observationStatus: "matched" as const, facts: {}, warnings: [], evidenceIds: ["evidence"] } };
    const prepared = preparePlanForApproval([history, shell()], context());
    expect(prepared.compatibilitySteps[0]).toEqual(history);
    expect(prepared.steps).toHaveLength(1);
    expect(prepared.steps[0]!.intent.semantic.dependencies.precedingStepIds).toEqual(["old"]);
  });

  it("keeps a stage grant stable as earlier steps record completion", () => {
    const first = preparePlanForApproval([shell("one"), shell("two")], context());
    const progressed = copy(first.compatibilitySteps); progressed[0]!.status = "completed"; progressed[0]!.output = "real output";
    const second = preparePlanForApproval(progressed, { ...context(), previous: first });
    expect(second.executionDigest).toBe(first.executionDigest);
    expect(second.planRevision).toBe(1);
    expect(second.steps[1]!.intent).toEqual(first.steps[1]!.intent);
    expect(second.compatibilitySteps[0]!.output).toBe("real output");
  });

  it("binds target identity, generation and exact Agent cwd separately from server presentation", () => {
    const ctx = context();
    const session: AgentSessionRef = { id: "session", taskId: "task", serverId: "s1", generation: 2, state: "ready", createdAt: "",
      context: { cwd: "/srv/app", shell: "bash", revision: 3, sourceFiles: [], environment: {} } };
    const step = { ...shell(), executionScope: "agent_session" as const };
    const first = preparePlanForApproval([step], { ...ctx, agentSession: session });
    expect(first.steps[0]!.intent.semantic.targets[0]).toMatchObject({ serverId: "s1", host: "s1.example", port: 22, username: "deploy", connectionGeneration: 1,
      agentSession: { id: "session", generation: 2, contextRevision: 3, cwd: "/srv/app" } });
    expect(preparePlanForApproval([step], { ...ctx, agentSession: { ...session, context: { ...session.context, cwd: "/tmp" } } }).executionDigest).not.toBe(first.executionDigest);
    expect(preparePlanForApproval([step], { ...ctx, connectionGeneration: 2, agentSession: session }).executionDigest).not.toBe(first.executionDigest);
    const renamed = { ...ctx.server!, name: "new label", group: "new folder" };
    expect(preparePlanForApproval([step], { ...ctx, server: renamed, servers: [renamed], agentSession: session }).executionDigest).toBe(first.executionDigest);
    expect(() => preparePlanForApproval([step], { ...ctx, server: { ...ctx.server!, port: 2222 } })).toThrow("身份已变化");
  });

  it("tracks dependencies, permissions and reference identity without credential values", () => {
    const ctx = context();
    const first = preparePlanForApproval([shell()], ctx);
    const altered = { ...shell(), failureDependencies: [{ failedStepId: "old", reason: "inspect" }] };
    expect(preparePlanForApproval([altered], ctx).executionDigest).not.toBe(first.executionDigest);
    expect(preparePlanForApproval([shell()], { ...ctx, permission: "managed" }).executionDigest).not.toBe(first.executionDigest);
    expect(preparePlanForApproval([shell()], { ...ctx, inputBindings: [{ key: "HOST", reference: "input-group:1", target: "s1" }] }).executionDigest).not.toBe(first.executionDigest);
    expect(() => preparePlanForApproval([shell()], { ...ctx, taskId: "other", previous: first })).toThrow("其他任务");
  });

  it("tracks effective tool contract/defaults but not catalog release descriptions", () => {
    const original = preparePlanForApproval([tool()], context());
    const cosmetic = defaultToolCatalog.map(item => ({ ...item, name: "展示", configurationVersion: 999, description: "新说明", updatedAt: "new" }));
    expect(preparePlanForApproval([tool()], context(), cosmetic).executionDigest).toBe(original.executionDigest);
    const versioned = defaultToolCatalog.map(item => item.id === "files.read_content" ? { ...item, version: item.version + 1 } : item);
    expect(preparePlanForApproval([tool()], context(), versioned).executionDigest).not.toBe(original.executionDigest);
    const disabled = defaultToolCatalog.map(item => item.id === "files.read_content" ? { ...item, enabled: false } : item);
    expect(() => preparePlanForApproval([tool()], context(), disabled)).toThrow("禁用");
  });

  it("rejects dependent future steps across a standalone connection/input boundary", () => {
    const query = { ...tool(), action: { type: "tool" as const, toolId: "server.resolve_connection", arguments: { host: "new.example" } } };
    expect(() => preparePlanForApproval([query, shell("two")], context())).toThrow("唯一待执行步骤");
    expect(() => preparePlanForApproval([query], { taskId: "task", permission: "safe", servers: [] })).not.toThrow();
  });

  it("binds both transfer endpoints and permits new server connections with a known credential reference", () => {
    const ctx = context(); const target = { ...server("s2"), name: "backup" }; ctx.servers = [...ctx.servers, target];
    const transfer = { ...tool(), kind: "change" as const, action: { type: "tool" as const, toolId: "files.transfer_between_servers",
      arguments: { sourcePath: "/srv/a", targetServer: "backup", targetPath: "/backup/a" } } };
    const prepared = preparePlanForApproval([transfer], ctx);
    expect(prepared.steps[0]!.intent.semantic.targets).toHaveLength(2);
    expect(prepared.steps[0]!.action).toMatchObject({ arguments: { targetServer: "s2", overwrite: false } });
    expect(() => preparePlanForApproval([transfer], { ...ctx, servers: [...ctx.servers, { ...server("s3"), name: "backup" }] })).toThrow("多个服务器");
    const connect = { ...tool(), kind: "change" as const, action: { type: "tool" as const, toolId: "server.connect",
      arguments: { host: "new.example", port: 2222, credentialRef: "server-credential:group" } } };
    const fresh = preparePlanForApproval([connect], { ...ctx, credentialBindings: { "server-credential:group": { host: "new.example", port: 2222 } } });
    const boundTargets = fresh.steps[0]!.intent.semantic.targets;
    expect(boundTargets[boundTargets.length - 1]).toMatchObject({ role: "connection", host: "new.example", port: 2222, credentialRef: "server-credential:group" });
    expect(boundTargets[boundTargets.length - 1]!.serverId).toBeUndefined();
  });

  it("detects corruption even when both compared digests contain the same stale value", () => {
    const intent = preparePlanForApproval([shell()], context()).steps[0]!.intent;
    expect(executionIntentMatches(intent, copy(intent))).toBe(true);
    const corrupted = copy(intent); corrupted.semantic.expected = "invented success";
    expect(executionIntentMatches(corrupted, corrupted)).toBe(false);
  });
});
