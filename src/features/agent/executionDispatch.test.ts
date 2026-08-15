import { describe, expect, it } from "vitest";
import { resolveStepDispatch } from "@/features/agent/executionDispatch";

describe("execution dispatch", () => {
  it("routes a valid model tool command", () => {
    const decision = resolveStepDispatch({
      command: 'opsark-tool files.get_structure {"rootPath":"/opt/app"}',
    }, [], "call-1");

    expect(decision).toEqual({
      kind: "tool",
      call: {
        id: "call-1",
        toolId: "files.get_structure",
        arguments: { rootPath: "/opt/app" },
      },
    });
  });

  it("returns a protocol error instead of throwing", () => {
    const decision = resolveStepDispatch({
      command: "opsark-tool files.get_structure []",
    }, [], "call-2");

    expect(decision.kind).toBe("invalid");
    if (decision.kind === "invalid") expect(decision.error).toContain("JSON 对象");
  });

  it("selects the first unconfirmed secret", () => {
    const decision = resolveStepDispatch({
      command: "deploy --user ${secret.USER} --token ${secret.TOKEN}",
    }, ["USER"], "call-3");

    expect(decision).toEqual({ kind: "await-secret", key: "TOKEN" });
  });

  it("routes an executable command when all secrets are confirmed", () => {
    const decision = resolveStepDispatch({
      command: "deploy --token ${secret.TOKEN}",
    }, ["TOKEN"], "call-4");

    expect(decision).toEqual({ kind: "command" });
  });
});

