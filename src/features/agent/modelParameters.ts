import type { ModelIntegration, ModelRequestParameters } from "@/types";

export const numericParameters = [
  { key: "outputBudget", min: 1, max: 1000000, step: 256 },
  { key: "temperature", min: 0, max: 2, step: 0.1 },
  { key: "top_p", min: 0, max: 1, step: 0.05 },
  { key: "max_tokens", min: 1, max: 1000000, step: 256 },
  { key: "max_completion_tokens", min: 1, max: 1000000, step: 256 },
  { key: "frequency_penalty", min: -2, max: 2, step: 0.1 },
  { key: "presence_penalty", min: -2, max: 2, step: 0.1 },
] as const;

export function validateRequestParameters(input?: ModelRequestParameters): ModelRequestParameters | undefined {
  if (!input) return undefined;
  for (const field of numericParameters) {
    const value = input[field.key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max
      || ((field.key.includes("tokens") || field.key === "outputBudget") && !Number.isInteger(value)))) throw new Error(`${field.key}: ${field.min} – ${field.max}`);
  }
  if ([input.outputBudget, input.max_tokens, input.max_completion_tokens].filter(value => value !== undefined).length > 1) throw new Error("outputBudget / max_tokens / max_completion_tokens: choose one");
  if (input.reasoning_effort !== undefined && (typeof input.reasoning_effort !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(input.reasoning_effort))) throw new Error("Invalid reasoning_effort");
  if (input.thinking && !["default", "enabled", "disabled"].includes(input.thinking)) throw new Error("Invalid thinking");
  return input;
}

export function parameterContext(context: string, input?: ModelRequestParameters, capabilities?: import("@/types").ModelCapabilities, integration?: ModelIntegration) {
  const parameters = validateRequestParameters(input);
  const configured = integration && (integration.apiProtocol || integration.outputPolicy || integration.capabilitiesV2);
  if ((!parameters || !Object.keys(parameters).length) && !capabilities && !configured) return context;
  return JSON.stringify({ ...JSON.parse(context || "{}"), ...(parameters ? { _requestParameters: parameters } : {}),
    ...(capabilities ? { _modelCapabilities: capabilities } : {}), ...(configured ? { _modelIntegration: integration } : {}) });
}
