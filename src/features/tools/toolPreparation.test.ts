import { describe, expect, it, vi } from "vitest";
import type { ServerProfile, StepAction } from "@/types";
import { defaultToolCatalog } from "./toolCatalog";
import { bindPreparedToolTargets, effectiveToolSemanticContract, prepareFinalToolArguments, resolveUniqueServer, resolveUniqueServerEndpoint } from "./toolPreparation";
import { executeToolCall, validatePreparedToolArguments } from "./toolExecutor";
import { ToolExecutionError } from "./toolFailure";

const server = (id: string, host = `${id}.example`, username = "root"): ServerProfile => ({
  id, name: id, host, port: 22, username, group: "", status: "online", environment: [], createdAt: "",
  info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" },
});
const tool = (id: string) => defaultToolCatalog.find(item => item.id === id)!;
const action = (toolId: string, args: Record<string, unknown>): Extract<StepAction, { type: "tool" }> => ({ type: "tool", toolId, arguments: args });

describe("J1 prepared tools", () => {
  it("captures every adapter default and path/list normalization before approval", async () => {
    const definition = tool("files.get_structure");
    const args = prepareFinalToolArguments(definition, { rootPath: "/srv//app/", excludeDirectories: [" node_modules ", "cache//nested"] });
    expect(args).toMatchObject({ rootPath: "/srv/app", maxDepth: 4, maxNodes: 600, includeHidden: false });
    expect(args.excludeDirectories).toContain("cache/nested");
    expect((args.excludeDirectories as string[]).filter(item => item === "node_modules")).toHaveLength(1);
    expect(() => validatePreparedToolArguments(definition, args)).not.toThrow();
    const getRemoteFileStructure = vi.fn().mockResolvedValue({ tree: "app", rootPath: "/srv/app", truncated: false, warnings: [] });
    const result = await executeToolCall({ id: "frozen", toolId: definition.id, arguments: args }, defaultToolCatalog, { getRemoteFileStructure }, { prepared: true });
    expect(result.success).toBe(true);
    expect(getRemoteFileStructure.mock.calls[0][0]).toBe(args);
  });

  it("rejects unprepared args instead of inserting defaults during dispatch", async () => {
    const readRemoteFileContent = vi.fn();
    const result = await executeToolCall({ id: "raw", toolId: "files.read_content", arguments: { path: "/README" } }, defaultToolCatalog,
      { getRemoteFileStructure: vi.fn(), readRemoteFileContent }, { prepared: true });
    expect(result).toMatchObject({ success: false, error: { category: "arguments", dispatchState: "not_sent" } });
    expect(readRemoteFileContent).not.toHaveBeenCalled();
  });

  it("ignores release prose but binds defaults, property identities and implementation", () => {
    const original = tool("files.read_content");
    const prose = { ...original, configurationVersion: 999, updatedAt: "tomorrow", name: "new", description: "new", usageInstructions: "new",
      inputSchema: { ...original.inputSchema, title: "new", description: "new", properties: {
        ...(original.inputSchema.properties as object), path: { ...((original.inputSchema.properties as Record<string, object>).path), description: "new" },
      } },
    };
    expect(effectiveToolSemanticContract(prose)).toEqual(effectiveToolSemanticContract(original));
    expect(effectiveToolSemanticContract({ ...original, version: original.version + 1 })).not.toEqual(effectiveToolSemanticContract(original));
    expect(effectiveToolSemanticContract({ ...original, enabled: false })).not.toEqual(effectiveToolSemanticContract(original));
    expect(effectiveToolSemanticContract({ ...original, inputSchema: { ...original.inputSchema, properties: {
      ...(original.inputSchema.properties as object), maxBytes: { type: "integer", default: 16 },
    } } })).not.toEqual(effectiveToolSemanticContract(original));
    const schema = effectiveToolSemanticContract({ ...original, inputSchema: { type: "object", properties: {
      description: { type: "string", description: "display", default: "identity" },
    } } }).inputSchema as Record<string, unknown>;
    expect(schema.properties).toEqual({ description: { type: "string", default: "identity" } });
  });

  it("rejects ambiguous host/name aliases while preserving an explicit ID", () => {
    const servers = [server("a", "same.example"), { ...server("b", "same.example", "deploy"), name: "a" }];
    expect(() => resolveUniqueServer(servers, "same.example")).toThrow("多个服务器");
    expect(() => resolveUniqueServerEndpoint(servers, "same.example", 22)).toThrow("多个服务器");
    expect(resolveUniqueServer(servers, "a")?.id).toBe("a");
    expect(resolveUniqueServerEndpoint(servers, "same.example", 22, "deploy")?.id).toBe("b");
    const names = [{ ...server("a"), name: "same" }, { ...server("b"), name: "same" }];
    expect(() => resolveUniqueServer(names, "same")).toThrow("多个服务器");
  });

  it("rejects a stale or ambiguous source profile before binding any action", () => {
    const original = server("a");
    const input = action("files.read_content", { path: "/README", maxBytes: 65536 });
    for (const servers of [[], [original, original], [{ ...original, username: "different" }], [{ ...original, host: "changed.example" }]]) {
      expect(() => bindPreparedToolTargets(input, { server: original, servers })).toThrow("源服务器身份已变化");
    }
  });

  it("freezes transfer endpoints, paths, overwrite and the target ID", () => {
    const servers = [server("a"), { ...server("b"), port: 2222, username: "deploy", name: "backup" }];
    const input = action("files.transfer_between_servers", prepareFinalToolArguments(tool("files.transfer_between_servers"), {
      sourcePath: "/srv/file", targetServer: "backup", targetPath: "/backup/file",
    }));
    const bound = bindPreparedToolTargets(input, { server: servers[0], servers, connectionGenerations: { a: 1, b: 3 } });
    expect(bound.action.arguments.targetServer).toBe("b");
    expect(input.arguments.targetServer).toBe("backup");
    expect(bound.targets).toEqual([
      { role: "source", serverId: "a", host: "a.example", port: 22, username: "root", connectionGeneration: 1, path: "/srv/file" },
      { role: "target", serverId: "b", host: "b.example", port: 2222, username: "deploy", connectionGeneration: 3, path: "/backup/file", overwrite: false },
    ]);
  });

  it("binds connection credential references and rejects hidden account changes", () => {
    const servers = [server("a"), server("b")];
    const ctx = { server: servers[0], servers };
    const bound = bindPreparedToolTargets(action("server.connect", { host: "b.example", port: 22, credentialRef: "managed-server:b" }), ctx);
    expect(bound.targets[1]).toMatchObject({ serverId: "b", host: "b.example", port: 22, username: "root", credentialRef: "managed-server:b" });
    expect(() => bindPreparedToolTargets(action("server.connect", { host: "evil.example", credentialRef: "managed-server:b" }), ctx)).toThrow("不匹配");
    expect(() => bindPreparedToolTargets(action("server.connect", { host: "b.example", credentialRef: "managed-server:b", username: "root", passwordSecretKey: "PASS" }), ctx)).toThrow("不能同时指定");
    expect(() => bindPreparedToolTargets(action("server.connect", { host: "b.example", port: 22, username: "other", passwordSecretKey: "PASS" }), ctx)).toThrow("不同 SSH 账户");
    const fresh = bindPreparedToolTargets(action("server.connect", { host: "new.example", port: 2222, username: "deploy", passwordSecretKey: "PASS" }), ctx);
    expect(fresh.targets[1]).toEqual({ role: "connection", host: "new.example", port: 2222, username: "deploy", passwordSecretKey: "PASS" });
  });

  it("requires a non-secret binding for server credential references", () => {
    const servers = [server("a")];
    const input = action("server.connect", { host: "new.example", port: 22, credentialRef: "server-credential:group" });
    expect(() => bindPreparedToolTargets(input, { server: servers[0], servers })).toThrow("缺少匹配");
    const result = bindPreparedToolTargets(input, { server: servers[0], servers,
      credentialBindings: { "server-credential:group": { host: "new.example", username: "${secret.SSH_USER}" } },
    });
    expect(result.targets[1]).toEqual({ role: "connection", host: "new.example", port: 22, username: "${secret.SSH_USER}", credentialRef: "server-credential:group" });
  });

  it("preserves already committed effects when a composite adapter is cancelled", async () => {
    const connectServer = vi.fn().mockRejectedValue(new ToolExecutionError("任务已取消，连接已建立", "business", "sent", undefined,
      { partial: true, connectionEstablished: true, taskTargetChanged: false, credentialStored: false }));
    const args = prepareFinalToolArguments(tool("server.connect"), { host: "new.example", username: "root", passwordSecretKey: "PASS" });
    const result = await executeToolCall({ id: "cancel", toolId: "server.connect", arguments: args }, defaultToolCatalog,
      { getRemoteFileStructure: vi.fn(), connectServer }, { prepared: true });
    expect(result).toMatchObject({ success: false, error: { dispatchState: "sent" }, data: {
      partial: true, connectionEstablished: true, taskTargetChanged: false, credentialStored: false,
    } });
  });
});
