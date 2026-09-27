import { describe, expect, it } from "vitest";
import { hasMatchingPresetIdentity, modelPresetConfiguration, modelPresets } from "./modelPresets";
import { validateModelConfiguration } from "./modelCapabilities";

describe("exact endpoint model presets", () => {
  it.each(modelPresets)("declares a documented independent configuration for $id", preset => {
    const model = modelPresetConfiguration(preset.id);
    expect(model.endpoint).toBe("https://api.openai.com/v1");
    expect(model.capabilitiesV2).toMatchObject({ outputModes: { json_object: "supported", json_schema: "supported" }, strictFlag: "required", store: "supported", evidence: { source: "documented" } });
    expect(() => validateModelConfiguration(model, { requireStructured: true })).not.toThrow();
    model.capabilitiesV2!.outputModes.json_schema = "unknown";
    expect(modelPresetConfiguration(preset.id).capabilitiesV2!.outputModes.json_schema).toBe("supported");
  });
  it("never transfers an official preset declaration to a custom URL, alias or other protocol", () => {
    const original = modelPresetConfiguration("openai:gpt-4.1-mini:chat_completions");
    for (const update of [{ endpoint: "https://compatible.example/v1" }, { model: "gpt-4.1-mini-alias" }, { apiProtocol: "responses" as const }]) {
      const model = { ...original, ...update };
      expect(hasMatchingPresetIdentity(model)).toBe(false);
      expect(() => validateModelConfiguration(model, { requireStructured: true })).toThrow("预设能力");
    }
    expect(original.model).toBe("gpt-4.1-mini");
  });
});
