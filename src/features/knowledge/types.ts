export interface KnowledgeConfig {
  endpoint: string;
  credentialId: string;
  hasApiKey: boolean;
  knowledgeBaseId: string;
  uploadEnabled: boolean;
  searchEnabled: boolean;
}
export interface KnowledgeBase { id: string; name: string; description?: string }
export interface KnowledgeHit {
  chunk_id: string;
  document_id: string;
  document_version: number;
  knowledge_base_id: string;
  title: string;
  content: string;
  rank: number;
  citation: { label: string; line_start: number; line_end: number; source_record_ids: string[]; document_url: string };
}
export interface KnowledgeSearchResult {
  retrieval_mode: "keyword_only" | "hybrid";
  index_version: string;
  hits: KnowledgeHit[];
  truncated: boolean;
  warnings: string[];
}
export interface KnowledgeDocumentVersion {
  document_id: string;
  version: number;
  title: string;
  content: string;
}
export interface TaskKnowledgeRetrieval {
  requestId: string;
  query?: string;
  endpoint: string;
  credentialId: string;
  knowledgeBaseId: string;
  status: "searching" | "ready" | "unavailable";
  result?: KnowledgeSearchResult;
}
export interface KnowledgeRecord {
  schema_version: "1.0";
  source_record_id: string;
  source_revision: number;
  knowledge_base_id: string;
  record_type: "task_result";
  title: string;
  occurred_at: string;
  context?: {
    server_ref?: string;
    software?: Array<{ name: string; version: string }>;
    runtime?: Partial<Record<"os" | "shell" | "scope" | "privilege" | "visibility", string>>;
  };
  problem: string;
  steps: Array<{
    step_id: string; description: string; command?: string;
    execution_status: "succeeded" | "failed" | "blocked" | "not_run" | "unknown";
    validation_status: "passed" | "failed" | "unknown" | "not_run";
    evidence: Array<{ evidence_id: string; kind: "command_result" | "validation" | "observation" | "expectation"; summary: string; excerpt?: string }>;
  }>;
  outcome: { status: "succeeded" | "failed" | "partial" | "unknown"; summary: string };
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
