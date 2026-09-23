// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { OpsTask, ServerProfile } from "@/types";
import { buildKnowledgeRecord, knowledgeExcerpt, redactKnowledgeText, serializeRecord } from "./record";
import { normalizeEndpoint, knowledgeRequest, KnowledgeError } from "./service";
import { useKnowledgeStore } from "./knowledgeStore";
import { backend } from "@/services/backend";

vi.mock("@/services/backend",()=>({isTauri:()=>true,backend:{saveCredential:vi.fn(),deleteCredential:vi.fn()}}));
vi.mock("./service",async(importOriginal)=>({...await importOriginal<typeof import("./service")>(),knowledgeRequest:vi.fn()}));

const task = (): OpsTask => ({id:"task-1",serverId:"server-private",title:"排查服务",status:"completed",rootGoal:"检查 192.168.1.2 password=hidden",updatedAt:"2026-09-07T01:00:00Z",createdAt:"2026-09-07T00:00:00Z",messages:[{content:"private-message"}],summary:"private-summary",plan:[{id:"a",title:"检查服务",command:"echo private-key",output:"raw-secret",result:{executionStatus:"success",observationStatus:"observed",exitCode:0,facts:{token:"arbitrary-secret"},warnings:[],evidenceIds:[]}}]} as unknown as OpsTask);
function ready(){const s=useKnowledgeStore();s.hydrate();s.config={...s.config,hasApiKey:true,knowledgeBaseId:"kb-1",uploadEnabled:true};return s;}
beforeEach(()=>{localStorage.clear();setActivePinia(createPinia());vi.clearAllMocks();});

