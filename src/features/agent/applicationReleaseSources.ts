import { normalizeApplicationReleaseHandover, applicationIntentIssue, releasePathIsCanonical,
  type ApplicationReleaseHandover, type ApplicationReleaseIntent } from "./applicationReleaseContract";
import type { FileManifestResult } from "../tools/fileManifestInspection";

export interface ReleaseSourceText { path: string; content: string; evidenceIds: string[] }
export interface ReleaseSourceMapping { role: string; path: string; selector: string; value: unknown }
export interface ReleaseSourceSelection { releasePath: string; artifact: FileManifestResult }
const dirname = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const unique = <T>(values: T[]): T | undefined => values.length && new Set(values.map(v => JSON.stringify(v))).size === 1 ? values[0] : undefined;
const quoted = "[\"']([^\"'\\r\\n]+)[\"']";
const exactSource = (sources: ReleaseSourceText[], path: string) => { const found = sources.filter(s => s.path === path); return found.length === 1 ? found[0] : undefined; };
const json = (s: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(s);
    const stack: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
    for (const token of s.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/g)) {
      const t = token[0], top = stack[stack.length - 1];
      if (t === "{" || t === "[") stack.push({ object: t === "{", keys: new Set(), key: t === "{" });
      else if (t === "}" || t === "]") stack.pop();
      else if (t === "," && top?.object) top.key = true;
      else if (t === ":" && top) top.key = false;
      else if (t.startsWith('"') && top?.object && top.key) { const key = JSON.parse(t) as string; if (top.keys.has(key)) throw new Error("重复JSON键"); top.keys.add(key); }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Invalid or ambiguous JSON cannot become a structured contract. */ }
};

