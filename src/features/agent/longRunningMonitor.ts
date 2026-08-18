import { backend } from "@/services/backend";
import type { RuntimeConnection, RuntimeModel } from "@/services/backend";
import { executeStepValidation } from "@/features/agent/executionRunner";
import { buildLongRunningReviewContext } from "@/features/agent/reviewContext";
import { redactExecutionOutput } from "@/features/agent/secretTool";
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
 * Starts command heartbeat and optional model-backed periodic review. The monitor
 * owns its timers; callers must invoke stop() when command execution settles.
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
  let reviewBusy = false;
  let lastNoticeAt = 0;
  const parsedStartedAt = input.step.startedAt
    ? new Date(input.step.startedAt).getTime()
    : scheduler.now();
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : scheduler.now();

  const elapsedSeconds = () => Math.max(
    0,
    Math.floor((scheduler.now() - startedAt) / 1000),
  );
  const cancelExecution = () => input.cancelExecution
    ? input.cancelExecution()
    : input.connection
      ? backend.cancelCommand(input.connection, input.executionId)
      : Promise.resolve();

  const heartbeatTimer = scheduler.setInterval(() => {
    if (stopped || input.isCancelled()) return;
    const elapsed = elapsedSeconds();
    const progressMessage = elapsed >= 10
      ? `远程命令仍在运行（${elapsed} 秒），系统会每 ${LONG_RUNNING_REVIEW_INTERVAL_MS / 1000} 秒获取状态并复核`
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

  const runReview = async () => {
    if (stopped || reviewBusy || input.isCancelled()) return;
    const connection = input.connection;
    if (!connection) return;
    if (state.decision) {
      try {
        await cancelExecution();
      } catch (error) {
        input.onError(
          `${input.step.title} · 重试停止长驻命令失败`,
          redactExecutionOutput(String(error), input.secretValues),
        );
      }
      return;
    }

    reviewBusy = true;
    state.reviewRound += 1;
    const elapsed = elapsedSeconds();
    input.onEvent(
      "system",
      `${input.step.title}已持续运行 ${elapsed} 秒，正在获取最新状态并进行第 ${state.reviewRound} 次长任务复核…`,
    );

    try {
      const observation = await executeStepValidation({
        step: { ...input.step, validation: input.validation },
        connection,
        executionId: `long-observation-${scheduler.now()}-${state.reviewRound}`,
        secretValues: input.secretValues,
      });
      if (stopped || input.isCancelled()) return;

      const context = buildLongRunningReviewContext({
        task: input.task,
        step: input.step,
        requirement: input.requirement,
        reviewRound: state.reviewRound,
        elapsedSeconds: elapsed,
        streamedOutput: input.getStreamedOutput(),
        observation,
      });
      const review = await backend.reviewStep(
        input.requirement,
        JSON.stringify(context),
        input.task.plan.some((step) => step.status === "pending"),
        input.runtimeModel,
      );
      if (stopped || input.isCancelled()) return;

      const acceptedDecision = acceptsLongRunningDecision(review, observation.passed);
      input.onAudit({
        round: state.reviewRound,
        context,
        modelDecision: review,
        acceptedDecision,
      });
      if (!acceptedDecision || review.decision === "continue") {
        const content = review.source !== "model"
          ? `第 ${state.reviewRound} 次长任务复核时模型不可用，保持执行并继续等待。`
          : review.decision === "complete" && !observation.passed
            ? "模型建议停止等待，但程序校验尚未通过，本轮继续等待。"
            : `第 ${state.reviewRound} 次复核建议继续等待：${review.summary}`;
        input.onEvent("system", content);
        return;
      }

      state.decision = review;
      state.validationPassed = observation.passed;
      input.onEvent(
        "assistant",
        review.decision === "complete"
          ? `定期校验已满足后置条件，模型建议停止持续等待并进入正式校验：${review.summary}`
          : `长任务复核建议停止当前命令并调整：${review.summary}`,
      );
      await cancelExecution();
    } catch (error) {
      if (!stopped) {
        input.onError(
          `${input.step.title} · 长任务状态获取失败`,
          redactExecutionOutput(String(error), input.secretValues),
        );
      }
    } finally {
      reviewBusy = false;
    }
  };

  const reviewTimer = input.connection && input.runtimeModel?.apiKey
    ? scheduler.setInterval(() => void runReview(), LONG_RUNNING_REVIEW_INTERVAL_MS)
    : undefined;

  return {
    stop() {
      stopped = true;
      scheduler.clearInterval(heartbeatTimer);
      if (reviewTimer !== undefined) scheduler.clearInterval(reviewTimer);
    },
    getState() {
      return { ...state };
    },
  };
}
