import { describe, expect, it } from "vitest";
import type { TaskRequirementUpdate } from "@/types";
import { applyTaskRequirementUpdate, ensureTaskRequirementLifecycle } from "./taskRequirements";
import { acceptPreparedPlanApproval } from "./stepApproval";
import { assertStaticSiteMutation, assertStaticSiteRequirementComplete, evaluateStaticSiteLedger,
  staticSiteAcceptanceContext, staticSiteApprovalBindings, validateAcceptanceCoverage } from "./staticSiteAcceptance";

import { fixture, task, update, request, source, server, manifest, oldFiles, newFiles, sourceTime } from "./staticSiteAcceptance.fixtures";

describe("静态站点需求覆盖、真实账本与业务完成闭环",()=>{
  it("精确覆盖目标和约束，拒绝遗漏、伪造来源和从HTTP反推路径",()=>{
    expect(()=>validateAcceptanceCoverage(update(),request)).not.toThrow();
    for(const edit of [(u:TaskRequirementUpdate)=>u.acceptanceCoverage!.pop(),(u:TaskRequirementUpdate)=>u.acceptanceCoverage![0]!.sourceQuote="伪造",(u:TaskRequirementUpdate)=>u.acceptanceCoverage![0]!.staticSite!.artifactPath="/tmp/unmentioned"]){const u=update();edit(u);expect(()=>validateAcceptanceCoverage(u,request)).toThrow();}
    const t=task();expect(t.requirementLifecycle!.items[0]!.acceptance?.strategy).toBe("static_site");
  });
  it("不能以当前用户的一次普通补充把已冻结static降为general",()=>{
    const t=task(),u=update();u.baseRevision=1;u.additions=[{id:"new",kind:"goal",content:request,sourceQuote:request,supersedes:["deploy"]}];u.focusIds=["new"];u.acceptanceCoverage=[{requirementId:"new",strategy:"general_review",sourceQuote:request,reason:"跳过验收"}];
    expect(()=>applyTaskRequirementUpdate(t,u,{source,roundId:"round"})).toThrow("降级");
  });
  it("损坏的持久验收契约显式拒绝，不沿旧任务迁移路径退回通用验收",()=>{
    const t=task();delete t.requirementLifecycle!.items[0]!.acceptance!.staticSite;
    expect(()=>ensureTaskRequirementLifecycle(t)).toThrow("不能退回");
  });
  it("完整事前基线可批准后续真实操作；仅有基线不能完成",async()=>{
    const f=await fixture();await f.refresh();const a=staticSiteAcceptanceContext(f.current).assessment!;
    expect(a.assessments[0],JSON.stringify(a)).toMatchObject({baselineReady:true,rootPath:"/tmp/site",state:"not_met"});
    const prepared=await f.change(10);expect(acceptPreparedPlanApproval(prepared,prepared)).toBeDefined();
    expect(()=>assertStaticSiteMutation(f.current,prepared.compatibilitySteps[0]!)).not.toThrow();
    expect(()=>assertStaticSiteRequirementComplete(f.current,"deploy")).toThrow();
  });
  it("可满足路径：事前包/配置/目录/对照→备份→旧目录复核→部署→成员/HTTP/保护验收",async()=>{
    const f=await fixture();await f.refresh();await f.change(10);await f.m(manifest("/tmp/backup","directory",oldFiles),12);await f.m(manifest("/tmp/site","directory",oldFiles),14);
    await f.change(16);await f.m(manifest("/tmp/site","directory",newFiles),18);await f.http("http://127.0.0.1:18080/",newFiles["index.html"],20);await f.http("http://127.0.0.1:18080/style.css","body{}",22);await f.http("http://127.0.0.1:18081/","CONTROL",24);await f.configuration(26);await f.m(manifest("/tmp/backup","directory",oldFiles),28);await f.refresh();
    expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0],JSON.stringify(staticSiteAcceptanceContext(f.current))).toMatchObject({state:"met"});
    expect(()=>assertStaticSiteRequirementComplete(f.current,"deploy")).not.toThrow();
  });
  it("旧页200、无备份和缺少资源只能保持未满足，不因模型给出完成理由而通过",async()=>{
    const f=await fixture();await f.refresh();await f.change(10);await f.m(manifest("/tmp/site","directory",newFiles),12);await f.http("http://127.0.0.1:18080/","OLD",14);await f.http("http://127.0.0.1:18080/style.css","404",16,404);await f.http("http://127.0.0.1:18081/","CONTROL",18);await f.configuration(20);await f.refresh();
    const a=staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!;expect(a.state).toBe("not_met");expect(a.conditions.find(c=>c.id==="backup")!.state).toBe("unknown");expect(()=>assertStaticSiteRequirementComplete(f.current,"deploy")).toThrow();
  });
  it.each(["foreign_task","generation","late","unknown_change","truncated"])("%s 不会变成可写基线",async(mode)=>{
    const f=await fixture();const operation=f.records[0]!;
    if(mode==="foreign_task")operation.taskId="other";
    if(mode==="generation")return expect(evaluateStaticSiteLedger(f.current,server,2,f.records).assessments[0]!.baselineReady).toBe(false);
    if(mode==="late")operation.attempts[0]!.late=true;
    if(mode==="truncated")(operation.attempts[0]!.outcome!.result as any).data.truncated=true;
    if(mode==="unknown_change"){await f.change(10);const o=f.records[f.records.length-1]!;o.state="unknown";o.attempts[0]!.status="unknown";o.attempts[0]!.outcome!.status="unknown";}
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.baselineReady).toBe(false);
  });
  it("重启没有私有投影时不能沿持久summary授予完成，新要求也使已有基线失效",async()=>{
    const f=await fixture();await f.refresh();const old=staticSiteApprovalBindings(f.current);
    expect(()=>assertStaticSiteRequirementComplete(JSON.parse(JSON.stringify(f.current)),"deploy")).toThrow();
    f.current.requirementLifecycle!.items[1]!.lastChangedAt=sourceTime(50);expect(staticSiteApprovalBindings(f.current)).not.toEqual(old);
    await f.refresh();expect(staticSiteAcceptanceContext(f.current).assessment!.assessments[0]!.baselineReady).toBe(false);
  });
});
