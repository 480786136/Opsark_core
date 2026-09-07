import { defineStore } from "pinia";
import { backend, isTauri } from "@/services/backend";
import { knowledgeRequest, KnowledgeError, normalizeEndpoint } from "./service";
import { serializeRecord } from "./record";
import type { KnowledgeBase, KnowledgeConfig, KnowledgeRecord, UploadEntry } from "./types";

const STORAGE = "opsark.knowledge.v1";
const defaults = (): KnowledgeConfig => ({endpoint:"http://127.0.0.1:8002/api/v1",credentialId:"knowledge-primary",hasApiKey:false,knowledgeBaseId:"",uploadEnabled:false,searchEnabled:false});
export const useKnowledgeStore = defineStore("knowledge", {
  state: () => ({ config: defaults(), entries: [] as UploadEntry[], revisions: {} as Record<string,number>, bases: [] as KnowledgeBase[], hydrated:false, busy:false, storageError:"" }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.hydrated=true;
      try {
        const saved=localStorage.getItem(STORAGE);
        if (!saved) return;
        const parsed=JSON.parse(saved);
        const c=parsed.config;
        if (!c || typeof c.credentialId!=="string" || !Array.isArray(parsed.entries)) throw new Error();
        this.config={ endpoint:normalizeEndpoint(c.endpoint), credentialId:c.credentialId,
          hasApiKey:c.hasApiKey===true,knowledgeBaseId:typeof c.knowledgeBaseId==="string"?c.knowledgeBaseId:"",
          uploadEnabled:c.uploadEnabled===true,searchEnabled:c.searchEnabled===true };
        this.entries=parsed.entries.filter((e: UploadEntry)=> typeof e.id==="string" && typeof e.body==="string" && e.body.length<300000 && typeof e.endpoint==="string")
          .map((e: UploadEntry)=>({...e, ...(e.status==="uploading"?{status:"failed",error:"上次请求中断，可用同一记录手动重试"}:{})})).slice(0,20);
        this.revisions=Object.fromEntries(Object.entries(parsed.revisions ?? {}).filter(([,v])=>Number.isSafeInteger(v) && Number(v)>0)) as Record<string,number>;
      } catch { this.storageError="知识配置或上传历史损坏，已暂停功能；原存储保留，请先备份后重置"; this.config=defaults(); }
    },
    persist() {
      if (this.storageError) throw new Error(this.storageError);
      // Reviewed payloads only; never persist input API keys or fetched keychain values.
      localStorage.setItem(STORAGE,JSON.stringify({config:this.config,entries:this.entries,revisions:this.revisions}));
    },
    async save(config: KnowledgeConfig, apiKey: string) {
      if (this.busy) throw new Error("请求进行中，请稍后保存");
      const endpoint=normalizeEndpoint(config.endpoint);
      const changed=endpoint!==this.config.endpoint;
      const hasApiKey=Boolean(apiKey.trim()) || !changed && this.config.hasApiKey;
      if (changed && this.config.hasApiKey && !apiKey.trim()) throw new Error("修改接口地址时请重新输入知识 Key，避免将旧凭据发送到新服务器");
      if (config.uploadEnabled && (!hasApiKey || !config.knowledgeBaseId)) throw new Error("启用上传前请保存 Key、测试连接并选择知识库");
      if (apiKey.trim()) {
        if (!isTauri()) throw new Error("请在桌面版保存知识 API Key");
      }
      const next: KnowledgeConfig={endpoint,credentialId:changed?crypto.randomUUID():this.config.credentialId,hasApiKey,
        knowledgeBaseId:config.knowledgeBaseId,uploadEnabled:config.uploadEnabled===true,searchEnabled:config.searchEnabled===true};
      if (changed) next.knowledgeBaseId="";
      if (changed && next.uploadEnabled) throw new Error("新地址需要先保存并测试连接，再选择知识库和启用上传");
      if (apiKey.trim()) await backend.saveCredential("knowledge",next.credentialId,apiKey.trim());
      const previous=this.config;
      this.config=next;
      try { this.persist(); } catch(error) { this.config=previous; throw error; }
      if(changed) this.bases=[];
    },
    async removeKey() {
      if(this.busy) throw new Error("请求进行中");
      if(!isTauri()) throw new Error("请在桌面版管理系统钥匙串");
      await backend.deleteCredential("knowledge",this.config.credentialId);
      this.config={...this.config,hasApiKey:false,uploadEnabled:false,searchEnabled:false};this.bases=[];this.persist();
    },
    async testConnection() {
      if(this.busy) throw new Error("请求进行中");
      this.busy=true;
      try {
        const data=await knowledgeRequest(this.config,"bases");
        if(!Array.isArray(data) || !data.every(x=>typeof x?.id==="string" && typeof x?.name==="string")) throw new Error("知识库列表格式无效");
        this.bases=data;
        return data;
      } finally { this.busy=false; }
    },
    nextRevision(taskId: string) { return (this.revisions[taskId] ?? 0)+1; },
    enqueue(record: KnowledgeRecord, destination?: Pick<KnowledgeConfig,"endpoint"|"credentialId">) {
      if(destination && (destination.endpoint!==this.config.endpoint || destination.credentialId!==this.config.credentialId)) throw new Error("目标接口已变化，请重新预览并确认");
      if(!this.config.uploadEnabled || !this.config.hasApiKey) throw new Error("请在设置中启用记录上传并保存知识 Key");
      if(record.knowledge_base_id!==this.config.knowledgeBaseId || !record.knowledge_base_id) throw new Error("目标知识库已变化，请重新预览");
      if(record.source_revision!==this.nextRevision(record.source_record_id)) throw new Error("已有新上传记录，请重新预览");
      if(this.entries.length>=20) throw new Error("上传历史已达 20 条，请移除不需要的本地记录后继续");
      const body=serializeRecord(record);
      const entry: UploadEntry={id:crypto.randomUUID(),taskId:record.source_record_id,title:record.title,createdAt:new Date().toISOString(),
        endpoint:this.config.endpoint,credentialId:this.config.credentialId,knowledgeBaseId:record.knowledge_base_id,
        body,idempotencyKey:crypto.randomUUID(),status:"pending"};
      this.entries.unshift(entry);this.revisions[entry.taskId]=record.source_revision;
      try { this.persist(); } catch(error) {this.entries.shift(); this.revisions[entry.taskId]=record.source_revision-1;throw error;}
      return entry.id;
    },
    async send(id: string) {
      const entry=this.entries.find(e=>e.id===id);
      if(!entry || entry.status==="accepted") return;
      if(this.busy) throw new Error("请求进行中，请稍后重试");
      if(!this.config.uploadEnabled) throw new Error("上传开关已关闭，队列已暂停");
      if(!this.config.hasApiKey || entry.endpoint!==this.config.endpoint || entry.credentialId!==this.config.credentialId || entry.knowledgeBaseId!==this.config.knowledgeBaseId) throw new Error("当前接口或目标库与预览时不同，请恢复原配置或重新预览上传");
      if(entry.retryAfter && Date.now()<entry.retryAfter) throw new Error("服务要求等待，请稍后再试");
      this.busy=true;
      try {
        entry.status="uploading";entry.error=undefined;this.persist();
        const result=await knowledgeRequest(this.config,"upload",{body:entry.body,idempotencyKey:entry.idempotencyKey}) as {record_id?:string;status?:string};
        if(!result || typeof result.record_id!=="string" || typeof result.status!=="string") throw new Error("接收响应格式不正确，可使用同一记录重试");
        entry.status="accepted";entry.recordId=result.record_id;entry.remoteStatus=result.status;
      } catch(error) {
        entry.status="failed";entry.error=error instanceof Error?error.message:"知识上传失败，请手动重试";
        if(error instanceof KnowledgeError) entry.retryAfter=Date.now()+error.retryAfterSeconds*1000;
      } finally {this.busy=false;this.persist();}
    },
    async refreshStatus(id: string) {
      const entry=this.entries.find(e=>e.id===id);
      if(!entry?.recordId || this.busy) return;
      if(!this.config.uploadEnabled) throw new Error("上传开关已关闭，不进行状态查询");
      if(entry.endpoint!==this.config.endpoint || entry.credentialId!==this.config.credentialId) throw new Error("当前服务与记录来源不同");
      this.busy=true;
      try {
        const result=await knowledgeRequest(this.config,"status",{recordId:entry.recordId}) as {status?:string};
        if(typeof result?.status!=="string") throw new Error("记录状态格式无效");
        entry.remoteStatus=result.status;this.persist();
      } finally {this.busy=false;}
    },
    forget(id: string) {
      if(this.busy) throw new Error("请求进行中");
      this.entries=this.entries.filter(e=>e.id!==id);this.persist();
    },
  },
});
