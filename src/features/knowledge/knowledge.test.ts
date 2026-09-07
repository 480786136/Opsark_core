// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { OpsTask } from "@/types";
import { buildKnowledgeRecord, redactKnowledgeText, serializeRecord } from "./record";
import { normalizeEndpoint, knowledgeRequest, KnowledgeError } from "./service";
import { useKnowledgeStore } from "./knowledgeStore";
import { backend } from "@/services/backend";

vi.mock("@/services/backend",()=>({isTauri:()=>true,backend:{saveCredential:vi.fn(),deleteCredential:vi.fn()}}));
vi.mock("./service",async(importOriginal)=>({...await importOriginal<typeof import("./service")>(),knowledgeRequest:vi.fn()}));

const task = (): OpsTask => ({id:"task-1",serverId:"server-private",title:"排查服务",status:"completed",rootGoal:"检查 192.168.1.2 password=hidden",updatedAt:"2026-09-07T01:00:00Z",createdAt:"2026-09-07T00:00:00Z",messages:[{content:"private-message"}],summary:"private-summary",plan:[{id:"a",title:"检查服务",command:"echo private-key",output:"raw-secret",result:{executionStatus:"success",observationStatus:"observed",exitCode:0,facts:{token:"arbitrary-secret"},warnings:[],evidenceIds:[]}}]} as unknown as OpsTask);
function ready(){const s=useKnowledgeStore();s.hydrate();s.config={...s.config,hasApiKey:true,knowledgeBaseId:"kb-1",uploadEnabled:true};return s;}
beforeEach(()=>{localStorage.clear();setActivePinia(createPinia());vi.clearAllMocks();});

describe("knowledge record",()=>{
  it("uploads an allowlisted current snapshot without raw data or commands by default",()=>{
    const record=buildKnowledgeRecord(task(),"kb-1",1,["private-key"]);
    const body=serializeRecord(record);
    for(const secret of ["private-message","private-summary","raw-secret","arbitrary-secret","private-key","server-private","192.168.1.2","hidden"])expect(body).not.toContain(secret);
    expect(record.steps[0].command).toBeUndefined();expect(record.outcome.status).toBe("partial");
    expect(record.steps[0].validation_status).toBe("unknown");
  });
  it("redacts optional commands and recognizable credentials",()=>{
    expect(buildKnowledgeRecord(task(),"kb-1",1,["private-key"],true).steps[0].command).toBe("echo [已脱敏]");
    const cleaned=redactKnowledgeText('Authorization: Bearer abc\npassword="secret value"\nhttps://user:pass@host/path\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----');
    for(const secret of ["abc","secret value","user:pass","\nprivate\n"])expect(cleaned).not.toContain(secret);
  });
  it("limits steps and characters without breaking Unicode",()=>{
    const t=task();t.title="😀".repeat(201);t.plan=Array(35).fill(t.plan[0]);
    const record=buildKnowledgeRecord(t,"kb-1",1,[]);expect(record.steps).toHaveLength(30);expect(Array.from(record.title)).toHaveLength(200);
    expect(()=>serializeRecord({...record,problem:"中".repeat(100000)})).toThrow("256 KiB");
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
