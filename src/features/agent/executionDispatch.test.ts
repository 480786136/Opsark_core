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

  it("rejects a tool forbidden by the active Skill before dispatch", () => {
    const decision = resolveStepDispatch({
      command: 'opsark-tool server.resolve_connection {"host":"gitee.com","port":443}',
    }, [], "call-forbidden", undefined, [], ["server.resolve_connection", "server.connect"]);

    expect(decision).toEqual({
      kind: "invalid",
      error: "当前激活 Skill 禁止调用工具：server.resolve_connection",
    });
  });

  it("rejects a tool that was not exposed to the current planning context", () => {
    const decision = resolveStepDispatch({
      command: 'opsark-tool files.get_structure {"rootPath":"/opt/app"}',
    }, [], "call-hidden", undefined, [], [], ["software.check"]);

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
    if (decision.kind === "invalid") expect(decision.error).toContain("JSON 对象");
  });

  it("rejects server.connect before execution when username or credential reference is missing", () => {
    const decision = resolveStepDispatch({
      command: "opsark-tool server.connect --host 192.168.1.237 --passwordSecretKey TARGET_SSH_PASSWORD",
    }, [], "call-connect-invalid");

    expect(decision).toMatchObject({ kind: "invalid" });
    if (decision.kind === "invalid") {
      expect(decision.error).toContain("同时提供 username 和 passwordSecretKey");
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
