export type ConnectionStatus = "online" | "testing" | "offline";
export type TaskStatus =
  | "draft"
  | "planning"
  | "planning_failed"
  | "awaiting_plan_approval"
  | "running"
  | "awaiting_step_approval"
  | "awaiting_input"
  | "validating"
  | "awaiting_continuation"
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
export type PlanStepKind = "observe" | "change";
export type PermissionLevel = "observe" | "safe" | "managed";
export type ExecutionScope =
  | "agent_session"
  | "isolated_exec"
  | "fresh_interactive_shell"
  | "fresh_login_shell"
  | "managed_service"
  | "user_action";
export type ExecutionPersistence = "command" | "agent_task" | "new_shells" | "host" | "service";
export type RuntimeClass = "bounded" | "progressive" | "persistent_service";
export type RequirementRelation =
  | "new_goal"
  | "continue"
  | "supplement"
  | "side_question"
  | "replace_goal"
  | "cancel_goal";
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

export interface AgentSessionContext {
  cwd?: string;
  environment: Record<string, string>;
  sourceFiles: string[];
  shell: "bash" | "sh" | "zsh";
  revision: number;
}

export interface AgentSessionRef {
  id: string;
  serverId: string;
  taskId: string;
  generation: number;
  state: "creating" | "ready" | "busy" | "recovering" | "closed";
  context: AgentSessionContext;
  createdAt: string;
  closedAt?: string;
}

export interface ExecutionScopeEvidence {
  targetId: string;
  sessionId?: string;
  generation?: number;
  scope: ExecutionScope;
  shell?: string;
  cwd?: string;
  persistence: ExecutionPersistence;
  doesNotProve: string[];
}

export interface ExecutionEvidence {
  id: string;
  type: ValidatorType | "command-output";
  source: "main" | "validation";
  facts: Record<string, unknown>;
  rawOutput: string;
  collectedAt: string;
  scope?: ExecutionScopeEvidence;
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
  /** Missing only on legacy persisted plans; normalization upgrades it to change. */
  kind?: PlanStepKind;
  title: string;
  description: string;
  command: string;
  risk: RiskLevel;
  expected: string;
  validation: string;
  /** Legacy persisted plans are normalized to isolated_exec before execution. */
  executionScope?: ExecutionScope;
  validationScope?: ExecutionScope;
  sessionContextChange?: Partial<AgentSessionContext>;
  runtimeClass?: RuntimeClass;
  validator?: StepValidator;
  status: StepStatus;
  output?: string;
  review?: StepReview;
  result?: StepResult;
  evidence?: ExecutionEvidence[];
  startedAt?: string;
  elapsedSeconds?: number;
  progressMessage?: string;
  /** Exact non-secret template shown when per-step approval was requested. */
  safetyApprovalSnapshot?: Pick<PlanStep,
    "command" | "validation" | "risk" | "executionScope" | "validationScope" | "sessionContextChange" | "runtimeClass"
  >;
  /** Exact template explicitly accepted by the user; any later change invalidates it. */
  approvedSafetySnapshot?: Pick<PlanStep,
    "command" | "validation" | "risk" | "executionScope" | "validationScope" | "sessionContextChange" | "runtimeClass"
  >;
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
  finalPlan?: PlanStep[];
  phases?: TaskExecutionPhase[];
  response?: TaskMessage;
  records?: TaskMessage[];
  summary?: string;
  pauseReason?: string;
  executionConstraints?: ExecutionConstraints;
  createdAt: string;
  completedAt: string;
}

export interface TaskExecutionPhase {
  id: string;
  roundId: string;
  requirement: string;
  reason: "adjustment" | "replan";
  plan: PlanStep[];
  summary?: string;
  createdAt: string;
  completedAt: string;
}

export type AdjustmentIncidentKind = "business" | "transport";

/**
 * One recoverable blocker observed by the task orchestrator. The fingerprint is
 * derived from structured execution state rather than user-facing prose, so a
 * changed credential, terminal generation, command or evidence starts a new
 * incident while an unchanged blocker cannot replan forever.
 */
