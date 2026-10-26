import { afterEach, describe, expect, it } from "vitest";
import { createPosixFixture, posixFixtureFs as fs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildFileManifestCommand, normalizeFileManifestRequest, parseFileManifestOutput } from "../tools/fileManifestInspection";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root); });
const quote = text => "'" + text.replace(/'/g, "'\"'\"'") + "'";
function inspect(path, source) {
  const request = normalizeFileManifestRequest({ path, source });
  const result = runPosixShell(buildFileManifestCommand(request), { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return parseFileManifestOutput(request, result.stdout);
}
describe("静态交付审查：真实POSIX清单语义", () => {
  it("真实tar可省略父目录成员，生产探针仍判双方完整并给出一致文件摘要", () => {
    const root = createPosixFixture(); roots.push(root);
    const site = root + "/site", archive = root + "/site.tar.gz";
    fs.mkdirSync(site); fs.mkdirSync(site + "/assets");
    fs.writeFileSync(site + "/index.html", '<link rel="stylesheet" href="assets/app.css">');
    fs.writeFileSync(site + "/assets/app.css", "body{}");
    const tar = runPosixShell(`tar --no-recursion -czf ${quote(archive)} -C ${quote(site)} index.html assets/app.css`);
    expect(tar.status, tar.stderr).toBe(0);
    const bundle = inspect(archive, "tar_gzip"), directory = inspect(site, "directory");
    expect(bundle.coverageComplete).toBe(true); expect(directory.coverageComplete).toBe(true);
    expect(bundle.entries.some(e => e.path === "assets")).toBe(false);
    expect(directory.entries.find(e => e.path === "assets")).toMatchObject({ kind: "directory", sizeBytes: 0 });
    const files = data => data.entries.filter(e => e.kind === "regular").map(e => [e.path, e.sizeBytes, e.sha256]).sort();
    expect(files(bundle)).toEqual(files(directory));
    // A raw full-entry digest must differ. Business equality must deliberately
    // normalize implicit parent directories, without dropping empty directories.
    expect(bundle.manifestSha256).not.toBe(directory.manifestSha256);
  });
});
