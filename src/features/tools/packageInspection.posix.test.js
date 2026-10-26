import { describe, expect, it } from "vitest";
import { runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput } from "./operationsInspection";
import { enforceToolResult } from "./toolResultContract";

describe("B01 本地POSIX真实查询，不执行安装", () => {
  it("固定探针经受管命令传输，真实APT安装状态与缓存候选进入严格消费者", () => {
    const request = normalizeOperationsRequest("packages.inspect", { packages: ["bash"], timeoutSeconds: 15 });
    const execution = runPosixShell(buildOperationsCommand("packages.inspect", request), { timeout: 20000 });
    expect(execution.status, execution.stderr).toBe(0);
    const data = parseOperationsOutput("packages.inspect", request, execution.stdout);
    expect(data.items[0]).toMatchObject({ family: "debian", packages: [{ name: "bash", installedStatus: "installed" }], sampleCount: 1 });
    const call = { id: "local-packages", toolId: "packages.inspect", arguments: request };
    expect(enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data }).success).toBe(true);
    expect(data.items[0].limitations).toContain("cached_metadata_only");
  }, 30000);
});
