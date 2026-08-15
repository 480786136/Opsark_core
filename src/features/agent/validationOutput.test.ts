import { describe, expect, it } from "vitest";
import {
  appendFirstValidationFailureOutput,
  assembleFinalValidationOutput,
} from "@/features/agent/validationOutput";

describe("validation output", () => {
  it("appends failed and final validation attempts in execution order", () => {
    const afterRetry = appendFirstValidationFailureOutput("main output", "timeout");
    const assembled = assembleFinalValidationOutput(afterRetry, "healthy");

    expect(assembled).toEqual({
      stepOutput: [
        "main output",
        "",
        "--- 独立校验（首次未通过） ---",
        "timeout",
        "",
        "--- 独立校验 ---",
        "healthy",
      ].join("\n"),
      validationOutput: "healthy",
    });
  });

  it("does not change step output when an attempt has no output", () => {
    expect(appendFirstValidationFailureOutput("main output", undefined)).toBe("main output");
    expect(assembleFinalValidationOutput("main output", undefined)).toEqual({
      stepOutput: "main output",
      validationOutput: "",
    });
  });

  it("avoids undefined text and leading blank lines without main output", () => {
    expect(appendFirstValidationFailureOutput(undefined, "connection refused")).toBe(
      "--- 独立校验（首次未通过） ---\nconnection refused",
    );
    expect(assembleFinalValidationOutput(undefined, "active").stepOutput).toBe(
      "--- 独立校验 ---\nactive",
    );
  });
});
