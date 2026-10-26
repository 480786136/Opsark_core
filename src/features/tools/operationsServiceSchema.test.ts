import { describe, expect, it } from "vitest";
import { operationsOutputSchemas, servicePropertyKeys } from "./operationsContracts";
import { validateSchemaValue } from "./toolParameterSchema";

const identity = () => ({ status: "stable", service: "example.service", pid: 123,
  bootId: "11111111-2222-3333-4444-555555555555", startTimeTicks: "9007199254740993123",
  sampleStartedAt: "2026-10-12T00:00:00.000Z", sampleFinishedAt: "2026-10-12T00:00:00.100Z",
  consistency: "sampled_non_atomic", verificationExitCode: 0 });
const item = () => ({ kind: "service", subject: "example.service", exitCode: 0,
  text: "Id=example.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n",
  properties: { Id: "example.service", LoadState: "loaded", ActiveState: "active", SubState: "running", MainPID: "123",
    UnitFileState: "enabled", ExecStart: "{ path=/usr/bin/example ; }", FragmentPath: "/etc/systemd/system/example.service" },
  processIdentity: identity() });
function validate(value: object) {
  return validateSchemaValue(operationsOutputSchemas["services.inspect"], {
    request: { check: "status", service: "example.service", timeoutSeconds: 15, logLines: 50, sinceMinutes: 30 },
    status: "complete", items: [value], scannedEntries: 0, matchedEntries: 1, skippedCount: 0, skipped: [],
    coverageComplete: true, truncated: false, elapsedMs: 100, finishedAt: "2026-10-12T00:00:00.100Z",
  }, "服务结构化证据", "");
}

describe("B06 服务属性与进程身份闭合 schema", () => {
  it("保留原文本并接受精确字符串身份与固定扩展属性", () => {
    expect(servicePropertyKeys).toHaveLength(12);
    expect(() => validate(item())).not.toThrow();
    expect(item().processIdentity.startTimeTicks).toBe("9007199254740993123");
  });

  it("历史无扩展身份的原始服务结果保持兼容", () => {
    const { properties: _properties, processIdentity: _identity, ...legacy } = item();
    expect(() => validate(legacy)).not.toThrow();
  });

  it.each([
    { bootId: "host-name" }, { startTimeTicks: 9007199254740992 }, { startTimeTicks: "0" },
    { startTimeTicks: "1.5" }, { pid: 0 }, { pid: Number.MAX_SAFE_INTEGER + 1 },
    { verificationExitCode: 7 }, { reason: "proc_unavailable" }, { consistency: "atomic" },
  ])("拒绝无法支持 stable 身份的字段 %j", changes => {
    expect(() => validate({ ...item(), processIdentity: { ...identity(), ...changes } })).toThrow();
  });

  it.each(["pid", "bootId", "startTimeTicks", "verificationExitCode", "sampleStartedAt", "service"])("stable 缺少 %s 必须拒绝", key => {
    const incomplete: Record<string, unknown> = identity(); delete incomplete[key];
    expect(() => validate({ ...item(), processIdentity: incomplete })).toThrow();
  });

  it("未知采样不携带貌似完整的 boot/start 身份，保留失败退出码", () => {
    const { bootId: _boot, startTimeTicks: _ticks, ...base } = identity();
    const unknown = { ...base, status: "unknown", reason: "properties_unavailable", verificationExitCode: 8 };
    expect(() => validate({ ...item(), processIdentity: unknown })).not.toThrow();
    expect(() => validate({ ...item(), processIdentity: { ...unknown, bootId: identity().bootId } })).toThrow();
  });

  it("空 MainPID 槽位必须有两次查询成功，不能用非零PID或完整身份冒充", () => {
    const { bootId: _boot, startTimeTicks: _ticks, ...base } = identity();
    const empty = { ...base, status: "not_running", pid: 0, reason: "no_main_process" };
    expect(() => validate({ ...item(), processIdentity: empty })).not.toThrow();
    expect(() => validate({ ...item(), processIdentity: { ...empty, pid: 123 } })).toThrow();
    expect(() => validate({ ...item(), processIdentity: { ...empty, verificationExitCode: 1 } })).toThrow();
  });

  it("新增属性仅限固定只读白名单，脱敏标志是显式可选字段", () => {
    expect(() => validate({ ...item(), observationsRedacted: true })).not.toThrow();
    expect(() => validate({ ...item(), properties: { ...item().properties, Environment: "PASSWORD=secret" } })).toThrow();
    expect(() => validate({ ...item(), properties: { ...item().properties, ExecStart: "x".repeat(32769) } })).toThrow();
  });

  it("兼容回退仅记录原始失败和有限缺失属性，不接受任意错误原因或基础字段缺失", () => {
    const compatibilityAttempt = { originalExitCode: 1, reason: "missing_requested_properties", missingProperties: ["UnitFileState"] };
    expect(() => validate({ ...item(), compatibilityAttempt })).not.toThrow();
    for (const change of [{ originalExitCode: 0 }, { reason: "permission_denied" }, { missingProperties: ["MainPID"] },
      { missingProperties: ["UnitFileState", "UnitFileState"] }, { missingProperties: [] }]) {
      expect(() => validate({ ...item(), compatibilityAttempt: { ...compatibilityAttempt, ...change } })).toThrow();
    }
  });
});
