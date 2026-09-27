import type { ModelApiProtocol, ModelCapabilitiesV2, ModelProfile } from "@/types";
import { executionDigest } from "./planPreparation";

const OPENAI_ENDPOINT = "https://api.openai.com/v1";
export const modelPresets = (["gpt-4.1-mini", "gpt-4.1"] as const).flatMap(model =>
  (["chat_completions", "responses"] as const).map(apiProtocol => ({
    id: `openai:${model}:${apiProtocol}`, model, apiProtocol, endpoint: OPENAI_ENDPOINT,
    label: `OpenAI · ${model} · ${apiProtocol === "responses" ? "Responses" : "Chat Completions"}`,
    documentation: `https://developers.openai.com/api/docs/models/${model}`,
  })));

/** A preset describes one endpoint + exact model ID + selected protocol, never a brand. */
export function presetIdentity(model: { endpoint?: string; model?: string; apiProtocol?: ModelApiProtocol }) {
  return executionDigest({ endpoint: model.endpoint?.replace(/\/$/, ""), model: model.model, apiProtocol: model.apiProtocol });
}

export function modelPresetConfiguration(id: string): Pick<ModelProfile, "endpoint" | "model" | "apiProtocol" | "outputPolicy" | "capabilitiesV2"> {
  const preset = modelPresets.find(item => item.id === id);
  if (!preset) throw new Error("未知的模型接入预设");
  const capabilitiesV2: ModelCapabilitiesV2 = {
    version: "model-capabilities@2", revision: `preset:${preset.id}:1`,
    supportedProtocols: ["chat_completions", "responses"], preferredProtocol: preset.apiProtocol,
    outputModes: { json_object: "supported", json_schema: "supported" }, parameterAdapter: "openai",
    tokenField: preset.apiProtocol === "responses" ? "max_output_tokens" : "max_completion_tokens",
    defaultOutputTokens: 5000, maxOutputTokens: 32768, budgetSemantics: "total_output",
    strictFlag: "required", store: "supported",
    parameterRules: { reasoningEfforts: [], thinkingEnabled: false, frequencyPenalty: preset.apiProtocol === "chat_completions",
      temperature: "supported", topP: "supported", presencePenalty: preset.apiProtocol === "chat_completions" ? "supported" : "unsupported" },
    evidence: { source: "documented", configFingerprint: presetIdentity(preset) },
  };
  return { endpoint: preset.endpoint, model: preset.model, apiProtocol: preset.apiProtocol, outputPolicy: "auto", capabilitiesV2 };
}

export function hasMatchingPresetIdentity(model: Pick<ModelProfile, "capabilitiesV2"> & { endpoint?: string; model?: string; apiProtocol?: ModelApiProtocol }) {
  return !model.capabilitiesV2?.revision.startsWith("preset:")
    || model.capabilitiesV2.evidence.configFingerprint === presetIdentity(model);
}
