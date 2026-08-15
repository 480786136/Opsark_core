import { describe, expect, it, vi } from "vitest";
import {
  executeStepCommand,
  executeStepValidation,
} from "@/features/agent/executionRunner";
import type { PlanStep } from "@/types";

describe("execution runner", () => {
  it("redacts streamed and final command output", async () => {
    const chunks: string[] = [];
    const executor = vi.fn(async (_command, _connection, _approved, options) => {
      options?.onProgress?.({ executionId: "exec-1", data: "token-value\n", stream: "stdout" });
      return { output: "$ command\ntoken-value\n[exit: 0]", success: true, simulated: false, exitCode: 0 };
    });

    const result = await executeStepCommand({
      command: "command",
      approvedHighRisk: false,
      executionId: "exec-1",
      secretValues: { TOKEN: "token-value" },
      onProgress: (chunk) => chunks.push(chunk),
    }, executor);

    expect(chunks.join("")).not.toContain("token-value");
    expect(result.output).not.toContain("token-value");
    expect(result.output).toContain("••••••••");
  });

  it("applies the same redaction boundary to validation output", async () => {
    const chunks: string[] = [];
    const step: PlanStep = {
      id: "step-1",
      title: "校验",
      description: "校验输出",
      command: "command",
      risk: "low",
      expected: "成功",
      validation: "check",
      status: "validating",
    };
    const executor = vi.fn(async (_step, _connection, options) => {
      options?.onProgress?.({ executionId: "validation-1", data: "secret-value\n", stream: "stdout" });
      return { passed: true, detail: "ok", output: "secret-value\n[exit: 0]", exitCode: 0 };
    });

    const result = await executeStepValidation({
      step,
      executionId: "validation-1",
      secretValues: { TOKEN: "secret-value" },
      onProgress: (chunk) => chunks.push(chunk),
    }, executor);

    expect(chunks.join("")).not.toContain("secret-value");
    expect(result.output).not.toContain("secret-value");
  });
});
