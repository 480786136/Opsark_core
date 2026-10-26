// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveApplicationReleaseHandover } from "./applicationReleaseSources";
import { normalizeApplicationReleaseHandover } from "./applicationReleaseContract";

const intent = (overrides = {}) => ({ operation: "deploy", runtimeKind: "systemd", projectPath: "/tmp/project", requestedVersion: "1.0.0",
  preserveConfiguration: true, preserveCurrentData: true, retainPreviousRelease: false, protectOtherServices: true,
  requiresBusinessWrite: false, requiresRecoveryExercise: false, ...overrides });
const source = (p, content) => ({ path: p, content, evidenceIds: ["real-source-receipt"] });
const artifact = (entries) => ({ request: { path: "/tmp/source", source: "directory" }, status: "complete", coverageComplete: true,
  safeForDeployment: true, truncated: false, entries: entries.map(p => ({ path: p, kind: "regular" })) });
const archive = path.resolve("../docs/Core测试/2026-10-11-第二轮/环境修复");
function original(name, files) {
  return files.map(file => source("/tmp/source/" + file, fs.readFileSync(path.join(archive, name, file), "utf8")));
}
const selection = (entries) => ({ releasePath: "/tmp/project/release", artifact: artifact(entries) });
describe("事前交接的有限角色映射", () => {
  it("原31中文Markdown及原Flask源码可映射unit/端口/WSGI/健康版本，不要求新增PID接口", () => {
    const texts = original("AGENT-31后端交付", ["部署说明.md", "api.py"]);
    const result = deriveApplicationReleaseHandover(intent(), texts[0], texts, selection(["api.py"]));
    expect(result.contract.unit).toBe("opsark-order-agent31.service");
    expect(result.contract.listenPort).toBe(18131);
    expect(result.contract.entryPath).toBe("/tmp/project/release/api.py");
    expect(result.contract.checks[0].equals).toContainEqual({ pointer: "/version", value: "1.0.0" });
    expect(result.contract.checks[0].equals.some(p => p.pointer === "/pid")).toBe(false);
    expect(result.contract.protection.data).toEqual([{ path: "/tmp/project/orders.json", kind: "file" }]);
  });
  it("原35源码中启动版本可绑定，动态磁盘hash不被当加载版本", () => {
    const texts = original("AGENT-35第003次-研发交付", ["发布说明.md", "app.py", "version.json"]);
    const result = deriveApplicationReleaseHandover(intent({ operation: "upgrade", requestedVersion: "2.0.0" }), texts[0], texts, selection(["app.py", "version.json"]));
    expect(result.contract.checks[0].equals).toContainEqual({ pointer: "/version", value: "2.0.0" });
    expect(result.contract.checks[0].equals).toContainEqual({ pointer: "/api_revision", value: 2 });
    expect(result.contract.checks[0].equals.some(p => p.pointer.includes("sha256"))).toBe(false);
  });
  it("原38回退交接把目标与对照单元分开且保留当前配置/数据路径", () => {
    const texts = original("AGENT-38旧版交付", ["发布说明.md", "app.py", "version.json"]);
    const result = deriveApplicationReleaseHandover(intent({ operation: "rollback", retainPreviousRelease: true }), texts[0], texts, selection(["app.py", "version.json"]));
    expect(result.contract.unit).toBe("opsark-order-agent38.service");
    expect(result.contract.protection.previousReleasePath).toBe("/tmp/project/releases/2.0.0");
    expect(result.contract.protection.data[0].path).toBe("/tmp/project/shared/orders.json");
  });
  it("同文出现的其他版本不能代替实际字段角色", () => {
    const texts = original("AGENT-31后端交付", ["部署说明.md", "api.py"]);
    texts[0].content += "\n以前1.1.0曾被计划但未交付。";
    expect(() => deriveApplicationReleaseHandover(intent({ requestedVersion: "1.1.0" }), texts[0], texts, selection(["api.py"]))).toThrow("目标运行版本");
  });
  it("目标unit声明冲突、没有完整产物或仅有响应正文都不能补合同", () => {
    const texts = original("AGENT-31后端交付", ["部署说明.md", "api.py"]);
    expect(() => deriveApplicationReleaseHandover(intent(), { ...texts[0], content: texts[0].content + "\n原服务为 another.service" }, texts, selection(["api.py"]))).toThrow("冲突");
    const selected = selection(["api.py"]); selected.artifact.coverageComplete = false;
    expect(() => deriveApplicationReleaseHandover(intent(), texts[0], texts, selected)).toThrow("完整");
    expect(() => deriveApplicationReleaseHandover(intent(), texts[0], [texts[0]], selection(["api.py"]))).toThrow("事前正文");
  });
});
describe("结构化交接边界", () => {
  const contract = () => ({ version: 1, operation: "deploy", runtimeKind: "systemd", projectPath: "/tmp/project",
    artifact: { path: "/tmp/source", source: "directory", entryPrefix: "" }, releasePath: "/tmp/project/release", entryPath: "/tmp/project/release/app.py",
    unit: "app.service", listenAddress: "127.0.0.1", listenPort: 8080,
    checks: [{ url: "http://127.0.0.1:8080/health", method: "GET", effect: "read", expectedStatus: 200, equals: [{ pointer: "/version", value: "1.0.0" }] }],
    protection: { scopeComplete: true, configuration: [{ path: "/tmp/project/config", kind: "file" }], data: [{ path: "/tmp/project/data", kind: "file" }],
      dataPolicy: "quiescent_files", otherUnits: [], previousReleasePath: null } });
  it("完整JSON由Core解析，不接受模型覆盖目标", () => {
    const body = source("/tmp/source/release.json", JSON.stringify(contract()));
    expect(deriveApplicationReleaseHandover(intent(), body, [body], selection(["app.py"])).contract.unit).toBe("app.service");
    expect(() => deriveApplicationReleaseHandover(intent(), body, [body], { ...selection(["app.py"]), releasePath: "/tmp/other" })).toThrow("布局");
  });
  it("重复JSON键、额外伪造met、副作用GET和不明保护集合不能通过", () => {
    const text = JSON.stringify(contract()).replace('"version":1', '"version":1,"version":1');
    expect(() => deriveApplicationReleaseHandover(intent(), source("/tmp/a", text), [], selection(["app.py"]))).toThrow();
    expect(() => normalizeApplicationReleaseHandover({ ...contract(), met: true })).toThrow();
    const bad = contract(); bad.checks[0].effect = "change";
    expect(() => normalizeApplicationReleaseHandover(bad)).toThrow();
    const incomplete = contract(); incomplete.protection.scopeComplete = false;
    expect(() => normalizeApplicationReleaseHandover(incomplete)).toThrow();
  });
});
