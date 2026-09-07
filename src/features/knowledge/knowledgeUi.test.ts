// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import { useKnowledgeStore } from "./knowledgeStore";
import TaskKnowledgeUpload from "./TaskKnowledgeUpload.vue";
import KnowledgeSettings from "./KnowledgeSettings.vue";
import { knowledgeRequest } from "./service";

vi.mock("./service",async(original)=>({...await original<typeof import("./service")>(),knowledgeRequest:vi.fn()}));
let app: App,host:HTMLElement;
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();host=document.createElement("div");document.body.append(host);});
afterEach(()=>{app?.unmount();host.remove();});
async function mountTask(){
  const pinia=createPinia();setActivePinia(pinia);const ops=useOpsStore();const task=ops.createTask("server-a","safe","model-a");task.title="检查服务";
  const knowledge=useKnowledgeStore();knowledge.config={...knowledge.config,hasApiKey:true,uploadEnabled:true,knowledgeBaseId:"kb-1"};
  app=createApp(TaskKnowledgeUpload,{task}).use(pinia);app.mount(host);await nextTick();return knowledge;
}
const button=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent?.includes(text))!;
it("requires preview and explicit consent before any request",async()=>{
  const knowledge=await mountTask();button("上传任务记录").click();await nextTick();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();expect(button("确认并上传").disabled).toBe(true);expect(knowledgeRequest).not.toHaveBeenCalled();
  const checks=document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]');checks[1].click();await nextTick();
  vi.mocked(knowledgeRequest).mockResolvedValue({record_id:"rec-1",status:"pending"});button("确认并上传").click();
  await new Promise(resolve=>setTimeout(resolve,0));await nextTick();expect(knowledge.entries[0].status).toBe("accepted");expect(document.body.textContent).toContain("不等于已发布知识");
});
it("keeps the preview destination visible and blocks upload after configuration changes",async()=>{
  const knowledge=await mountTask();button("上传任务记录").click();await nextTick();knowledge.config.endpoint="https://changed.example/api/v1";
  document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')[1].click();await nextTick();button("确认并上传").click();await nextTick();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("http://127.0.0.1:8002/api/v1");expect(document.body.textContent).toContain("目标接口已变化");expect(knowledgeRequest).not.toHaveBeenCalled();
});
it("renders safe defaults and the browser-only warning on the settings page",async()=>{
  const pinia=createPinia();app=createApp(KnowledgeSettings).use(pinia);app.mount(host);await nextTick();
  expect(host.textContent).toContain("当前为浏览器预览");expect(host.textContent).toContain("尚未接入 Agent");
  expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).every(i=>!i.checked)).toBe(true);
  expect(knowledgeRequest).not.toHaveBeenCalled();
});
