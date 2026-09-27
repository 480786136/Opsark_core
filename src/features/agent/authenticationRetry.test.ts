import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { taskAttemptContext } from "./attemptState";
import { gitAuthenticationRetryBlocker, repeatedAuthenticationInputBlocker } from "./authenticationRetry";
import { gitAuthenticationOperation } from "./interactiveSshCredential";
import { confirmedInputScope } from "./confirmedUserInputs";
import { prepareOperationalDecision, retryBlocker } from "./operationalRecovery";

function fixture(output = "fatal: could not read Username for 'https://gitee.com': No such device or address") {
  const task = { id: "task", serverId: "server", title: "部署", rootGoal: "部署", currentRoundId: "round", credentialRevision: 1,
    plan: [], messages: [], status: "needs_adjustment", permission: "managed" } as unknown as OpsTask;
  const failed = { id: "failed", kind: "change", status: "failed", command: "git clone https://gitee.com/team/app.git /opt/app",
    title: "克隆", description: "克隆", expected: "仓库存在", validation: "test -d /opt/app/.git", risk: "medium",
    output, attemptContext: taskAttemptContext(task), authenticationAttempt: { channel: "foreground-pty-v2", credentialRevision: 1 },
    result: { executionStatus: "failed", observationStatus: "unknown", facts: { commandDispatched: true }, warnings: [], evidenceIds: [] } } as PlanStep;
  const retry = { ...failed, id: "retry", status: "pending", output: undefined, result: undefined,
    command: "set -o pipefail\nprintf 'retrying differently\\n'\ngit clone https://gitee.com/team/app.git /opt/app\nrc=$?\nexit \"$rc\"" } as PlanStep;
  task.plan = [failed];
  return { task, failed, retry };
}

describe("authentication retry identity", () => {
  it("blocks changed wrapping/logging, new credentials and generic planned repairs for a broken channel", () => {
    const { task, failed, retry } = fixture();
    expect(gitAuthenticationOperation(retry.command)).toEqual(gitAuthenticationOperation(failed.command));
    expect(retryBlocker(task, retry)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    task.plan.push({ ...failed, id: "not-dispatched", output: "preflight rejected",
      result: { ...failed.result!, executionStatus: "blocked", facts: { commandDispatched: false } } });
    expect(retryBlocker(task, retry)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    task.credentialRevision = 2;
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, true)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    const check = { ...retry, id: "check", kind: "observe", command: "pwd" } as PlanStep;
    retry.retryBasis = { failedStepId: failed.id, kind: "changed_state", evidenceIds: [], reason: "new wording", afterStepIndex: 1 };
    expect(() => prepareOperationalDecision(task, { decision: "adjust", reason: "repair", summary: "repair", source: "model", steps: [check, retry] }))
      .toThrow("AUTH_CHANNEL_UNAVAILABLE");
  });

  it("allows one actual migration to the fixed PTY but not an anonymous runtime or disabled prompts", () => {
    const { task, failed, retry } = fixture();
    failed.authenticationAttempt = undefined;
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan)).toBeUndefined();
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, false)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, true)).toBeUndefined();
    failed.authenticationAttempt = { channel: "foreground-pty-v2", credentialRevision: 1 };
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, true)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    failed.authenticationAttempt = undefined;
    retry.command = "GIT_TERMINAL_PROMPT=0 git clone https://gitee.com/team/app.git /opt/app";
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan)).toContain("AUTH_CHANNEL_UNAVAILABLE");
  });

  it("distinguishes rejected credentials from channel failure and respects target changes and successful newer attempts", () => {
    const { task, failed, retry } = fixture("fatal: Authentication failed");
    expect(retryBlocker(task, retry)).toContain("AUTH_RETRY_NO_PROGRESS");
    task.credentialRevision = 2;
    expect(retryBlocker(task, retry)).toBeUndefined();
    task.credentialRevision = 1;
    task.executionTargetServerId = "other";
    expect(retryBlocker(task, retry)).toBeUndefined();
    task.executionTargetServerId = undefined;
    retry.command = "git clone https://gitee.com/other/repository.git /opt/other";
    expect(retryBlocker(task, retry)).toBeUndefined();
    retry.command = failed.command;
    task.plan.push({ ...failed, id: "new-success", status: "completed", output: "cloned", result: { ...failed.result!, executionStatus: "success" } });
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, true)).toBeUndefined();
  });

  it("new credentials do not repair disabled prompts without an actual bound channel", () => {
    const { task, failed, retry } = fixture("fatal: could not read Username: terminal prompts disabled");
    failed.authenticationAttempt = { channel: "noninteractive", credentialRevision: 1 };
    task.credentialRevision = 2;
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, false)).toContain("AUTH_RETRY_NO_PROGRESS");
    expect(gitAuthenticationRetryBlocker(task, retry, task.plan, true)).toBeUndefined();
    retry.command = "GIT_TERMINAL_PROMPT=0 git clone https://gitee.com/team/app.git /opt/app";
    expect(retryBlocker(task, retry)).toContain("AUTH_RETRY_NO_PROGRESS");
  });

  it("permits first-time credential collection after an anonymous probe, without pretending a bound PTY failed", () => {
    const { task, failed, retry } = fixture();
    failed.authenticationAttempt = { channel: "noninteractive", credentialRevision: 1 };
    retry.command = ""; retry.action = { type: "tool" as const, toolId: "user.request_input", arguments: {"title":"gitee.com 首次凭据","fields":[{"key":"password","type":"password"}]} };
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toBeUndefined();
    failed.authenticationAttempt = undefined;
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toBeUndefined();
  });

  it("does not ask the same scoped choice again, or ask for passwords when the channel is broken", () => {
    const { task, retry } = fixture();
    task.submittedInputs = { git_credential_decision: { type: "select", value: "use_saved", allowedValues: ["use_saved", "cancel"],
      label: "授权", description: "授权", groupId: "form", groupTitle: "授权", submittedAt: "now", scope: confirmedInputScope(task, "form") } };
    retry.command = ""; retry.action = { type: "tool" as const, toolId: "user.request_input", arguments: {"fields":[{"key":"git_credential_decision","type":"select","options":[{"value":"use_saved"},{"value":"cancel"}]}]} };
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toContain("USER_DECISION_ALREADY_CONFIRMED");
    task.executionTargetServerId = "other";
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toBeUndefined();
    task.executionTargetServerId = undefined;
    retry.command = ""; retry.action = { type: "tool" as const, toolId: "user.request_input", arguments: {"title":"gitee.com 凭据","fields":[{"key":"password","type":"password"}]} };
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toContain("AUTH_CHANNEL_UNAVAILABLE");
    retry.action = JSON.parse(JSON.stringify(retry.action).replace("gitee.com", "unrelated.example"));
    expect(repeatedAuthenticationInputBlocker(task, retry, task.plan)).toBeUndefined();
  });
});