/** Finite role extraction. Ambiguous prose stays unknown, never substring acceptance. */
export function deriveApplicationReleaseHandover(intent: ApplicationReleaseIntent, handover: ReleaseSourceText,
  sources: ReleaseSourceText[], selection: ReleaseSourceSelection): { contract: ApplicationReleaseHandover; mappings: ReleaseSourceMapping[]; limitations: string[] } {
  const structured = json(handover.content);
  if (structured?.version === 1 && structured.runtimeKind === "systemd") {
    const contract = normalizeApplicationReleaseHandover(structured);
    const issue = applicationIntentIssue(intent, contract); if (issue) throw new Error(issue);
    if (contract.releasePath !== selection.releasePath || contract.artifact.path !== selection.artifact.request.path
      || contract.artifact.source !== selection.artifact.request.source) throw new Error("规划布局/产物与交接声明不符");
    return { contract, mappings: [{ role: "complete_handover", path: handover.path, selector: "JSON root", value: "validated_complete_contract" }],
      limitations: ["handover_is_declared_scope_not_authorization", "read_endpoint_effect_declared_by_handover"] };
  }
  if (!intent.projectPath || !releasePathIsCanonical(intent.projectPath)) throw new Error("Markdown交接需先明确项目根目录；未知目标请正常澄清");
  if (!selection.releasePath.startsWith(intent.projectPath + "/") && selection.releasePath !== intent.projectPath) throw new Error("发布布局超出用户项目目录");
  const mappings: ReleaseSourceMapping[] = [];
  const take = <T>(role: string, values: T[], source = handover, selector = role): T => {
    const value = unique(values); if (value === undefined) throw new Error(`交接字段 ${role} 缺失或冲突，请正常澄清`);
    mappings.push({ role, path: source.path, selector, value }); return value;
  };
  const unit = take("systemd_unit", [...handover.content.matchAll(/(?:systemd\s*(?:独立)?单元\s*|原服务为\s*|(?:^|[。；，,\s])单元\s*)([A-Za-z0-9_.@:-]+\.service)/gm)].map(m => m[1]!));
  const listen = [...handover.content.matchAll(/监听\s*((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})/g)];
  const ports = [...listen.map(m => Number(m[2])), ...[...handover.content.matchAll(/(?:服务访问端口(?:保持|为)?|接口为本机|监听端口(?:为)?)\s*(\d{1,5})/g)].map(m => Number(m[1]))];
  const listenPort = take("listen_port", ports);
  const listenAddress = listen.length ? take("listen_address", listen.map(m => m[1]!)) : "127.0.0.1";
  if (!listen.length) mappings.push({ role: "listen_address", path: handover.path, selector: "本机接口", value: listenAddress });
  const artifact = selection.artifact;
  if (artifact.status !== "complete" || !artifact.coverageComplete || !artifact.safeForDeployment || artifact.truncated) throw new Error("目标产物必须先有完整只读清单");
  const pythonFiles = artifact.entries.filter(e => e.kind === "regular" && e.path.endsWith(".py"));
  const wsgi = unique([...handover.content.matchAll(/WSGI\s*入口\s*([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => `${m[1]}.py`));
  const entryMember = take("entry_member", pythonFiles.filter(e => wsgi ? e.path === wsgi || e.path.endsWith("/" + wsgi) : pythonFiles.length === 1).map(e => e.path), handover, wsgi ? "WSGI module → .py" : "唯一普通Python程序成员");
  const prefix = dirname(entryMember);
  const entryName = entryMember.slice(prefix ? prefix.length + 1 : 0);
  if (artifact.request.source !== "directory") throw new Error("归档正文尚未有固定只读成员读取，需提供相同发布源目录的真实正文收据；不能执行解压后倒造事前来源");
  const sourceEntry = exactSource(sources, artifact.request.path + "/" + entryMember);
  if (!sourceEntry) throw new Error("缺少产物中程序入口的完整事前正文");
  // health/version equals must come from an explicit response role, not any
  // number appearing in a changelog or a later HTTP result.
  const predicates: Array<{ pointer: string; value: string | number | boolean | null }> = [];
  const route = new RegExp(`@app\\.route\\(\\s*${quoted}\\s*\\)\\s*\\ndef\\s+[A-Za-z_][A-Za-z0-9_]*\\(\\):\\s*\\n[ \\t]+return jsonify\\(([^\\n]*)\\)`, "g");
  let healthPath: string | undefined;
  for (const match of sourceEntry.content.matchAll(route)) {
    if (match[1] !== "/health") continue;
    healthPath = match[1];
    const tokens = match[2]!.split(/,\s*/);
    for (const token of tokens) {
      const literal = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)'|(-?\d+(?:\.\d+)?)|(True|False|None))$/.exec(token.trim());
      if (!literal) continue;
      const value = literal[2] ?? literal[3] ?? (literal[4] !== undefined ? Number(literal[4]) : literal[5] === "None" ? null : literal[5] === "True");
      predicates.push({ pointer: "/" + literal[1], value });
      mappings.push({ role: "health_response_literal", path: sourceEntry.path, selector: `Flask route ${healthPath} jsonify.${literal[1]}`, value });
    }
  }
  if (!healthPath) {
    // Finite standard-library response mapping: VERSION["field"] in the
    // explicitly named /health or /version branch, backed by the peer manifest.
    const versions = sources.filter(s => dirname(s.path) === dirname(sourceEntry.path) && s.path.endsWith("/version.json"));
    const versionSource = versions.length === 1 ? versions[0] : undefined;
    const version = versionSource && json(versionSource.content);
    const versionLoad = /^VERSION\s*=\s*json\.loads\(CODE\.with_name\(['"]version\.json['"]\)\.read_text\(encoding=['"]utf-8['"]\)\)(?:\[['"]version['"]\])?\s*$/m.test(sourceEntry.content)
      && /^CODE\s*=\s*Path\(__file__\)\.resolve\(\)\s*$/m.test(sourceEntry.content);
    if (versionSource && version && versionLoad && /["']\/health["']/.test(sourceEntry.content)) {
      for (const key of ["version", "api_revision", "release_id"]) {
        const expression = new RegExp(`["']${key}["']\\s*:\\s*VERSION\\[\\s*["']${key}["']\\s*\\]`);
        const value = version[key];
        if (expression.test(sourceEntry.content) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)) {
          predicates.push({ pointer: "/" + key, value }); mappings.push({ role: "health_version_mapping", path: versionSource.path, selector: "/" + key, value });
        }
      }
      // A literal startup VERSION and REVISION used in the health response are
      // startup observations, unlike code_sha256 which reads disk per request.
      const healthBranch = /if self\.path in \(\s*['"]\/health['"]\s*,\s*['"]\/version['"]\s*\):\s*\n\s+self\.reply\(200, dict\(([\s\S]*?)\)\)\s*\n\s*elif/.exec(sourceEntry.content)?.[1];
      if (healthBranch && /\bversion\s*=\s*VERSION\b/.test(healthBranch) && typeof version.version === "string"
        && /\[['"]version['"]\]\s*$/m.test(sourceEntry.content.split(/\r?\n/).find(l => /^VERSION\s*=/.test(l)) ?? "")) {
        predicates.push({ pointer: "/version", value: version.version });
        mappings.push({ role: "startup_version", path: versionSource.path, selector: "/version → VERSION → health.version", value: version.version });
        const revision = /^REVISION\s*=\s*(\d+)\s*$/m.exec(sourceEntry.content)?.[1];
        if (revision && /\bapi_revision\s*=\s*REVISION\b/.test(healthBranch)) {
          predicates.push({ pointer: "/api_revision", value: Number(revision) });
          mappings.push({ role: "startup_api_revision", path: sourceEntry.path, selector: "literal REVISION → health.api_revision", value: Number(revision) });
        }
      }
      healthPath = predicates.length ? "/health" : undefined;
    }
  }
  if (!healthPath || !predicates.some(p => p.pointer === "/version") || !/GET\s*\/health|接口.{0,60}\/health|健康接口/.test(handover.content)) throw new Error("缺少健康接口、启动版本与事前源码字段的有限映射；不得从响应反推预期");
  const configNames = [...new Set([...handover.content.matchAll(/(?:[A-Za-z0-9_.-]+\/)*(?:config|settings)\.json/g)].map(m => m[0]))];
  const dataNames = [...new Set([...handover.content.matchAll(/(?:[A-Za-z0-9_.-]+\/)*(?:orders|data)\.json/g)].map(m => m[0]))];
  if ((intent.preserveConfiguration && !configNames.length) || (intent.preserveCurrentData && !dataNames.length)) throw new Error("交接未给可解释的完整配置/数据角色，请正常澄清而非缩小范围");
  if (intent.operation !== "deploy" && !/无数据迁移|不需要迁移|格式兼容/.test(handover.content)) throw new Error("升级/回退数据兼容依据尚未解释");
  const previous = unique([...handover.content.matchAll(/current\s*指向\s*([A-Za-z0-9_./-]+)/g)].map(m => m[1]!));
  const previousReleasePath = previous && !previous.startsWith("/") && releasePathIsCanonical("/" + previous) ? intent.projectPath + "/" + previous : null;
  if (intent.retainPreviousRelease && !previousReleasePath) throw new Error("旧发布材料位置及恢复要求尚未结构化绑定，请补充明确交接；不能凭旧文件存在判可恢复");
  const contract = normalizeApplicationReleaseHandover({ version: 1, operation: intent.operation, runtimeKind: "systemd", projectPath: intent.projectPath,
    artifact: { path: artifact.request.path, source: artifact.request.source, entryPrefix: prefix }, releasePath: selection.releasePath,
    entryPath: selection.releasePath + "/" + entryName, unit, listenAddress, listenPort,
    checks: [{ url: `http://${listenAddress === "0.0.0.0" ? "127.0.0.1" : listenAddress}:${listenPort}${healthPath}`, method: "GET", effect: "read", expectedStatus: 200, equals: predicates }],
    protection: { scopeComplete: true, configuration: configNames.map(n => ({ path: intent.projectPath + "/" + n, kind: "file" })),
      data: dataNames.map(n => ({ path: intent.projectPath + "/" + n, kind: "file" })), dataPolicy: "quiescent_files", otherUnits: [], previousReleasePath } });
  // Other services use a full manager inventory, never a model-picked list.
  const issue = applicationIntentIssue({ ...intent, protectOtherServices: false }, contract); if (issue) throw new Error(issue);
  return { contract, mappings, limitations: ["finite_markdown_and_python_roles", "natural_language_completeness_requires_review",
    "read_endpoint_effect_declared_by_handover", "disk_digest_is_not_loaded_code", "all_loaded_services_inventory_required_for_other_services"] };
}
