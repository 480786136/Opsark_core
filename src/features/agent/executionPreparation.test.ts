import { describe, expect, it } from "vitest";
import { prepareStepExecution } from "@/features/agent/executionPreparation";
import type { ModelProfile, ServerProfile } from "@/types";

const server: ServerProfile = {
  id: "server-1",
  name: "server",
  host: "example.invalid",
  port: 22,
  username: "ops",
  group: "test",
  status: "online",
  environment: [],
  info: { os: "Linux", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
  createdAt: "now",
};

const model: ModelProfile = {
  id: "model-1",
  name: "model",
  provider: "Remote",
  model: "model-v1",
  endpoint: "https://model.invalid",
  enabled: true,
  hasApiKey: true,
};

describe("execution preparation", () => {
  it("preserves templates while resolving execution-only secrets", () => {
    const prepared = prepareStepExecution({
      step: {
        command: "deploy --token \\${secret.TOKEN}",
        validation: "check --token ${secret.TOKEN}",
      },
      server,
      serverPassword: "ssh-password",
      model,
      modelApiKey: "model-key",
      secretValues: { TOKEN: "runtime-token" },
    });

    expect(prepared.commandTemplate).toBe("deploy --token ${secret.TOKEN}");
    expect(prepared.validationTemplate).toBe("check --token ${secret.TOKEN}");
    expect(prepared.resolvedCommand).toBe("deploy --token runtime-token");
    expect(prepared.resolvedValidation).toBe("check --token runtime-token");
    expect(prepared.connection).toMatchObject({ username: "ops", password: "ssh-password" });
    expect(prepared.runtimeModel).toMatchObject({ apiKey: "model-key", model: "model-v1" });
  });

  it("does not create connection or runtime model without credentials", () => {
    const prepared = prepareStepExecution({
      step: { command: "pwd", validation: "true" },
      server,
      model,
      secretValues: {},
    });

    expect(prepared.connection).toBeUndefined();
    expect(prepared.runtimeModel).toBeUndefined();
  });
});

