import type { RuntimeConnection, RuntimeModel } from "@/services/backend";
import type { OpsTask, PlanStep, StepReview } from "@/types";

export const LONG_RUNNING_REVIEW_INTERVAL_MS = 30_000;

export interface LongRunningMonitorState {
  decision?: StepReview;
  reviewRound: number;
  validationPassed: boolean;
}

export interface LongRunningReviewAudit {
  round: number;
  context: Record<string, unknown>;
  modelDecision: StepReview;
  acceptedDecision: boolean;
}

export interface LongRunningMonitorScheduler {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(timerId: number): void;
}

export interface StartLongRunningMonitorInput {
  task: OpsTask;
  step: PlanStep;
  requirement: string;
  validation: string;
  executionId: string;
  connection?: RuntimeConnection;
  runtimeModel?: RuntimeModel;
  secretValues: Record<string, string>;
  getStreamedOutput(): string;
  isCancelled(): boolean;
  onHeartbeat(elapsedSeconds: number, progressMessage: string): void;
  onEvent(role: "assistant" | "system", content: string): void;
  onAudit(audit: LongRunningReviewAudit): void;
  onError(title: string, detail: string): void;
  cancelExecution?(): Promise<void> | void;
  scheduler?: LongRunningMonitorScheduler;
}

export interface LongRunningMonitorController {
  stop(): void;
  getState(): LongRunningMonitorState;
}

const browserScheduler: LongRunningMonitorScheduler = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (timerId) => window.clearInterval(timerId),
};

/**
 * A model decision may stop a running command only when it came from the model.
 * Completion additionally requires an independently observed passing state.
 */
export function acceptsLongRunningDecision(review: StepReview, validationPassed: boolean) {
  return review.source === "model"
    && (
      review.decision === "continue"
      || review.decision === "adjust"
      || (review.decision === "complete" && validationPassed)
    );
}

/**
 * Starts a heartbeat without running the postcondition concurrently. A finite
 * command must first return its real exit marker; only then may formal validation
 * start. This prevents downloads/installers from being interrupted by a stale or
 * overly broad intermediate observation.
 */
export function startLongRunningMonitor(
  input: StartLongRunningMonitorInput,
): LongRunningMonitorController {
  const scheduler = input.scheduler ?? browserScheduler;
  const state: LongRunningMonitorState = {
    reviewRound: 0,
    validationPassed: false,
  };
  let stopped = false;
  let lastNoticeAt = 0;
  const parsedStartedAt = input.step.startedAt
    ? new Date(input.step.startedAt).getTime()
    : scheduler.now();
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : scheduler.now();

  const elapsedSeconds = () => Math.max(
    0,
    Math.floor((scheduler.now() - startedAt) / 1000),
  );
  const heartbeatTimer = scheduler.setInterval(() => {
    if (stopped || input.isCancelled()) return;
    const elapsed = elapsedSeconds();
    const hasStreamedOutput = input.getStreamedOutput().trim().length > 0;
    const progressMessage = elapsed >= 10
      ? `远程命令仍在运行（${elapsed} 秒），系统正在等待真实退出，完成后才会进行后置校验${hasStreamedOutput ? "" : "；暂未收到实时输出，可能正在等待网络或输出被管道缓冲"}`
      : "远程命令正在执行";
    input.onHeartbeat(elapsed, progressMessage);
    if (elapsed >= 30 && elapsed - lastNoticeAt >= 60) {
      lastNoticeAt = elapsed;
      input.onEvent(
        "system",
        `${input.step.title}仍在执行，已运行 ${elapsed} 秒；可继续等待或点击“终止业务”。`,
      );
    }
  }, 1000);

  return {
    stop() {
      stopped = true;
      scheduler.clearInterval(heartbeatTimer);
    },
    getState() {
      return { ...state };
    },
  };
}
