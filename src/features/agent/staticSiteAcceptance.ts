import type { ExecutionInputBinding, OpsTask, PlanStep, ServerProfile, TaskRequirementItem, TaskRequirementUpdate } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { restoreArchivedExecutionResult, type ExecutionReceiptReader } from "@/services/executionReceiptArchive";
import { enforceToolResult } from "@/features/tools/toolResultContract";
import type { FileManifestResult } from "@/features/tools/fileManifestInspection";
import type { HttpDeliveryResult } from "@/features/tools/httpDeliveryInspection";
import type { NginxConfigResult } from "@/features/tools/nginxConfigContracts";
import { canonicalExecutionJson, executionDigest, executionIntentMatches, sha256Utf8 } from "./planPreparation";
import { inspectNginxConfigurationFromLedger, precisePaths, reconciledAt } from "./nginxConfigRuntime";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const path = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && v !== "/" && !/[\u0000-\u001f\u007f\\]/.test(v)
  && !v.includes("//") && !v.split("/").some(p => p === "." || p === "..");
const effective = (i: TaskRequirementItem) => i.status === "active" || i.status === "satisfied";
const last = <T>(a: T[]) => a[a.length - 1];
const overlap = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
function url(value: string): URL | undefined {
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.hash ? u : undefined; } catch { return; }
}

/** Source checks do not pretend to prove arbitrary natural-language semantics. */
export function validateAcceptanceCoverage(update: TaskRequirementUpdate, source: string): void {
  if (update.acceptanceCoverage === undefined) return; // Explicit legacy protocol only.
  const coverage = update.acceptanceCoverage;
  if (!Array.isArray(coverage) || coverage.length !== update.additions.length
    || new Set(coverage.map(i => i.requirementId)).size !== coverage.length) throw new Error("验收策略必须逐项覆盖本次新增目标及约束，不能遗漏或重复");
  for (const item of coverage) {
    const addition = update.additions.find(i => i.id === item.requirementId);
    if (!addition || !nonempty(item.sourceQuote) || !source.includes(item.sourceQuote) || !nonempty(item.reason)) throw new Error("验收策略缺少当前用户原文、条目或分类理由");
    if (item.strategy === "general_review") {
      if (item.staticSite !== undefined) throw new Error("通用验收不能夹带或替代静态站点契约");
    } else if (item.strategy === "static_site") {
      const s = item.staticSite;
      if (addition.kind !== "goal" || !s || typeof s.preserveExisting !== "boolean" || typeof s.preserveOtherSites !== "boolean"
        || s.artifactPath !== null && (!path(s.artifactPath) || !source.includes(s.artifactPath))
        || s.entryUrl !== null && (typeof s.entryUrl !== "string" || !url(s.entryUrl) || !source.includes(s.entryUrl))) throw new Error("静态交付需要用户来源明确的包路径、入口及保护条件；未知参数必须保留null");
    } else throw new Error("未知验收策略不能回退为通用完成");
  }
}

