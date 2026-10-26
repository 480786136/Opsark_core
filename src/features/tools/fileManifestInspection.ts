import probe from "./file_manifest_probe.py?raw";
import { fillToolDefaults, validateSchemaValue } from "./toolParameterSchema";
import { sha256Utf8 } from "@/features/agent/planPreparation";
import { fileManifestInputSchema, fileManifestOutputSchema, FILE_MANIFEST_LIMITATIONS, FILE_MANIFEST_OUTPUT_LIMIT } from "./fileManifestContracts";
export { fileManifestTool, fileManifestInputSchema, fileManifestOutputSchema, FILE_MANIFEST_LIMITATIONS, FILE_MANIFEST_OUTPUT_LIMIT } from "./fileManifestContracts";

export interface FileManifestRequest {
  path: string; source: "directory" | "tar" | "tar_gzip"; maxEntries: number; maxDepth: number;
  maxFileBytes: number; maxTotalBytes: number; maxArchiveBytes: number; maxExpandedBytes: number; timeoutSeconds: number;
}
export interface FileManifestIdentity {
  device: string; inode: string; sizeBytes: number; mode: string; uid: number; gid: number; mtimeNs: string; ctimeNs: string;
}
export interface FileManifestEntry {
  path: string; kind: "regular" | "directory" | "symlink" | "hardlink" | "other"; status: "complete" | "partial"; reason: string;
  sizeBytes: number; mode: string; uid: number; gid: number; sha256?: string; linkTarget?: string; identity?: FileManifestIdentity;
}
export interface FileManifestResult {
  request: FileManifestRequest; status: "complete" | "partial" | "timeout" | "unsupported";
  coverageComplete: boolean; truncated: boolean; safeForDeployment: boolean; rootIdentity: FileManifestIdentity | null;
  entries: FileManifestEntry[]; issues: Array<{ path: string; reason: string }>; issueCount: number; scannedEntries: number;
  contentBytes: number; readBytes: number; archiveReadBytes: number; expandedBytes: number;
  manifestSha256: string | null; archiveSha256: string | null; sampledAt: string | null; finishedAt: string | null; elapsedMs: number;
  consistency: "sampled_non_atomic"; limitations: string[]; observationsRedacted?: boolean;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const validText = (value: string) => !/[\u0000-\u001f\u007f]/.test(value) && !Array.from(value).some(c => c.length === 1 && /[\ud800-\udfff]/.test(c));
const validRelative = (value: string) => validText(value) && !value.startsWith("/") && value.split("/").every(p => p && p !== "." && p !== "..");
export function normalizeFileManifestRequest(value: Record<string, unknown> | FileManifestRequest): FileManifestRequest {
  const request = fillToolDefaults(fileManifestInputSchema, value) as FileManifestRequest;
  validateSchemaValue(fileManifestInputSchema, request, "文件清单参数", "");
  if (!validText(request.path) || request.path !== "/" && !validRelative(request.path.slice(1))) throw new Error("文件清单需要精确绝对路径，不接受空路径段或点段");
  return request;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function buildFileManifestCommand(value: Record<string, unknown> | FileManifestRequest): string {
  const request = normalizeFileManifestRequest(value);
  const unsupported: FileManifestResult = { request, status: "unsupported", coverageComplete: false, truncated: false, safeForDeployment: false,
    rootIdentity: null, entries: [], issues: [{ path: "", reason: "linux_python36_unavailable" }], issueCount: 1,
    scannedEntries: 0, contentBytes: 0, readBytes: 0, archiveReadBytes: 0, expandedBytes: 0, manifestSha256: null, archiveSha256: null,
    sampledAt: null, finishedAt: null, elapsedMs: 0, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
  return `opsark_manifest_python=''
for opsark_manifest_candidate in python3 python; do
  if command -v "$opsark_manifest_candidate" >/dev/null 2>&1 && "$opsark_manifest_candidate" -c 'import sys; sys.exit(0 if sys.platform.startswith("linux") and sys.version_info >= (3, 6) else 1)' 2>/dev/null; then
    opsark_manifest_python="$opsark_manifest_candidate"
    break
  fi
done
if [ -n "$opsark_manifest_python" ]; then
  "$opsark_manifest_python" -I -B -u -c ${quote(probe)} ${quote(JSON.stringify(request))}
else
  printf '%s\\n' ${quote("OPSARK_FILE_MANIFEST " + JSON.stringify(unsupported))}
fi`;
}
const utf8Compare = (a: string, b: string) => {
  const encoder = new TextEncoder(), first = encoder.encode(a), second = encoder.encode(b);
  for (let i = 0; i < Math.min(first.length, second.length); i++) if (first[i] !== second[i]) return first[i] - second[i];
  return first.length - second.length;
};
export function fileManifestDigest(entries: FileManifestEntry[]): string {
  return sha256Utf8(JSON.stringify([...entries].sort((a, b) => utf8Compare(a.path, b.path)).map(item =>
    [item.path, item.kind, item.sizeBytes, item.mode, item.uid, item.gid, item.sha256 ?? null, item.linkTarget ?? null])));
}
export function fileManifestResultIssue(args: Record<string, unknown> | FileManifestRequest, data: FileManifestResult): string | undefined {
  const request = normalizeFileManifestRequest(args);
  if (stable(request) !== stable(data.request)) return "文件清单与原请求不一致";
  if (data.status === "unsupported" && (data.rootIdentity !== null || data.entries.length || data.scannedEntries
    || data.contentBytes || data.readBytes || data.archiveReadBytes || data.expandedBytes || data.manifestSha256 !== null
    || data.archiveSha256 !== null || data.sampledAt !== null || data.finishedAt !== null || !data.issueCount)) return "未支持能力不能携带已采集证据";
  if (data.coverageComplete !== (data.status === "complete") || data.coverageComplete && (data.truncated || data.issueCount || !data.rootIdentity)) return "文件清单覆盖状态矛盾";
  if (data.entries.length > data.scannedEntries || data.scannedEntries > request.maxEntries || data.issueCount < data.issues.length
    || data.issues.length !== Math.min(data.issueCount, 128) || data.coverageComplete && data.scannedEntries !== data.entries.length) return "文件清单计数或错误范围不一致";
  if (data.contentBytes > request.maxTotalBytes || data.readBytes > 2 * request.maxTotalBytes + 2 * request.maxEntries
    || data.archiveReadBytes > 2 * request.maxArchiveBytes + 2 || data.expandedBytes > request.maxExpandedBytes + 1) return "文件清单超过声明读取预算";
  if (request.source === "directory" ? data.archiveSha256 !== null || data.archiveReadBytes !== 0 || data.expandedBytes !== 0
    : data.readBytes !== 0 || data.archiveSha256 !== null && (!data.rootIdentity || data.archiveReadBytes !== 2 * data.rootIdentity.sizeBytes)) return "文件清单来源与读取证据不一致";
  const seen = new Map<string, FileManifestEntry>();
  for (const item of data.entries) {
    if (!validRelative(item.path) || seen.has(item.path) || item.path.split("/").length > request.maxDepth) return "文件清单成员路径重复、越界或无效";
    seen.set(item.path, item);
    if (item.status === "complete" && (item.reason || item.kind === "regular" && (!item.sha256 || item.sizeBytes > request.maxFileBytes)
      || ["symlink", "hardlink"].includes(item.kind) && (!item.linkTarget || !validText(item.linkTarget))
      || ["directory", "symlink"].includes(item.kind) && item.sizeBytes !== 0 || item.kind === "other")) return "完整成员缺少类型、内容或链接证据";
    if (item.kind !== "regular" && item.sha256 !== undefined || item.kind === "regular" && item.linkTarget !== undefined) return "成员摘要与类型不一致";
    if (request.source === "directory" ? !item.identity || item.kind === "regular" && item.identity.sizeBytes !== item.sizeBytes
      : item.identity !== undefined || ["symlink", "hardlink"].includes(item.kind) && item.status === "complete") return "成员身份与目录或归档来源不一致";
  }
  for (const item of data.entries) {
    const parts = item.path.split("/");
    if (parts.slice(0, -1).some((_part, i) => seen.has(parts.slice(0, i + 1).join("/")) && seen.get(parts.slice(0, i + 1).join("/"))!.kind !== "directory")) return "成员穿过非目录父项";
  }
  const completeBytes = data.entries.filter(row => row.kind === "regular" && row.status === "complete").reduce((sum, row) => sum + row.sizeBytes, 0);
  if (completeBytes > data.contentBytes || data.coverageComplete && (data.entries.some(row => row.status !== "complete") || completeBytes !== data.contentBytes
    || request.source !== "directory" && data.archiveSha256 === null)) return "完整清单缺少全部成员或归档证据";
  if (data.safeForDeployment !== (data.coverageComplete && data.entries.every(row => ["regular", "directory"].includes(row.kind)))) return "部署适用性不能忽略链接或缺失范围";
  if (data.coverageComplete ? data.manifestSha256 !== fileManifestDigest(data.entries) : data.manifestSha256 !== null) return "完整清单摘要与真实成员不一致";
  if (data.status !== "unsupported" && (!data.sampledAt || !data.finishedAt || !Number.isFinite(Date.parse(data.sampledAt)) || !Number.isFinite(Date.parse(data.finishedAt)))) return "采样缺少有效时间";
  return undefined;
}
export function parseFileManifestOutput(args: Record<string, unknown> | FileManifestRequest, output: string): FileManifestResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("OPSARK_FILE_MANIFEST "));
  if (lines.length !== 1 || new TextEncoder().encode(lines[0]).length > FILE_MANIFEST_OUTPUT_LIMIT) throw new Error("文件清单缺少唯一有界回执");
  const data = JSON.parse(lines[0].slice("OPSARK_FILE_MANIFEST ".length)) as FileManifestResult;
  validateSchemaValue(fileManifestOutputSchema, data, "文件清单回执", "");
  if (data.observationsRedacted !== undefined) throw new Error("远端不能声明Core脱敏状态");
  const issue = fileManifestResultIssue(args, data);
  if (issue) throw new Error(issue);
  return data;
}
export function redactFileManifestObservations(data: FileManifestResult, redact: (value: string) => string): FileManifestResult {
  // Requested path is already public identity. Observed member/link names may carry secrets;
  // remove sensitive members instead of rewriting identity and inventing an equal manifest.
  const safe = data.entries.filter(item => redact(item.path) === item.path && (item.linkTarget === undefined || redact(item.linkTarget) === item.linkTarget));
  let changed = safe.length !== data.entries.length;
  data.issues = data.issues.map(item => { const path = redact(item.path); changed ||= path !== item.path; return { ...item, path }; });
  if (changed) {
    data.entries = safe; data.status = "partial"; data.coverageComplete = false; data.safeForDeployment = false; data.manifestSha256 = null; data.observationsRedacted = true;
    data.issueCount++;
    if (data.issues.length < 128) data.issues.push({ path: "", reason: "observations_redacted" });
  }
  return data;
}
export function fileManifestEvidenceFacts(data: FileManifestResult) {
  return { evidenceKind: "file_manifest", inspectionStatus: data.status, evidenceScope: data.request.path,
    evidenceComplete: data.coverageComplete && data.observationsRedacted !== true, source: data.request.source,
    manifestSha256: data.manifestSha256, archiveSha256: data.archiveSha256, memberCount: data.entries.length,
    safeForDeployment: data.safeForDeployment && data.observationsRedacted !== true, sampleFinishedAt: data.finishedAt,
    consistency: data.consistency, limitations: data.limitations, backupVerified: false, deploymentPerformed: false };
}
