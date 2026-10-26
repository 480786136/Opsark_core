import type { RuntimeModel } from "@/services/backend";
import type { AiGenerationSettings, ModelProfile } from "@/types";
import { modelIntegrationConfig } from "./modelIntegration";

export function localModelAdapterBase(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}/`;
  } catch { return undefined; }
}

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
    ...(model.requestLifecycleAdapter ? { requestLifecycleAdapter: model.requestLifecycleAdapter } : {}),
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