export const staticSiteRequirements = (task: OpsTask) => (task.requirementLifecycle?.items ?? []).filter(i => effective(i) && i.acceptance?.strategy === "static_site");
export function acceptanceContractDigest(task: OpsTask): string | undefined {
  if (!staticSiteRequirements(task).length) return;
  return executionDigest({ taskId: task.id, serverId: task.executionTargetServerId ?? task.serverId,
    requirements: task.requirementLifecycle!.items.filter(effective).map(i => ({ id: i.id, content: i.content, source: i.source,
      changedAt: i.lastChangedAt, acceptance: i.acceptance })) });
}
interface Receipt<T> { operation: ExecutionOperationRecord; started: number; ended: number; refs: string[]; data: T }
interface TextReceipt { path: string; content: string; totalBytes: number; returnedBytes: number; truncated: boolean; encoding: string }
interface Condition { id: string; state: "met" | "not_met" | "unknown"; reason: string; evidenceIds: string[] }
export interface StaticSiteAssessment {
  requirementId: string; state: "met" | "not_met" | "unknown"; baselineReady: boolean;
  rootPath?: string; baselineDigest?: string; conditions: Condition[];
  nextActions: string[]; evidenceIds: string[];
}
export interface StaticSiteAcceptanceSnapshot {
  contractDigest: string; serverId: string; connectionGeneration: number; assessments: StaticSiteAssessment[];
  limitations: string[];
}
// Only the controller's ledger reader installs authority. Persistence/model text
// may display a summary but can never restore a completion grant.
const authority = new WeakMap<OpsTask, StaticSiteAcceptanceSnapshot>();
export function clearStaticSiteAcceptance(task: OpsTask) { authority.delete(task); }
export function staticSiteAcceptanceContext(task: OpsTask) {
  const requirements = (task.requirementLifecycle?.items ?? []).filter(effective).filter(i => i.acceptance)
    .map(i => ({ requirementId: i.id, ...clone(i.acceptance!) }));
  const digest = acceptanceContractDigest(task), snapshot = authority.get(task);
  return { requirements, ...(digest && snapshot?.contractDigest === digest ? { assessment: clone(snapshot) } : {}),
    instruction: "验收策略来自用户需求并已固定；static_site不能改为通用复核。按Core列出的缺口推进真实备份、最小部署及验收；不能用HTTP200、备份退出0、模型理由或重复采样声称完成。general_review仍须原有全部目标、约束与证据复核。未解释或不支持的条件保持未知。" };
}
export function staticSiteApprovalBindings(task: OpsTask): ExecutionInputBinding[] {
  const digest = acceptanceContractDigest(task);
  if (!digest) return [];
  const snapshot = authority.get(task);
  return [{ key: "core.static-site.acceptance", reference: `acceptance:${task.id}`, target: task.executionTargetServerId ?? task.serverId,
    version: executionDigest({ contract: digest, baselines: snapshot?.contractDigest === digest
      ? snapshot.assessments.map(i => ({ id: i.requirementId, baseline: i.baselineDigest ?? null })) : [] }) }];
}
export function assertStaticSiteMutation(task: OpsTask, step: PlanStep): void {
  if (!staticSiteRequirements(task).length || step.executionIntent?.semantic.effect !== "change") return;
  const snapshot = authority.get(task);
  // Do not turn a business predicate into a new global Shell authorization
  // policy. Before resource discovery, existing safety/approval gates still own
  // prerequisite actions. An unidentifiable earlier write prevents completion.
  const paths = step.executionIntent.semantic.targets.map(t => t.path).filter((p): p is string => !!p);
  if (!snapshot || snapshot.contractDigest !== acceptanceContractDigest(task)) return;
  if (snapshot.assessments.some(a => !a.baselineReady && a.rootPath && paths.some(p => overlap(p,a.rootPath!)))) {
    throw new Error("STATIC_SITE_BASELINE_REQUIRED: 修改前须取得完整交付包、目标目录和受保护站点基线；请按静态交付缺口继续只读发现");
  }
}
export function assertStaticSiteRequirementComplete(task: OpsTask, requirementId: string): void {
  if (!staticSiteRequirements(task).some(i => i.id === requirementId)) return;
  const snapshot = authority.get(task), assessment = snapshot?.assessments.find(i => i.requirementId === requirementId);
  if (!snapshot || snapshot.contractDigest !== acceptanceContractDigest(task) || assessment?.state !== "met") {
    throw new Error(`静态站点目标尚未取得确定性业务验收：${assessment?.conditions.filter(i => i.state !== "met").map(i => i.reason).join("；") || "缺少当前执行账本核验"}`);
  }
}

function sameEndpoint(o: ExecutionOperationRecord, server: ServerProfile) {
  return o.intent.semantic.targets.some(t => t.serverId === server.id || t.host.toLowerCase() === server.host.toLowerCase() && t.port === server.port);
}
function receipt<T>(o: ExecutionOperationRecord, task: OpsTask, server: ServerProfile, generation: number, tool: string, historical = false): Receipt<T> | undefined {
  const a = last(o.attempts), s = o.intent.semantic;
  if (o.taskId !== task.id || s.taskId !== task.id || !historical && (o.roundId !== task.currentRoundId || o.workflowEpoch !== (task.workflowEpoch ?? 0))
    || o.phase !== "tool" || o.state !== "succeeded" || o.effect !== "read" || s.effect !== "read" || o.cancelRequested
    || !executionIntentMatches(o.intent, o.intent) || o.intentDigest !== o.intent.digest
    || s.action.type !== "tool" || s.action.toolId !== tool || !s.targets.length
    || !s.targets.every(t => t.serverId === server.id && t.host.toLowerCase() === server.host.toLowerCase() && t.port === server.port
      && t.username === server.username && (historical ? Number.isSafeInteger(t.connectionGeneration) : t.connectionGeneration === generation))
    || !a || a.status !== "succeeded" || a.outcome?.status !== "succeeded" || a.late || a.cancelRequested
    || a.operationId !== o.operationId || !Number.isFinite(a.startedAt) || !Number.isFinite(a.completedAt) || a.completedAt! < a.startedAt
    || !a.outcome.evidenceRefs.length || new Set(a.outcome.evidenceRefs).size !== a.outcome.evidenceRefs.length) return;
  const r = enforceToolResult({ id: a.executionId, toolId: tool, arguments: s.action.arguments }, a.outcome.result);
  if (!r.success || !r.data || (r.data as { observationsRedacted?: boolean }).observationsRedacted) return;
  return { operation: o, started: a.startedAt, ended: a.completedAt!, refs: a.outcome.evidenceRefs, data: r.data as T };
}
const manifestComplete = (r: Receipt<FileManifestResult>) => r.data.status === "complete" && r.data.coverageComplete && !r.data.truncated
  && r.data.safeForDeployment && !!r.data.manifestSha256 && r.data.entries.every(e => e.status === "complete" && ["regular", "directory"].includes(e.kind));
