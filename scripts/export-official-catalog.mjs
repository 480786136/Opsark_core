// Export the compiled baseline for Admin; this never publishes to a running service.
import { createServer } from "vite";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const server = await createServer({ optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { builtInSkillCatalog } = await server.ssrLoadModule("/src/features/skills/skillCatalog.ts");
  const { defaultToolCatalog } = await server.ssrLoadModule("/src/features/tools/toolCatalog.ts");
  const { toolResultSchema } = await server.ssrLoadModule("/src/features/tools/toolOutputSchemas.ts");
  const contractPath = fileURLToPath(new URL("../contracts/tool-contracts.json", import.meta.url));
  const contracts = { schemaVersion: 1, dialect: "http://json-schema.org/draft-07/schema#", resultSchema: toolResultSchema,
    tools: defaultToolCatalog.map(({ id, inputSchema, outputSchema }) => ({ id, inputSchema, ...(outputSchema ? { outputSchema } : {}) })) };
  if (process.argv.includes("--check")) {
    if (!isDeepStrictEqual(JSON.parse(await readFile(contractPath, "utf8")), contracts)) throw new Error("Tool contracts are out of date");
  } else {
    await mkdir(fileURLToPath(new URL("../contracts/", import.meta.url)), { recursive: true });
    await writeFile(contractPath, JSON.stringify(contracts, null, 2) + "\n");
  }
  const fields = ["id", "name", "category", "description", "instructions", "matchRules", "version", "enabled"];
  const skills = builtInSkillCatalog.map(skill => Object.fromEntries(fields.filter(key => skill[key] !== undefined).map(key => [key, skill[key]])));
  const path = fileURLToPath(new URL("../../Opsark_admin/app/resources/core_catalog.json", import.meta.url));
  await mkdir(fileURLToPath(new URL("../../Opsark_admin/app/resources/", import.meta.url)), { recursive: true });
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const catalog = { core_version: version, skills, tools: defaultToolCatalog };
  if (process.argv.includes("--check")) {
    if (!isDeepStrictEqual(JSON.parse(await readFile(path, "utf8")), catalog)) {
      throw new Error("Admin catalog is out of date; review and run export-official-catalog.mjs");
    }
    console.log("Admin and Core catalogs match.");
  } else {
    await writeFile(path, JSON.stringify(catalog, null, 2) + "\n");
    console.log(`Exported ${skills.length} Skills and ${defaultToolCatalog.length} tools to ${path}`);
  }
} finally { await server.close(); }
