// Export the compiled baseline for Admin; this never publishes to a running service.
import { createServer } from "vite";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { builtInSkillCatalog } = await server.ssrLoadModule("/src/features/skills/skillCatalog.ts");
  const { defaultToolCatalog } = await server.ssrLoadModule("/src/features/tools/toolCatalog.ts");
  const fields = ["id", "name", "category", "description", "instructions", "matchRules", "version", "enabled", "allowShell", "allowedToolIds", "forbiddenToolIds"];
  const skills = builtInSkillCatalog.map(skill => Object.fromEntries(fields.filter(key => skill[key] !== undefined).map(key => [key, skill[key]])));
  const path = fileURLToPath(new URL("../../Opsark_admin/app/resources/core_catalog.json", import.meta.url));
  await mkdir(fileURLToPath(new URL("../../Opsark_admin/app/resources/", import.meta.url)), { recursive: true });
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await writeFile(path, JSON.stringify({ core_version: version, skills, tools: defaultToolCatalog }, null, 2) + "\n");
  console.log(`Exported ${skills.length} Skills and ${defaultToolCatalog.length} tools to ${path}`);
} finally { await server.close(); }
