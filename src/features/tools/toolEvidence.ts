import { normalizeFileStructureRequest } from "@/features/tools/fileStructure";
import { normalizeSoftwareCheckRequest } from "@/features/tools/softwareCheck";
import type { ToolCall, ToolResult } from "@/features/tools/types";

export interface ToolEvidenceFacts extends Record<string, unknown> {
  evidenceKind?: "directory_structure" | "file_content" | "software_check";
  evidenceScope?: string;
  evidenceComplete: boolean;
  evidenceNonEmpty?: boolean;
  /** Fingerprint of the returned observation, never a remote file version/hash. */
  evidenceFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve POSIX case and literal backslashes; never resolve .. across symlinks. */
export function normalizeToolEvidencePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return undefined;
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return undefined;
  return `/${parts.join("/")}`;
}

const absolutePath = normalizeToolEvidencePath;

function requestPath(value: unknown) {
  // The file tool parsers trim their input before dispatching the remote read.
  return absolutePath(typeof value === "string" ? value.trim() : value);
}

function observationFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return `returned:${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function byteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fileContentFacts(call: ToolCall, result: ToolResult, data: Record<string, unknown>): ToolEvidenceFacts {
  const scope = absolutePath(data.path);
  const maxBytes = call.arguments.maxBytes ?? 65_536;
  if (!scope || scope !== requestPath(call.arguments.path)
    || typeof data.content !== "string" || data.encoding !== "utf-8"
    || typeof data.truncated !== "boolean"
    || typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262_144
    || !byteCount(data.totalBytes) || !byteCount(data.returnedBytes)
    || data.returnedBytes > data.totalBytes || data.returnedBytes > maxBytes
    || (data.returnedBytes === 0 && data.content.length > 0)) {
    return { evidenceComplete: false };
  }
  // content is already decoded and redacted. Its encoded length can legitimately
  // differ from returnedBytes (secrets and UTF-8 BOM), which describes the read.
  return {
    evidenceKind: "file_content",
    evidenceScope: scope,
    evidenceComplete: result.truncated !== true && !data.truncated
      && data.returnedBytes === data.totalBytes,
    evidenceNonEmpty: data.content.trim().length > 0,
    evidenceFingerprint: observationFingerprint(data.content),
  };
}

function directoryFacts(call: ToolCall, result: ToolResult, data: Record<string, unknown>): ToolEvidenceFacts {
  const scope = absolutePath(data.rootPath);
  if (!scope || scope !== requestPath(call.arguments.rootPath)
    || typeof data.tree !== "string" || !data.tree.trim()
    || typeof data.truncated !== "boolean"
    || !Array.isArray(data.warnings) || data.warnings.some((warning) => typeof warning !== "string")) {
    return { evidenceComplete: false };
  }
  try {
    const request = normalizeFileStructureRequest({
      rootPath: String(call.arguments.rootPath),
      excludeDirectories: call.arguments.excludeDirectories as string[] | undefined,
      maxDepth: call.arguments.maxDepth as number | undefined,
      maxNodes: call.arguments.maxNodes as number | undefined,
      includeHidden: call.arguments.includeHidden as boolean | undefined,
    });
    const scanCoverage = {
      maxDepth: request.maxDepth,
      maxNodes: request.maxNodes,
      includeHidden: request.includeHidden,
      excludeDirectories: [...request.excludeDirectories].sort(),
    };
    return {
      evidenceKind: "directory_structure",
      evidenceScope: scope,
      // Complete means the requested bounded scan, including its exclusions.
      evidenceComplete: result.truncated !== true && !data.truncated && data.warnings.length === 0,
      evidenceFingerprint: observationFingerprint(JSON.stringify([data.tree, scanCoverage])),
      scanCoverage,
    };
  } catch {
    return { evidenceComplete: false };
  }
}

function softwareFacts(call: ToolCall, result: ToolResult, data: Record<string, unknown>): ToolEvidenceFacts {
  if (!Array.isArray(data.items) || !data.items.length
    || (data.truncated !== undefined && typeof data.truncated !== "boolean")) {
    return { evidenceComplete: false };
  }
  try {
    const names = normalizeSoftwareCheckRequest(call.arguments).names.sort();
    const seen = new Set<string>();
    const items: Array<{ name: string; installed: boolean; path?: string; version?: string }> = [];
    for (const item of data.items) {
      if (!isRecord(item) || typeof item.name !== "string" || !names.includes(item.name)
        || seen.has(item.name) || typeof item.installed !== "boolean"
        || (item.version !== undefined && typeof item.version !== "string")) {
        return { evidenceComplete: false };
      }
      const path = absolutePath(item.path);
      if ((item.installed && !path)
        || (!item.installed && item.path !== undefined && item.path !== "")) {
        return { evidenceComplete: false };
      }
      seen.add(item.name);
      items.push({ name: item.name, installed: item.installed, path, version: item.version });
    }
    items.sort((left, right) => left.name.localeCompare(right.name));
    const complete = seen.size === names.length && result.truncated !== true && data.truncated !== true;
    const installedNames = items.filter((item) => item.installed).map((item) => item.name);
    return {
      evidenceKind: "software_check",
      evidenceScope: `software:${names.join(",")}`,
      evidenceComplete: complete,
      evidenceFingerprint: observationFingerprint(JSON.stringify(items)),
      softwareNames: names,
      softwareCheckedNames: items.map((item) => item.name),
      softwareInstalledNames: installedNames,
      softwareMissingNames: items.filter((item) => !item.installed).map((item) => item.name),
      // Executable availability alone does not prove runtime compatibility.
      softwareAllInstalled: complete && installedNames.length === names.length,
    };
  } catch {
    return { evidenceComplete: false };
  }
}

/** Derive reusable products only from successful, well-shaped tool observations. */
export function buildToolEvidenceFacts(call: ToolCall, result: ToolResult): ToolEvidenceFacts {
  if (!result.success || result.callId !== call.id || result.toolId !== call.toolId
    || (result.truncated !== undefined && typeof result.truncated !== "boolean")
    || !isRecord(result.data)) {
    return { evidenceComplete: false };
  }
  if (call.toolId === "files.read_content") return fileContentFacts(call, result, result.data);
  if (call.toolId === "files.get_structure") return directoryFacts(call, result, result.data);
  if (call.toolId === "software.check") return softwareFacts(call, result, result.data);
  return { evidenceComplete: false };
}
