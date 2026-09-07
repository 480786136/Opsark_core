import type { RuntimeConnection, RuntimeModel } from "@/services/backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import { normalizeSecretPlaceholders } from "@/features/agent/planNormalizer";
import { mergeSecretPlaceholders } from "@/features/agent/secretTool";
import type { ModelProfile, PlanStep, ServerProfile } from "@/types";

export interface PrepareStepExecutionInput {
  step: Pick<PlanStep, "command" | "validation">;
  server?: ServerProfile;
  serverPassword?: string;
  model?: ModelProfile;
  modelApiKey?: string;
  secretValues: Record<string, string>;
}

export interface PreparedStepExecution {
  commandTemplate: string;
  validationTemplate: string;
  resolvedCommand: string;
  resolvedValidation: string;
  connection?: RuntimeConnection;
  runtimeModel?: RuntimeModel;
}

/**
 * Builds execution-only values while preserving placeholder templates for UI and
 * audit use. Resolved secrets must be passed only to backend execution boundaries.
 */
export function prepareStepExecution(
  input: PrepareStepExecutionInput,
): PreparedStepExecution {
  const commandTemplate = normalizeSecretPlaceholders(input.step.command);
  const validationTemplate = normalizeSecretPlaceholders(input.step.validation);
  const connection = input.server && input.serverPassword
    ? {
        host: input.server.host,
        port: input.server.port,
        username: input.server.username,
        password: input.serverPassword,
      }
    : undefined;
  return {
    commandTemplate,
    validationTemplate,
    resolvedCommand: mergeSecretPlaceholders(commandTemplate, input.secretValues),
    resolvedValidation: mergeSecretPlaceholders(validationTemplate, input.secretValues),
    connection,
    runtimeModel: createRuntimeModel(input.model, input.modelApiKey, ""),
  };
}

