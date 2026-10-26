import { describe, expect, it, vi } from "vitest";
import type { NextStageDecision, PlanStep } from "@/types";
import { createMemoryExecutionLedgerRepository } from "@/services/executionLedger";
import { preparePlanForApproval, sha256Utf8 } from "./planPreparation";
import { decideTaskNextStage } from "./agentService";
import { prepareTaskDecision, taskDecisionEvidenceIds } from "./taskDecisionResolution";
import { applyTaskRequirementUpdate } from "./taskRequirements";
import { acceptanceContractDigest, assertStaticSiteMutation, staticSiteAcceptanceContext, staticSiteApprovalBindings } from "./staticSiteAcceptance";
import { currentAcceptance, deliveredFixture, fixture, manifest, newFiles, oldFiles, sourceTime, server, start } from "./staticSiteAcceptance.fixtures";

const input=(f:Awaited<ReturnType<typeof fixture>>)=>({task:f.current,model:{id:"model",name:"fixture",provider:"Remote",model:"fixture",endpoint:"https://fixture.invalid",enabled:true,hasApiKey:true},
  apiKey:"fixture",tools:[],secretMetadata:[],skills:[],generationSettings:{limitOutput:false,maxPlanSteps:6,maxOutputTokens:5000,maxTextChars:200,maxCommandChars:4000},refreshBusinessAcceptance:f.refresh});
function decision(f:Awaited<ReturnType<typeof fixture>>):NextStageDecision {
  const ids=taskDecisionEvidenceIds(f.current);
  return {decision:"complete",source:"model",reason:"模型提出完成，由Core重新核实",summary:"交付完成",steps:[],requirementReview:{baseRevision:f.current.requirementLifecycle!.revision,
    roundId:f.current.currentRoundId!,focusOutcome:"completed",overallOutcome:"completed",items:f.current.requirementLifecycle!.items.filter(i=>i.status==="active").map(i=>({requirementId:i.id,outcome:"satisfied",reason:"引用实际收据",evidenceIds:[ids[ids.length-1]!]}))}};
}

/** An actual repository reconciliation, with deterministic local response fixtures. */
async function externalTransfer(f:Awaited<ReturnType<typeof fixture>>,path:string,unknown=false,reconcile=false) {
  let tick=start+40_000;const now=vi.spyOn(Date,"now").mockImplementation(()=>tick+=100);
  const repo=createMemoryExecutionLedgerRepository(),other={...server,id:"source-server",host:"192.0.2.2"};let ordinal=0;
  try {
    const execute=async(action:NonNullable<PlanStep["action"]>,host:typeof server,status:"succeeded"|"unknown",result:unknown)=>{
      const id=`foreign-${ordinal++}`,step:PlanStep={id,title:"真实内存台账夹具",description:"仅本地",action,command:action.type==="shell"?action.command:"",kind:action.type==="shell"?"observe":"change",risk:action.type==="shell"?"low":"medium",validation:"",expected:"核对同端点精确路径",status:"pending"};
      const intent=preparePlanForApproval([step],{taskId:"other-task",permission:"managed",server:host,servers:[server,other],connectionGeneration:1,connectionGenerations:{[server.id]:1,[other.id]:1}}).steps[0]!.intent;
      await repo.prepare({version:1,operationId:id,taskId:"other-task",stepId:id,roundId:"foreign-round",workflowEpoch:1,planRevision:1,stepRevision:1,intentDigest:intent.digest,intent,phase:action.type==="shell"?"command":"tool",effect:intent.semantic.effect,resourceKeys:["endpoint:127.0.0.1:22"],executionId:id});
      await repo.begin(id,id,id);await repo.complete({operationId:id,attemptId:id,eventId:id,outcome:{status,evidenceRefs:[`evidence-${id}`],result}});
      if(status==="succeeded")await repo.acknowledge(id,id,false);return id;
    };
    const id=await execute({type:"tool",toolId:"files.transfer_between_servers",arguments:{sourcePath:"/staging/file",targetServer:server.id,targetPath:path,overwrite:true}},other,unknown?"unknown":"succeeded",{success:!unknown});
    if(reconcile) {
      const reads:string[]=[];
      for(const [p,host] of [["/staging/file",other],[path,server]] as const) {
        const q="'"+p.replace(/'/g,"'\"'\"'")+"'",command=`test -f ${q} && LC_ALL=C stat -Lc '%s' -- ${q} && sha256sum -- ${q} && LC_ALL=C stat -Lc '%s' -- ${q}`;
        reads.push(await execute({type:"shell",command},host,"succeeded",{success:true,exitCode:0,stdout:`3\n${sha256Utf8("OLD")}  ${p}\n3\n`,stdoutTruncated:false}));
      }
      await repo.resolve(id,id,{version:1,kind:"file_transfer",sourceReadOperationId:reads[0]!,targetReadOperationId:reads[1]!});
    }
    const records=await repo.list();f.records.push(...records);return records;
  } finally {now.mockRestore();}
}

