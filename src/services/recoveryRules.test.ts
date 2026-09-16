import { describe, expect, it } from "vitest";
import cases from "../../shared/recovery-cases.json";
import metadataCases from "../../shared/recovery-metadata-cases.json";
import { commandMutation, recoveryMetadataIssue, RecoveryProtocolError, readRecoveryProtocolError, RECOVERY_RULE_VERSION } from "./recoveryRules";

describe("shared Rust/TS recovery policy", () => {
  for (const testCase of metadataCases) {
    it(testCase.name, () => {
      const issue = recoveryMetadataIssue(testCase.step, 3);
      expect(issue?.code ?? null).toBe(testCase.code);
      if (issue) expect(issue).toMatchObject({ fieldPath: `steps[3].${testCase.field}`,
        allowedRepairPaths: testCase.code === "OBSERVE_COMMAND_MUTATION" ? ["steps[3].command"] : [], ruleVersion: RECOVERY_RULE_VERSION });
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
});
