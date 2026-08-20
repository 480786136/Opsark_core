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
export type PermissionLevel = "observe" | "safe" | "managed";
export type StepReviewDecision = "continue" | "adjust" | "complete";
export type ExecutionStatus = "success" | "failed" | "cancelled" | "blocked";
export type ObservationStatus =
  | "matched"
  | "not_found"
  | "healthy"
  | "unhealthy"
  | "warning"
  | "unknown";
export type ValidatorType =
  | "command"
  | "platform"
  | "runtime"
  | "process"
  | "service"
  | "port-owner"
  | "http"
  | "file"
  | "sql-query"
  | "docker"
  | "log";

export interface StepValidator {
  type: ValidatorType;
  command: string;
  validStates: ObservationStatus[];
}

export interface ExecutionEvidence {
  id: string;
  type: ValidatorType | "command-output";
  source: "main" | "validation";
  facts: Record<string, unknown>;
  rawOutput: string;
  collectedAt: string;
}

export interface StepResult {
  executionStatus: ExecutionStatus;
  observationStatus: ObservationStatus;
  exitCode?: number;
  facts: Record<string, unknown>;
  warnings: string[];
  evidenceIds: string[];
  failureReason?: string;
}

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
  validator?: StepValidator;
  status: StepStatus;
  output?: string;
  review?: StepReview;
  result?: StepResult;
  evidence?: ExecutionEvidence[];
  startedAt?: string;
  elapsedSeconds?: number;
  progressMessage?: string;
}

export interface TaskMessage {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "message" | "event" | "summary";
  content: string;
  createdAt: string;
}

export interface ExecutionConstraints {
  changePolicy: "unspecified" | "read_only" | "requested_changes_only" | "allow_necessary_changes";
  environmentPolicy: "unspecified" | "preserve" | "allow_isolated_changes" | "allow_host_changes";
  failurePolicy: "unspecified" | "strict" | "best_effort";
  prohibitedActions: string[];
  requiredConditions: string[];
  userDirectives: string[];
}

export interface TaskPlanHistory {
  id: string;
  requirement: string;
  status: TaskStatus;
  plan: PlanStep[];
  response?: TaskMessage;
  records?: TaskMessage[];
  summary?: string;
  pauseReason?: string;
  executionConstraints?: ExecutionConstraints;
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
  pauseReason?: string;
  executionConstraints?: ExecutionConstraints;
  adjustmentCount?: number;
  lastAdjustmentBlocker?: string;
  discoveryRefined?: boolean;
  refinementCount?: number;
  activeSkillIds?: string[];
  currentExecutionId?: string;
  cancelRequested?: boolean;
  confirmedSecretKeys?: string[];
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

export interface AiGenerationSettings {
  limitOutput: boolean;
  maxPlanSteps: number;
  maxOutputTokens: number;
  maxTextChars: number;
  maxCommandChars: number;
}

export interface RequirementProcessingResult {
  intent: "answer" | "execute" | "terminal_context";
  answer?: string;
  plan: PlanStep[];
  constraints?: ExecutionConstraints;
  terminalContextLines?: number;
  selectedSkillIds?: string[];
  planError?: string;
}

export interface AuditEvent {
  id: string;
  category: "task" | "model" | "command" | "tool" | "system";
  level: "info" | "warning" | "error" | "success";
  title: string;
  detail: string;
  serverId?: string;
  /** Snapshot names make an audit record understandable after a server/task is renamed or deleted. */
  serverName?: string;
  taskId?: string;
  taskTitle?: string;
  stepId?: string;
  executionId?: string;
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
  scope: "server";
  serverId: string;
}
