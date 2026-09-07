import type {
  AdjustmentIncident,
  AdjustmentIncidentKind,
  OpsTask,
  PlanStep,
} from "@/types";

export interface AdjustmentTargetState {
  paneId?: string;
  terminalRevision?: number;
  terminalStatus?: string;
  terminalBusy?: boolean;
  host?: string;
  port?: number;
  username?: string;
}

export interface AdjustmentBlockerSnapshot {
  fingerprint: string;
  kind: AdjustmentIncidentKind;
  category: string;
  stepFingerprint: string;
  targetFingerprint: string;
  evidenceFingerprint: string;
}

const VOLATILE_EVIDENCE_KEYS = /^(?:id|evidenceIds|executionId|reviewRound|elapsedSeconds|durationMs|collectedAt|createdAt|updatedAt|timestamp)$/i;
const TERMINAL_RECOVERY_PATTERN = /(?:\bpty\b|\bshell\b.*(?:busy|occupied|release|reconnect)|terminal.*(?:busy|occupied|release|reconnect)|绑定终端|终端.*(?:未就绪|未释放|被占用|断开|重连|超时)|命令结束标记|执行通道.*(?:断开|异常)|connection closed|channel closed|socket closed)/i;

export function isTerminalTransportFailure(error: unknown) {
  return TERMINAL_RECOVERY_PATTERN.test(String(error));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_EVIDENCE_KEYS.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

/** Small deterministic non-cryptographic hash used only for orchestration identity. */
export function adjustmentFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizedCommand(command: string) {
  return command.replace(/\s+/g, " ").trim();
}

function activeRoundSteps(task: OpsTask) {
  const archived = (task.phaseHistory ?? [])
    .filter((phase) => !task.currentRoundId || phase.roundId === task.currentRoundId)
    .flatMap((phase) => phase.plan);
  return [...archived, ...task.plan];
}

function evidenceFingerprint(task: OpsTask, failedStep?: PlanStep) {
  const evidence = activeRoundSteps(task)
    .filter((step) => step === failedStep || step.status === "completed" || step.status === "failed")
    .map((step) => ({
      step: adjustmentFingerprint(`${step.title}\n${normalizedCommand(step.command)}`),
      status: step.status,
      result: canonicalize(step.result),
      evidence: step.evidence?.map((item) => ({
        type: item.type,
        source: item.source,
        facts: canonicalize(item.facts),
        output: adjustmentFingerprint(item.rawOutput ?? ""),
      })),
      output: adjustmentFingerprint(step.output ?? ""),
    }));
  // Re-archiving an identical failed step is not new evidence.
  const unique = [...new Set(evidence.map(stableJson))].sort();
  return adjustmentFingerprint(unique.join("\n"));
}

function failureCategory(task: OpsTask, failedStep?: PlanStep) {
  const category = failedStep?.result?.facts.category;
  if (typeof category === "string" && category.trim()) return category.trim();
  if (failedStep?.result?.facts.stoppedByPeriodicReview === true) return "periodic_review";
  if (task.status === "awaiting_continuation") return "goal_continuation";
  return failedStep?.result?.executionStatus ?? "workflow_adjustment";
}

function incidentKind(
  category: string,
  task: OpsTask,
  failedStep: PlanStep | undefined,
  target: AdjustmentTargetState,
): AdjustmentIncidentKind {
  if (target.terminalBusy) return "transport";
  if (["terminal_transport", "terminal_recovery", "validation_protocol_exception"].includes(category)) {
    return "transport";
  }
  if (failedStep) return "business";
  const detail = [task.pauseReason]
    .filter(Boolean)
    .join("\n");
  return TERMINAL_RECOVERY_PATTERN.test(detail) ? "transport" : "business";
}

/** Builds a stable blocker identity from execution facts and runtime revisions. */
export function buildAdjustmentBlockerSnapshot(
  task: OpsTask,
  failedStep: PlanStep | undefined,
  target: AdjustmentTargetState,
): AdjustmentBlockerSnapshot {
  const category = failureCategory(task, failedStep);
  const stepFingerprint = adjustmentFingerprint(stableJson({
    command: normalizedCommand(failedStep?.command ?? ""),
    validation: normalizedCommand(failedStep?.validation ?? ""),
    fallbackTitle: failedStep?.command?.trim() ? undefined : failedStep?.title ?? "",
  }));
  const targetFingerprint = adjustmentFingerprint(stableJson({
    serverId: task.serverId,
    paneId: target.paneId,
    terminalRevision: target.terminalRevision ?? 0,
    terminalStatus: target.terminalStatus,
    host: target.host,
    port: target.port,
    username: target.username,
    credentialRevision: task.credentialRevision ?? 0,
  }));
  const currentEvidenceFingerprint = evidenceFingerprint(task, failedStep);
  const kind = incidentKind(category, task, failedStep, target);
  return {
    fingerprint: adjustmentFingerprint(stableJson({
      kind,
      category,
      stepFingerprint,
      targetFingerprint,
      evidenceFingerprint: currentEvidenceFingerprint,
    })),
    kind,
    category,
    stepFingerprint,
    targetFingerprint,
    evidenceFingerprint: currentEvidenceFingerprint,
  };
}

export function openAdjustmentIncident(
  snapshot: AdjustmentBlockerSnapshot,
  automatic: boolean,
  timestamp: string,
): AdjustmentIncident {
  return {
    ...snapshot,
    executionAttemptCount: 0,
    generationFailureCount: 0,
    automatic,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isSameAdjustmentIncident(
  incident: AdjustmentIncident | undefined,
  snapshot: AdjustmentBlockerSnapshot,
) {
  return incident?.fingerprint === snapshot.fingerprint;
}