describe("静态交付的实际阶段决策和可恢复证据作用域",()=>{
  it("真实决策服务消费完整账本并允许完成，契约与原需求不被模型决策提前修改",async()=>{
    const f=await deliveredFixture(),before=JSON.stringify(f.current.requirementLifecycle),decide=vi.fn().mockResolvedValue(decision(f));
    const result=await decideTaskNextStage(input(f),decide);
    expect(result.complete).toBe(true);expect(result.taskDecision?.currentRequestReview?.completed).toBe(true);
    expect(JSON.stringify(f.current.requirementLifecycle)).toBe(before);
    const sent=JSON.parse(decide.mock.calls[0]![1].context);
    expect(JSON.stringify(sent)).toContain('"baselineReady":true');expect(JSON.stringify(sent)).toContain('"static_site"');
  });
  it("连续操作在每次派发前刷新并重新准备；明确目标路径缺当前配置时可补证据后继续",async()=>{
    const f=await fixture();
    const proposal=():PlanStep=>({id:"publish",title:"发布明确目标文件",description:"传输单个静态资源",kind:"change",risk:"medium",status:"pending",command:"",validation:"",expected:"目标静态内容更新",
      action:{type:"tool",toolId:"files.transfer_between_servers",arguments:{sourcePath:"/staging/index.html",targetServer:server.id,targetPath:"/tmp/site/index.html",overwrite:true}}});
    const staging={...server,id:"staging",host:"192.0.2.22"};
    const prepare=()=>preparePlanForApproval([proposal()],{taskId:f.current.id,permission:"managed",server:staging,servers:[server,staging],connectionGeneration:1,connectionGenerations:{[server.id]:1,[staging.id]:1},inputBindings:staticSiteApprovalBindings(f.current)}).compatibilitySteps[0]!;
    await f.refresh();expect(()=>assertStaticSiteMutation(f.current,prepare())).not.toThrow();
    await f.change(10);await f.m(manifest("/tmp/backup","directory",oldFiles),12);await f.m(manifest("/tmp/site","directory",oldFiles),14);await f.refresh();
    expect(()=>assertStaticSiteMutation(f.current,prepare())).toThrow("BASELINE_REQUIRED");
    await f.configuration(15);await f.refresh();expect(()=>assertStaticSiteMutation(f.current,prepare())).not.toThrow();
    await f.change(18);await currentAcceptance(f,20);expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
  });
  it("HTTP200和模型satisfied不能绕过实际prepareTaskDecision，阶段修复仍只返回待补缺口",async()=>{
    const f=await fixture();await f.http("http://127.0.0.1:18080/","OLD",10);await f.refresh();
    expect(()=>prepareTaskDecision(f.current,decision(f))).toThrow("静态站点");
    const pending:NextStageDecision={decision:"adjust",source:"model",reason:"先补真实部署与验收",summary:"尚未交付",steps:[],blocking:{kind:"external",reason:"只读基线后尚无部署和验收",requirementIds:["deploy"]},
      requirementReview:{baseRevision:1,roundId:"round",focusOutcome:"pending",overallOutcome:"pending",items:[{requirementId:"deploy",outcome:"unknown",reason:"待部署",evidenceIds:[]},{requirementId:"protect",outcome:"unknown",reason:"待保护验收",evidenceIds:[]}]}};
    const decide=vi.fn().mockResolvedValueOnce(decision(f)).mockResolvedValueOnce(pending);
    const result=await decideTaskNextStage(input(f),decide);expect(result.complete).toBe(false);expect(decide).toHaveBeenCalledTimes(2);
  });
  it("模型等待期间同端点再次变更，返回前真实刷新使先前完整验收失效",async()=>{
    const f=await deliveredFixture(),complete=decision(f);
    const decide=vi.fn().mockImplementation(async()=>{if(decide.mock.calls.length===1)await f.change(40);return complete;});
    await expect(decideTaskNextStage(input(f),decide)).rejects.toThrow("静态站点");
    expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
  });
  it("同端点重连保留原包/备份时序，补新generation当前收据后可恢复完成",async()=>{
    const f=await deliveredFixture();f.setGeneration(2);f.current.workflowEpoch=2;
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
    await currentAcceptance(f,50);expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
    expect(()=>prepareTaskDecision(f.current,decision(f))).not.toThrow();
  });
  it("新增保护约束使审批失效但不销毁变更前基线，补当前验收后有可满足出口",async()=>{
    const f=await deliveredFixture(),oldBinding=staticSiteApprovalBindings(f.current),oldDigest=acceptanceContractDigest(f.current);
    const text="交付后保留备份，不要清理备份目录";
    f.current.requirementLifecycle=applyTaskRequirementUpdate(f.current,{baseRevision:1,sourceMessageId:"supplement",additions:[{id:"backup-policy",kind:"constraint",content:text,sourceQuote:text,supersedes:[]}],changes:[],focusIds:["deploy","protect","backup-policy"],
      acceptanceCoverage:[{requirementId:"backup-policy",strategy:"general_review",reason:"补充长期保留条件，当前备份由静态契约核对",sourceQuote:text}]},
      {roundId:"round",source:{content:text,sourceMessageId:"supplement",source:"user_message",relation:"supplement",createdAt:sourceTime(40)}});
    expect(acceptanceContractDigest(f.current)).not.toBe(oldDigest);expect(staticSiteApprovalBindings(f.current)).not.toEqual(oldBinding);
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
    await currentAcceptance(f,50);expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
  });
  it("已有内容已满足时不强制制造重复部署或虚构备份",async()=>{
    const f=await fixture();const original=f.records.find(o=>(o.attempts[0]?.outcome?.result as any)?.data?.request?.path==="/tmp/site")!;
    (original.attempts[0]!.outcome!.result as any).data=manifest("/tmp/site","directory",newFiles);
    await currentAcceptance(f,18);expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
    expect(f.records.every(o=>o.effect==="read")).toBe(true);
  });
  it("备份目录后来内容损坏，即使首页及其他站点正常也不能完成",async()=>{
    const f=await deliveredFixture();await f.m(manifest("/tmp/backup","directory",{...oldFiles,"corruption":"unexpected"}),40);await f.refresh();
    expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.conditions.find(c=>c.id==="backup")!.state).toBe("unknown");
    expect(()=>prepareTaskDecision(f.current,decision(f))).toThrow("静态站点");
  });
  it("同端点其他任务的精确无关写入不销毁有效交付，备份路径写入则使其过期",async()=>{
    const f=await deliveredFixture();await externalTransfer(f,"/srv/unrelated/file");await f.refresh();
    expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
    await externalTransfer(f,"/tmp/backup/index.html");await f.refresh();
    expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
  });
  it("unknown保留原状但可信repository.resolve与后续新采样可解除屏障",async()=>{
    const f=await deliveredFixture(),records=await externalTransfer(f,"/tmp/backup/index.html",true,true);
    expect(records[0]!.attempts[0]!.status).toBe("unknown");expect(records[0]!.reconciliation?.status).toBe("completed");
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
    await currentAcceptance(f,60);expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).toBe("met");
    records[0]!.reconciliation!.evidenceRefs=["forged"];
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
  });
  it.each(["http_failed","text_truncated","config_unknown"])("最新%s使同资源旧成功证据失效",async(mode)=>{
    const f=await deliveredFixture();
    if(mode==="http_failed") {
      const o=await f.http("http://127.0.0.1:18080/",newFiles["index.html"],40);o.state="failed";o.attempts[0]!.status="failed";o.attempts[0]!.outcome!.status="failed";o.attempts[0]!.outcome!.result={success:false,error:"TIMEOUT"};
    } else if(mode==="text_truncated") {
      const o=await f.readText("/tmp/site/index.html",newFiles["index.html"],40);(o.attempts[0]!.outcome!.result as any).data.truncated=true;
    } else {
      const o=await f.configuration(40);(o.attempts[0]!.outcome!.result as any).data.analysis.status="unknown";
    }
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.state).not.toBe("met");
  });
});
