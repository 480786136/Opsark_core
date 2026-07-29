export type ConnectionStatus = "online" | "testing" | "offline";
export type TaskStatus =
  | "draft"
  | "planning"
  | "awaiting_plan_approval"
  | "running"
  | "awaiting_step_approval"
  | "awaiting_input"
  | "validating"
  | "needs_adjustment"
  | "completed"
  | "failed"
  | "cancelled";
export type StepStatus =
  | "pending"
  | "awaiting_approval"
  | "awaiting_input"
  | "running"
  | "validating"
  | "completed"
  | "failed"
  | "skipped";
export type RiskLevel = "low" | "medium" | "high";
export type PermissionLevel = "observe" | "safe" | "autonomous";
export type StepReviewDecision = "continue" | "adjust" | "complete";

export interface StepReview {
  decision: StepReviewDecision;
  reason: string;
  summary: string;
  source: "model" | "rules";
}

export interface ServerInfo {
  os: string;
  kernel: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  uptime: string;
}

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  status: ConnectionStatus;
  environment: string[];
  info: ServerInfo;
  createdAt: string;
}

export interface Metrics {
  cpu: number;
  memory: number;
  disk: number;
  networkIn: number;
  networkOut: number;
  sampledAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  command: string;
  risk: RiskLevel;
  expected: string;
  validation: string;
  status: StepStatus;
  output?: string;
  review?: StepReview;
}

export interface TaskMessage {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "message" | "event" | "summary";
  content: string;
  createdAt: string;
}

export interface TaskPlanHistory {
  id: string;
  requirement: string;
  status: TaskStatus;
  plan: PlanStep[];
  response?: TaskMessage;
  records?: TaskMessage[];
  summary?: string;
  createdAt: string;
  completedAt: string;
}

export interface OpsTask {
  id: string;
  serverId: string;
  title: string;
  status: TaskStatus;
  permission: PermissionLevel;
  modelId: string;
  messages: TaskMessage[];
  plan: PlanStep[];
  planHistory?: TaskPlanHistory[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  endpoint: string;
  enabled: boolean;
  hasApiKey: boolean;
}

export interface ModelAvailability {
  status: "unknown" | "checking" | "available" | "unavailable";
  reason: string;
  checkedAt?: string;
}

export interface AuditEvent {
  id: string;
  category: "task" | "model" | "command" | "system";
  level: "info" | "warning" | "error" | "success";
  title: string;
  detail: string;
  serverId?: string;
  taskId?: string;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: string;
  modified: string;
}

export interface SecretMetadata {
  key: string;
  description: string;
  scope: "global" | "server";
  serverId?: string;
}
