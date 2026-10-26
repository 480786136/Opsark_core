import { describe, expect, it } from "vitest";
import { buildLogRotationCommand, logRotationEvidenceFacts, logRotationInputSchema, logRotationOutputSchema, logRotationResultIssue,
  logRotationTool, normalizeLogRotationRequest, parseLogRotationOutput, redactLogRotationObservations, logRotationLimitations } from "./logRotationInspection";
import { compileToolSchema } from "./toolParameterSchema";
import { loadSkillDefinition } from "../skills/skillFileLoader";

const request = normalizeLogRotationRequest({ activePaths: ["/var/log/app.log"] });
const time = "2026-10-12T10:00:00.000Z", sha = "a".repeat(64);
const fixture = (args = request) => ({ request: structuredClone(args), status: "complete", coverageComplete: true,
  files: [{ path: args.activePaths[0], role: "active", status: "complete", kind: "regular", compression: "none", compressionValid: null,
    readBytes: 100, expandedBytes: 100, lineCount: 2, partialLastLine: false, sampledAt: time, finishedAt: time, consistency: "prefix_rechecked", reason: "sampled",
    metadata: { device: "1", inode: "99", sizeBytes: 100, mode: "0640", uid: 99, gid: 99, mtimeNs: "1", ctimeNs: "1" }, appendObserved: false, rawSha256: sha, contentSha256: sha }],
  configs: [], writers: [], sequence: null, sampledAt: time, finishedAt: time, elapsedMs: 2, limitations: [...logRotationLimitations] });
const wire = data => "OPSARK_LOG_ROTATION " + JSON.stringify(data);
const parse = (data, args = request) => parseLogRotationOutput(args, wire(data));
const writer = () => ({ pid: 123, status: "complete", reason: "sampled", startTicks: "5", process: "writer", scannedFds: 4,
  descriptors: [{ fd: 3, path: request.activePaths[0], device: "1", inode: "99", append: true }] });
const config = () => ({ path: "/etc/logrotate.d/app", status: "complete", reason: "declarations_only", sha256: sha, globalDirectives: [], includes: [], scripts: [], unparsedCount: 0,
  blocks: [{ targets: ["/var/log/app.log"], directives: [{ name: "daily", value: "" }, { name: "rotate", value: "7" }], scripts: [{ phase: "postrotate", sha256: sha }] }] });
const sequence = () => ({ field: "sequence", first: 1, last: 2, expectedCount: 2, observedUnique: 2, parsedRecords: 2, missingCount: 0, duplicateCount: 0, invalidRecords: 0,
  unscannedPaths: [], coverageComplete: true, status: "complete", sampling: "independent_file_prefixes", scope: "requested_sequence_window" });

