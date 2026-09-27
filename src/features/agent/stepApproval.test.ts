import { describe, expect, it } from "vitest";
import {
  acceptStepApproval,
  hasCurrentStepApproval,
  requestStepApproval,
} from "@/features/agent/stepApproval";
import type { PlanStep } from "@/types";

function step(risk: PlanStep["risk"], status: PlanStep["status"] = "pending"): PlanStep {
  return {
    id: "step-1",
    title: "部署服务",
    description: "部署服务",
    command: "systemctl restart app",
    risk,
    expected: "服务运行",
    validation: "systemctl is-active app",
    status,
  };
}

describe("step approval", () => {
  it("moves a step requiring approval into the waiting state", () => {
    const pending = step("medium");
    const request = requestStepApproval("safe", pending);

    expect(pending.status).toBe("awaiting_approval");
    expect(request).toEqual({
      taskStatus: "awaiting_step_approval",
      eventMessage: "步骤“部署服务”为中风险，需要单独确认。",
    });
  });

  it("leaves an automatically allowed step unchanged", () => {
    const pending = step("low");

    expect(requestStepApproval("safe", pending)).toBeUndefined();
    expect(pending.status).toBe("pending");
  });

  it("accepts only a step currently waiting for approval", () => {
    const waiting = step("high");
    requestStepApproval("managed", waiting);

    expect(acceptStepApproval(waiting)).toEqual({ taskStatus: "running", shouldExecute: true });
    expect(waiting.status).toBe("awaiting_approval");
    expect(hasCurrentStepApproval(waiting)).toBe(true);
  });

  it("does not turn a restored waiting status or old snapshot into new approval", () => {
    const waiting = step("high", "awaiting_approval");
    expect(acceptStepApproval(waiting)).toBeUndefined();
    waiting.safetyApprovalSnapshot = {
      command: waiting.command, validation: waiting.validation, risk: waiting.risk,
    };
    expect(acceptStepApproval(waiting)).toBeUndefined();
    expect(hasCurrentStepApproval(waiting)).toBe(false);
  });

  it.each(["command", "validation", "expected", "kind", "validator", "failureDependencies", "recovery"] as const)(
    "rejects %s edits made while the approval dialog was waiting",
    field => {
      const waiting = step("high");
      requestStepApproval("managed", waiting);
      if (field === "kind") waiting.kind = "observe";
      else if (field === "validator") waiting.validator = { type: "command", command: "true", validStates: ["unknown"] };
      else if (field === "failureDependencies") waiting.failureDependencies = [{ failedStepId: "old", reason: "must recover" }];
      else if (field === "recovery") waiting.recovery = { failedStepId: "old", targetContext: "target", purpose: "repair" };
      else waiting[field] += " changed";
      expect(acceptStepApproval(waiting)).toBeUndefined();
      expect(hasCurrentStepApproval(waiting)).toBe(false);
    },
  );

  it("allows display-only edits and object-key reordering without changing semantics", () => {
    const waiting: PlanStep = { ...step("high"), sessionContextChange: { cwd: "/opt/app", shell: "bash" } };
    requestStepApproval("managed", waiting);
    waiting.title = "新的展示名称";
    waiting.description = "新的展示文案";
    waiting.sessionContextChange = { shell: "bash", cwd: "/opt/app" };
    expect(acceptStepApproval(waiting)?.shouldExecute).toBe(true);
    expect(hasCurrentStepApproval(waiting)).toBe(true);
  });

  it("treats a backend null session context as absent when approving", () => {
    const waiting = {
      ...step("high"),
      sessionContextChange: null as unknown as PlanStep["sessionContextChange"],
    };

    requestStepApproval("managed", waiting);
    acceptStepApproval(waiting);

    expect(waiting.safetyApprovalSnapshot?.sessionContextChange).toBeUndefined();
    expect(hasCurrentStepApproval(waiting)).toBe(true);
  });

  it("rejects approval for a step that is not waiting", () => {
    expect(acceptStepApproval(step("high"))).toBeUndefined();
  });

  it.each(["command", "validation", "risk"] as const)(
    "binds approval to the exact %s shown to the user",
    (field) => {
      const waiting = step("high");
      requestStepApproval("managed", waiting);
      acceptStepApproval(waiting);
      expect(hasCurrentStepApproval(waiting)).toBe(true);
      if (field === "risk") waiting.risk = "medium";
      else waiting[field] = `${waiting[field]} changed`;
      expect(hasCurrentStepApproval(waiting)).toBe(false);
    },
  );

  it("invalidates approval when execution scope or replayed context changes", () => {
    const waiting = {
      ...step("high"),
      executionScope: "agent_session" as const,
      sessionContextChange: { cwd: "/opt/app" },
    };
    requestStepApproval("managed", waiting);
    acceptStepApproval(waiting);
    waiting.sessionContextChange.cwd = "/opt/other";
    expect(hasCurrentStepApproval(waiting)).toBe(false);
  });

  it("explains concrete-action approval after protocol replanning and binds the confirmed decisions", () => {
    const pending = { ...step("low"), protocolReplanApproval: {
      inputFingerprint: "confirmed-1", decisionSummary: "系统前置调整授权：no-system-changes",
    } };
    const request = requestStepApproval("managed", pending);
    expect(request?.eventMessage).toContain("no-system-changes");
    expect(request?.eventMessage).toContain("仅授权本步骤展示的具体变更");
    expect(request?.eventMessage).toContain("不撤销任务级禁止事项");
    acceptStepApproval(pending);
    expect(hasCurrentStepApproval(pending)).toBe(true);
    pending.protocolReplanApproval.inputFingerprint = "confirmed-2";
    expect(hasCurrentStepApproval(pending)).toBe(false);
  });

  it("cannot retain approval by dropping the concrete-action reminder", () => {
    const pending = { ...step("low"), protocolReplanApproval: {
      inputFingerprint: "confirmed-1", decisionSummary: "原决定",
    } } as PlanStep;
    requestStepApproval("managed", pending);
    acceptStepApproval(pending);
    pending.protocolReplanApproval = undefined;
    expect(hasCurrentStepApproval(pending)).toBe(false);
  });
});


it("invalidates approval when structured arguments or the tool identity change", () => {
  const pending = step("medium");
  pending.command = "";
  pending.validation = "";
  pending.action = { type: "tool", toolId: "files.transfer_between_servers", arguments: {
    sourcePath: "/app/archive", targetPath: "/backup/archive", targetServer: "backup", overwrite: false,
  } };
  requestStepApproval("safe", pending);
  acceptStepApproval(pending);
  expect(hasCurrentStepApproval(pending)).toBe(true);
  pending.action.arguments.overwrite = true;
  expect(hasCurrentStepApproval(pending)).toBe(false);
  expect(pending.approvedSafetySnapshot?.action).toMatchObject({ arguments: { overwrite: false } });
  pending.action.arguments.overwrite = false;
  pending.action.toolId = "server.connect";
  expect(hasCurrentStepApproval(pending)).toBe(false);
});
