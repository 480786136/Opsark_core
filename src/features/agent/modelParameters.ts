import type { ModelRequestParameters } from "@/types";

export const numericParameters = [
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
      || (field.key.includes("tokens") && !Number.isInteger(value)))) throw new Error(`${field.key}: ${field.min} – ${field.max}`);
  }
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) throw new Error("max_tokens / max_completion_tokens: choose one");
  if (input.reasoning_effort && !["low", "medium", "high"].includes(input.reasoning_effort)) throw new Error("Invalid reasoning_effort");
  if (input.thinking && !["default", "enabled", "disabled"].includes(input.thinking)) throw new Error("Invalid thinking");
  return input;
}

export function parameterContext(context: string, input?: ModelRequestParameters) {
  const parameters = validateRequestParameters(input);
  if (!parameters || !Object.keys(parameters).length) return context;
  return JSON.stringify({ ...JSON.parse(context || "{}"), _requestParameters: parameters });
}
