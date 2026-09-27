import { describe, expect, it } from "vitest";
import { directCapabilities, effectiveModelOutput, modelConfigurationFingerprint, newModelCapabilities, parameterRules, validateCapabilities, validateCapabilitiesV2, validateModelConfiguration } from "./modelCapabilities";
import { parameterContext } from "./modelParameters";
import type { ModelProfile } from "@/types";

describe("model capabilities", () => {
  it("validates capability-specific values before saving, without discarding overrides", () => {
    const model = { capabilities: directCapabilities("qwen"), requestParameters: { thinking: "enabled" as const } };
    expect(() => validateModelConfiguration(model)).toThrow("thinking");
    expect(model.requestParameters.thinking).toBe("enabled");
    expect(() => validateModelConfiguration({ capabilities: directCapabilities("deepseek"), requestParameters: { reasoning_effort: "medium" } })).toThrow("reasoning_effort");
    expect(() => validateModelConfiguration({ capabilities: directCapabilities("portable"), requestParameters: { max_tokens: 20000 } })).toThrow("16384");
    expect(() => validateModelConfiguration({ capabilities: { ...directCapabilities("portable"), parameterAdapter: "gateway", parameterRules: { reasoningEfforts: [], thinkingEnabled: false, frequencyPenalty: true } }, requestParameters: { reasoning_effort: "high" } })).toThrow("reasoning_effort");
  });
  it("uses explicit adapters instead of guessing from endpoints", () => {
    for (const adapter of ["portable", "deepseek", "qwen", "openai"] as const) {
      const capabilities = directCapabilities(adapter);
      expect(() => validateCapabilities(capabilities)).not.toThrow();
      expect(capabilities.structuredOutput).toBe(adapter === "openai" ? "json_schema" : "json_object");
      expect(capabilities.tokenField).toBe(adapter === "openai" ? "max_completion_tokens" : "max_tokens");
    }
  });
  it("preserves evidence while carrying private compatibility settings", () => {
    const capabilities = directCapabilities("qwen");
    const context = { evidence: { id: "evidence-1" } };
    expect(JSON.parse(parameterContext(JSON.stringify(context), { max_tokens: 1234 }, capabilities))).toEqual({ ...context,
      _requestParameters: { max_tokens: 1234 }, _modelCapabilities: capabilities });
    expect(context).toEqual({ evidence: { id: "evidence-1" } });
  });
  it("rejects unimplemented protocols and inconsistent budgets", () => {
    const caps = directCapabilities("portable");
    expect(() => validateCapabilities({ ...caps, maxOutputTokens: 1 })).toThrow();
    expect(() => validateCapabilities({ ...caps, version: "x".repeat(81) })).toThrow();
  });
  it("keeps unknown V2 output and strict support unconfirmed even with a known adapter", () => {
    for (const parameterAdapter of ["openai", "deepseek", "qwen"] as const) {
      const capabilitiesV2 = { ...newModelCapabilities(), parameterAdapter };
      expect(capabilitiesV2.strictFlag).toBeUndefined();
      expect(effectiveModelOutput({ capabilitiesV2 })).toBe("unknown");
      expect(parameterRules(capabilitiesV2)).toBeUndefined();
      expect(() => validateModelConfiguration({ capabilitiesV2 }, { requireStructured: true })).toThrow("结构输出能力");
      for (const requestParameters of [{ reasoning_effort: "low" }, { frequency_penalty: 0 }, { thinking: "enabled" as const }, { temperature: 0 }]) {
        expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters })).toThrow();
      }
    }
    const capabilitiesV2 = newModelCapabilities();
    capabilitiesV2.outputModes.json_schema = "supported";
    expect(() => validateModelConfiguration({ capabilitiesV2, outputPolicy: "require_schema" }, { requireStructured: true })).not.toThrow();
    expect(capabilitiesV2.strictFlag).toBeUndefined();
  });
  it("uses the same revision and reasoning limits as the Rust contract", () => {
    const capabilitiesV2 = newModelCapabilities();
    capabilitiesV2.revision = "r".repeat(160);
    capabilitiesV2.parameterRules = { reasoningEfforts: Array.from({ length: 16 }, (_, n) => `level_${n}`), thinkingEnabled: false, frequencyPenalty: false };
    expect(() => validateCapabilitiesV2(capabilitiesV2)).not.toThrow();
    capabilitiesV2.revision += "r";
    expect(() => validateCapabilitiesV2(capabilitiesV2)).toThrow();
    capabilitiesV2.revision = "revision";
    capabilitiesV2.parameterRules.reasoningEfforts.push("extra");
    expect(() => validateCapabilitiesV2(capabilitiesV2)).toThrow();
    capabilitiesV2.parameterRules.reasoningEfforts = ["a".repeat(33)];
    expect(() => validateCapabilitiesV2(capabilitiesV2)).toThrow();
  });
  it("invalidates verification for request changes and credentials but not display names", () => {
    const model = { endpoint: "https://example.test/v1", model: "custom", name: "Before", capabilitiesV2: newModelCapabilities() } as ModelProfile;
    const initial = modelConfigurationFingerprint(model, "key-one");
    expect(modelConfigurationFingerprint({ ...model, name: "After" }, "key-one")).toBe(initial);
    expect(modelConfigurationFingerprint(model, "key-two")).not.toBe(initial);
    expect(modelConfigurationFingerprint({ ...model, apiProtocol: "responses" }, "key-one")).not.toBe(initial);
    expect(modelConfigurationFingerprint({ ...model, requestParameters: { outputBudget: 1000 } }, "key-one")).not.toBe(initial);
  });
  it("checks explicitly selected DeepSeek adapter parameter combinations without guessing gateway behavior", () => {
    const capabilitiesV2 = { ...newModelCapabilities(), parameterAdapter: "deepseek" as const,
      supportedProtocols: ["chat_completions", "responses"] as ("chat_completions" | "responses")[],
      parameterRules: { reasoningEfforts: ["none", "low", "high", "medium", "xhigh"], thinkingEnabled: true, frequencyPenalty: true,
        temperature: "supported" as const, topP: "supported" as const, presencePenalty: "supported" as const } };
    for (const thinking of [{ thinking: "enabled" as const }, { thinking: "default" as const }, { reasoning_effort: "high" }]) {
      for (const penalty of [{ temperature: 0 }, { presence_penalty: 0 }, { frequency_penalty: 0 }]) {
        expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { ...thinking, ...penalty } })).toThrow("思考模式");
      }
      expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { ...thinking, top_p: 0.94 } })).toThrow("top_p");
      expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { ...thinking, top_p: 0.95 } })).not.toThrow();
      expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { ...thinking, top_p: 1 } })).not.toThrow();
    }
    expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { top_p: 1, thinking: "disabled" } })).toThrow("top_p");
    for (const reasoning_effort of ["none", "medium", "xhigh"]) {
      expect(() => validateModelConfiguration({ capabilitiesV2, requestParameters: { reasoning_effort } })).toThrow("原意");
    }
    expect(() => validateModelConfiguration({ capabilitiesV2, apiProtocol: "responses" })).toThrow("Token");
    const responsesCaps = { ...capabilitiesV2, tokenField: "max_output_tokens" as const, preferredProtocol: "responses" as const };
    expect(() => validateModelConfiguration({ capabilitiesV2: responsesCaps, apiProtocol: "responses", requestParameters: { reasoning_effort: "none", temperature: 0.5 } })).not.toThrow();
    expect(() => validateModelConfiguration({ capabilitiesV2: responsesCaps, apiProtocol: "responses", requestParameters: { reasoning_effort: "none", thinking: "disabled", temperature: 0.5 } })).toThrow();
    expect(() => validateModelConfiguration({ capabilitiesV2: responsesCaps, apiProtocol: "responses", requestParameters: { reasoning_effort: "none", top_p: 0.95 } })).toThrow("top_p");
    expect(() => validateModelConfiguration({ capabilitiesV2: { ...capabilitiesV2, parameterAdapter: "gateway" },
      requestParameters: { thinking: "enabled", temperature: 0 } })).not.toThrow();
  });
});