describe("B05 日志轮转结构化采集契约", () => {
  it("只读元数据及有限默认参数", () => {
    expect(logRotationTool).toMatchObject({ id: "logs.inspect_rotation", implementation: "inspectLogRotation", effect: "read", planMode: "read_batch" });
    expect(request).toMatchObject({ archivePaths: [], configPaths: [], writerPids: [], maxBytesPerFile: 262144, timeoutSeconds: 30 });
    expect(compileToolSchema(logRotationInputSchema)({ activePaths: ["/tmp/log"] })).toBe(true);
    expect(compileToolSchema(logRotationOutputSchema)(fixture())).toBe(true);
  });
  it.each([{ activePaths: [] }, { activePaths: ["relative"] }, { activePaths: ["/tmp/a\n"] }, { activePaths: ["/tmp/../a"] },
    { activePaths: ["/tmp//a"] }, { activePaths: ["/tmp/a"], archivePaths: ["/tmp/a"] }, { activePaths: ["/tmp/a"], writerPids: [0] },
    { activePaths: ["/tmp/a"], maxBytesPerFile: 4194305 }, { activePaths: ["/tmp/a"], maxFdsPerProcess: 1025 },
    { activePaths: ["/tmp/a"], sequenceCheck: { field: "sequence", first: 10, last: 1 } },
    { activePaths: ["/tmp/a"], sequenceCheck: { field: "sequence", first: 0, last: 100000 } },
    { activePaths: ["/tmp/a"], sequenceCheck: { field: "$.sequence", first: 1, last: 10 } },
    { activePaths: ["/tmp/a"], rotate: true }])("拒绝无界或不明确参数 %j", args => expect(() => normalizeLogRotationRequest(args)).toThrow());
  it("保留合法中文/反斜杠名称并引用传递，不生成轮转或信号命令", () => {
    const path = "/tmp/中文 ' \\ $(touch danger).log";
    const args = normalizeLogRotationRequest({ activePaths: [path] });
    expect(args.activePaths).toEqual([path]);
    const command = buildLogRotationCommand(args);
    expect(command).toContain("-I -B -u -c");
    expect(command).toContain("sys.version_info >= (3, 6)");
    expect(command).not.toContain("logrotate --force");
    expect(command).not.toContain("kill -HUP");
  });
  it("没有时序观察时不自动声称轮转/调度/持续写入完成", () => {
    const data = parse(fixture());
    expect(logRotationEvidenceFacts(data)).toMatchObject({ evidenceKind: "log_rotation", evidenceComplete: true,
      rotationPerformed: false, scheduleVerified: false, uninterruptedWritingVerified: false, sequenceStatus: "not_requested" });
  });
  it("原请求/文件路径/角色/省略对象不匹配均拒绝", () => {
    for (const change of [data => { data.request.activePaths = ["/tmp/foreign"]; }, data => { data.files[0].path = "/tmp/foreign"; },
      data => { data.files[0].role = "archive"; }, data => { data.files = []; }]) {
      const data = fixture(); change(data); expect(() => parse(data)).toThrow();
    }
  });
  it("压缩/内容完整性、字节上限、未完末行必须与完整状态一致", () => {
    for (const change of [file => { file.compression = "gzip"; file.compressionValid = false; }, file => { file.contentSha256 = undefined; },
      file => { file.readBytes = 1; }, file => { file.partialLastLine = true; }, file => { file.expandedBytes = request.maxBytesPerFile + 2; },
      file => { file.consistency = "unverified"; }, file => { file.lineCount = file.expandedBytes + 1; }]) {
      const data = fixture(); change(data.files[0]); expect(() => parse(data)).toThrow();
    }
    const data = fixture(); Object.assign(data, { status: "partial", coverageComplete: false }); Object.assign(data.files[0], { status: "partial", partialLastLine: true });
    expect(parse(data).coverageComplete).toBe(false);
  });
  it("完整配置不能含未解析include，脚本只能为有限摘要", () => {
    const args = normalizeLogRotationRequest({ ...request, configPaths: ["/etc/logrotate.d/app"] });
    const data = fixture(args); data.configs = [config()]; expect(parse(data, args).configs).toHaveLength(1);
    data.configs[0].includes = ["/etc/logrotate.d"];
    expect(() => parse(data, args)).toThrow(/未解析/);
    data.configs[0] = config(); data.configs[0].blocks[0].scripts = Array.from({ length: 17 }, () => ({ phase: "postrotate", sha256: sha }));
    expect(() => parse(data, args)).toThrow();
  });
  it("PID与fd必须绑定已请求文件身份；unknown不算完整", () => {
    const args = normalizeLogRotationRequest({ ...request, writerPids: [123] });
    const data = fixture(args); data.writers = [writer()]; expect(parse(data, args).writers).toHaveLength(1);
    for (const change of [w => { w.pid = 124; }, w => { delete w.startTicks; }, w => { w.descriptors[0].inode = "100"; },
      w => { w.scannedFds = 0; }, w => { w.status = "unknown"; }, w => { w.descriptors.push({ ...w.descriptors[0] }); }]) {
      data.writers = [writer()]; change(data.writers[0]); expect(() => parse(data, args)).toThrow();
    }
  });
  it("序号完整仅证明限定窗口且必须覆盖实际解析行数", () => {
    const args = normalizeLogRotationRequest({ ...request, sequenceCheck: { field: "sequence", first: 1, last: 2 } });
    const data = fixture(args); data.sequence = sequence(); expect(parse(data, args).sequence.status).toBe("complete");
    for (const change of [s => { s.field = "foreign"; }, s => { s.first = 0; }, s => { s.missingCount = 1; },
      s => { s.parsedRecords = 3; }, s => { s.invalidRecords = 1; }, s => { s.status = "mismatch"; }, s => { s.unscannedPaths = ["/tmp/foreign"]; }]) {
      data.sequence = sequence(); change(data.sequence); expect(() => parse(data, args)).toThrow(/序号/);
    }
    data.sequence = sequence(); Object.assign(data.sequence, { status: "mismatch", observedUnique: 1, missingCount: 1 });
    expect(parse(data, args).sequence.status).toBe("mismatch");
    Object.assign(data, { status: "partial", coverageComplete: false });
    Object.assign(data.files[0], { status: "changed" });
    Object.assign(data.sequence, { status: "partial", coverageComplete: false, unscannedPaths: [request.activePaths[0]] });
    expect(parse(data, args).sequence.status).toBe("partial");
  });
  it("缺少Python、取消、超时、输出截断均保留不完整", () => {
    for (const status of ["unsupported", "cancelled", "timeout"]) {
      const data = fixture(); Object.assign(data, { status, coverageComplete: false, files: [] });
      if (status === "unsupported") Object.assign(data, { sampledAt: null, finishedAt: null });
      expect(parse(data).coverageComplete).toBe(false);
    }
    const data = fixture(); Object.assign(data, { status: "partial", coverageComplete: false, files: [], incompleteReason: "output_limit" });
    expect(parse(data).incompleteReason).toBe("output_limit");
    data.files = fixture().files;
    expect(() => parse(data)).toThrow(/输出超限/);
    expect(() => parseLogRotationOutput(request, wire(fixture()) + "\n" + wire(fixture()))).toThrow(/唯一/);
  });
  it("观测统一脱敏后降低证据完整性，远端不能伪造脱敏标记", () => {
    const args = normalizeLogRotationRequest({ ...request, configPaths: ["/etc/logrotate.d/app"], writerPids: [123] });
    const data = fixture(args); data.writers = [writer()]; data.writers[0].process = "secret-worker";
    data.configs = [config()]; data.configs[0].blocks[0].directives.push({ name: "compresscmd", value: "/secret/bin/gzip" });
    redactLogRotationObservations(data, value => value.replaceAll("secret", "REDACTED"));
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(data.observationsRedacted).toBe(true);
    expect(logRotationEvidenceFacts(data).evidenceComplete).toBe(false);
    expect(logRotationResultIssue(args, data)).toBeUndefined();
    expect(() => parse(data, args)).toThrow(/脱敏/);
  });
  it("领域Skill可加载，保留无损/调度/保留验收及授权边界", () => {
    const skill = loadSkillDefinition("log-rotation");
    expect(skill.id).toBe("log-rotation");
    expect(skill.instructions).toContain("copytruncate");
    expect(skill.instructions).toContain("logs.inspect_rotation");
    expect(skill.instructions).toContain("七天");
    expect(skill.instructions).toContain("不推断连续无损");
  });
});
