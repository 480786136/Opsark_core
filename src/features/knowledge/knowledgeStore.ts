import { defineStore } from "pinia";
import { backend, isTauri } from "@/services/backend";
import { knowledgeRequest, KnowledgeError, normalizeEndpoint } from "./service";
import { serializeRecord } from "./record";
import type { KnowledgeBase, KnowledgeConfig, KnowledgeRecord, TaskKnowledgeRetrieval, UploadEntry } from "./types";
import { i18n } from "@/features/preferences/i18n";

const STORAGE = "opsark.knowledge.v1";
const tr = (key: string, params?: Record<string, unknown>) => String(i18n.global.t(key, params ?? {}));
const defaults = (): KnowledgeConfig => ({endpoint:"http://127.0.0.1:8002/api/v1",credentialId:"knowledge-primary",hasApiKey:false,knowledgeBaseId:"",uploadEnabled:false,searchEnabled:false});
export const useKnowledgeStore = defineStore("knowledge", {
  state: () => ({ config: defaults(), entries: [] as UploadEntry[], revisions: {} as Record<string,number>, bases: [] as KnowledgeBase[], retrievals: {} as Record<string, TaskKnowledgeRetrieval>, hydrated:false, busy:false, storageError:"" }),
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
          .map((e: UploadEntry)=>({...e, ...(e.status==="uploading"?{status:"failed",error:tr("knowledge.interrupted")}:{})})).slice(0,20);
        this.revisions=Object.fromEntries(Object.entries(parsed.revisions ?? {}).filter(([,v])=>Number.isSafeInteger(v) && Number(v)>0)) as Record<string,number>;
      } catch { this.storageError=tr("knowledge.storageCorrupted"); this.config=defaults(); }
    },
    persist() {
      if (this.storageError) throw new Error(this.storageError);
      // Reviewed payloads only; never persist input API keys or fetched keychain values.
      localStorage.setItem(STORAGE,JSON.stringify({config:this.config,entries:this.entries,revisions:this.revisions}));
    },
    async save(config: KnowledgeConfig, apiKey: string) {
      if (this.busy) throw new Error(tr("knowledge.requestBusySave"));
      const endpoint=normalizeEndpoint(config.endpoint);
      const changed=endpoint!==this.config.endpoint;
      const hasApiKey=Boolean(apiKey.trim()) || !changed && this.config.hasApiKey;
      if (changed && this.config.hasApiKey && !apiKey.trim()) throw new Error(tr("knowledge.endpointChangeNeedsKey"));
      if ((config.uploadEnabled || config.searchEnabled) && (!hasApiKey || !config.knowledgeBaseId)) throw new Error(tr("knowledge.enableNeedsConfiguration"));
      if (apiKey.trim()) {
        if (!isTauri()) throw new Error(tr("knowledge.desktopSaveKey"));
      }
      const next: KnowledgeConfig={endpoint,credentialId:changed?crypto.randomUUID():this.config.credentialId,hasApiKey,
        knowledgeBaseId:config.knowledgeBaseId,uploadEnabled:config.uploadEnabled===true,searchEnabled:config.searchEnabled===true};
      if (changed) next.knowledgeBaseId="";
      if (changed && (next.uploadEnabled || next.searchEnabled)) throw new Error(tr("knowledge.newEndpointNeedsTest"));
      if (apiKey.trim()) await backend.saveCredential("knowledge",next.credentialId,apiKey.trim());
      const previous=this.config;
      this.config=next;
      try { this.persist(); } catch(error) { this.config=previous; throw error; }
      if(changed || !next.searchEnabled || next.knowledgeBaseId !== previous.knowledgeBaseId || apiKey.trim()) this.retrievals={};
      if(changed) this.bases=[];
    },
    async removeKey() {
      if(this.busy) throw new Error(tr("knowledge.requestBusy"));
      if(!isTauri()) throw new Error(tr("knowledge.desktopKeychain"));
      await backend.deleteCredential("knowledge",this.config.credentialId);
      this.config={...this.config,hasApiKey:false,uploadEnabled:false,searchEnabled:false};this.bases=[];this.retrievals={};this.persist();
    },
    async testConnection() {
      if(this.busy) throw new Error(tr("knowledge.requestBusy"));
      this.busy=true;
      try {
        const data=await knowledgeRequest(this.config,"bases");
        if(!Array.isArray(data) || !data.every(x=>typeof x?.id==="string" && typeof x?.name==="string")) throw new Error(tr("knowledge.invalidBaseList"));
        this.bases=data;
        return data;
      } finally { this.busy=false; }
    },
    nextRevision(taskId: string) { return (this.revisions[taskId] ?? 0)+1; },
    enqueue(record: KnowledgeRecord, destination?: Pick<KnowledgeConfig,"endpoint"|"credentialId">) {
      if(destination && (destination.endpoint!==this.config.endpoint || destination.credentialId!==this.config.credentialId)) throw new Error(tr("knowledge.destinationChanged"));
      if(!this.config.uploadEnabled || !this.config.hasApiKey) throw new Error(tr("knowledge.enableAndSaveKey"));
      if(record.knowledge_base_id!==this.config.knowledgeBaseId || !record.knowledge_base_id) throw new Error(tr("knowledge.baseChanged"));
      if(record.source_revision!==this.nextRevision(record.source_record_id)) throw new Error(tr("knowledge.newerUploadExists"));
      if(this.entries.length>=20) throw new Error(tr("knowledge.historyFull"));
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
      if(this.busy) throw new Error(tr("knowledge.requestBusyRetry"));
      if(!this.config.uploadEnabled) throw new Error(tr("knowledge.uploadPaused"));
      if(!this.config.hasApiKey || entry.endpoint!==this.config.endpoint || entry.credentialId!==this.config.credentialId || entry.knowledgeBaseId!==this.config.knowledgeBaseId) throw new Error(tr("knowledge.previewConfigurationChanged"));
      if(entry.retryAfter && Date.now()<entry.retryAfter) throw new Error(tr("knowledge.retryLater"));
      this.busy=true;
      try {
        entry.status="uploading";entry.error=undefined;this.persist();
        const result=await knowledgeRequest(this.config,"upload",{body:entry.body,idempotencyKey:entry.idempotencyKey}) as {record_id?:string;status?:string};
        if(!result || typeof result.record_id!=="string" || typeof result.status!=="string") throw new Error(tr("knowledge.invalidUploadResponse"));
        entry.status="accepted";entry.recordId=result.record_id;entry.remoteStatus=result.status;
      } catch(error) {
        entry.status="failed";entry.error=error instanceof Error?error.message:tr("knowledge.uploadFailed");
        if(error instanceof KnowledgeError) entry.retryAfter=Date.now()+error.retryAfterSeconds*1000;
      } finally {this.busy=false;this.persist();}
    },
    async refreshStatus(id: string) {
      const entry=this.entries.find(e=>e.id===id);
      if(!entry?.recordId || this.busy) return;
      if(!this.config.uploadEnabled) throw new Error(tr("knowledge.statusQueryDisabled"));
      if(entry.endpoint!==this.config.endpoint || entry.credentialId!==this.config.credentialId) throw new Error(tr("knowledge.recordServiceChanged"));
      this.busy=true;
      try {
        const result=await knowledgeRequest(this.config,"status",{recordId:entry.recordId}) as {status?:string};
        if(typeof result?.status!=="string") throw new Error(tr("knowledge.invalidRecordStatus"));
        entry.remoteStatus=result.status;this.persist();
      } finally {this.busy=false;}
    },
    forget(id: string) {
      if(this.busy) throw new Error(tr("knowledge.requestBusy"));
      this.entries=this.entries.filter(e=>e.id!==id);this.persist();
    },
  },
});