describe("knowledge record",()=>{
  it("exports reviewed excerpts and summary, while excluding credentials and arbitrary facts",()=>{
    const record=buildKnowledgeRecord(task(),"kb-1",1,["private-key", "raw-secret", "private-summary"]);
    const body=serializeRecord(record);
    for(const secret of ["private-message","private-summary","raw-secret","arbitrary-secret","private-key","server-private","192.168.1.2","hidden"])expect(body).not.toContain(secret);
    expect(record.steps[0].command).toBeUndefined();expect(record.outcome.status).toBe("partial");
    expect(record.steps[0].validation_status).toBe("unknown");
    expect(record.outcome.summary).toContain("Core 总结");
    expect(record.steps[0].evidence[0].excerpt).toBe("[已脱敏]");
  });
  it("exports independent verification and complete descriptions without inferring it from exit zero",()=>{
    const t=task(), step=t.plan[0];
    step.status="completed";step.description="父目录可写，目标不存在时执行";step.expected="FETCH_OK";
    step.result!.evidenceIds=["main", "check"];
    step.evidence=[
      {id:"main",type:"command-output",source:"main",facts:{secret:"never-export"},rawOutput:"克隆完成",collectedAt:t.updatedAt},
      {id:"check",type:"command",source:"validation",facts:{passed:true,exitCode:0,token:"never-export"},rawOutput:"FETCH_OK\npassword=hidden",collectedAt:t.updatedAt},
    ];
    t.summary="仓库获取完成，校验输出 FETCH_OK";
    const record=buildKnowledgeRecord(t,"kb-1",1,[]);
    expect(record.steps[0].description).toContain(step.description);
    expect(record.steps[0].validation_status).toBe("passed");
    expect(record.steps[0].evidence.find(e=>e.kind==="validation")?.excerpt).toContain("FETCH_OK");
    expect(serializeRecord(record)).not.toContain("never-export");
    expect(serializeRecord(record)).not.toContain("hidden");
    expect(record.outcome.status).toBe("succeeded");
    step.evidence[1].facts.passed=false;
    expect(buildKnowledgeRecord(t,"kb-1",1,[]).outcome.status).toBe("partial");
    expect(buildKnowledgeRecord(t,"kb-1",1,[]).steps[0].validation_status).toBe("failed");
    step.evidence[1].facts.passed=true;
    step.evidence[1].archive={evidenceId:"a",fingerprint:"f",characters:100,capturedPartial:true};
    expect(buildKnowledgeRecord(t,"kb-1",1,[]).steps[0].validation_status).toBe("unknown");
  });
  it("keeps current-round failed attempts and explicitly excludes other rounds",()=>{
    const t=task();t.currentRoundId="current";
    t.phaseHistory=[{id:"p",roundId:"current",plan:[{...t.plan[0],status:"failed",title:"先前失败尝试"}],requirement:"目标",reason:"adjustment",createdAt:t.createdAt,completedAt:t.updatedAt},
      {id:"old",roundId:"old",plan:[{...t.plan[0],title:"other-round"}],requirement:"旧目标",reason:"adjustment",createdAt:t.createdAt,completedAt:t.updatedAt}];
    const r=buildKnowledgeRecord(t,"kb-1",1,[]);
    expect(r.steps).toHaveLength(2);expect(r.steps[0].description).toContain("先前失败尝试");
    expect(serializeRecord(r)).not.toContain("other-round");expect(r.outcome.summary).toContain("未导出的历史");
  });
  it("exports the latest executed archive after a display-only side question",()=>{
    const t=task(), executed={...t.plan[0]};
    executed.status="completed";executed.result!.observationStatus="matched";
    executed.result!.evidenceIds=["main"];
    executed.evidence=[{id:"main",type:"command",source:"main",facts:{},rawOutput:"clone complete",collectedAt:t.updatedAt}];
    t.currentRoundId="question-round";t.plan=[];t.phaseHistory=[];t.summary=undefined;t.lastRequirementRelation="side_question";
    t.planHistory=[{id:"execution-round",requirement:"拉取项目",status:"completed",plan:[executed],summary:"项目已拉取",createdAt:t.createdAt,completedAt:t.updatedAt}];
    const record=buildKnowledgeRecord(t,"kb-1",2,[]);
    expect(record.steps).toHaveLength(1);
    expect(record.problem).toBe("拉取项目");
    expect(record.outcome.summary).toContain("最近一次有执行步骤的已归档轮次");
    expect(record.outcome.summary).toContain("项目已拉取");
  });
  it("filters progress noise and redacts before selecting bounded output excerpts",()=>{
    const output="GIT_AVAILABLE=yes\n接收对象中: 1%\r接收对象中: 50%\r接收对象中: 100%, 完成.\nFETCH_OK";
    const excerpt=knowledgeExcerpt(output,[]);
    expect(excerpt).toContain("GIT_AVAILABLE=yes");expect(excerpt).toContain("FETCH_OK");
    expect(excerpt).not.toContain("50%");
    const long=knowledgeExcerpt("--password topsecret\n"+"x".repeat(4000)+"\nHEAD=abc",[]);
    expect(long).not.toContain("topsecret");expect(long).toContain("内容已省略");
    expect(long).toContain("HEAD=abc");expect(Array.from(long).length).toBeLessThanOrEqual(2000);
    expect(knowledgeExcerpt("credential: top\u001b[31msecret",["topsecret"])).not.toContain("topsecret");
  });
  it("does not reuse stale validation or export a cut-off executable command",()=>{
    const t=task();const step=t.plan[0];
    step.command="echo "+"x".repeat(4100);
    step.evidence=[{id:"stale",source:"validation",type:"command",facts:{passed:true},rawOutput:"OLD_PASS",collectedAt:t.createdAt}];
    step.result!.evidenceIds=["current"];
    const record=buildKnowledgeRecord(t,"kb-1",1,[],true);
    expect(record.steps[0].command).toBeUndefined();
    expect(record.steps[0].validation_status).toBe("unknown");
    expect(serializeRecord(record)).not.toContain("OLD_PASS");
    expect(serializeRecord(record)).toContain("已省略整条命令");
  });
  it("redacts optional commands and recognizable credentials",()=>{
    expect(buildKnowledgeRecord(task(),"kb-1",1,["private-key"],true).steps[0].command).toBe("echo [已脱敏]");
    const cleaned=redactKnowledgeText('Authorization: Bearer abc\npassword="secret value"\nhttps://user:pass@host/path\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----');
    for(const secret of ["abc","secret value","user:pass","\nprivate\n"])expect(cleaned).not.toContain(secret);
  });
  it("keeps MySQL evidence intact when unrelated scoped secrets are short",()=>{
    const t=task(),step=t.plan[0];
    step.status="completed";
    step.command='mysql --host=localhost --port=3306 --user="${secret.MYSQL_USERNAME}" --password="${secret.MYSQL_PASSWORD}" --execute="SHOW DATABASES;" 2>&1';
    step.result={executionStatus:"success",observationStatus:"matched",exitCode:0,facts:{},warnings:[],evidenceIds:["main"]};
    step.evidence=[{id:"main",type:"command-output",source:"main",facts:{},rawOutput:"mysql Ver 8.0.43\nERROR 1045 (28000)\nDatabase\ninformation_schema\nmysql\noaoa\nproject_db\nCURRENT_USER()\tUSER()\nroot@%\troot@localhost\nGrants for root@%\nGRANT ALL ON *.* TO root@%\n[exit: 0]",collectedAt:t.updatedAt}];
    t.summary="当前账户可见 5 个数据库：information_schema、mysql、oaoa、project_db、sys。";
    const context={secretValues:{MYSQL_USERNAME:"root",MYSQL_PASSWORD:"1",OTHER_COUNT:"5",OTHER_PORT:"3306",OTHER_CHAR:"a"},redactIpAddresses:true};
    const record=buildKnowledgeRecord(t,"kb-1",1,context,true);
    const body=serializeRecord(record);
    expect(record.steps[0].command).toContain("--port=3306");
    expect(record.steps[0].command).toContain("2>&1");
    expect(record.steps[0].command).not.toContain('${secret.MYSQL_PASSWORD}');
    expect(record.steps[0].evidence[0].summary).toContain("退出码=0");
    expect(record.steps[0].evidence[0].excerpt).toContain("8.0.43");
    expect(record.steps[0].evidence[0].excerpt).toContain("1045 (28000)");
    expect(record.steps[0].evidence[0].excerpt).toContain("oaoa");
    expect(record.steps[0].evidence[0].excerpt).toContain("数据库身份与授权明细已省略");
    expect(record.steps[0].evidence[0].excerpt).not.toContain("GRANT ALL");
    expect(record.steps[0].evidence[0].excerpt).not.toContain("root@localhost");
    expect(record.outcome.summary).toContain("共 1/1 步");
    expect(record.outcome.summary).toContain("可见 5 个数据库");
    expect(record.redaction.ruleset_version).toBe("core-upload-v3");
    expect(()=>JSON.parse(body)).not.toThrow();
    t.rootGoal="审计当前账户权限和 SHOW GRANTS";
    expect(buildKnowledgeRecord(t,"kb-1",2,context).steps[0].evidence[0].excerpt).toContain("GRANT ALL");
  });
  it("can force-redact a short value when handling unredacted legacy text",()=>{
    const cleaned=redactKnowledgeText(
      "legacy credential is x; CPU=20",
      {secretValues:{LEGACY_PASSWORD:"x",OTHER_COUNT:"20"}},
      ["LEGACY_PASSWORD"],
    );
    expect(cleaned).toBe("legacy credential is [已脱敏]; CPU=20");
  });
  it("limits steps and characters without breaking Unicode",()=>{
    const t=task();t.title="😀".repeat(201);t.plan=Array(35).fill(t.plan[0]);
    const record=buildKnowledgeRecord(t,"kb-1",1,[]);expect(record.steps).toHaveLength(30);expect(Array.from(record.title)).toHaveLength(200);
    expect(()=>serializeRecord({...record,problem:"中".repeat(100000)})).toThrow("256 KiB");
  });
  it("keeps attempt and evidence IDs stable as the export window moves, and types expectations explicitly",()=>{
    const t=task();t.plan=Array.from({length:31},(_,index)=>({...t.plan[0],id:`step-${index}`,expected:"HTTP 200",result:{...t.plan[0].result!,evidenceIds:[`main-${index}`]}}));
    const first=buildKnowledgeRecord(t,"kb-1",1,[]);
    t.plan.push({...t.plan[0],id:"step-31",result:{...t.plan[0].result!,evidenceIds:["main-31"]}});
    const second=buildKnowledgeRecord(t,"kb-1",2,[]);
    expect(first.steps[1].step_id).toBe(second.steps[0].step_id);
    expect(first.steps[1].evidence.map(e=>e.evidence_id)).toEqual(second.steps[0].evidence.map(e=>e.evidence_id));
    expect(second.steps[0].evidence.find(e=>e.summary.includes("预期验收标准"))?.kind).toBe("expectation");
    expect(new Set(second.steps.map(step=>step.step_id)).size).toBe(30);
    const nextAttempt={...t.plan[1],startedAt:"2026-09-23T01:02:03Z"};
    t.plan.push(nextAttempt);
    expect(buildKnowledgeRecord(t,"kb-1",3,[]).steps[29]?.step_id).not.toBe(first.steps[0].step_id);
  });
  it("exports only runtime collected from linked evidence and metadata of that exact target",()=>{
    const t=task(),step=t.plan[0];step.result!.evidenceIds=["main"];
    step.evidence=[{id:"main",source:"main",type:"command-output",rawOutput:"ok",facts:{},collectedAt:t.updatedAt,
      scope:{targetId:"server-private",scope:"isolated_exec",shell:"bash",persistence:"command",doesNotProve:["不证明用户交互会话状态"]}}];
    const server={id:"server-private",info:{os:"Ubuntu 24.04"},environment:["nginx 1.26.2","Docker","password=hidden"]} as ServerProfile;
    const record=buildKnowledgeRecord(t,"kb-1",1,[],false,server);
    expect(record.context).toMatchObject({runtime:{os:"Ubuntu 24.04",shell:"bash",scope:"isolated_exec",visibility:"不证明用户交互会话状态"},software:[{name:"nginx",version:"1.26.2"}]});
    expect(serializeRecord(record)).not.toContain("server-private");expect(serializeRecord(record)).not.toContain("hidden");
    expect(record.context?.runtime?.privilege).toBeUndefined();
    const wrongServer=buildKnowledgeRecord(t,"kb-1",1,[],false,{...server,id:"other"});
    expect(wrongServer.context?.runtime?.os).toBeUndefined();expect(wrongServer.context?.software).toBeUndefined();
    step.result!.evidenceIds=[];
    expect(buildKnowledgeRecord(t,"kb-1",1,[],false,server).context).toBeUndefined();
  });
});

