import type { RuntimeModel } from "@/services/backend";
import type { AiGenerationSettings, ModelProfile } from "@/types";
import { modelIntegrationConfig } from "./modelIntegration";

/** Creates backend model parameters only when both profile and credential are available. */
export function createRuntimeModel(
  model: ModelProfile | undefined,
  apiKey: string | undefined,
  context: string,
  generationSettings?: AiGenerationSettings,
  logContext?: Record<string, unknown>,
): RuntimeModel | undefined {
  if (!model || !apiKey) return undefined;
  return {
    ...modelIntegrationConfig(model),
    capabilities: model.capabilities,
    requestParameters: model.requestParameters,
    timeoutSeconds: model.timeoutSeconds,
    apiKey,
    endpoint: model.endpoint,
    model: model.model,
    context,
    generationSettings,
    ...(logContext ? { logContext } : {}),
  };
}
