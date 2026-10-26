import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSchemaValue } from "./toolParameterSchema";
import { fileManifestInputSchema, fileManifestOutputSchema, FILE_MANIFEST_LIMITATIONS, fileManifestTool,
  normalizeFileManifestRequest, buildFileManifestCommand, parseFileManifestOutput, fileManifestResultIssue,
  fileManifestDigest, redactFileManifestObservations, fileManifestEvidenceFacts } from "./fileManifestInspection";

const sha = value => createHash("sha256").update(value).digest("hex");
const identity = { device: "1", inode: "2", sizeBytes: 0, mode: "0755", uid: 0, gid: 0, mtimeNs: "1", ctimeNs: "1" };
const request = () => normalizeFileManifestRequest({ path: "/fixture", source: "directory" });
function complete() {
  return { request: request(), status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true,
    rootIdentity: { ...identity }, entries: [], issues: [], issueCount: 0, scannedEntries: 0, contentBytes: 0, readBytes: 0,
    archiveReadBytes: 0, expandedBytes: 0, manifestSha256: sha("[]"), archiveSha256: null,
    sampledAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:00:01Z", elapsedMs: 1000,
    consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
}
const receipt = data => "OPSARK_FILE_MANIFEST " + JSON.stringify(data);
const regular = (path = "index.html") => ({ path, kind: "regular", status: "complete", reason: "", sizeBytes: 4,
  mode: "0644", uid: 0, gid: 0, sha256: sha("body"), identity: { ...identity, sizeBytes: 4, mode: "0644" } });
function one() {
  const data = complete(); data.entries = [regular()]; data.scannedEntries = 1; data.contentBytes = 4; data.readBytes = 8;
  data.manifestSha256 = fileManifestDigest(data.entries); return data;
}
const parsed = data => parseFileManifestOutput(data.request, receipt(data));

describe("文件清单公开契约与消费者", () => {
  it("注册为固定只读工具并应用所有有限默认值", () => {
    expect(fileManifestTool).toMatchObject({ id: "files.inspect_manifest", implementation: "inspectFileManifest", effect: "read" });
    expect(request()).toMatchObject({ maxEntries: 1024, maxDepth: 16, maxExpandedBytes: 67108864, timeoutSeconds: 30 });
    expect(() => validateSchemaValue(fileManifestInputSchema, request(), "request", "")).not.toThrow();
  });
  it.each(["/a/../b", "/a//b", "/a/./b", "relative", "/a\n", "/\ud800"])("拒绝不明确或无损不可表示路径 %j", path => {
    expect(() => normalizeFileManifestRequest({ path, source: "directory" })).toThrow();
  });
  it.each([{ maxEntries: 0 }, { maxEntries: 4097 }, { maxDepth: 65 }, { maxFileBytes: 0 }, { maxTotalBytes: 268435457 },
    { maxArchiveBytes: 67108865 }, { maxExpandedBytes: 268435457 }, { timeoutSeconds: 121 }, { source: "zip" }, { extract: true }])("拒绝无界/未支持参数 %j", values => {
    expect(() => normalizeFileManifestRequest({ path: "/fixture", source: "directory", ...values })).toThrow();
  });
  it("真实空树与普通文件清单可被消费且不宣称执行了备份", () => {
    expect(parsed(complete()).coverageComplete).toBe(true);
    expect(parsed(one()).entries[0].sha256).toBe(sha("body"));
    expect(fileManifestEvidenceFacts(one())).toMatchObject({ evidenceComplete: true, backupVerified: false, deploymentPerformed: false });
  });
  it("摘要明确使用UTF8排序和固定成员tuple，忽略inode以便比较副本", () => {
    const rows = [regular("😀"), regular("\ue000"), regular("a")];
    const expected = sha(JSON.stringify([rows[2], rows[1], rows[0]].map(row => [row.path, row.kind, row.sizeBytes, row.mode, row.uid, row.gid, row.sha256, null])));
    expect(fileManifestDigest(rows)).toBe(expected);
    rows[0].identity.inode = "999"; expect(fileManifestDigest(rows)).toBe(expected);
  });
  it.each(["scope", "hash", "row_hash", "type", "count", "budget", "coverage", "root", "timestamp"])("拒绝不一致结果 %s", mutation => {
    const data = one();
    if (mutation === "scope") data.request.path = "/other";
    if (mutation === "hash") data.manifestSha256 = "a".repeat(64);
    if (mutation === "row_hash") delete data.entries[0].sha256;
    if (mutation === "type") data.entries[0].kind = "directory";
    if (mutation === "count") data.scannedEntries = 0;
    if (mutation === "budget") data.contentBytes = data.request.maxTotalBytes + 1;
    if (mutation === "coverage") data.coverageComplete = false;
    if (mutation === "root") data.rootIdentity = null;
    if (mutation === "timestamp") data.finishedAt = "invalid";
    expect(() => parseFileManifestOutput(request(), receipt(data))).toThrow();
  });
  it.each(["../escape", "/absolute", "a//b", "a/./b"])("拒绝回执中的非法成员 %s", path => {
    const data = one(); data.entries[0].path = path; data.manifestSha256 = fileManifestDigest(data.entries);
    expect(() => parsed(data)).toThrow();
  });
  it("重复成员和穿过普通文件的路径不能形成完整清单", () => {
    for (const rows of [[regular("a"), regular("a")], [regular("a"), regular("a/b")]]) {
      const data = one(); data.entries = rows; data.scannedEntries = 2; data.contentBytes = 8; data.readBytes = 16; data.manifestSha256 = fileManifestDigest(rows);
      expect(() => parsed(data)).toThrow();
    }
  });
  it("目录链接仅观察本体，不能用来声明可部署的普通文件集合", () => {
    const data = complete(); data.entries = [{ ...regular("link"), kind: "symlink", sizeBytes: 0, linkTarget: "../outside" }];
    delete data.entries[0].sha256; data.scannedEntries = 1; data.safeForDeployment = false; data.manifestSha256 = fileManifestDigest(data.entries);
    expect(parsed(data).coverageComplete).toBe(true);
    data.safeForDeployment = true; expect(() => parsed(data)).toThrow();
  });
  it("归档完整必须带与同一根身份和两遍读取一致的外层摘要", () => {
    const data = complete(); data.request = normalizeFileManifestRequest({ path: "/fixture.tar", source: "tar" });
    data.rootIdentity.sizeBytes = 10240; data.archiveReadBytes = 20480; data.expandedBytes = 10240; data.archiveSha256 = sha("archive");
    expect(parsed(data).coverageComplete).toBe(true);
    data.archiveReadBytes--; expect(() => parsed(data)).toThrow();
  });
  it("partial保留已采证据但不能有完整manifest或部署许可", () => {
    const data = one(); data.status = "partial"; data.coverageComplete = false; data.safeForDeployment = false; data.manifestSha256 = null;
    data.issues = [{ path: "", reason: "permission_denied" }]; data.issueCount = 1;
    expect(parsed(data).entries).toHaveLength(1);
    expect(fileManifestEvidenceFacts(data).evidenceComplete).toBe(false);
  });
  it("未支持能力不能伪装为已经采样的部分清单", () => {
    const data = one(); data.status = "unsupported"; data.coverageComplete = false; data.safeForDeployment = false;
    data.manifestSha256 = null; data.issues = [{ path: "", reason: "linux_python36_unavailable" }]; data.issueCount = 1;
    expect(() => parsed(data)).toThrow("未支持");
    Object.assign(data, { rootIdentity: null, entries: [], scannedEntries: 0, contentBytes: 0, readBytes: 0, sampledAt: null, finishedAt: null });
    expect(parsed(data).status).toBe("unsupported");
  });
  it("原始回执禁止自行声称脱敏，只有Core能转换公开观测", () => {
    const data = one(); data.observationsRedacted = false;
    expect(() => parsed(data)).toThrow("脱敏");
  });
  it("秘密成员/链接被移出公开结果，并使完整清单失效", () => {
    const data = one(); data.entries[0].path = "credential-private"; data.manifestSha256 = fileManifestDigest(data.entries);
    redactFileManifestObservations(data, value => value.replaceAll("credential-private", "[REDACTED]"));
    expect(JSON.stringify(data)).not.toContain("credential-private");
    expect(data).toMatchObject({ status: "partial", coverageComplete: false, observationsRedacted: true, manifestSha256: null });
    expect(fileManifestResultIssue(data.request, data)).toBeUndefined();
    expect(() => validateSchemaValue(fileManifestOutputSchema, data, "result", "")).not.toThrow();
  });
  it("重复回执和超1MiB原始输出拒绝而不采用末尾片段", () => {
    expect(() => parseFileManifestOutput(request(), receipt(complete()) + "\n" + receipt(complete()))).toThrow("唯一");
    expect(() => parseFileManifestOutput(request(), "OPSARK_FILE_MANIFEST " + " ".repeat(1048576))).toThrow("有界");
  });
  it("固定命令保留Linux/Python3.6能力分支且不安装依赖", () => {
    const command = buildFileManifestCommand({ path: "/中文 ' \\ $(echo unsafe)", source: "directory" });
    expect(command).toContain("sys.version_info >= (3, 6)");
    expect(command).toContain("OPSARK_FILE_MANIFEST");
    expect(command).not.toContain("pip install");
  });
});
