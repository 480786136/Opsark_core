import { describe, expect, it } from "vitest";
import {
  findSecretKeys,
  mergeSecretPlaceholders,
  redactExecutionOutput,
} from "@/features/agent/secretTool";

describe("secret tool", () => {
  it("finds and merges explicit placeholders", () => {
    const command = "login ${secret.USER} ${secret.PASSWORD}";
    expect(findSecretKeys(command)).toEqual(["USER", "PASSWORD"]);
    expect(mergeSecretPlaceholders(command, { USER: "ops", PASSWORD: "hidden" })).toBe("login ops hidden");
  });

  it("redacts known values and credential-shaped output", () => {
    const output = redactExecutionOutput(
      "token=known-value\nurl=https://host/path?password=visible",
      { TOKEN: "known-value" },
    );
    expect(output).not.toContain("known-value");
    expect(output).not.toContain("visible");
    expect(output).toContain("••••••••");
  });
});
