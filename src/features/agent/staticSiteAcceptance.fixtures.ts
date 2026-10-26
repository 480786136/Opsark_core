import type { OpsTask, PlanStep, ServerProfile, TaskRequirementUpdate } from "@/types";
import { createMemoryExecutionLedgerRepository, type ExecutionOperationRecord } from "@/services/executionLedger";
import { applyTaskRequirementUpdate } from "./taskRequirements";
import { preparePlanForApproval, sha256Utf8 } from "./planPreparation";
import { normalizeFileManifestRequest, fileManifestDigest, FILE_MANIFEST_LIMITATIONS, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { normalizeHttpDeliveryRequest, httpDeliveryTarget } from "@/features/tools/httpDeliveryInspection";
import { httpDeliveryLimitations } from "@/features/tools/httpDeliveryContracts";
import { inspectNginxConfigurationFromLedger } from "./nginxConfigRuntime";
import { refreshStaticSiteAcceptance, staticSiteApprovalBindings } from "./staticSiteAcceptance";
import { toolExecutionScope } from "./toolEvidenceScope";

export const start = Date.parse("2026-10-13T00:00:00Z");
export const server: ServerProfile = { id: "server", name: "fixture", host: "127.0.0.1", port: 22, username: "fixture", group: "test", status: "online", environment: [], createdAt: "",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
export const request = "将 /tmp/site-v2.tar.gz 部署到 http://127.0.0.1:18080/，保留旧网站且不影响其他站点。";
export const source = { content: request, sourceMessageId: "message", source: "user_message" as const, relation: "new_goal" as const, createdAt: new Date(start).toISOString() };
export const update = (): TaskRequirementUpdate => ({ baseRevision: 0, sourceMessageId: "message", additions: [
  { id: "deploy", kind: "goal", content: request, sourceQuote: request, supersedes: [] },
  { id: "protect", kind: "constraint", content: "保留旧网站且不影响其他站点", sourceQuote: "保留旧网站且不影响其他站点", supersedes: [] },
], changes: [], focusIds: ["deploy", "protect"], acceptanceCoverage: [
  { requirementId: "deploy", strategy: "static_site", sourceQuote: request, reason: "明确包与入口的静态部署，包含备份及保护", staticSite: {
    artifactPath: "/tmp/site-v2.tar.gz", entryUrl: "http://127.0.0.1:18080/", preserveExisting: true, preserveOtherSites: true } },
  { requirementId: "protect", strategy: "general_review", sourceQuote: "保留旧网站且不影响其他站点", reason: "静态契约同时核验备份与保护，原约束保持绑定" },
] });
export function task(): OpsTask {
  const value: OpsTask = { id: "task", serverId: server.id, title: request, rootGoal: request, status: "running", permission: "managed", modelId: "model",
    currentRoundId: "round", workflowEpoch: 1, messages: [], plan: [], createdAt: source.createdAt, updatedAt: source.createdAt,
    requirementLifecycle: { version: 1, revision: 0, items: [], focus: { roundId: "round", requirementIds: [] } } };
  value.requirementLifecycle = applyTaskRequirementUpdate(value, update(), { source, roundId: "round" }); return value;
}
const identity = (sizeBytes = 0) => ({ device: "1", inode: "2", sizeBytes, mode: "0644", uid: 1, gid: 1, mtimeNs: "10", ctimeNs: "10" });
export function manifest(path: string, source: "directory" | "tar_gzip", contents: Record<string,string>): FileManifestResult {
  const request = normalizeFileManifestRequest({ path, source });
  const entries = Object.entries(contents).map(([path, text]) => ({ path, kind: "regular" as const, status: "complete" as const, reason: "",
    sizeBytes: new TextEncoder().encode(text).length, mode: "0644", uid: 1, gid: 1, sha256: sha256Utf8(text), ...(source === "directory" ? { identity: identity(new TextEncoder().encode(text).length) } : {}) }));
  const bytes = entries.reduce((sum,e)=>sum+e.sizeBytes,0);
  return { request, status: "complete", coverageComplete: true, truncated: false, safeForDeployment: true, rootIdentity: { ...identity(source === "directory" ? 0 : 1024), mode: source === "directory" ? "0755" : "0644" },
    entries, issues: [], issueCount: 0, scannedEntries: entries.length, contentBytes: bytes, readBytes: source === "directory" ? bytes*2 : 0, archiveReadBytes: source === "directory" ? 0 : 2048,
    expandedBytes: source === "directory" ? 0 : 10240, manifestSha256: fileManifestDigest(entries), archiveSha256: source === "directory" ? null : "a".repeat(64),
    sampledAt: sourceTime(1), finishedAt: sourceTime(2), elapsedMs: 1000, consistency: "sampled_non_atomic", limitations: [...FILE_MANIFEST_LIMITATIONS] };
}
export const sourceTime = (n: number) => new Date(start+n*1000).toISOString();
export const oldFiles = { "index.html": "OLD" }; export const newFiles = { "index.html": '<html><head><link rel="stylesheet" href="style.css"></head><body>NEW</body></html>', "style.css": "body{}" };
export const config = "events {} http { server { listen 18080; server_name 127.0.0.1; root /tmp/site; } server { listen 18081; server_name 127.0.0.1; location / { return 200 'CONTROL'; } } }";

export async function fixture() {
  const current = task(), records: ExecutionOperationRecord[] = [];
  const repo = createMemoryExecutionLedgerRepository(); let ordinal=0, generation=1;
  async function record(toolId: string, args: Record<string,unknown>, data: unknown, at: number) {
    const id = `step-${ordinal++}`, execution = `execution-${id}`;
    const step: PlanStep = { id, title: toolId, description: "fixture", action: { type: "tool", toolId, arguments: args }, command: "", validation: "", kind: "observe", risk: "low", expected: "真实收据", status: "pending" };
    const prepared = preparePlanForApproval([step], { taskId: current.id, permission: current.permission, requirementRevision: current.requirementLifecycle!.revision,
      server, servers: [server], connectionGeneration: generation, inputBindings: staticSiteApprovalBindings(current) });
    const intent = prepared.steps[0]!.intent;
    await repo.prepare({ version: 1, operationId: id, taskId: current.id, stepId: id, roundId: current.currentRoundId, workflowEpoch: current.workflowEpoch!,
      planRevision: prepared.planRevision, stepRevision: 1, intentDigest: intent.digest, intent, phase: "tool", effect: "read", resourceKeys: ["server:server"], executionId: execution });
    await repo.begin(id,id,execution);
    const value = typeof data === "function" ? data(execution, intent.semantic.action.type === "tool" ? intent.semantic.action.arguments : {}) : data;
    await repo.complete({ operationId: id, attemptId: id, eventId: id, outcome: { status: "succeeded", evidenceRefs: [`proof-${id}`], result: { callId: execution, toolId, success: true, data: value } } });
    await repo.acknowledge(id,id,false);
    const operation = (await repo.list()).find(o=>o.operationId===id)!;
    Object.assign(operation.attempts[0]!, { startedAt: start+at*1000, completedAt: start+(at+0.5)*1000 }); records.push(operation);
    const projected:PlanStep={...prepared.compatibilitySteps[0]!,status:"completed",startedAt:sourceTime(at),attemptContext:JSON.stringify([server.id,current.currentRoundId,"",0,0])};
    projected.result={executionStatus:"success",observationStatus:"unknown",evidenceIds:[`proof-${id}`],facts:{toolId,commandDispatched:true,evidenceComplete:true},warnings:[]};
    projected.evidence=[{id:`proof-${id}`,type:"command-output",source:"main",facts:{toolId,evidenceComplete:true},rawOutput:JSON.stringify(value),collectedAt:sourceTime(at+.5),scope:toolExecutionScope(projected,toolId,current.id)}];
    current.plan.push(projected); return operation;
  }
  const readText=(path:string,content:string,at:number)=>record("files.read_content",{path,maxBytes:262144},{path,content,encoding:"utf-8",totalBytes:new TextEncoder().encode(content).length,returnedBytes:new TextEncoder().encode(content).length,truncated:false},at);
  const m = async (value: FileManifestResult, at: number) => {
    const result=await record("files.inspect_manifest",value.request as unknown as Record<string,unknown>,value,at);
    if(value.request.source==="directory" && value.request.path==="/tmp/site") for(const [i,e] of value.entries.entries()) {
      const text=Object.values({...oldFiles,...newFiles}).find(text=>sha256Utf8(text)===e.sha256);
      if(text!==undefined) await readText(value.request.path+"/"+e.path,text,at+.6+i*.1);
    }
    return result;
  };
  const http = (u: string, body: string, at: number, status = 200) => record("http.inspect_delivery", { url:u }, (execution: string, args: Record<string,unknown>) => {
    const r=normalizeHttpDeliveryRequest(args), binding={ executionId: execution, probeId:"opsark-12345678-1234-4234-8234-123456789abc", requestDigest: sha256Utf8(JSON.stringify(r)) };
    // Build binding with the same canonical digest as the actual collector.
    const ordered=(v:unknown):unknown=>v && typeof v==="object" && !Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:1).map(([k,w])=>[k,ordered(w)])):v;
    binding.requestDigest=sha256Utf8(JSON.stringify(ordered(r)));
    return { request:r,binding,status:"complete",coverageComplete:true,target:{ ...httpDeliveryTarget(r,binding), peerAddress:"127.0.0.1", peerPort:Number(new URL(u).port) },
      response:{httpStatus:status,headers:{},body:{mode:"sha256",readBytes:new TextEncoder().encode(body).length,eof:true,complete:true,encoding:"identity",sha256:sha256Utf8(body)},status:"complete",reason:"complete"},
      correlation:null,sampledAt:sourceTime(at),finishedAt:sourceTime(at+0.5),elapsedMs:500,reason:"complete",limitations:[...httpDeliveryLimitations] };
  },at);
  async function configuration(at:number) {
    const body = await record("files.read_content", {path:"/etc/nginx/nginx.conf"}, {path:"/etc/nginx/nginx.conf",content:config,encoding:"utf-8",totalBytes:config.length,returnedBytes:config.length,truncated:false},at);
    const args={entryPath:"/etc/nginx/nginx.conf",prefix:"/etc/nginx",target:{address:"127.0.0.1",port:18080,serverName:"127.0.0.1",uriPath:"/"},sourceStepIds:[body.stepId]};
    return record("nginx.inspect_configuration",args,inspectNginxConfigurationFromLedger(args,{taskId:current.id,roundId:current.currentRoundId!,workflowEpoch:current.workflowEpoch!,serverId:server.id,connectionGeneration:generation},records),at+1);
  }
  async function change(at:number) {
    const id=`change-${ordinal++}`, step:PlanStep={id,title:"已批准部署",description:"fixture",action:{type:"shell",command:"cp -- /tmp/source /tmp/target"},command:"cp -- /tmp/source /tmp/target",validation:"",kind:"change",risk:"medium",expected:"真实变更",status:"pending"};
    const plan=preparePlanForApproval([step],{taskId:"task",permission:"managed",server,servers:[server],connectionGeneration:1,inputBindings:staticSiteApprovalBindings(current)});
    await repo.prepare({version:1,operationId:id,taskId:"task",stepId:id,roundId:"round",workflowEpoch:1,planRevision:1,stepRevision:1,intentDigest:plan.steps[0]!.intent.digest,intent:plan.steps[0]!.intent,phase:"command",effect:"change",resourceKeys:["server:server"],executionId:id});
    await repo.begin(id,id,id);await repo.complete({operationId:id,attemptId:id,eventId:id,outcome:{status:"succeeded",evidenceRefs:[id],result:{success:true,exitCode:0,output:""}}});await repo.acknowledge(id,id,false);
    const operation=(await repo.list()).find(o=>o.operationId===id)!;Object.assign(operation.attempts[0]!,{startedAt:start+at*1000,completedAt:start+(at+.5)*1000});records.push(operation);return plan;
  }
  const refresh = () => refreshStaticSiteAcceptance(current,server,generation,{list:async()=>JSON.parse(JSON.stringify(records)),read:async()=>{throw new Error("unexpected archive read");},assertCurrent:()=>{}});
  await m(manifest("/tmp/site-v2.tar.gz","tar_gzip",newFiles),1);await configuration(3);await m(manifest("/tmp/site","directory",oldFiles),6);await http("http://127.0.0.1:18081/","CONTROL",8);
  return {current,records,m,http,configuration,change,refresh,readText,setGeneration:(value:number)=>{generation=value;}};
}

export async function deliveredFixture() {
  const f=await fixture();await f.refresh();await f.change(10);await f.m(manifest("/tmp/backup","directory",oldFiles),12);await f.m(manifest("/tmp/site","directory",oldFiles),14);await f.change(16);
  await currentAcceptance(f,18);return f;
}
export async function currentAcceptance(f:Awaited<ReturnType<typeof fixture>>,at:number) {
  await f.m(manifest("/tmp/site","directory",newFiles),at);await f.http("http://127.0.0.1:18080/",newFiles["index.html"],at+2);
  await f.http("http://127.0.0.1:18080/style.css",newFiles["style.css"],at+4);await f.http("http://127.0.0.1:18081/","CONTROL",at+6);
  await f.configuration(at+8);await f.m(manifest("/tmp/backup","directory",oldFiles),at+10);await f.refresh();
}

