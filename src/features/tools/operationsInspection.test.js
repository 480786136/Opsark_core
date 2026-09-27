import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, statSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput } from "./operationsInspection";
import { defaultToolCatalog } from "./toolCatalog";
import { executeToolCall, parseToolAction, prepareFinalToolArguments, validatePreparedToolArguments } from "./toolExecutor";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";
import { buildToolStepOutcome } from "@/features/agent/toolStepResult";
import { bindPreparedToolTargets } from "./toolPreparation";
const roots = [];
function fixture() { const path = mkdtempSync(join(tmpdir(), "opsark-readonly-")); roots.push(path); return path; }
function probe(toolId, value) {
    const request = normalizeOperationsRequest(toolId, value);
    const command = buildOperationsCommand(toolId, request);
    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return parseOperationsOutput(toolId, request, output);
}
afterEach(() => { for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true }); });
describe("J4 bounded read-only probes", () => {
    it("separates recursive scan depth from presentation depth without changing legacy shallow scans", () => {
        const path = fixture(); mkdirSync(join(path, "app")); mkdirSync(join(path, "app", "data"));
        writeFileSync(join(path, "app", "data", "payload"), "x".repeat(1048576));
        const deep = probe("disk.inspect", { path, check: "directory", reportDepth: 1 });
        const expanded = probe("disk.inspect", { path, check: "directory", reportDepth: 2 });
        const shallow = probe("disk.inspect", { path, check: "directory", maxDepth: 1 });
        expect(deep.coverageComplete).toBe(true);
        expect(deep.items.find(item => item.subject === join(path, "app")).allocatedBytes).toBeGreaterThanOrEqual(1048576);
        expect(deep.items.some(item => item.subject === join(path, "app", "data"))).toBe(false);
        expect(expanded.items.some(item => item.subject === join(path, "app", "data"))).toBe(true);
        expect(shallow.coverageComplete).toBe(false);
        expect(shallow.items[0].allocatedBytes).toBeLessThan(deep.items[0].allocatedBytes);
        const tool = defaultToolCatalog.find(tool => tool.id === "disk.inspect");
        expect(tool.version).toBe(2);
        const old = { ...deep.request }; delete old.reportDepth;
        expect(() => validatePreparedToolArguments(tool, old)).toThrow();
    });
    it("executes quoted literal paths and reports top files, exclusions and symlinks without following them", () => {
        const root = fixture(), path = join(root, "quote' $(touch NEVER)\n目录");
        mkdirSync(path);
        writeFileSync(join(path, "small"), "abc");
        writeFileSync(join(path, "large"), "x".repeat(100));
        mkdirSync(join(path, "excluded"));
        writeFileSync(join(path, "excluded", "hidden"), "x".repeat(1000));
        symlinkSync(join(path, "excluded"), join(path, "link"));
        const data = probe("files.find_large", { path, minBytes: 0, maxResults: 1, excludePaths: [join(path, "excluded")] });
        expect(data).toMatchObject({ status: "complete", coverageComplete: true, truncated: true, matchedEntries: 2 });
        expect(data.items).toMatchObject([{ kind: "file", subject: join(path, "large"), sizeBytes: 100 }]);
        expect(data.skipped.map(item => item.reason).sort()).toEqual(["excluded", "symlink"]);
        const call = { id: "scan", toolId: "files.find_large", arguments: data.request };
        expect(buildToolEvidenceFacts(call, { callId: call.id, toolId: call.toolId, success: true, data }).evidenceComplete).toBe(false);
    });
    it("distinguishes an empty match from a missing path, depth and entry limits", () => {
        const path = fixture();
        mkdirSync(join(path, "child"));
        writeFileSync(join(path, "child", "file"), "data");
        expect(probe("files.find_large", { path, minBytes: 100000 }).status).toBe("no_match");
        expect(probe("files.find_large", { path: join(path, "missing") })).toMatchObject({ status: "error", coverageComplete: false });
        expect(probe("files.find_large", { path, minBytes: 0, maxDepth: 1 })).toMatchObject({ status: "partial", coverageComplete: false, truncated: true });
        expect(probe("files.find_large", { path, minBytes: 0, maxEntries: 1 })).toMatchObject({ status: "partial", scannedEntries: 1, coverageComplete: false });
    });
    it("reports actual allocation and avoids double counting hard links in directory totals", () => {
        const path = fixture(), file = join(path, "file");
        writeFileSync(file, "payload");
        linkSync(file, join(path, "alias"));
        const data = probe("disk.inspect", { path, check: "directory" });
        expect(data.status).toBe("complete");
        expect(data.items[0].allocatedBytes).toBe((statSync(file).blocks + statSync(path).blocks) * 512);
        const capacity = probe("disk.inspect", { path });
        expect(capacity.items[0].totalBytes).toBeGreaterThan(0);
        expect(capacity.items[0].availableBytes).toBeLessThanOrEqual(capacity.items[0].freeBytes);
    });
    it("uses typed prepared dispatch and refuses output from a different scope", async () => {
        const path = fixture(), data = probe("disk.inspect", { path });
        const tool = defaultToolCatalog.find(tool => tool.id === "disk.inspect");
        const args = prepareFinalToolArguments(tool, { path });
        const call = { id: "disk", toolId: tool.id, arguments: args };
        const inspectOperations = vi.fn().mockResolvedValue(data);
        expect((await executeToolCall(call, defaultToolCatalog, { getRemoteFileStructure: vi.fn(), inspectOperations }, { prepared: true })).success).toBe(true);
        expect(inspectOperations).toHaveBeenCalledWith(tool.id, args);
        expect(() => validatePreparedToolArguments(tool, { path })).toThrow();
        expect(enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data: { ...data, request: { ...args, path: "/other" } } })).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT_INVALID" } });
        const outcome = buildToolStepOutcome({ call, result: { callId: call.id, toolId: call.toolId, success: true, data }, completedAt: "now", evidenceId: "e" });
        expect(outcome.result.facts.evidenceComplete).toBe(true);
    });
    it("rejects hidden write arguments, unsafe selectors, URL credentials and relative paths before dispatch", () => {
        for (const [toolId, args] of [
            ["disk.inspect", { path: "/", command: "anything" }], ["disk.inspect", { path: "relative" }],
            ["files.find_large", { path: "/a/../b" }], ["files.find_large", { path: "/", timeoutSeconds: 601 }],
            ["services.inspect", { check: "status", service: "--now" }], ["services.inspect", { check: "status", service: "a;reboot" }],
            ["services.inspect", { check: "health", url: "http://user:secret@localhost/" }],
            ["services.inspect", { check: "health", url: "http://localhost/#fragment" }],
            ["services.inspect", { check: "health", url: "http://local host/" }],
            ["services.inspect", { check: "ports", service: "unexpected" }],
            ["services.inspect", { check: "logs" }],
        ]) {
            expect(() => parseToolAction({ type: "tool", toolId, arguments: args }, "call")).toThrow();
        }
    });
    it("does not misreport unsupported and partial observations as complete evidence", () => {
        const args = normalizeOperationsRequest("services.inspect", { check: "ports" });
        const call = { id: "ports", toolId: "services.inspect", arguments: args };
        const data = { request: args, status: "unsupported", items: [], scannedEntries: 0, matchedEntries: 0,
            skippedCount: 1, skipped: [{ path: "ss", reason: "unsupported" }], coverageComplete: false, truncated: true, elapsedMs: 0, finishedAt: "now" };
        const result = { callId: call.id, toolId: call.toolId, success: true, data, truncated: true };
        expect(enforceToolResult(call, result).success).toBe(true);
        expect(buildToolStepOutcome({ call, result, completedAt: "now", evidenceId: "e" }).result.observationStatus).toBe("warning");
        expect(buildToolEvidenceFacts(call, result)).toMatchObject({ evidenceComplete: false, inspectionStatus: "unsupported" });
        expect(enforceToolResult(call, { ...result, data: { ...data, coverageComplete: true } }).success).toBe(false);
        expect(() => parseOperationsOutput(call.toolId, args, "OPSARK_RESULT {}\nOPSARK_RESULT {}")).toThrow();
    });
    it("binds the approved path to the managed server target", () => {
        const server = { id: "server", host: "host", port: 22, username: "user" };
        const { targets } = bindPreparedToolTargets({ type: "tool", toolId: "files.find_large", arguments: { path: "/srv" } }, { server, servers: [server], connectionGeneration: 3 });
        expect(targets).toEqual([{ role: "source", serverId: "server", host: "host", port: 22, username: "user", connectionGeneration: 3, path: "/srv" }]);
    });
});
