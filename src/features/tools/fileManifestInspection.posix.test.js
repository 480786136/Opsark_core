import { afterEach, describe, expect, it } from "vitest";
import { createPosixFixture, posixFixtureFs as fs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildFileManifestCommand, normalizeFileManifestRequest, parseFileManifestOutput } from "./fileManifestInspection";
const roots = [];
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const root = () => { const value = createPosixFixture(); roots.push(value); return value; };
afterEach(() => { for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true }); });
const inspect = args => {
  const request = normalizeFileManifestRequest(args), result = runPosixShell(buildFileManifestCommand(request), { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return parseFileManifestOutput(request, result.stdout);
};
describe("文件清单真实POSIX固定传输及跨语言摘要", () => {
  it("中文/引号/反斜杠/命令样式路径无损且内容不执行", () => {
    const base = root(), path = base + "/中文 ' \\ $(printf unsafe)";
    fs.mkdirSync(path); fs.writeFileSync(path + "/😀.txt", "body"); fs.writeFileSync(path + "/\ue000.txt", "body2");
    const data = inspect({ path, source: "directory" });
    expect(data.coverageComplete).toBe(true); expect(data.entries.map(row => row.path).sort()).toEqual(["😀.txt", "\ue000.txt"].sort());
  });
  it("真实tar.gz普通成员经生产Python/schema/关系摘要校验", () => {
    const base = root(), path = base + "/source", archive = base + "/release.tar.gz";
    fs.mkdirSync(path); fs.writeFileSync(path + "/index.html", "new release"); fs.writeFileSync(path + "/中文.css", "body{}");
    expect(runPosixShell(`tar -czf ${quote(archive)} -C ${quote(path)} .`).status).toBe(0);
    const data = inspect({ path: archive, source: "tar_gzip" });
    expect(data.coverageComplete).toBe(true); expect(data.archiveSha256).toMatch(/^[a-f0-9]{64}$/); expect(data.entries).toHaveLength(2);
  });
  it("目录链接只返回本体，单文件超限仍给有效partial", () => {
    const base = root(), path = base + "/source", outside = base + "/outside";
    fs.mkdirSync(path); fs.writeFileSync(outside, "outside secret"); fs.symlinkSync(outside, path + "/link");
    const link = inspect({ path, source: "directory" }); expect(link.coverageComplete).toBe(true); expect(link.safeForDeployment).toBe(false);
    fs.writeFileSync(path + "/large", "abcdef");
    const partial = inspect({ path, source: "directory", maxFileBytes: 2 }); expect(partial.status).toBe("partial"); expect(partial.manifestSha256).toBeNull();
  });
  it("归档内链接与错误压缩输入不会产生完整可部署清单", () => {
    const base = root(), source = base + "/source", target = base + "/target", archive = base + "/links.tar";
    fs.mkdirSync(source); fs.writeFileSync(target, "outside"); fs.symlinkSync(target, source + "/link");
    expect(runPosixShell(`tar -cf ${quote(archive)} -C ${quote(source)} .`).status).toBe(0);
    const data = inspect({ path: archive, source: "tar" }); expect(data.coverageComplete).toBe(false); expect(data.entries[0].reason).toBe("archive_link");
    const bad = inspect({ path: archive, source: "tar_gzip" }); expect(bad.coverageComplete).toBe(false); expect(bad.archiveSha256).toBeNull();
  });
  it("非法目录负载与空链接目标仍得到可消费的partial回执", () => {
    const base = root(), archive = base + "/invalid.tar";
    for (const kind of ["5", "2"]) {
      const script = `import io,tarfile; p=${JSON.stringify(archive)}; t=tarfile.open(p,'w'); i=tarfile.TarInfo('invalid'); i.type=b'${kind}'; i.size=${kind === "5" ? 1 : 0}; t.addfile(i,io.BytesIO(b'x')); t.close()`;
      expect(runPosixShell(`python3 -B -c ${quote(script)}`).status).toBe(0);
      const data = inspect({ path: archive, source: "tar" });
      expect(data.status).toBe("partial"); expect(data.entries[0].status).toBe("partial"); expect(data.manifestSha256).toBeNull();
    }
  });
});
