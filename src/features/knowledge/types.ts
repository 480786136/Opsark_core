export interface KnowledgeConfig {
  endpoint: string;
  credentialId: string;
  hasApiKey: boolean;
  knowledgeBaseId: string;
  uploadEnabled: boolean;
  searchEnabled: boolean;
}
export interface KnowledgeBase { id: string; name: string; description?: string }
export interface KnowledgeRecord {
  schema_version: "1.0";
  source_record_id: string;
  source_revision: number;
  knowledge_base_id: string;
  record_type: "task_result";
  title: string;
  occurred_at: string;
  problem: string;
  steps: Array<{
    step_id: string; description: string; command?: string;
    execution_status: "succeeded" | "failed" | "blocked" | "not_run" | "unknown";
    validation_status: "passed" | "failed" | "unknown" | "not_run";
    evidence: Array<{ evidence_id: string; kind: "command_result"; summary: string }>;
  }>;
  outcome: { status: "partial" | "unknown"; summary: string };
  redaction: { client_applied: true; ruleset_version: string };
}
export interface UploadEntry {
  id: string; taskId: string; title: string; createdAt: string;
  endpoint: string; credentialId: string; knowledgeBaseId: string;
  body: string; idempotencyKey: string;
  status: "pending" | "uploading" | "accepted" | "failed";
  recordId?: string; remoteStatus?: string; error?: string;
  retryAfter?: number;
}
