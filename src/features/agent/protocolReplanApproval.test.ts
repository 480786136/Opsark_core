import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep, SubmittedTaskInput } from "@/types";
import { confirmedInputScope, confirmedUserInputsContext } from "./confirmedUserInputs";
import { markProtocolReplanApprovals, refreshProtocolReplanApproval } from "./protocolReplanApproval";
import { requiresStepApproval } from "./approvalPolicy";
import { acceptStepApproval, hasCurrentStepApproval, requestStepApproval } from "./stepApproval";
import { assertTaskPlanAuthorization } from "./recoveryContract";

function task(): OpsTask {
  return { id: "task-1", serverId: "server-1", title: "部署应用", rootGoal: "部署应用",
    permission: "managed", plan: [], submittedInputs: {} } as unknown as OpsTask;
}

function input(current: OpsTask, value: string): SubmittedTaskInput {
  return { value, type: "select", label: "授权选择", description: "用户的真实决定", groupId: "form-1",
    groupTitle: "部署确认", submittedAt: "2026-09-16T00:00:00Z", scope: confirmedInputScope(current, "form-1") };
}

function step(kind: PlanStep["kind"] = "change", command = "mkdir -p /var/backups/app"): PlanStep {
  return { id: "new-step", kind, title: "准备备份目录", description: "创建备份目录", command,
    validation: "test -d /var/backups/app", expected: "目录存在", risk: "low", status: "pending" };
}

describe("protocol business-replan approval", () => {
  it("marks only new changes with current user decisions without changing risk or task constraints", () => {
    const current = task();
    current.submittedInputs = { arbitrary_permission_key: input(current, "no-system-changes") };
    current.executionConstraints = { changePolicy: "requested_changes_only", environmentPolicy: "preserve",
      failurePolicy: "strict", prohibitedActions: ["不得修改系统"], requiredConditions: [], userDirectives: [] };
    const before = JSON.stringify(current);
    const source = [step(), step("observe", "uname -a")];
    const marked = markProtocolReplanApprovals(current, source);
    expect(marked[0].protocolReplanApproval?.decisionSummary).toContain("no-system-changes");
    expect(requiresStepApproval("managed", marked[0])).toBe(true);
    expect(marked[1].protocolReplanApproval).toBeUndefined();
    expect(marked[0].risk).toBe("low");
    expect(source[0].protocolReplanApproval).toBeUndefined();
    expect(JSON.stringify(current)).toBe(before);
  });

  it("detects mutating commands even if a candidate incorrectly retains observe", () => {
    const current = task();
    current.submittedInputs = { decision: input(current, "arbitrary-option") };
    expect(markProtocolReplanApprovals(current, [step("observe")])[0].protocolReplanApproval).toBeDefined();
  });

  it("does not guess authorization semantics or gate unrelated scopes, legacy values, and credentials", () => {
    const current = task();
    const unrelated = input(current, "old-choice");
    unrelated.scope!.serverId = "another-server";
    current.submittedInputs = { old: unrelated, legacy: { ...input(current, "legacy"), scope: undefined },
      REGISTRY_TOKEN: input(current, "SECRET_MUST_NOT_LEAK") };
    const marked = markProtocolReplanApprovals(current, [step()]);
    expect(marked[0].protocolReplanApproval).toBeUndefined();
    expect(JSON.stringify(marked)).not.toContain("SECRET_MUST_NOT_LEAK");
    current.submittedInputs.decision = input(current, "普通版本选择");
    expect(markProtocolReplanApprovals(current, [step()])[0].protocolReplanApproval).toBeDefined();
  });

  it("uses every full active decision, even values omitted from the bounded planning context", () => {
    const current = task();
    current.submittedInputs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `choice_${index}`, { ...input(current, `${"x".repeat(800)}-value-${index}`), submittedAt: String(index).padStart(2, "0") },
    ]));
    expect(confirmedUserInputsContext(current)!.includedItems).toBeLessThan(30);
    const [marked] = markProtocolReplanApprovals(current, [step()]);
    const originalFingerprint = marked.protocolReplanApproval!.inputFingerprint;
    requestStepApproval("managed", marked);
    acceptStepApproval(marked);
    current.submittedInputs.choice_0.value = `${"x".repeat(800)}-changed-tail`;
    refreshProtocolReplanApproval(current, marked);
    expect(marked.protocolReplanApproval!.inputFingerprint).not.toBe(originalFingerprint);
    expect(hasCurrentStepApproval(marked)).toBe(false);
    expect(marked.protocolReplanApproval!.decisionSummary).toContain("完整内容请核对任务输入记录");
  });

  it("discards inherited/model approvals and does not override hard read-only authorization", () => {
    const current = task();
    current.submittedInputs = { decision: input(current, "禁止变更") };
    current.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve",
      failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: [] };
    const source = step();
    requestStepApproval("observe", source);
    acceptStepApproval(source);
    const [marked] = markProtocolReplanApprovals(current, [source]);
    expect(marked.approvedSafetySnapshot).toBeUndefined();
    expect(marked.safetyApprovalSnapshot).toBeUndefined();
    requestStepApproval("managed", marked);
    acceptStepApproval(marked);
    expect(hasCurrentStepApproval(marked)).toBe(true);
    expect(() => assertTaskPlanAuthorization(current, [marked])).toThrow("只读授权");
  });

  it("keeps valid approval stable but invalidates it when the input scope changes", () => {
    const current = task();
    current.submittedInputs = { decision: input(current, "本机") };
    const [marked] = markProtocolReplanApprovals(current, [step()]);
    requestStepApproval("managed", marked);
    acceptStepApproval(marked);
    refreshProtocolReplanApproval(current, marked);
    expect(hasCurrentStepApproval(marked)).toBe(true);
    current.executionTargetServerId = "another-server";
    refreshProtocolReplanApproval(current, marked);
    expect(hasCurrentStepApproval(marked)).toBe(false);
    expect(marked.protocolReplanApproval!.decisionSummary).toContain("范围已变化");
    requestStepApproval("managed", marked);
    acceptStepApproval(marked);
    refreshProtocolReplanApproval(current, marked);
    expect(hasCurrentStepApproval(marked)).toBe(true);
    current.executionTargetServerId = "third-server";
    refreshProtocolReplanApproval(current, marked);
    expect(hasCurrentStepApproval(marked)).toBe(false);
  });
});