export interface AdjustmentIncident {
  fingerprint: string;
  kind: AdjustmentIncidentKind;
  category: string;
  stepFingerprint: string;
  targetFingerprint: string;
  evidenceFingerprint: string;
  attemptCount: number;
  automatic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TransportRecoveryAttempt {
  /** Includes terminal generation, target identity and task credential revision. */
  targetFingerprint: string;
  replayCount: number;
  updatedAt: string;
}

export type ManagedAdjustmentPhase =
  | "countdown"
  | "generating"
  | "waiting_transport"
  | "manual_required";

export type ManagedStopReason =
  | "model_generation_failed"
  | "transport_recovery"
  | "retry_exhausted"
  | "user_input_required"
  | "high_risk_approval"
  | "cancelled";

export interface OpsTask {
  id: string;
  serverId: string;
  /** Explicit server used by Agent execution after a server.connect tool step. */
  executionTargetServerId?: string;
  title: string;
  status: TaskStatus;
  permission: PermissionLevel;
  modelId: string;
  messages: TaskMessage[];
  plan: PlanStep[];
  planHistory?: TaskPlanHistory[];
  /** The stable user outcome this task owns. Follow-up prompts must not replace it implicitly. */
  rootGoal?: string;
  /** The latest instruction within rootGoal, such as a supplement or retry request. */
  currentInstruction?: string;
  lastRequirementRelation?: RequirementRelation;
  currentRoundId?: string;
  /** Earlier plans from the active round that were superseded by an adjustment. */
  phaseHistory?: TaskExecutionPhase[];
  /** Remaining delay before managed mode automatically requests an adjustment plan. */
  autoAdjustmentSeconds?: number;
  /** Ephemeral UI state while adjustment prerequisites or a replacement plan are being prepared. */
  adjustmentInProgress?: boolean;
  /** Single managed-mode scheduler state; never inferred from a briefly idle timer. */
  managedAdjustmentPhase?: ManagedAdjustmentPhase;
  /** Present only when automatic continuation intentionally stopped. */
  managedStopReason?: ManagedStopReason;
  summary?: string;
  pauseReason?: string;
  executionConstraints?: ExecutionConstraints;
  /** Compatibility projection of the current business incident's attempt count. */
  adjustmentCount?: number;
  /** @deprecated Kept for persisted-task compatibility; now stores a structured fingerprint. */
  lastAdjustmentBlocker?: string;
  adjustmentIncident?: AdjustmentIncident;
  /** Bounds deterministic command replay to once per actual terminal generation. */
  transportRecovery?: TransportRecoveryAttempt;
  /** Changes whenever task-visible server or service credentials actually change. */
  credentialRevision?: number;
  discoveryRefined?: boolean;
  refinementCount?: number;
  activeSkillIds?: string[];
  currentExecutionId?: string;
  agentSessionId?: string;
  agentSessionGeneration?: number;
  cancelRequested?: boolean;
  /** Compatibility list for credentials entered while a task is already waiting; server secrets are reusable without it. */
  confirmedSecretKeys?: string[];
  /**
   * Task-scoped, non-sensitive values collected by user.request_input.
   *
   * Credential usernames and password/token fields never enter this object:
   * both are promoted into a durable server credential group in the keychain.
   */
  submittedInputs?: Record<string, SubmittedTaskInput>;
  /** Legacy/task audit metadata; durable pairing is owned by SecretMetadata.credentialGroupId. */
  submittedSecretBindings?: Record<string, SubmittedSecretBinding>;
  createdAt: string;
  updatedAt: string;
}

export interface SubmittedTaskInput {
  value: string | number;
  label: string;
  description: string;
  type: "text" | "number";
  /** Identifies fields submitted together, so a username is never paired with an unrelated password. */
  groupId: string;
  groupTitle: string;
  submittedAt: string;
}

export interface SubmittedSecretBinding {
  key: string;
  label: string;
  description: string;
  groupId: string;
  groupTitle: string;
  submittedAt: string;
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
  relation?: RequirementRelation;
  answer?: string;
  plan: PlanStep[];
  constraints?: ExecutionConstraints;
  terminalContextLines?: number;
  selectedSkillIds?: string[];
  planError?: string;
  developerTrace?: ModelDeveloperTrace;
}

export interface ModelDeveloperTrace {
  attempts: ModelAttemptTrace[];
}

export interface ModelAttemptTrace {
  stage: string;
  attempt: number;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export interface DeveloperLogEntry {
  id: string;
  level: "info" | "warning" | "error" | "success";
  operation: string;
  title: string;
  summary: string;
  request?: string;
  response?: string;
  trace?: string;
  error?: string;
  stack?: string;
  serverId?: string;
  serverName?: string;
  taskId?: string;
  taskTitle?: string;
  modelProfileId?: string;
  modelName?: string;
  endpoint?: string;
  durationMs?: number;
  createdAt: string;
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
  /** Stable server-scoped credential profile. Fields with the same id are reused atomically across tasks. */
  credentialGroupId?: string;
  credentialKind?: "git-https" | "ssh-password" | "database" | "service";
  credentialRole?: "username" | "secret";
  /** Authentication endpoint, such as gitee.com or a database host. Never contains a credential value. */
  credentialTarget?: string;
  credentialLabel?: string;
}
