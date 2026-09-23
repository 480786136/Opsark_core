import { describe, expect, it } from "vitest";
import { assertShellToolBoundary } from "./toolShellBoundary";
import { resolveStepDispatch } from "@/features/agent/executionDispatch";
import { normalizePlanPreconditions } from "@/features/agent/planNormalizer";
import type { PlanStep } from "@/types";

const tool = 'opsark-tool files.get_structure {"rootPath":"/opt/report"}';
const step = (command: string, validation = ""): PlanStep => ({ id: "step", kind: "observe", title: "inspect",
  description: "inspect", command, validation, expected: "observe", risk: "low", status: "pending" });

describe("tool/Shell execution boundary", () => {
  it.each([
    `set -o pipefail\ns1=0\n${tool} || s1=$?\nexit "$s1"`,
    `pwd; ${tool}`, `if test -d /opt; then ${tool}; fi`,
    `printf x | ${tool}`, `X=1 ${tool}`, `sudo ${tool}`, `env X=1 ${tool}`,
    `bash -c '${tool}'`, `echo "$(${tool})"`, `X=$(${tool})`,
    `echo \`${tool}\``, `"opsark-tool" files.get_structure '{}'`,
  ])("rejects embedded invocation before normalization and dispatch: %s", command => {
    expect(() => normalizePlanPreconditions([step(command)])).toThrow("TOOL_IN_SHELL");
    expect(resolveStepDispatch(step(command), [], "call")).toMatchObject({ kind: "invalid", error: expect.stringContaining("TOOL_IN_SHELL") });
  });
  it.each(["echo 'opsark-tool is a protocol'", "# opsark-tool files.get_structure {}\npwd", "grep 'opsark-tool' README.md", "printf '%s' opsark-tool"])("allows non-executed text: %s", command => {
    expect(() => assertShellToolBoundary(command)).not.toThrow();
  });
  it("keeps atomic tools valid but prohibits tools in postcondition Shells", () => {
    expect(normalizePlanPreconditions([step(tool, "true")])).toHaveLength(1);
    expect(resolveStepDispatch(step(tool, "true"), [], "call").kind).toBe("tool");
    expect(() => normalizePlanPreconditions([{ ...step("touch /tmp/result", tool), kind: "change" }])).toThrow("TOOL_IN_SHELL");
    expect(resolveStepDispatch(step("pwd", tool), [], "call").kind).toBe("invalid");
  });
});
