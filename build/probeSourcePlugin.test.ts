// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { build, createServer, normalizePath } from "vite";
import { probeSourcePlugin } from "./probeSourcePlugin";
import operations from "../src/features/tools/operations_probe.py?opsark-probe";
import packages from "../src/features/tools/package_probe.py?opsark-probe";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "opsark-probe-source-")); roots.push(root);
  mkdirSync(join(root, "src/features/tools"), { recursive: true });
  for (const name of ["operations_probe.py", "package_probe.py"]) {
    writeFileSync(join(root, "src/features/tools", name), Buffer.from('# 原始换行\r\nprint("fixture")\r\n', "utf8"));
  }
  writeFileSync(join(root, "entry.js"), 'export { default } from "./src/features/tools/operations_probe.py?opsark-probe";');
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || resolve(root, "..") !== resolve(tmpdir()) || !basename(root).startsWith("opsark-probe-source-")) {
      throw new Error("拒绝清理不属于测试的目录");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("固定探针构建源", () => {
  it("Vitest加载原两文件，每个原字节、长度和SHA一致，未手工存放Base64", () => {
    for (const [name, packed] of [["operations_probe.py", operations], ["package_probe.py", packages]] as const) {
      const bytes = readFileSync(join(process.cwd(), "src/features/tools", name));
      expect(packed).toMatchObject({ version: 1, encoding: "zlib-base64", sourceBytes: bytes.length,
        sourceSha256: createHash("sha256").update(bytes).digest("hex") });
      expect(inflateSync(Buffer.from(packed.data, "base64"))).toEqual(bytes);
      expect(packed.data.length).toBeLessThan(bytes.length);
    }
  });

  it("dev与build生成同合同，CRLF/Unicode保真，HMR失效后读取新源", async () => {
    const root = fixture(), plugin = probeSourcePlugin();
    const server = await createServer({ root, configFile: false, logLevel: "error", plugins: [plugin],
      server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
    try {
      const initial = (await server.ssrLoadModule("/entry.js")).default;
      const bundle = await build({ root, configFile: false, logLevel: "error", plugins: [probeSourcePlugin()],
        build: { write: false, minify: false, lib: { entry: join(root, "entry.js"), formats: ["cjs"], fileName: "probe" } } });
      const chunk = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === "chunk");
      if (!chunk || chunk.type !== "chunk") throw new Error("构建没有模块输出");
      const module = { exports: {} };
      new Function("module", "exports", chunk.code)(module, module.exports);
      expect(module.exports).toEqual(initial);
      expect(inflateSync(Buffer.from(initial.data, "base64"))).toEqual(readFileSync(join(root, "src/features/tools/operations_probe.py")));

      const path = join(root, "src/features/tools/operations_probe.py");
      const changed = Buffer.from('# 变更后仍保留原字节\r\nprint("new")\n');
      writeFileSync(path, changed);
      const moduleNode = server.moduleGraph.getModuleById("\0opsark-probe:" + normalizePath(path));
      expect(moduleNode).toBeDefined();
      const update = plugin.handleHotUpdate as Function;
      const invalidated = await update({ file: path, modules: [], server });
      expect(invalidated).toContain(moduleNode);
      const refreshed = (await server.ssrLoadModule("/entry.js")).default;
      expect(refreshed.sourceSha256).not.toBe(initial.sourceSha256);
      expect(inflateSync(Buffer.from(refreshed.data, "base64"))).toEqual(changed);
    } finally { await server.close(); }
  }, 20000);

  it("拒绝任意路径/额外query/伪虚拟模块，普通raw导入不受影响", async () => {
    const root = fixture();
    writeFileSync(join(root, "unregistered.py"), 'print("not allowed")');
    const plugin = probeSourcePlugin();
    const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [plugin],
      server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
    try {
      for (const id of ["/unregistered.py?opsark-probe", "/src/features/tools/operations_probe.py?opsark-probe&raw",
        "/src/features/tools/operations_probe.py?raw?opsark-probe"]) {
        await expect(server.pluginContainer.resolveId(id)).rejects.toThrow();
      }
      const load = plugin.load as Function;
      expect(() => load.call({ addWatchFile() {} }, "\0opsark-probe:" + normalizePath(join(root, "unregistered.py")))).toThrow();
      expect((await server.ssrLoadModule("/src/features/tools/operations_probe.py?raw")).default).toContain('print("fixture")');
    } finally { await server.close(); }
  }, 20000);
});
