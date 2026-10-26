import { describe, expect, it } from "vitest";
import { buildOperationsCommand, normalizeOperationsRequest, parseOperationsOutput, redactOperationsObservations } from "./operationsInspection";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";
import { operationsProgressIdentity } from "./operationsObservation";
import { operationsToolCatalog } from "./operationsContracts";
import { inflateSync } from "node:zlib";
import packageSource from "./package_probe.py?opsark-probe";

const toolId = "packages.inspect";
const request = normalizeOperationsRequest(toolId, { packages: ["redis-server"] });
const fixture = () => ({ request: structuredClone(request), status: "complete", coverageComplete: true, truncated: false,
  scannedEntries: 1, matchedEntries: 1, skippedCount: 0, skipped: [], elapsedMs: 5, finishedAt: "2026-10-12T10:00:00+00:00",
  items: [{ kind: "package_environment", subject: "server:package-management", family: "debian",
    managers: [{ name: "apt-cache", executable: "/usr/bin/apt-cache" }, { name: "dpkg-query", executable: "/usr/bin/dpkg-query" }],
    packages: [{ name: "redis-server", installedStatus: "absent", installedVersions: [], candidateStatus: "available", candidateSelection: "apt_policy",
      candidateVersions: [{ version: "6:7.0.1", architecture: "policy-selected", source: "apt-cache:local-policy" }] }],
    sourcesStatus: "complete", sources: [{ id: "line-1", file: "/etc/apt/sources.list", enabled: true, origins: ["https://example.test"], signatureCheck: null }],
    locks: ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"].map(path => ({ path, state: "clear", holders: [] })),
    pidFiles: [], packageKit: { state: "idle", locked: false, transactions: [] }, decision: "clear", transactionCoverageComplete: true, nextAction: "continue_installation_planning",
    waitOutcome: "not_requested", sampleCount: 1, waitedMs: 0, observedAt: "2026-10-12T10:00:00+00:00",
    limitations: ["point_in_time", "standard_paths_only", "visible_pid_namespace", "cached_metadata_only", "not_install_authorization"] }],
});
const parse = (data, args = request) => parseOperationsOutput(toolId, args, "OPSARK_RESULT " + JSON.stringify(data));
const call = { id: "pkg-1", toolId, arguments: request };
const result = data => enforceToolResult(call, { callId: call.id, toolId, success: true, data });
const step = data => ({ action: { type: "tool", toolId, arguments: request }, result: { executionStatus: "success" }, output: JSON.stringify(data) });

