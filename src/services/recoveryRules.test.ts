import { describe, expect, it } from "vitest";
import cases from "../../shared/recovery-cases.json";
import metadataCases from "../../shared/recovery-metadata-cases.json";
import firewallCases from "../../shared/firewall-query-cases.json";
import scopeCases from "../../shared/recovery-repair-scope-cases.json";
import rules from "../../shared/recovery-rules.json";
import { commandMutation, currentRecoveryRepairScope, isReadOnlyFirewallScript, readOnlyPlanProtocol, recoveryMetadataIssue, RecoveryProtocolError, readRecoveryProtocolError, RECOVERY_RULE_VERSION } from "./recoveryRules";

describe("shared Rust/TS recovery policy", () => {
  for (const testCase of firewallCases) {
    it(`firewall read-only policy: ${testCase.name}`, () => {
      expect(isReadOnlyFirewallScript(testCase.command)).toBe(testCase.readonly);
      expect(commandMutation(testCase.command) ?? null).toBe(testCase.mutation);
      if (testCase.mutation) expect(recoveryMetadataIssue({ id: "query", kind: "observe", command: testCase.command }))
        .toMatchObject({ code: "OBSERVE_COMMAND_MUTATION", matchedToken: testCase.mutation });
    });
  }
  for (const testCase of metadataCases) {
    it(testCase.name, () => {
      const issue = recoveryMetadataIssue(testCase.step, 3);
      expect(issue?.code ?? null).toBe(testCase.code);
      if (issue) expect(issue).toMatchObject({ fieldPath: `steps[3].${testCase.field}`,
        allowedRepairPaths: ["OBSERVE_COMMAND_MUTATION", "RECOVERY_DIAGNOSE_MUTATION"].includes(testCase.code ?? "")
          ? [`steps[3].${testCase.field}`] : [], ruleVersion: RECOVERY_RULE_VERSION });
    });
  }
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(commandMutation(testCase.command) ?? null).toBe(testCase.mutation);
      const issue = recoveryMetadataIssue({ id: "next", kind: "observe", command: testCase.command,
        recovery: { failedStepId: "failed", targetContext: "original", purpose: "diagnose" } }, 2);
      if (testCase.mutation === null) expect(issue).toBeUndefined();
      else {
        expect(issue).toMatchObject({ code: "RECOVERY_DIAGNOSE_MUTATION", stepIndex: 2,
          fieldPath: "steps[2].command", matchedToken: testCase.mutation,
          allowedRepairPaths: ["steps[2].command"], ruleVersion: RECOVERY_RULE_VERSION });
        expect(readRecoveryProtocolError(JSON.stringify({ issue }))).toEqual(issue);
        expect(readRecoveryProtocolError(new RecoveryProtocolError(issue!))).toEqual(issue);
      }
    });
  }
  it("does not repair by changing purpose or the shared rule version", () => {
    const step = { id: "next", kind: "observe", command: "true", recovery: { failedStepId: "old", targetContext: "original", purpose: "repair" } };
    expect(recoveryMetadataIssue(step)).toMatchObject({ code: "RECOVERY_KIND_MISMATCH", allowedRepairPaths: [] });
    expect(recoveryMetadataIssue({ ...step, recoveryRuleVersion: 999 })).toMatchObject({ code: "RECOVERY_RULE_VERSION_MISMATCH", allowedRepairPaths: [] });
  });

  it.each(scopeCases)("verifies local authority: $name", testCase => {
    const step = { id: "next", kind: "observe", command: "mktemp -d", action: { type: "shell", command: "mktemp -d" } };
    const diagnostic = { ...recoveryMetadataIssue(step, 2)!, ...testCase.patch };
    expect(currentRecoveryRepairScope(diagnostic, step)).toBe(testCase.allowed);
  });

  it("rejects a no-longer-failing proposal and publishes rules rather than invented capabilities", () => {
    const step = { kind: "observe", command: "mktemp -d" };
    expect(currentRecoveryRepairScope(recoveryMetadataIssue(step)!, { ...step, command: "uname -a" })).toBe(false);
    expect(readOnlyPlanProtocol()).toMatchObject({ ruleVersion: RECOVERY_RULE_VERSION,
      unsupportedShellOperators: rules.shell.unsupportedShellOperators, opaqueInterpreters: rules.shell.opaqueInterpreters,
      safeWriteTargets: rules.shell.safeWriteTargets, maxNestedDepth: rules.shell.maxNestedDepth,
      requiresFullValidation: true, localRepair: rules.localRepairPolicy });
    for (const command of ["cat <<'EOF'\nreadonly text\nEOF", "python3 -B -c 'print(1)'",
      "printf '%s' \"$(touch /tmp/x)\"", "uname -a >/tmp/x", "bash -c 'rm /tmp/x' &"]) {
      expect(commandMutation(command)).toBeDefined();
    }
  });
});