const contentFingerprint = (m: FileManifestResult) => {
  const rows = new Map(m.entries.map(e => [e.path, { path: e.path, kind: e.kind, size: e.sizeBytes, sha: e.sha256 }]));
  // A tar may omit implicit parent directory headers; a filesystem cannot.
  for (const e of m.entries) { const parts=e.path.split("/"); for(let n=1;n<parts.length;n++) { const p=parts.slice(0,n).join("/"); if(!rows.has(p)) rows.set(p,{path:p,kind:"directory",size:0,sha:undefined}); } }
  return executionDigest([...rows.values()].sort((a,b)=>a.path<b.path?-1:1));
};
const httpComplete = (r: Receipt<HttpDeliveryResult>) => r.data.status === "complete" && r.data.coverageComplete && r.data.response?.status === "complete"
  && r.data.response.body.complete && r.data.response.body.eof && r.data.response.body.encoding === "identity" && !!r.data.response.body.sha256;
function configFor(r: Receipt<NginxConfigResult>, entry: URL) {
  const a = r.data.analysis;
  return a.status === "parsed" && a.selected?.root && !a.selected.terminalResponse && !a.selected.alias && !a.selected.proxyPass
    && a.target.address === entry.hostname && a.target.port === Number(entry.port || (entry.protocol === "https:" ? 443 : 80))
    && a.target.serverName.toLowerCase() === entry.hostname.toLowerCase() && a.target.uriPath === "/" && !!a.globalFingerprint && !!a.nonTargetFingerprint;
}
/** Finite inert markup reader: it never creates DOM nodes or runs/downloads code. */
function publicResources(html: string, entry: URL): Array<{ path: string; url: string; stylesheet: boolean }> | undefined {
  const resources = [{ path: "index.html", url: entry.href, stylesheet: false }];
  const inertTags = new Set("html head title body main header footer nav section article aside div span p br hr h1 h2 h3 h4 h5 h6 a strong em b i u s small sub sup pre code blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col figure figcaption img link meta".split(" "));
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype\s[^>]*>/gi, "");
  let offset=0;
  while (offset<clean.length) {
    const open=clean.indexOf("<",offset); if(open<0) break;
    const match=/^<\/?([a-z][a-z0-9-]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/i.exec(clean.slice(open));
    if(!match) return; offset=open+match[0].length;
    const tag=match[1]!.toLowerCase(); if(!inertTags.has(tag)) return;
    if(match[0].startsWith("</")) continue;
    const attrs:Record<string,string>={}; let remainder=match[2]!.trim().replace(/\/$/,"").trim();
    while(remainder) {
      const attr=/^([a-z_:][a-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(remainder);
      if(!attr) return; const name=attr[1]!.toLowerCase(); if(name in attrs || name.startsWith("on") || ["srcset","style"].includes(name)) return;
      if (["src","href"].includes(name) && attr[2]===undefined && attr[3]===undefined) return;
      attrs[name]=attr[2]??attr[3]??attr[4]??""; remainder=remainder.slice(attr[0].length).trim();
    }
    // Unimplemented resource and navigation behavior remains unknown. Neither
    // tag spelling nor filename extensions may hide a required observation.
    if (Object.keys(attrs).some(name => ["background","poster","data","action","formaction","ping","srcdoc","xlink:href"].includes(name)
      || name === "src" && tag !== "img" || name === "href" && !["a","link"].includes(tag))) return;
    if(tag === "meta" && ("http-equiv" in attrs || !Object.keys(attrs).every(k=>["charset","name","content"].includes(k)))) return;
    const stylesheet=tag==="link" && attrs.rel?.toLowerCase()==="stylesheet";
    if(tag==="link" && !["stylesheet","icon"].includes(attrs.rel?.toLowerCase()??"")) return;
    if((tag==="img" && !("src" in attrs)) || tag==="link" && !("href" in attrs)) return;
    const ref=tag==="img"?attrs.src:tag==="link"?attrs.href:undefined;
    if(ref!==undefined) {
      if(!ref || /&|[\\\u0000-\u0020]/.test(ref)) return;
      let u:URL;try{u=new URL(ref,entry);}catch{return;}
      if(u.origin!==entry.origin || u.hash || u.username || u.password) return;
      let p:string;try{p=decodeURIComponent(u.pathname).slice(1);}catch{return;}
      if(!path("/"+p) || !p) return;resources.push({path:p,url:u.href,stylesheet});
    }
  }
  const unique = new Map<string, typeof resources[number]>();
  for (const r of resources) unique.set(r.url,{ ...r, stylesheet:r.stylesheet || unique.get(r.url)?.stylesheet || false });
  return [...unique.values()];
}
function inertStylesheet(css:string):boolean {
  // A deliberately finite subset: simple rules/declarations and literal values.
  // Reject functions, escapes and at-rules instead of pretending to resolve CSS.
  const text=css.replace(/\/\*[\s\S]*?\*\//g,"");
  return !/[\\@()<>]/.test(text) && !text.includes("/*") && !text.includes("*/");
}
function controlUrls(config: NginxConfigResult, entry: URL): string[] | undefined {
  const values: string[] = [];
  for (const server of config.analysis.servers.filter(s => s.id !== config.analysis.selected!.serverId)) {
    if (!server.listens.length) return;
    for (const listen of server.listens) {
      const names = server.serverNames.filter(n => n !== "_" && n !== "");
      if (names.some(n => !/^[a-zA-Z0-9.-]+$/.test(n))) return;
      for (const hostname of names.length ? names : [entry.hostname]) {
        const u = new URL(entry.href); u.protocol = listen.tls ? "https:" : "http:"; u.hostname = hostname; u.port = String(listen.port); u.pathname = "/"; u.search = "";
        if (u.href === entry.href) return; // Overlapping virtual hosts need explicit routing evidence.
        values.push(u.href);
      }
    }
  }
  return [...new Set(values)].sort();
}

/** Evaluate complete immutable receipts; never infer expected content from HTTP. */
export function evaluateStaticSiteLedger(task: OpsTask, server: ServerProfile, generation: number, records: ExecutionOperationRecord[]): StaticSiteAcceptanceSnapshot {
  const digest = acceptanceContractDigest(task)!;
  const resourceKey=(o:ExecutionOperationRecord):string|undefined=>{
    const a=o.intent.semantic.action;if(a.type!=="tool")return;
    if(["files.inspect_manifest","files.read_content"].includes(a.toolId))return `${a.toolId}:${String(a.arguments.path)}`;
    if(a.toolId==="http.inspect_delivery") { try{return `${a.toolId}:${new URL(String(a.arguments.url)).href}`;}catch{return;} }
    if(a.toolId==="nginx.inspect_configuration")return `${a.toolId}:${canonicalExecutionJson({entryPath:a.arguments.entryPath,target:a.arguments.target})}`;
    return;
  };
  // A newer failed/partial/unknown collection is an observation too. Select by
  // identity and ordering BEFORE checking success; never fall back to an older
  // complete receipt. Historical pre-change baselines retain their own times.
  const currentObservations=records.filter(o=>o.taskId===task.id && o.roundId===task.currentRoundId && o.workflowEpoch===(task.workflowEpoch??0)
    && o.intent.semantic.targets.some(t=>t.serverId===server.id && t.host.toLowerCase()===server.host.toLowerCase() && t.port===server.port && t.username===server.username && t.connectionGeneration===generation)
    && o.attempts.some(a=>a.status!=="not_dispatched"));
  const newest=<T>(r:Receipt<T>)=>!currentObservations.some(o=>o.operationId!==r.operation.operationId && resourceKey(o)===resourceKey(r.operation)
    && o.attempts.some(a=>a.status!=="not_dispatched" && (!Number.isFinite(a.startedAt) || a.startedAt>=r.started)));
  const allMs = records.map(o => receipt<FileManifestResult>(o, task, server, generation, "files.inspect_manifest", true)).filter((r): r is Receipt<FileManifestResult> => !!r).filter(manifestComplete);
  const ms = allMs.filter(r => !!receipt(r.operation, task, server, generation, "files.inspect_manifest")).filter(newest);
  const hs = records.map(o => receipt<HttpDeliveryResult>(o, task, server, generation, "http.inspect_delivery")).filter((r): r is Receipt<HttpDeliveryResult> => !!r).filter(httpComplete).filter(newest);
  const allHs = records.map(o => receipt<HttpDeliveryResult>(o, task, server, generation, "http.inspect_delivery",true)).filter((r): r is Receipt<HttpDeliveryResult> => !!r).filter(httpComplete);
  const texts=records.map(o=>receipt<TextReceipt>(o,task,server,generation,"files.read_content")).filter((r):r is Receipt<TextReceipt>=>!!r)
    .filter(r=>!r.data.truncated && r.data.returnedBytes===r.data.totalBytes && new TextEncoder().encode(r.data.content).length===r.data.totalBytes).filter(newest);
  const allCs = records.map(o => receipt<NginxConfigResult>(o, task, server, generation, "nginx.inspect_configuration", true)).filter((r): r is Receipt<NginxConfigResult> => !!r);
  const uniqueRecord=(id:string)=>{const matches=records.filter(o=>o.operationId===id);return matches.length===1?matches[0]:undefined;};
  const configSourcesCurrent=(r:Receipt<NginxConfigResult>)=>r.data.analysis.sources.length>0 && r.data.analysis.sources.every(source=>{
    const op=uniqueRecord(source.operationId),read=op && receipt<TextReceipt>(op,task,server,generation,"files.read_content");
    return read && newest(read) && read.ended<=r.started && last(op!.attempts).id===source.attemptId && last(op!.attempts).executionId===source.executionId
      && read.data.path===source.path && !read.data.truncated && read.data.returnedBytes===read.data.totalBytes
      && read.data.totalBytes===source.bytes && `sha256:${sha256Utf8(read.data.content)}`===source.contentSha256;
  }) && r.data.analysis.includes.every(include=>{
    const coverage=include.directoryCoverage;if(!coverage)return true;
    // The earlier manifest is intentionally superseded by the closing sample;
    // only that closing directory sample may grant current include coverage.
    const op=uniqueRecord(coverage.afterOperationId),read=op && receipt<FileManifestResult>(op,task,server,generation,"files.inspect_manifest");
    return read && newest(read) && read.ended<=r.started && read.data.coverageComplete && !read.data.truncated
      && read.data.manifestSha256===coverage.manifestSha256;
  });
  const cs = allCs.filter(r => !!receipt(r.operation, task, server, generation, "nginx.inspect_configuration")).filter(newest).filter(configSourcesCurrent);
  const changes = records.filter(o => sameEndpoint(o, server) && (o.effect === "change" || o.intent.semantic.effect === "change"))
    .flatMap(o => o.attempts.filter(a => a.status !== "not_dispatched").map(a => ({ o, a })));
  const sourceBoundary = Math.max(0, ...task.requirementLifecycle!.items.filter(effective).map(i => Date.parse(i.lastChangedAt ?? i.source.createdAt ?? "") || Infinity));
  const assessments = staticSiteRequirements(task).map(item => {
    const s = item.acceptance!.staticSite!, entry = s.entryUrl && url(s.entryUrl), conditions: Condition[] = [], actions: string[] = [];
    const add = (id: string, state: Condition["state"], reason: string, receipts: Array<{ refs: string[] }> = []) => {
      conditions.push({ id, state, reason, evidenceIds: [...new Set(receipts.flatMap(r => r.refs))] }); if (state !== "met") actions.push(reason);
    };
    const out: StaticSiteAssessment = { requirementId: item.id, state: "unknown", baselineReady: false, conditions, nextActions: actions, evidenceIds: [] };
    if (!s.artifactPath || !entry || entry.pathname !== "/" || entry.search) {
      add("source", "unknown", "请明确交付包和入口；本批仅支持根路径静态站点，未知或复杂路径不能改为通用验收"); return out;
    }
    const baselineBoundary=Date.parse(item.lastChangedAt??item.source.createdAt??"") || Infinity;
    const candidate = allCs.filter(r => r.started >= baselineBoundary && configFor(r,entry)).sort((a,b)=>a.ended-b.ended)[0];
    const resources = [s.artifactPath, candidate?.data.analysis.selected?.root, ...(candidate?.data.analysis.sources.map(i=>i.path)??[]),
      ...allMs.filter(m=>m.data.request.source==="directory").map(m=>m.data.request.path),
      ...(candidate?.data.analysis.servers.flatMap(v=>[...v.directives,...v.locations.flatMap(l=>l.directives)].filter(d=>["root","alias"].includes(d.name)).map(d=>d.args[0]))??[])].filter((p):p is string=>!!p);
    const related = changes.filter(({o}) => { const paths=precisePaths(o); return !paths.length || !resources.length || paths.some(p=>resources.some(r=>overlap(p,r))); });
    const currentChanges = related.filter(({a})=>a.startedAt>=baselineBoundary);
    const settled = ({o,a}:typeof related[number]) => a.status === "unknown" ? reconciledAt(o,a,records) : a.completedAt;
    const unresolved = related.some(c => c.a.status === "dispatching" || !Number.isFinite(settled(c)));
    const firstChange = currentChanges.length ? Math.min(...currentChanges.map(({a})=>a.startedAt)) : Infinity;
    const lastChange = currentChanges.length ? Math.max(...currentChanges.map(c=>settled(c)??Infinity)) : -Infinity;
    const before = <T>(r:Receipt<T>) => r.started>=baselineBoundary && r.ended<firstChange;
    const after = <T>(r:Receipt<T>) => r.started>=sourceBoundary && r.started>lastChange;
    const artifact = allMs.filter(r => before(r) && r.data.request.path === s.artifactPath && r.data.request.source !== "directory").sort((a,b)=>a.ended-b.ended)[0];
    const config = candidate && before(candidate) ? candidate : undefined;
    const root = config?.data.analysis.selected!.root;
    out.rootPath=root;
    const original = root ? allMs.filter(r => before(r) && r.data.request.source === "directory" && r.data.request.path === root).sort((a,b)=>a.ended-b.ended)[0] : undefined;
    const controls = config && controlUrls(config.data, entry);
    const endpointMatches = (r:Receipt<HttpDeliveryResult>) => r.data.target.peerAddress === entry.hostname && r.data.target.connectAddress === entry.hostname
      && (!r.data.request.connectAddress || r.data.request.connectAddress === entry.hostname);
    const originalHttp = controls?.map(u => allHs.filter(r => before(r) && endpointMatches(r) && new URL(r.data.request.url).href === u).sort((a,b)=>a.ended-b.ended)[0]);
    // Re-parse the SAME ledger sources for each other frontend; root may be
    // inherited from http/server. Never treat absence of an explicit root as an
    // empty protection set. A literal return has no served filesystem root.
    const protectedAnalyses = config && controls?.map(value => {
      const u = new URL(value), originalRequest = config.data.request;
      return inspectNginxConfigurationFromLedger({ ...originalRequest, target: { ...originalRequest.target,
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), serverName: u.hostname, uriPath: "/" } },
      config.data.analysis.binding, records.filter(o => !o.attempts.some(a => a.startedAt > config.ended))).analysis;
    });
    const protectedScopeComplete = protectedAnalyses?.every(a => a.status === "parsed" && a.selected
      && !a.selected.alias && !a.selected.proxyPass && (!!a.selected.root || !!a.selected.terminalResponse));
    const protectedRoots = [...new Set((protectedAnalyses ?? []).map(a => a.selected?.root).filter((p): p is string => !!p))];
    const originals = protectedRoots.map(p => allMs.filter(r => before(r) && r.data.request.source === "directory" && r.data.request.path === p).sort((a,b)=>a.ended-b.ended)[0]);
    const ordinaryArchive = /^\d+\.\d+\.\d+\.\d+$/.test(entry.hostname) && artifact && artifact.data.entries.some(e => e.kind === "regular" && e.path === "index.html")
      && artifact.data.entries.filter(e => e.kind === "regular").every(e => !!e.sha256);
    add("baseline", artifact && config && original && ordinaryArchive && (!s.preserveOtherSites || controls && protectedScopeComplete && originalHttp?.every(Boolean) && originals.every(Boolean)) ? "met" : "unknown",
      "修改前需完整包清单（普通文件、根index.html）、目标配置与目录基线；要求保护其他站点时还需其入口HTTP和明确root目录基线", [artifact,config,original,...(originalHttp??[]),...originals].filter((r): r is NonNullable<typeof r> => !!r));
    if (conditions[0]!.state !== "met" || !artifact || !config || !original || !root) return out;
    const currentScope = ms.some(r=>after(r) && r.data.request.source==="directory" && r.data.request.path===root)
      && cs.some(r=>after(r) && configFor(r,entry));
    out.rootPath = root; out.baselineReady = !unresolved && currentScope;
    out.baselineDigest = executionDigest({ contract: digest, artifact: artifact.data.archiveSha256, members: artifact.data.manifestSha256,
      root, original: original.data.manifestSha256, config: [config.data.analysis.globalFingerprint, config.data.analysis.nonTargetFingerprint],
      controls: originalHttp?.map(r => ({ url: r!.data.request.url, sha: r!.data.response!.body.sha256 })), protected: originals.map(r => r!.data.manifestSha256) });
    add("execution", unresolved ? "unknown" : "met", "同端点仍有未决变更时先核对原操作，不能重复部署或完成");
    add("current_scope", currentScope ? "met":"unknown", "连接或需求修订后须补当前代际的配置和目标目录证据；历史基线保留但不能直接授予当前状态");
    const deployed = ms.filter(r => after(r) && r.data.request.path === root && r.data.request.source === "directory").sort((a,b)=>b.ended-a.ended)[0];
    const filesMatch = deployed && contentFingerprint(deployed.data) === contentFingerprint(artifact.data);
    add("deployed_content", deployed ? filesMatch ? "met" : "not_met" : "unknown", "执行最小部署后重新采集目标目录，逐项核对文件集合、字节数和SHA256与事前交付包一致", deployed ? [artifact,deployed] : [artifact]);
    const index=artifact.data.entries.find(e=>e.path==="index.html")!;
    const indexRead=texts.filter(r=>after(r) && r.data.path===root+"/index.html" && sha256Utf8(r.data.content)===index.sha256).sort((a,b)=>b.ended-a.ended)[0];
    const publicFiles=indexRead && publicResources(indexRead.data.content,entry);
    const requiredFiles=(publicFiles??[]).map(r=>artifact.data.entries.find(e=>e.path===r.path && e.kind==="regular"));
    const styles=(publicFiles??[]).filter(r=>r.stylesheet);
    const stylesComplete=styles.every(r=>texts.some(t=>after(t) && t.data.path===root+"/"+r.path && sha256Utf8(t.data.content)===artifact.data.entries.find(e=>e.path===r.path)?.sha256
      && inertStylesheet(t.data.content)));
    add("public_resources", indexRead && publicFiles && requiredFiles.every(Boolean) && stylesComplete ? "met":"unknown",
      "读取并核对部署首页与引用CSS的完整正文摘要，按有限静态HTML声明取得公开资源；脚本/动态引用或CSS额外URL需补明确支持，不能把README等包内文件强制公开",indexRead?[indexRead]:[]);
    const deliveries=(publicFiles??[]).map(r=>hs.filter(h=>after(h) && new URL(h.data.request.url).href===r.url).sort((a,b)=>b.ended-a.ended)[0]);
    const delivered = !!publicFiles?.length && requiredFiles.every(Boolean) && stylesComplete && deliveries.every((r,i) => r && endpointMatches(r) && r.data.response!.httpStatus === 200 && r.data.response!.body.sha256 === requiredFiles[i]!.sha256
      && r.data.response!.body.readBytes === requiredFiles[i]!.sizeBytes);
    add("http_content", delivered ? "met" : deliveries.length && deliveries.every(Boolean) ? "not_met" : "unknown", "从指定前端GET首页及HTML声明资源，完整实体SHA256/字节数须匹配事前包；旧页200或资源404不通过", deliveries.filter((r): r is NonNullable<typeof r> => !!r));
    if (s.preserveExisting && (currentChanges.length || contentFingerprint(original.data)!==contentFingerprint(artifact.data))) {
      const backups = allMs.filter(r => r.data.request.source === "directory" && !overlap(r.data.request.path, root) && r.started > original.ended
        && r.data.manifestSha256 === original.data.manifestSha256);
      // Prove the complete backup already existed while the target still had its
      // original contents, before the final deployment mutation. cp exit 0 is not proof.
      const backup = backups.find(b => allMs.some(check => check.data.request.path === root && check.started > b.ended
        && check.data.manifestSha256 === original.data.manifestSha256
        && currentChanges.some(({ a }) => a.startedAt > check.ended && deployed && a.completedAt! < deployed.started)));
      const backupNow=backup && ms.filter(r=>after(r) && r.data.request.source==="directory" && r.data.request.path===backup.data.request.path).sort((a,b)=>b.ended-a.ended)[0];
      const backupIntact=backupNow?.data.manifestSha256===original.data.manifestSha256;
      add("backup", backup && backupIntact ? "met" : "unknown", "先备份并采集完整备份清单，再核对目标仍为旧基线；之后部署并再次核对备份，证明备份先于替换且当前仍完整", backup ? [original,backup,...(backupNow?[backupNow]:[])] : [original]);
    }
    if (s.preserveOtherSites) {
      const currentConfig = cs.filter(r => after(r) && configFor(r, entry)).sort((a,b)=>b.ended-a.ended)[0];
      const currentHttp = controls!.map(u => hs.filter(r => after(r) && new URL(r.data.request.url).href === u).sort((a,b)=>b.ended-a.ended)[0]);
      const currentRoots = protectedRoots.map(p => ms.filter(r => after(r) && r.data.request.path === p && r.data.request.source === "directory").sort((a,b)=>b.ended-a.ended)[0]);
      const okay = currentConfig?.data.analysis.globalFingerprint === config.data.analysis.globalFingerprint
        && currentConfig?.data.analysis.nonTargetFingerprint === config.data.analysis.nonTargetFingerprint
        && currentHttp.every((r,i) => r && endpointMatches(r) && r.data.response!.httpStatus === originalHttp![i]!.data.response!.httpStatus && r.data.response!.body.sha256 === originalHttp![i]!.data.response!.body.sha256)
        && currentRoots.every((r,i) => r && r.data.manifestSha256 === originals[i]!.data.manifestSha256);
      add("other_sites", okay ? "met" : "unknown", "部署后复核非目标配置指纹、明确root目录清单及其他入口HTTP与事前基线一致", [currentConfig,...currentHttp,...currentRoots].filter((r): r is NonNullable<typeof r> => !!r));
    }
    out.state = conditions.every(c => c.state === "met") ? "met" : conditions.some(c => c.state === "not_met") ? "not_met" : "unknown";
    out.evidenceIds = [...new Set(conditions.flatMap(c => c.evidenceIds))]; return out;
  });
  return { contractDigest: digest, serverId: server.id, connectionGeneration: generation, assessments,
    limitations: ["同机观察视角；不证明用户浏览器网络", "有限非原子采样；不保证全天或未声明动态后端", "本批仅根入口、普通文件静态包；不推断复杂rewrite、动态路由或链接身份"] };
}

export async function refreshStaticSiteAcceptance(task: OpsTask, server: ServerProfile, generation: number, deps: {
  list: () => Promise<ExecutionOperationRecord[]>; read: ExecutionReceiptReader; assertCurrent: () => void;
}): Promise<void> {
  clearStaticSiteAcceptance(task);
  if (!staticSiteRequirements(task).length) return;
  const digest = acceptanceContractDigest(task); deps.assertCurrent();
  const initial = await deps.list(); deps.assertCurrent();
  const restored = new Map<string, ExecutionOperationRecord>(); let bytes = 0;
  for (const operation of initial) {
    const action = operation.intent.semantic.action, attempt = last(operation.attempts);
    if (operation.taskId !== task.id
      || action.type !== "tool" || !["files.read_content", "files.inspect_manifest", "http.inspect_delivery", "nginx.inspect_configuration"].includes(action.toolId)
      || attempt?.status !== "succeeded" || !attempt.outcome) continue;
    const record = await restoreArchivedExecutionResult(operation, attempt.id, deps.read, deps.assertCurrent);
    bytes += new TextEncoder().encode(JSON.stringify(last(record.attempts)!.outcome!.result)).length;
    if (bytes > 16 * 1024 * 1024) throw new Error("静态站点验收归档超过16MiB，不能以截断证据完成");
    restored.set(operation.operationId, record);
  }
  const current = await deps.list(); deps.assertCurrent();
  if (digest !== acceptanceContractDigest(task)) throw new Error("静态站点需求已变化");
  for (const id of restored.keys()) {
    const candidates = current.filter(o => o.operationId === id);
    if (candidates.length !== 1 || canonicalExecutionJson(candidates[0]) !== canonicalExecutionJson(initial.find(o => o.operationId === id))) throw new Error("静态站点证据在读取期间已变化");
  }
  authority.set(task, evaluateStaticSiteLedger(task, server, generation, current.map(o => restored.get(o.operationId) ?? o)));
}
