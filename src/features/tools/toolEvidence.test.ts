import { describe, expect, it } from "vitest";
import { buildToolEvidenceFacts } from "@/features/tools/toolEvidence";
import type { ToolCall, ToolResult } from "@/features/tools/types";

function call(toolId: string, argumentsValue: Record<string, unknown>): ToolCall {
  return { id: "call-1", toolId, arguments: argumentsValue };
}

function result(toolCall: ToolCall, data: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { callId: toolCall.id, toolId: toolCall.toolId, success: true, data, ...extra };
}

const fileCall = call("files.read_content", { path: "/opt/app/package.json" });
const fileData = { path: "/opt/app/package.json", content: "{}", encoding: "utf-8", totalBytes: 2, returnedBytes: 2, truncated: false };
const structureCall = call("files.get_structure", { rootPath: "/opt/app" });
const structureData = { rootPath: "/opt/app", tree: "/opt/app/\n└── package.json", truncated: false, warnings: [] };

describe("tool evidence products", () => {
  it("requires actual file content and complete read metadata", () => {
    expect(buildToolEvidenceFacts(fileCall, result(fileCall, fileData))).toMatchObject({
      evidenceKind: "file_content", evidenceScope: fileData.path, evidenceComplete: true, evidenceNonEmpty: true,
    });
    for (const data of [
      {}, { ...fileData, content: undefined }, { ...fileData, encoding: "binary" },
      { ...fileData, totalBytes: "2" }, { ...fileData, returnedBytes: -1 },
      { ...fileData, returnedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...fileData, totalBytes: 1 }, { ...fileData, returnedBytes: 0 },
      { ...fileData, truncated: undefined },
    ]) {
      expect(buildToolEvidenceFacts(fileCall, result(fileCall, data))).toEqual({ evidenceComplete: false });
    }
    const bounded = call("files.read_content", { path: fileData.path, maxBytes: 1 });
    expect(buildToolEvidenceFacts(bounded, result(bounded, fileData))).toEqual({ evidenceComplete: false });
  });

  it("normalizes POSIX spelling without conflating case, literal backslashes, or symlink parent paths", () => {
    const normalized = call("files.read_content", { path: " /opt//app/./package.json " });
    expect(buildToolEvidenceFacts(normalized, result(normalized, fileData)).evidenceScope).toBe(fileData.path);
    for (const path of ["/opt/App/package.json", "/opt/other/package.json", "/opt/link/../app/package.json", "/opt/app\\package.json"]) {
      expect(buildToolEvidenceFacts(fileCall, result(fileCall, { ...fileData, path })).evidenceComplete).toBe(false);
    }
    const literal = call("files.read_content", { path: "/opt/a\\b.txt" });
    expect(buildToolEvidenceFacts(literal, result(literal, { ...fileData, path: "/opt/a\\b.txt" })).evidenceScope)
      .toBe("/opt/a\\b.txt");
  });

  it("keeps partial file observations and honors both truncation layers and byte coverage", () => {
    for (const observed of [
      result(fileCall, fileData, { truncated: true }),
      result(fileCall, { ...fileData, truncated: true }),
      result(fileCall, { ...fileData, totalBytes: 100 }),
    ]) {
      expect(buildToolEvidenceFacts(fileCall, observed)).toMatchObject({
        evidenceKind: "file_content", evidenceScope: fileData.path, evidenceComplete: false,
      });
    }
  });

  it("distinguishes an empty file from nonempty content and fingerprints the returned observation", () => {
    const empty = buildToolEvidenceFacts(fileCall, result(fileCall, { ...fileData, content: "", totalBytes: 0, returnedBytes: 0 }));
    expect(empty).toMatchObject({ evidenceComplete: true, evidenceNonEmpty: false });
    const whitespace = buildToolEvidenceFacts(fileCall, result(fileCall, { ...fileData, content: "  " }));
    expect(whitespace.evidenceNonEmpty).toBe(false);
    const first = buildToolEvidenceFacts(fileCall, result(fileCall, fileData));
    const changed = buildToolEvidenceFacts(fileCall, result(fileCall, { ...fileData, content: "[]" }));
    expect(first.evidenceFingerprint).toBe(buildToolEvidenceFacts(fileCall, result(fileCall, fileData)).evidenceFingerprint);
    expect(first.evidenceFingerprint).not.toBe(changed.evidenceFingerprint);
    // Raw byte counts precede secret redaction and TextDecoder BOM removal.
    expect(buildToolEvidenceFacts(fileCall, result(fileCall, {
      ...fileData, content: "password=••••••••", totalBytes: 80, returnedBytes: 80,
    })).evidenceComplete).toBe(true);
    expect(buildToolEvidenceFacts(fileCall, result(fileCall, {
      ...fileData, content: "", totalBytes: 3, returnedBytes: 3,
    }))).toMatchObject({ evidenceComplete: true, evidenceNonEmpty: false });
  });

  it("records the bounded directory coverage and treats scan warnings as partial observations", () => {
    const complete = buildToolEvidenceFacts(structureCall, result(structureCall, structureData));
    expect(complete).toMatchObject({
      evidenceKind: "directory_structure", evidenceScope: "/opt/app", evidenceComplete: true,
      scanCoverage: { maxDepth: 4, maxNodes: 600, includeHidden: false },
    });
    expect((complete.scanCoverage as { excludeDirectories: string[] }).excludeDirectories).toContain("node_modules");
    for (const observed of [
      result(structureCall, structureData, { truncated: true }),
      result(structureCall, { ...structureData, truncated: true }),
      result(structureCall, { ...structureData, warnings: ["Cannot read /opt/app/private"] }),
    ]) {
      expect(buildToolEvidenceFacts(structureCall, observed)).toMatchObject({ evidenceKind: "directory_structure", evidenceComplete: false });
    }
    for (const data of [
      {}, { ...structureData, rootPath: "/opt/other" }, { ...structureData, tree: "" },
      { ...structureData, warnings: undefined }, { ...structureData, warnings: [false] },
      { ...structureData, truncated: undefined },
    ]) {
      expect(buildToolEvidenceFacts(structureCall, result(structureCall, data))).toEqual({ evidenceComplete: false });
    }
  });

  it("requires every requested software name while keeping missing software distinct from availability", () => {
    const softwareCall = call("software.check", { names: ["node", " git "] });
    const items = [{ name: "node", installed: false }, { name: "git", installed: true, path: "/usr/bin/git", version: "git version 2.48" }];
    expect(buildToolEvidenceFacts(softwareCall, result(softwareCall, { items }))).toMatchObject({
      evidenceKind: "software_check", evidenceScope: "software:git,node", evidenceComplete: true,
      softwareNames: ["git", "node"], softwareCheckedNames: ["git", "node"],
      softwareInstalledNames: ["git"], softwareMissingNames: ["node"], softwareAllInstalled: false,
    });
    expect(buildToolEvidenceFacts(softwareCall, result(softwareCall, { items: items.slice(1) })))
      .toMatchObject({ evidenceKind: "software_check", evidenceComplete: false, softwareAllInstalled: false });
    expect(buildToolEvidenceFacts(softwareCall, result(softwareCall, { items: [
      { name: "git", installed: true, path: "/usr/bin/git" }, { name: "node", installed: true, path: "/usr/bin/node" },
    ] }))).toMatchObject({ evidenceComplete: true, softwareAllInstalled: true });
  });

  it("rejects malformed software observations and does not infer readiness from an installed label alone", () => {
    const softwareCall = call("software.check", { names: ["git"] });
    for (const items of [
      [], [{ name: "git", installed: true }], [{ name: "git", installed: true, path: "git" }],
      [{ name: "git", installed: "true", path: "/usr/bin/git" }],
      [{ name: "git", installed: false, path: "/usr/bin/git" }],
      [{ name: "node", installed: true, path: "/usr/bin/node" }],
      [{ name: "git", installed: false }, { name: "git", installed: false }],
    ]) {
      expect(buildToolEvidenceFacts(softwareCall, result(softwareCall, { items }))).toEqual({ evidenceComplete: false });
    }
    expect(buildToolEvidenceFacts(softwareCall, result(softwareCall, { items: [{ name: "git", installed: false }] }, { truncated: true })))
      .toMatchObject({ evidenceComplete: false, softwareAllInstalled: false });
  });

  it("does not create complete products for failed, mismatched, empty, or unknown tool results", () => {
    for (const observed of [
      result(fileCall, fileData, { success: false }), result(fileCall, fileData, { callId: "other" }),
      result(fileCall, fileData, { toolId: "other" }), result(fileCall, null), result(fileCall, []),
    ]) {
      expect(buildToolEvidenceFacts(fileCall, observed)).toEqual({ evidenceComplete: false });
    }
    const unknown = call("custom.read", { path: fileData.path });
    expect(buildToolEvidenceFacts(unknown, result(unknown, fileData))).toEqual({ evidenceComplete: false });
  });
});
