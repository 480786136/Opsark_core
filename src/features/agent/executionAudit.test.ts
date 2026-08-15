import { describe, expect, it } from "vitest";
import {
  buildCommandResultAudit,
  buildValidationResultAudit,
} from "@/features/agent/executionAudit";

const scope = { stepTitle: "部署", serverId: "server-1", taskId: "task-1" };

describe("execution audit", () => {
  it("uses placeholder-safe command text", () => {
    const event = buildCommandResultAudit({
      ...scope,
      commandTemplate: "deploy --token ${secret.TOKEN}",
      output: "token=••••••••",
      success: true,
    });

    expect(event.level).toBe("success");
    expect(event.detail).toContain("${secret.TOKEN}");
    expect(event.detail).not.toContain("runtime-token");
  });

  it("marks accepted unhealthy evidence as warning", () => {
    const event = buildValidationResultAudit({
      ...scope,
      accepted: true,
      validator: { type: "http", command: "curl", validStates: ["healthy"] },
      result: {
        executionStatus: "success",
        observationStatus: "unhealthy",
        facts: { httpStatus: 500 },
        warnings: ["HTTP 500"],
        evidenceIds: ["evidence-1"],
      },
      validationTemplate: "curl --header ${secret.TOKEN}",
      validationOutput: "HTTP/1.1 500",
    });

    expect(event.level).toBe("warning");
    expect(JSON.parse(event.detail)).toMatchObject({
      validationCommand: "curl --header ${secret.TOKEN}",
      result: { observationStatus: "unhealthy" },
    });
  });

  it("marks rejected evidence as error", () => {
    const event = buildValidationResultAudit({
      ...scope,
      accepted: false,
      result: {
        executionStatus: "success",
        observationStatus: "unknown",
        facts: {},
        warnings: [],
        evidenceIds: [],
      },
      validationTemplate: "true",
      validationOutput: "",
    });

    expect(event.level).toBe("error");
  });
});

