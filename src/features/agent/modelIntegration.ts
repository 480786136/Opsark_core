import type { ModelIntegration } from "@/types";

/** A contract update permits an explicit retry of old format failures only. */
export const MODEL_PLAN_CONTRACT_REVISION = "2026-10-03-output-recovery-v8";

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
