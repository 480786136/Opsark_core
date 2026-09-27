import { describe, expect, it } from "vitest";
import { ensureModelRecoveryContext } from "./modelRecovery";

describe("model operation identity", () => {
  it("preserves invalid supplied contexts for Rust rejection instead of silently starting a new budget", () => {
    for (const value of [null, false, "invalid", {}, { operationId: "old", startedAtMs: -1 }]) {
      expect(JSON.parse(ensureModelRecoveryContext(JSON.stringify({ _modelRecovery: value })))._modelRecovery).toEqual(value);
    }
  });

  it("retains legacy free-form context while creating an independent operation", () => {
    const first = JSON.parse(ensureModelRecoveryContext("existing business context"));
    const second = JSON.parse(ensureModelRecoveryContext("existing business context"));
    expect(first.originalContext).toBe("existing business context");
    expect(first._modelRecovery.operationId).not.toBe(second._modelRecovery.operationId);
    expect(JSON.parse(ensureModelRecoveryContext(JSON.stringify(first)))).toEqual(first);
  });
});
