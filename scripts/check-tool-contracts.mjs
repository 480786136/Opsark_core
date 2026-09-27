// One gate for catalog drift and the shared TS/Rust/Python validation corpus.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const core = fileURLToPath(new URL("../", import.meta.url));
const admin = fileURLToPath(new URL("../../Opsark_admin/", import.meta.url));
const venvPython = join(admin, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.OPSARK_CONTRACT_PYTHON || (existsSync(venvPython) ? venvPython : "python3");
const jobs = [
  [process.execPath, ["scripts/export-official-catalog.mjs", "--check"], core],
  [process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/features/tools/toolContracts.test.ts"], core],
  ["cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "schema_validation::tests"], core],
  [python, ["-m", "pytest", "-q", "tests/test_tool_contracts.py"], admin],
];
for (const [command, args, cwd] of jobs) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Tool contracts agree across TypeScript, Rust and Python.");
