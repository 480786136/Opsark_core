import type { RuntimeModel } from "@/services/backend";
import type { AiGenerationSettings, ModelProfile } from "@/types";

/** Creates backend model parameters only when both profile and credential are available. */
export function createRuntimeModel(
  model: ModelProfile | undefined,
  apiKey: string | undefined,
  context: string,
  generationSettings?: AiGenerationSettings,
): RuntimeModel | undefined {
  if (!model || !apiKey) return undefined;
  return {
    apiKey,
    endpoint: model.endpoint,
    model: model.model,
    context,
    generationSettings,
  };
}

