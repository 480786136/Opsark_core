import { describe, expect, it, vi } from "vitest";
import { executeToolCall, parseToolCommand, parseUserInputArguments } from "@/features/tools/toolExecutor";
import { resolveToolRegistry } from "@/features/tools/toolRegistry";

describe("tool executor", () => {
  it("parses the model-facing tool command protocol", () => {
    expect(parseToolCommand(
      'opsark-tool files.get_structure {"rootPath":"/opt/app","maxDepth":4}',
      "call-1",
    )).toEqual({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", maxDepth: 4 },
    });
    expect(parseToolCommand("uname -a", "call-2")).toBeUndefined();
    expect(() => parseToolCommand("opsark-tool files.get_structure []", "call-3")).toThrow("JSON 对象");
  });

  it("routes a validated file structure call", async () => {
    const getRemoteFileStructure = vi.fn().mockResolvedValue({
      rootPath: "/opt/app",
      nodes: [],
      excludedDirectories: [],
      totalNodes: 0,
      maxDepthReached: false,
      truncated: false,
      warnings: [],
    });

    const result = await executeToolCall({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", excludeDirectories: ["uploads"] },
    }, resolveToolRegistry([]), { getRemoteFileStructure });

    expect(result.success).toBe(true);
    expect(getRemoteFileStructure).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/opt/app",
      excludeDirectories: ["uploads"],
    }));
  });

  it("requires a readable name and purpose for every user input parameter", async () => {
    const request = parseUserInputArguments({
      title: "补充部署信息",
      description: "用于生成部署计划",
      fields: [{
        key: "targetPort",
        label: "服务端口",
        description: "应用启动后对外监听的 TCP 端口",
        type: "number",
        required: true,
      }],
    });
    expect(request.fields[0]).toMatchObject({ label: "服务端口", required: true });
    expect(() => parseUserInputArguments({
      title: "补充信息",
      fields: [{ key: "token", label: "令牌", type: "password", required: true }],
    })).toThrow("用途说明");

    const requestUserInput = vi.fn().mockResolvedValue({ title: request.title, values: { targetPort: 8080 } });
    const result = await executeToolCall({
      id: "input-1",
      toolId: "user.request_input",
      arguments: request as unknown as Record<string, unknown>,
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), requestUserInput });
    expect(result.success).toBe(true);
    expect(requestUserInput).toHaveBeenCalledWith(request);
  });

  it("routes a validated cross-server transfer without exposing credentials", async () => {
    const transferFileBetweenServers = vi.fn().mockResolvedValue({
      sourcePath: "/root/build/app.rpm",
      targetPath: "/root/app.rpm",
      transferredBytes: 42,
      sha256: "abc",
      targetServerId: "server-b",
    });
    const result = await executeToolCall({
      id: "transfer-1",
      toolId: "files.transfer_between_servers",
      arguments: {
        sourcePath: "/root/build/app.rpm",
        targetServer: "10.0.0.2",
        targetPath: "/root/app.rpm",
      },
    }, resolveToolRegistry([]), {
      getRemoteFileStructure: vi.fn(),
      transferFileBetweenServers,
    });

    expect(result.success).toBe(true);
    expect(transferFileBetweenServers).toHaveBeenCalledWith(expect.objectContaining({
      targetServer: "10.0.0.2",
      overwrite: undefined,
    }));
  });

  it("routes a native managed SSH connection by secret key", async () => {
    const connectServer = vi.fn().mockResolvedValue({
      serverId: "server-new",
      name: "192.168.1.23",
      host: "192.168.1.23",
      port: 22,
      username: "root",
      connected: true,
      info: { os: "Linux" },
    });
    const result = await executeToolCall({
      id: "connect-1",
      toolId: "server.connect",
      arguments: {
        host: "192.168.1.23",
        username: "root",
        passwordSecretKey: "ssh_password",
      },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), connectServer });

    expect(result.success).toBe(true);
    expect(connectServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "192.168.1.23",
      port: 22,
      username: "root",
      passwordSecretKey: "SSH_PASSWORD",
    }));
    expect(JSON.stringify(result.data)).not.toContain("password");
  });

  it("resolves a target-scoped managed credential reference without exposing its value", async () => {
    const resolveServerConnection = vi.fn().mockResolvedValue({
      found: true,
      serverId: "target-1",
      host: "192.168.1.23",
      port: 22,
      username: "root",
      credentialAvailable: true,
      credentialRef: "managed-server:target-1",
    });
    const result = await executeToolCall({
      id: "lookup-1",
      toolId: "server.resolve_connection",
      arguments: { host: "192.168.1.23" },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), resolveServerConnection });

    expect(result.success).toBe(true);
    expect(resolveServerConnection).toHaveBeenCalledWith({ host: "192.168.1.23", port: 22 });
    expect(JSON.stringify(result.data)).not.toContain("password");
  });

  it("rejects disabled tools and invalid arguments", async () => {
    const dependency = { getRemoteFileStructure: vi.fn() };
    const disabled = resolveToolRegistry([{ id: "files.get_structure", enabled: false }]);
    const disabledResult = await executeToolCall({
      id: "call-2",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app" },
    }, disabled, dependency);
    const invalidResult = await executeToolCall({
      id: "call-3",
      toolId: "files.get_structure",
      arguments: { rootPath: "relative" },
    }, resolveToolRegistry([]), dependency);

    expect(disabledResult.error?.code).toBe("TOOL_DISABLED");
    expect(invalidResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(dependency.getRemoteFileStructure).not.toHaveBeenCalled();
  });
});
