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
      "token=known-value\nurl=https://host/path?password=visible\n\"apiKey\": \"json-visible\"",
      { TOKEN: "known-value" },
    );
    expect(output).not.toContain("known-value");
    expect(output).not.toContain("visible");
    expect(output).not.toContain("json-visible");
    expect(output).toContain("••••••••");
  });

  it("does not globally replace unreferenced short or numeric secrets in system metrics", () => {
    const output = redactExecutionOutput(
      "CentOS Stream 10\nCPU=20\nmodel=i5-14600KF\nMem=958Mi\nroot=87%\ncreatedAt=2026-09-14T22:50:00Z",
      {
        ONE: "1",
        FIVE: "5",
        CPU_COUNT: "20",
        LONG_NUMBER: "20260914",
        DATE_FRAGMENT: "2026-09-14",
      },
    );

    expect(output).toBe(
      "CentOS Stream 10\nCPU=20\nmodel=i5-14600KF\nMem=958Mi\nroot=87%\ncreatedAt=2026-09-14T22:50:00Z",
    );
  });

  it("still redacts short secrets used by the current execution", () => {
    const output = redactExecutionOutput(
      "pin=1\nvalue 1 was accepted",
      { PIN: "1" },
      { exactSecretKeys: ["PIN"] },
    );

    expect(output).not.toContain("1");
    expect(output).toContain("••••••••");
  });

  it("redacts short credentials when they appear in credential-shaped fields", () => {
    const output = redactExecutionOutput(
      "username=root\npassword=1\nCPU=20",
      { PASSWORD: "1", USERNAME: "root", CPU_COUNT: "20" },
    );

    expect(output).toBe("username=••••••••\npassword=••••••••\nCPU=20");
  });

  it("supports a caller-specific redaction marker", () => {
    expect(redactExecutionOutput(
      "token=known-value",
      { TOKEN: "known-value" },
      { marker: "[已脱敏]" },
    )).toBe("token=[已脱敏]");
  });
});
