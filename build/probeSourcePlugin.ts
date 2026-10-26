import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { normalizePath, type Plugin } from "vite";
import type { PackedProbeSource } from "../src/features/tools/probeDelivery";

const QUERY = "?opsark-probe";
const VIRTUAL_PREFIX = "\0opsark-probe:";
const SOURCES = ["operations_probe.py", "package_probe.py"] as const;

/** The same loader is installed in dev, production build and Vitest. No generated source copies. */
export function probeSourcePlugin(): Plugin {
  let allowed = new Set<string>();
  return {
    name: "opsark-packed-probe-source",
    enforce: "pre",
    configResolved(config) {
      allowed = new Set(SOURCES.map(name => normalizePath(resolve(config.root, "src/features/tools", name))));
    },
    async resolveId(id, importer) {
      if (!id.includes("?opsark-probe")) return null;
      if (!id.endsWith(QUERY) || id.indexOf("?") !== id.length - QUERY.length) {
        throw new Error("探针源仅接受固定 ?opsark-probe 查询");
      }
      const resolution = await this.resolve(id.slice(0, -QUERY.length), importer, { skipSelf: true });
      const path = resolution && normalizePath(resolution.id);
      if (!path || !allowed.has(path)) throw new Error("只能打包已登记的 operations/package 探针源");
      return VIRTUAL_PREFIX + path;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const path = id.slice(VIRTUAL_PREFIX.length);
      if (!allowed.has(path)) throw new Error("未知探针虚拟模块");
      this.addWatchFile(path);
      // Buffer preserves CRLF and every source byte. Read anew on each invalidated load.
      const source = readFileSync(path);
      if (source.length === 0 || source.length > 1024 * 1024) throw new Error("探针源码大小超出打包边界");
      const compressed = deflateSync(source, { level: 9 });
      if (!inflateSync(compressed, { maxOutputLength: source.length + 1 }).equals(source)) {
        throw new Error("探针压缩还原校验失败");
      }
      const packed: PackedProbeSource = {
        version: 1, encoding: "zlib-base64", data: compressed.toString("base64"),
        sourceBytes: source.length, sourceSha256: createHash("sha256").update(source).digest("hex"),
      };
      return `export default Object.freeze(${JSON.stringify(packed)});`;
    },
    handleHotUpdate(context) {
      const path = normalizePath(context.file);
      if (!allowed.has(path)) return;
      const packed = context.server.moduleGraph.getModuleById(VIRTUAL_PREFIX + path);
      if (!packed) return;
      context.server.moduleGraph.invalidateModule(packed);
      return [...new Set([...context.modules, packed])];
    },
  };
}
