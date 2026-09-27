import type { ModelIntegration } from "@/types";

/** Only protocol metadata crosses the model boundary; credentials and profile UI state never do. */
export function modelIntegrationConfig(model: ModelIntegration): ModelIntegration | undefined {
  const { apiProtocol, outputPolicy, capabilitiesV2 } = model;
  if (!apiProtocol && !outputPolicy && !capabilitiesV2) return undefined;
  return {
    ...(apiProtocol ? { apiProtocol } : {}),
    ...(outputPolicy ? { outputPolicy } : {}),
    ...(capabilitiesV2 ? { capabilitiesV2 } : {}),
  };
}
