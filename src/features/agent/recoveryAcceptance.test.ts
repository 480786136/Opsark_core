// The application deliberately has DOM-only types; this integration test runs in Node.
// @ts-expect-error Node's built-in module is available to Vitest, not the application bundle.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { classifyStepResult } from "@/services/validation";
import { taskAttemptContext } from "./attemptState";
import { hasVerifiedRecovery, isRelatedRecoveryStep, recoveryVerificationContract, unresolvedRecoveryBlockers } from "./recoveryContract";
import { recordedSupplementalAcceptance, supplementalRecoveryAcceptance, validationHasAcceptanceCheck } from "./planSafety";
import { selectAdjustmentSteps, selectContinuationSteps } from "./taskProgression";

function fixture(validation = "test -d /opt/app") {
  const task: OpsTask = { id: "acceptance-task", serverId: "server", title: "Install prerequisites", status: "running",
    permission: "managed", modelId: "model", currentRoundId: "round", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
  const context = taskAttemptContext(task);
  const failed: PlanStep = { id: "install", kind: "change", title: "Install prerequisites", description: "Install prerequisites",
    command: "dnf install -y tool", validation, expected: "All required tools are available", risk: "medium", status: "failed",
    attemptContext: context, result: { executionStatus: "failed", observationStatus: "unknown", exitCode: 1,
      facts: {}, warnings: [], evidenceIds: [] } };
  const verify: PlanStep = { ...failed, id: "verify", kind: "observe", command: validation, validation: "", risk: "low",
    status: "pending", result: undefined, attemptContext: undefined,
    recovery: { failedStepId: failed.id, targetContext: context, purpose: "verify" } };
  const repair: PlanStep = { ...failed, id: "repair", command: "dnf install -y --refresh tool", status: "pending", attemptContext: undefined, result: undefined,
    recovery: { failedStepId: failed.id, targetContext: context, purpose: "repair" } };
  task.plan = [failed, repair, verify];
  return { task, failed, verify, repair, context };
}

function observed(step: PlanStep, context: string, output: string, exitCode = 0, at = "2026-09-16T00:00:03Z") {
  const classified = classifyStepResult(step, { output, success: exitCode === 0, exitCode }, { passed: true, detail: "observe-only" });
  step.status = classified.accepted ? "completed" : "failed";
  step.attemptContext = context;
  step.startedAt = at;
  step.result = classified.result;
  step.evidence = classified.evidence.map(evidence => ({ ...evidence, collectedAt: at }));
  return classified;
}

describe("conservative historical proof recognition is stronger than command completion", () => {
  it("offers old and supplemental verification as references, not immutable acceptance rules", () => {
    const { failed } = fixture("command -v sh || echo absent");
    const reference = recoveryVerificationContract(failed);
    expect(reference).toMatchObject({ usage: "historical_reference", allowsRevisedVerification: true });
    expect(reference.acceptanceInstruction).toContain("可根据用户目标和新证据修正验收命令、expected 或执行方式");
    expect(reference.acceptanceInstruction).toContain("不是唯一允许的验收方法");
    expect(reference.acceptanceInstruction).not.toContain("原查询、expected 和目标不变");
    expect(failed.validation).toBe("command -v sh || echo absent");
  });

  it.each([
    "echo absent", "printf '%s\\n' absent", "command -v missing || echo absent", "pwd",
    "custom-state-query", "test -d /opt/app; echo finished", "test 1 = 1", "true", "set -e; printf healthy",
    "set -e; test -d /missing && echo found; test -d /",
  ])("does not treat a print-only or masked command as acceptance: %s", command => {
    expect(validationHasAcceptanceCheck(command)).toBe(false);
  });

  it.each([
    "test -d /opt/app", "command -v sh", "systemctl is-active containerd", "test -s /etc/kubernetes/admin.conf",
    "command -v kubeadm && command -v kubelet", "set -e; command -v kubeadm; command -v kubelet",
    'test "$(sysctl -n net.ipv4.ip_forward)" = 1', "test -d /opt/app || exit 1; printf done",
  ])("accepts a real exit-code predicate without requiring a domain parser: %s", command => {
    expect(validationHasAcceptanceCheck(command)).toBe(true);
    const { failed, verify, context } = fixture(command);
    observed(verify, context, "");
    expect(verify.result?.observationStatus).toBe("unknown");
    expect(hasVerifiedRecovery(failed, verify)).toBe(true);
  });

  it("preserves a successful raw observe while refusing to release its prior blocker", () => {
    const { task, failed, verify, context } = fixture("command -v kubeadm || echo absent");
    const classified = observed(verify, context, "absent\n");
    expect(classified.accepted).toBe(true);
    expect(classified.needsModelReview).toBe(false);
    expect(verify.status).toBe("completed");
    expect(verify.result).toMatchObject({ executionStatus: "success", observationStatus: "unknown",
      facts: { interpretation: "raw", proves: "command_execution_only", acceptancePassed: false } });
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
    expect(unresolvedRecoveryBlockers(task)).toContain(failed);
  });

  it("executes a recorded bounded supplement without changing original query or expected", () => {
    const original = "command -v sh || echo 'sh absent'; command -v printf || echo 'printf absent'";
    const { failed, verify, context } = fixture(original);
    const contract = recoveryVerificationContract(failed);
    expect(contract.command).toBe(original);
    expect(contract.requiresAcceptanceEvidence).toBe(true);
    expect(contract.supplementalVerification?.command).toContain(`(\n${original}\n)`);
    verify.command = contract.supplementalVerification!.command;
    const execution = spawnSync("sh", ["-c", verify.command], { encoding: "utf8" });
    expect(execution.status).toBe(0);
    observed(verify, context, execution.stdout, execution.status!);
    expect(isRelatedRecoveryStep(failed, verify, context)).toBe(true);
    expect(verify.evidence?.[0].facts.recoveryAcceptance).toMatchObject({
      originalCommand: original, expected: failed.expected, failedStepId: failed.id, targetContext: context,
      source: "original_read_only_predicates", assertions: ["command -v sh", "command -v printf"],
    });
    expect(hasVerifiedRecovery(failed, verify)).toBe(true);
    expect(failed.validation).toBe(original);
    delete verify.evidence![0].facts.recoveryAcceptance;
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
  });

  it("keeps absent tools blocking even though their original printer exits zero", () => {
    const original = "command -v __opsark_missing_acceptance_probe_72f84 || echo absent";
    const { failed, verify, context } = fixture(original);
    const originalResult = spawnSync("sh", ["-c", original], { encoding: "utf8" });
    expect(originalResult.status).toBe(0);
    expect(originalResult.stdout).toContain("absent");
    verify.command = recoveryVerificationContract(failed).supplementalVerification!.command;
    const execution = spawnSync("sh", ["-c", verify.command], { encoding: "utf8" });
    expect(execution.status).not.toBe(0);
    observed(verify, context, execution.stdout, execution.status!);
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
  });

  it("handles the incident's printf substitution contract without dropping any original check", () => {
    const original = [
      "set -u",
      `printf 'KUBEADM_PATH=%s\\n' "$(command -v kubeadm || echo absent)"`,
      `printf 'KUBELET_PATH=%s\\n' "$(command -v kubelet || echo absent)"`,
      `printf 'KUBECTL_PATH=%s\\n' "$(command -v kubectl || echo absent)"`,
      `printf 'KUBELET_ENABLED=%s\\n' "$(systemctl is-enabled kubelet 2>/dev/null || echo unknown)"`,
      `printf 'KUBEADM_VERSION=%s\\n' "$(kubeadm version -o short 2>/dev/null || echo unavailable)"`,
      `printf 'KUBELET_VERSION=%s\\n' "$(kubelet --version 2>/dev/null || echo unavailable)"`,
    ].join("\n");
    const { failed, verify, context } = fixture(original);
    expect(validationHasAcceptanceCheck(original)).toBe(false);
    const supplement = recoveryVerificationContract(failed).supplementalVerification!;
    expect(supplement.command).toContain(`(\n${original}\n)`);
    expect(supplement.assertions).toHaveLength(6);
    expect(supplement.assertions[3]).toBe("systemctl is-enabled kubelet 2>/dev/null");
    expect(supplement.assertions[4]).toBe('__opsark_acceptance_output="$(kubeadm version -o short 2>/dev/null)" && test -n "$__opsark_acceptance_output"');
    verify.command = supplement.command;
    expect(isRelatedRecoveryStep(failed, verify, context)).toBe(true);
    expect(recordedSupplementalAcceptance(verify.command)).toEqual(supplement);
    const unavailable = `printf 'PATH=%s\\n' "$(command -v __opsark_missing_acceptance_probe_72f84 || echo absent)"`;
    const execution = spawnSync("sh", ["-c", supplementalRecoveryAcceptance(unavailable)!.command], { encoding: "utf8" });
    expect(execution.stdout).toContain("PATH=absent");
    expect(execution.status).not.toBe(0);
  });

  it("does not automatically equate changed expected states, targets or queries with historical proof", () => {
    const original = "command -v sh || echo absent; command -v printf || echo absent";
    const { failed, verify, context } = fixture(original);
    const supplement = recoveryVerificationContract(failed).supplementalVerification!;
    verify.command = supplement.command;
    expect(isRelatedRecoveryStep(failed, verify, context)).toBe(true);
    expect(isRelatedRecoveryStep(failed, { ...verify, expected: "Only one tool" }, context)).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, command: verify.command.replace(/command -v printf/g, "command -v ls") }, context)).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, command: verify.command.replace(" &&\ncommand -v printf", "") }, context)).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, command: "command -v sh" }, context)).toBe(false);
    expect(recordedSupplementalAcceptance(verify.command.replace(" &&\ncommand -v printf", ""))).toBeUndefined();
    expect(supplementalRecoveryAcceptance("printf 'healthy'" )).toBeUndefined();
    expect(supplementalRecoveryAcceptance("mktemp -d; command -v sh || echo absent")).toBeUndefined();
  });

  it("does not invent an acceptance condition or lower an independent validation scope", () => {
    const { failed } = fixture("custom-query --format=text");
    expect(recoveryVerificationContract(failed)).toMatchObject({ command: failed.validation, requiresAcceptanceEvidence: true });
    expect(recoveryVerificationContract(failed).supplementalVerification).toBeUndefined();
    failed.validation = "command -v sh || echo absent";
    failed.validationScope = "fresh_login_shell";
    expect(recoveryVerificationContract(failed).supplementalVerification).toBeUndefined();
    expect(recoveryVerificationContract(failed).validationScope).toBe("fresh_login_shell");
  });

  it.each([selectAdjustmentSteps, selectContinuationSteps])("preserves the model's complete recovery proposal", select => {
    const { failed, verify, repair, context } = fixture();
    const duplicate = { ...verify, id: "duplicate" };
    const after = { ...verify, id: "after-repair" };
    expect(select([failed], [verify, duplicate, repair, after], context).map(step => step.id))
      .toEqual([verify.id, duplicate.id, repair.id, after.id]);
  });

  it("requires fresh verification after the latest repair, including stale evidence attached to a later step", () => {
    const { task, failed, verify, repair, context } = fixture();
    observed(verify, context, "", 0, "2026-09-16T00:00:01Z");
    observed(repair, context, "installed", 0, "2026-09-16T00:00:02Z");
    task.plan = [failed, verify, repair];
    expect(hasVerifiedRecovery(failed, verify, task.plan)).toBe(false);
    expect(unresolvedRecoveryBlockers(task)).toContain(failed);
    const stale = { ...verify, id: "post-repair" };
    task.plan.push(stale);
    expect(hasVerifiedRecovery(failed, stale, task.plan)).toBe(false);
    observed(stale, context, "", 0, "2026-09-16T00:00:03Z");
    expect(hasVerifiedRecovery(failed, stale, task.plan)).toBe(true);
    expect(unresolvedRecoveryBlockers(task)).toEqual([]);
  });
});
