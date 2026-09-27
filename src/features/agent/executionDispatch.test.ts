import { describe, expect, it } from "vitest";
import { resolveStepDispatch } from "@/features/agent/executionDispatch";

describe("execution dispatch", () => {
  it.each([
    { command: "id" }, { validation: "true" },
    { validator: { type: "command" as const, command: "", validStates: ["unknown" as const] } },
    { sessionContextChange: { cwd: "/tmp" } },
  ])("rejects all Shell-only tool fields at dispatch: %j", fields => {
    const decision = resolveStepDispatch({ command: "", validation: "",
      action: { type: "tool", toolId: "server.resolve_connection", arguments: { host: "host.example" } },
      ...fields,
    }, [], "invalid-tool");
    expect(decision).toMatchObject({ kind: "invalid", error: expect.stringContaining("工具步骤不能夹带 Shell") });
  });

  it("routes a valid model tool command", () => {
    const decision = resolveStepDispatch({
      command: "", action: { type: "tool" as const, toolId: "files.get_structure", arguments: {"rootPath":"/opt/app"} },
    }, [], "call-1");

    expect(decision).toEqual({
      kind: "tool",
      call: {
        id: "call-1",
        toolId: "files.get_structure",
        arguments: { rootPath: "/opt/app", maxDepth: 4, maxNodes: 600, includeHidden: false },
      },
    });
  });

  it("dispatches a connection tool when it is in the current capability directory", () => {
    const decision = resolveStepDispatch({
      command: "", action: { type: "tool" as const, toolId: "server.resolve_connection", arguments: {"host":"gitee.com","port":443} },
    }, [], "call-forbidden", undefined, [], ["server.resolve_connection", "server.connect"]);

    expect(decision).toMatchObject({ kind: "tool", call: { toolId: "server.resolve_connection" } });
  });

  it("rejects a tool that was not exposed to the current planning context", () => {
    const decision = resolveStepDispatch({
      command: "", action: { type: "tool" as const, toolId: "files.get_structure", arguments: {"rootPath":"/opt/app"} },
    }, [], "call-hidden", undefined, [], ["software.check"]);

    expect(decision).toEqual({
      kind: "invalid",
      error: "当前规划上下文未开放工具：files.get_structure",
    });
  });

  it("returns a protocol error instead of throwing", () => {
    const decision = resolveStepDispatch({
      command: "opsark-tool files.get_structure []",
    }, [], "call-2");

    expect(decision.kind).toBe("invalid");
    if (decision.kind === "invalid") expect(decision.error).toContain("TOOL_IN_SHELL");
  });

  it("rejects server.connect before execution when username or credential reference is missing", () => {
    const decision = resolveStepDispatch({
      command: "opsark-tool server.connect --host 192.168.1.237 --passwordSecretKey TARGET_SSH_PASSWORD",
    }, [], "call-connect-invalid");

    expect(decision).toMatchObject({ kind: "invalid" });
    if (decision.kind === "invalid") {
      expect(decision.error).toContain("TOOL_IN_SHELL");
    }
  });

  it("selects the first unconfirmed secret", () => {
    const decision = resolveStepDispatch({
      command: "deploy --user ${secret.USER} --token ${secret.TOKEN}",
    }, ["USER"], "call-3");

    expect(decision).toEqual({ kind: "await-secret", key: "TOKEN" });
  });

  it("rejects shell modifiers inside secret placeholders before execution", () => {
    const decision = resolveStepDispatch({
      command: "ssh -i ${secret.SSH_PRIVATE_KEY:-} host",
    }, [], "call-invalid-secret");

    expect(decision).toMatchObject({ kind: "invalid" });
    if (decision.kind === "invalid") expect(decision.error).toContain("仅支持 ${secret.NAME}");
  });

  it("routes an executable command when all secrets are confirmed", () => {
    const decision = resolveStepDispatch({
      command: "deploy --token ${secret.TOKEN}",
    }, ["TOKEN"], "call-4");

    expect(decision).toEqual({ kind: "command" });
  });

  it("fails closed instead of injecting a user_action into the user shell", () => {
    expect(resolveStepDispatch({
      command: "source ~/.bashrc",
      executionScope: "user_action",
    }, [], "call-user-action")).toEqual({
      kind: "invalid",
      error: "user_action 只能由用户在自己的 Shell 中完成，Agent 拒绝自动执行",
    });
  });

  it("reuses an available server secret across tasks and checks validation placeholders", () => {
    expect(resolveStepDispatch({
      command: "deploy",
      validation: "verify --token ${secret.SAVED_TOKEN}",
    }, [], "call-server-secret", undefined, ["SAVED_TOKEN"]))
      .toEqual({ kind: "command" });
  });
});