describe("B01 包管理采集消费者", () => {
  it("有限参数和现有read_batch/inspectOperations入口，不扩为安装权限", () => {
    expect(request).toEqual({ packages: ["redis-server"], timeoutSeconds: 30, waitSeconds: 0 });
    expect(operationsToolCatalog.find(tool => tool.id === toolId)).toMatchObject({ effect: "read", implementation: "inspectOperations", planMode: "read_batch" });
    for (const packages of [[], ["--assumeyes"], ["redis;id"], ["redis*"], ["a", "a"], Array.from({ length: 9 }, (_, i) => `p${i}`)]) {
      expect(() => normalizeOperationsRequest(toolId, { packages })).toThrow();
    }
    expect(() => normalizeOperationsRequest(toolId, { packages: ["redis"], waitSeconds: 30 })).toThrow(/等待时间/);
    expect(() => normalizeOperationsRequest(toolId, { packages: ["redis"], waitSeconds: 31, timeoutSeconds: 120 })).toThrow();
  });
  it("驻留PackageKit但空事务且未锁定可返回clear，只生成包管理证据", () => {
    const data = parse(fixture());
    expect(result(data).success).toBe(true);
    expect(buildToolEvidenceFacts(call, result(data))).toMatchObject({ evidenceKind: "package_management", evidenceComplete: true,
      packageManagementDecision: "clear", packageManagementNextAction: "continue_installation_planning" });
  });
  it("没有真实锁/事务却声称blocked被拒绝", () => {
    const data = fixture(); data.items[0].decision = "blocked";
    expect(() => parse(data)).toThrow(/阻塞结论/);
  });
  it("真正活动事务即使Locked=false也能构成阻塞，不能标可继续", () => {
    const data = fixture(); const item = data.items[0];
    item.packageKit = { state: "active", locked: false, transactions: ["/12_active"] }; item.decision = "blocked"; item.nextAction = "wait_or_report";
    expect(parse(data).items[0].decision).toBe("blocked");
    item.nextAction = "continue_installation_planning";
    expect(() => parse(data)).toThrow(/下一步/);
  });
  it("省略锁路径不许宣布无阻塞或覆盖完整", () => {
    const data = fixture(); data.items[0].locks.pop();
    expect(() => parse(data)).toThrow(/锁范围/);
  });
  it("持有记录不能被标为clear，空holder不能伪称held", () => {
    const data = fixture(); data.items[0].locks[0].holders.push({ pid: 123, mode: "WRITE", kind: "POSIX", start: "0", end: "EOF" });
    expect(() => parse(data)).toThrow(/阻塞结论/);
  });
  it("未知候选版本或事务状态不能提升为完整采集", () => {
    for (const change of [item => { item.packages[0].candidateStatus = "unknown"; item.packages[0].candidateVersions = []; },
      item => { item.packageKit = { state: "unknown", locked: null, transactions: [] }; item.decision = "unknown"; item.transactionCoverageComplete = false; }]) {
      const data = fixture(); change(data.items[0]);
      expect(() => parse(data)).toThrow();
      data.status = "partial"; data.coverageComplete = false; data.truncated = true; data.items[0].nextAction = "resolve_evidence_gap";
      expect(parse(data).coverageComplete).toBe(false);
      expect(buildToolEvidenceFacts(call, result(data)).evidenceComplete).toBe(false);
    }
  });
  it("包名被替换或调用请求被篡改均拒绝", () => {
    const data = fixture(); data.items[0].packages[0].name = "nginx";
    expect(() => parse(data)).toThrow(/请求/);
    expect(() => parse(fixture(), { ...request, packages: ["nginx"] })).toThrow(/请求/);
  });
  it("安装记录不能伪称真实已安装，候选来自不同家族被拒绝", () => {
    const data = fixture(); data.items[0].packages[0].installedStatus = "installed";
    expect(() => parse(data)).toThrow(/版本状态/);
    data.items[0].packages[0].installedStatus = "absent"; data.items[0].packages[0].candidateSelection = "unranked_cache";
    expect(() => parse(data)).toThrow(/来源/);
  });
  it("未请求等待不允许回执声称多次等待或已清除阻塞", () => {
    const data = fixture(); data.items[0].sampleCount = 2; data.items[0].waitOutcome = "cleared";
    expect(() => parse(data)).toThrow(/等待/);
  });
  it("等待耗尽仍blocked，不伪报timeout或安装成功", () => {
    const args = { ...request, waitSeconds: 3 }; const data = fixture(); data.request = args;
    const item = data.items[0]; item.packageKit = { state: "active", locked: true, transactions: [] };
    Object.assign(item, { decision: "blocked", nextAction: "wait_or_report", waitOutcome: "exhausted", waitedMs: 3000, sampleCount: 3 });
    expect(parse(data, args)).toMatchObject({ status: "complete", coverageComplete: true });
  });
  it("已知阻塞不能掩盖另一锁未知，也不能建议自动等待", () => {
    const data = fixture(); const item = data.items[0];
    item.locks[0].state = "unknown";
    item.packageKit = { state: "active", locked: true, transactions: [] };
    item.decision = "blocked"; item.nextAction = "wait_or_report";
    expect(() => parse(data)).toThrow(/事务覆盖/);
    item.transactionCoverageComplete = false;
    expect(() => parse(data)).toThrow(/覆盖范围/);
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true });
    expect(() => parse(data)).toThrow(/下一步/);
    item.nextAction = "resolve_evidence_gap";
    expect(parse(data).items[0]).toMatchObject({ decision: "blocked", transactionCoverageComplete: false });
    expect(buildToolEvidenceFacts(call, result(data)).evidenceComplete).toBe(false);
  });
  it("三秒等待不能以九秒采集完整回执通过", () => {
    const args = { ...request, waitSeconds: 3 }; const data = fixture(); data.request = args;
    Object.assign(data.items[0], { packageKit: { state: "active", locked: true, transactions: [] }, decision: "blocked", nextAction: "wait_or_report", waitOutcome: "exhausted", waitedMs: 9000, sampleCount: 2 });
    expect(() => parse(data, args)).toThrow(/等待/);
  });
  it("重采样超时只保留未知覆盖，不能沿用旧活动状态或声明完整", () => {
    const args = { ...request, waitSeconds: 3 }; const data = fixture(); data.request = args;
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true });
    const item = data.items[0]; item.locks.forEach(lock => { lock.state = "unknown"; });
    Object.assign(item, { packageKit: { state: "unknown", locked: null, transactions: [] }, decision: "unknown", transactionCoverageComplete: false,
      nextAction: "resolve_evidence_gap", waitOutcome: "sample_timeout", waitedMs: 3000, sampleCount: 2 });
    expect(parse(data, args).items[0].waitOutcome).toBe("sample_timeout");
    Object.assign(data, { status: "complete", coverageComplete: true, truncated: false });
    expect(() => parse(data, args)).toThrow(/等待/);
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true });
    item.packageKit = { state: "active", locked: true, transactions: [] }; item.decision = "blocked";
    expect(() => parse(data, args)).toThrow(/等待/);
  });
  it("源目录枚举不完整即使版本缓存与事务均可用也不能伪报完整", () => {
    const data = fixture(); data.items[0].sourcesStatus = "partial";
    expect(() => parse(data)).toThrow(/覆盖范围/);
    Object.assign(data, { status: "partial", coverageComplete: false, truncated: true });
    data.items[0].nextAction = "resolve_evidence_gap";
    expect(parse(data).coverageComplete).toBe(false);
  });
  it("脱敏版本/源不能继续作为完整精确证据，远端不能自报已脱敏", () => {
    const data = fixture(); data.items[0].packages[0].candidateVersions[0].version = "secret-version";
    redactOperationsObservations(data, text => text.replaceAll("secret-version", "[REDACTED]"));
    expect(data.items[0].observationsRedacted).toBe(true);
    expect(data.items[0].packages[0].name).toBe("redis-server");
    expect(buildToolEvidenceFacts(call, result(data)).evidenceComplete).toBe(false);
    expect(() => parse(data)).toThrow(/远端采集/);
  });
  it("轮询时间/次数变化不是新进展，真实锁状态变化保留", () => {
    const first = fixture(), second = fixture();
    Object.assign(second.items[0], { observedAt: "2026-10-12T10:00:10+00:00", sampleCount: 3, waitedMs: 2000, waitOutcome: "not_needed" });
    expect(operationsProgressIdentity(step(first))).toBe(operationsProgressIdentity(step(second)));
    second.items[0].packageKit = { state: "active", locked: true, transactions: [] }; second.items[0].decision = "blocked";
    expect(operationsProgressIdentity(step(first))).not.toBe(operationsProgressIdentity(step(second)));
  });
  it("无Python时保留unsupported，不自动安装系统依赖", () => {
    const command = buildOperationsCommand(toolId, request);
    expect(command).toContain('sys.version_info >= (3, 6)');
    expect(command).toContain('"status":"unsupported"');
    expect(command).not.toContain("yum install"); expect(command).not.toContain("apt-get install");
    expect(inflateSync(Buffer.from(packageSource.data, "base64")).toString("utf8")).toContain("--auto-start=no");
  });
});