describe("destination validation",()=>{
  it("allows local development and HTTPS with the API prefix",()=>{
    expect(normalizeEndpoint(" http://127.0.0.1:8002/api/v1/ ")).toBe("http://127.0.0.1:8002/api/v1");
    expect(normalizeEndpoint("https://kb.example/api/v1")).toBe("https://kb.example/api/v1");
  });
  it.each(["http://remote.example/api/v1","https://u:p@host/api/v1","https://host/api/v1?key=x","https://host/api/v1#x","https://host/internal/v1","file:///api/v1"])("rejects %s",url=>expect(()=>normalizeEndpoint(url)).toThrow());
});

describe("knowledge upload store",()=>{
  it("defaults to disabled and stores the API key only in the keychain",async()=>{
    const s=useKnowledgeStore();s.hydrate();expect(s.config.uploadEnabled).toBe(false);expect(s.config.searchEnabled).toBe(false);
    await s.save({...s.config},"demo-private-key");
    expect(backend.saveCredential).toHaveBeenCalledWith("knowledge","knowledge-primary","demo-private-key");
    expect(localStorage.getItem("opsark.knowledge.v1")).not.toContain("demo-private-key");
  });
  it("does not enable configuration if credential storage fails",async()=>{
    const s=useKnowledgeStore();vi.mocked(backend.saveCredential).mockRejectedValueOnce(new Error("keychain unavailable"));
    await expect(s.save({...s.config},"key")).rejects.toThrow("keychain");expect(s.config.hasApiKey).toBe(false);
  });
  it("requires re-entry on URL change and invalidates the old base",async()=>{
    const s=ready();await expect(s.save({...s.config,endpoint:"https://new.example/api/v1"},"")).rejects.toThrow();
    await s.save({...s.config,endpoint:"https://new.example/api/v1",uploadEnabled:false},"new-key");
    expect(s.config.knowledgeBaseId).toBe("");expect(s.config.credentialId).not.toBe("knowledge-primary");
  });
  it("requires another preview if the destination changed",()=>{
    const s=ready(), destination={...s.config};s.config.endpoint="https://new.example/api/v1";
    expect(()=>s.enqueue(buildKnowledgeRecord(task(),"kb-1",1,[]),destination)).toThrow("目标接口");expect(s.entries).toHaveLength(0);
  });
  it("retries the exact same body and idempotency key, and refreshes processing status",async()=>{
    const s=ready(),id=s.enqueue(buildKnowledgeRecord(task(),"kb-1",1,[]));
    vi.mocked(knowledgeRequest).mockRejectedValueOnce(new Error("timeout"));await s.send(id);expect(s.entries[0].status).toBe("failed");
    const first=vi.mocked(knowledgeRequest).mock.calls[0][2];
    vi.mocked(knowledgeRequest).mockResolvedValueOnce({record_id:"rec-1",status:"pending"});await s.send(id);
    expect(vi.mocked(knowledgeRequest).mock.calls[1][2]).toEqual(first);expect(s.entries[0].status).toBe("accepted");
    vi.mocked(knowledgeRequest).mockResolvedValueOnce({status:"processed"});await s.refreshStatus(id);expect(s.entries[0].remoteStatus).toBe("processed");
    expect(s.nextRevision("task-1")).toBe(2);
  });
  it("blocks sends when disabled or the destination changed",async()=>{
    const s=ready(),id=s.enqueue(buildKnowledgeRecord(task(),"kb-1",1,[]));s.config.uploadEnabled=false;
    await expect(s.send(id)).rejects.toThrow();s.config.uploadEnabled=true;s.config.endpoint="https://other.example/api/v1";
    await expect(s.send(id)).rejects.toThrow();expect(knowledgeRequest).not.toHaveBeenCalled();
  });
  it("honors server retry delay",async()=>{
    const s=ready(),id=s.enqueue(buildKnowledgeRecord(task(),"kb-1",1,[]));vi.mocked(knowledgeRequest).mockRejectedValueOnce(new KnowledgeError("rate limited",60));
    await s.send(id);await expect(s.send(id)).rejects.toThrow("等待");expect(knowledgeRequest).toHaveBeenCalledTimes(1);
  });
  it("restores interrupted uploads without automatically sending",()=>{
    const s=ready();s.enqueue(buildKnowledgeRecord(task(),"kb-1",1,[]));s.entries[0].status="uploading";s.persist();
    setActivePinia(createPinia());const restored=useKnowledgeStore();restored.hydrate();
    expect(restored.entries[0].status).toBe("failed");expect(knowledgeRequest).not.toHaveBeenCalled();
    restored.forget(restored.entries[0].id);expect(restored.nextRevision("task-1")).toBe(2);
  });
  it("preserves corrupt storage and disables the feature",()=>{
    localStorage.setItem("opsark.knowledge.v1","broken");const s=useKnowledgeStore();s.hydrate();
    expect(s.config.uploadEnabled).toBe(false);expect(()=>s.persist()).toThrow();expect(localStorage.getItem("opsark.knowledge.v1")).toBe("broken");
  });
});
