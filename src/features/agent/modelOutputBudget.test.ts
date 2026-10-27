import { describe, expect, it } from "vitest";
import { directCapabilities, newModelCapabilities, normalizeModelOutputLimit, validateModelConfiguration } from "./modelCapabilities";
import type { ModelProfile } from "@/types";

describe("unknown provider output ceilings", () => {
  it.each(["deepseek", "qwen"] as const)("allows a 30000 budget without inventing a %s ceiling", parameterAdapter => {
    const capabilitiesV2 = { ...newModelCapabilities(), parameterAdapter };
    expect(capabilitiesV2.maxOutputTokens).toBeUndefined();
    expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { outputBudget: 30000 } })).not.toThrow();
    expect(() => validateModelConfiguration({ capabilities: directCapabilities(parameterAdapter), requestParameters: { max_tokens: 30000 } })).not.toThrow();
    expect(() => validateModelConfiguration({ capabilitiesV2 }, { requireStructured: true })).toThrow("结构输出能力");
  });

  it("enforces declared ceilings and requires official gateway ceilings", () => {
    const capabilitiesV2 = { ...newModelCapabilities(), maxOutputTokens: 16384 };
    expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { outputBudget: 30000 } })).toThrow("16384");
    expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { outputBudget: 16384 } })).not.toThrow();
    expect(() => validateModelConfiguration({ capabilitiesV2: { ...newModelCapabilities(), parameterAdapter: "gateway" } })).toThrow();
    for (const maxOutputTokens of [0, -1, NaN, 1000001]) {
      expect(() => validateModelConfiguration({ capabilitiesV2: { ...capabilitiesV2, maxOutputTokens } })).toThrow();
    }
  });

  it("migrates the old unverified 16K default without changing explicit budgets or declarations", () => {
    const model = { id: "existing", capabilities: { ...directCapabilities("deepseek"), maxOutputTokens: 16384 },
      capabilitiesV2: { ...newModelCapabilities(), revision: "custom-unverified-v2", maxOutputTokens: 16384 },
      requestParameters: { outputBudget: 30000 } } as ModelProfile;
    const migrated = normalizeModelOutputLimit(model);
    expect(migrated.capabilitiesV2?.maxOutputTokens).toBeUndefined();
    expect(migrated.capabilities?.maxOutputTokens).toBeUndefined();
    expect(migrated.requestParameters).toEqual({ outputBudget: 30000 });
    expect(model.capabilitiesV2?.maxOutputTokens).toBe(16384);
    expect(normalizeModelOutputLimit(migrated)).toBe(migrated);
    for (const original of [
      { ...model, source: "official" as const },
      { ...model, capabilitiesV2: { ...model.capabilitiesV2!, maxOutputTokens: 32768 } },
      { ...model, capabilitiesV2: { ...model.capabilitiesV2!, revision: "user:123", evidence: { source: "user_declared" as const } } },
    ]) expect(normalizeModelOutputLimit(original)).toBe(original);
  });
});
