// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/services/backend";
import { knowledgeRequest } from "./service";
import type { KnowledgeConfig } from "./types";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("@/services/backend",()=>({isTauri:vi.fn(()=>true)}));
const config:KnowledgeConfig={endpoint:"http://localhost:8002/api/v1/",credentialId:"knowledge-primary",hasApiKey:true,knowledgeBaseId:"kb",uploadEnabled:true,searchEnabled:false};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(isTauri).mockReturnValue(true);});
it("passes a credential reference and the exact body to Rust, not a secret",async()=>{
  vi.mocked(invoke).mockResolvedValue({status:202,data:{record_id:"r"}});
  await knowledgeRequest(config,"upload",{body:'{"title":"任务"}',idempotencyKey:"id"});
  expect(invoke).toHaveBeenCalledWith("knowledge_request",{endpoint:"http://localhost:8002/api/v1",credentialId:"knowledge-primary",operation:"upload",body:'{"title":"任务"}',idempotencyKey:"id"});
});
it("blocks browser requests",async()=>{vi.mocked(isTauri).mockReturnValue(false);await expect(knowledgeRequest(config,"bases")).rejects.toThrow("桌面版");expect(invoke).not.toHaveBeenCalled();});
it("does not show sensitive remote error messages",async()=>{
  vi.mocked(invoke).mockResolvedValue({status:429,data:{error:{message:"private-server-content"}},retryAfterSeconds:30});
  await expect(knowledgeRequest(config,"bases")).rejects.toMatchObject({message:"请求过于频繁，请稍后重试",retryAfterSeconds:30});
});
