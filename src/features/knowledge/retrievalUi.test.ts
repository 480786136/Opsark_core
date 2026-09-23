// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useKnowledgeStore } from "./knowledgeStore";
import { readKnowledgeCitation } from "./service";
import TaskKnowledgeReferences from "./TaskKnowledgeReferences.vue";
import { i18n } from "@/features/preferences/i18n";
import type { KnowledgeHit } from "./types";

vi.mock("./service", async original => ({ ...await original<typeof import("./service")>(), readKnowledgeCitation: vi.fn() }));
let app: App, host: HTMLElement;
beforeEach(() => { localStorage.clear(); i18n.global.locale.value="zh-CN"; vi.clearAllMocks(); host=document.createElement("div");document.body.append(host); });
afterEach(() => { app?.unmount();host.remove(); });
async function mountReferences() {
  const pinia=createPinia();setActivePinia(pinia);const store=useKnowledgeStore();
  store.config={...store.config,searchEnabled:true,hasApiKey:true,knowledgeBaseId:"kb-1"};
  const hit:KnowledgeHit={chunk_id:"chunk",document_id:"doc",document_version:2,knowledge_base_id:"kb-1",title:"排查",content:"<script>steal()</script>",rank:1,citation:{label:"K1",line_start:2,line_end:3,source_record_ids:["rec"],document_url:"https://evil.example"}};
  store.retrievals.task={requestId:"request",endpoint:store.config.endpoint,credentialId:store.config.credentialId,knowledgeBaseId:"kb-1",status:"ready",result:{retrieval_mode:"keyword_only",index_version:"index",hits:[hit],truncated:false,warnings:[]}};
  app=createApp(TaskKnowledgeReferences,{taskId:"task"}).use(pinia).use(i18n);app.mount(host);await nextTick();return store;
}
it("renders reference versions and lines as text, and resolves source through the authenticated service",async()=>{
  await mountReferences();expect(host.textContent).toContain("版本 2 · 第 2–3 行");expect(host.textContent).toContain("关键词检索");
  expect(host.querySelector("script")).toBeNull();expect(host.querySelector("a")).toBeNull();
  vi.mocked(readKnowledgeCitation).mockResolvedValue({document_id:"doc",version:2,title:"排查",content:"标题\n配置\n校验\n其他"});
  host.querySelector("button")!.click();await new Promise(resolve=>setTimeout(resolve,0));await nextTick();
  expect(readKnowledgeCitation).toHaveBeenCalledOnce();expect(host.textContent).toContain("2  配置");expect(host.textContent).toContain("3  校验");
});
it("shows unavailable versions without falling back to stale cached content",async()=>{
  await mountReferences();vi.mocked(readKnowledgeCitation).mockRejectedValue(new Error("引用版本已下架"));host.querySelector("button")!.click();
  await new Promise(resolve=>setTimeout(resolve,0));await nextTick();expect(host.querySelector('[role="alert"]')?.textContent).toContain("下架");
  expect(host.querySelector("section pre")).toBeNull();
});
it("hides references immediately when retrieval is disabled",async()=>{
  const store=await mountReferences();store.config.searchEnabled=false;await nextTick();expect(host.querySelector("details")).toBeNull();
});
