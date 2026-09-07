import { backend } from "@/services/backend";
import type { RuntimeConnection, RuntimeModel } from "@/services/backend";
import type { AgentRuntimeProgress } from "@/services/backend";
import { buildLongRunningReviewContext } from "@/features/agent/reviewContext";
import type { LongRunningProgressStatus } from "@/features/agent/reviewContext";
import {
  buildLongRunningOutputWindow,
  compactReviewText,
  initialLongRunningOutputCursor,
  LONG_RUNNING_GOAL_CONTEXT_LIMIT,
  mergeLongRunningSalientEvidence,
  semanticLongRunningOutputFingerprint,
<<<<<<< HEAD
=======
  hasCriticalLongRunningEvidence,
>>>>>>> origin/master
} from "@/features/agent/longRunningReviewOutput";
import type { OpsTask, PlanStep, StepReview } from "@/types";

export const LONG_RUNNING_REVIEW_INTERVAL_MS = 30_000;
<<<<<<< HEAD
=======
export const PROGRESSIVE_ADVISORY_INTERVAL_MS = 120_000;
>>>>>>> origin/master
export const BOUNDED_COMMAND_HARD_LIMIT_SECONDS = 90;
export const STALLED_REVIEW_NOTICE_ROUNDS = 2;
export const PROGRESSIVE_MAX_STALLED_REVIEW_ROUNDS = 4;
export const BOUNDED_MAX_CONTINUE_ROUNDS = 2;
export const PROGRESSIVE_MAX_CONTINUE_ROUNDS = 4;

export type LongRunningWorkload = "bounded" | "progressive";

export interface LongRunningMonitorState {
  decision?: StepReview;
  reviewRound: number;
  validationPassed: boolean;
  workload: LongRunningWorkload;
  outputFingerprint: string;
  lastOutputChangeAt: string;
  noProgressSeconds: number;
  noProgressReviewRounds: number;
  consecutiveContinueRounds: number;
  salientEvidence: string[];
  runtimeProgress?: AgentRuntimeProgress;
  runtimeIdleReviewRounds: number;
<<<<<<< HEAD
=======
  modelReviewCount: number;
  skippedModelReviewCount: number;
>>>>>>> origin/master
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
  sampleRuntimeProgress?(): Promise<AgentRuntimeProgress>;
  reviewStep?: typeof backend.reviewStep;
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

const PROGRESSIVE_COMMAND_PATTERNS = [
  /\b(?:curl|wget)\b/,
  /\bgit\s+(?:clone|fetch|pull|submodule\s+update)\b/,
  /\b(?:scp|rsync)\b/,
  /\b(?:dnf|yum|apt|apt-get|zypper|pacman)\s+(?:install|update|upgrade|download)\b/,
  /\b(?:npm|pnpm|yarn|composer)\s+(?:ci|install|update)\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|compile|bundle|test)\b/,
  /\b(?:pip|pip3)\s+(?:install|download|wheel)\b/,
  /\b(?:mvn|mvnw)\b[^\n;]*(?:package|install|deploy)/,
  /\b(?:gradle|gradlew)\b[^\n;]*(?:build|assemble|publish)/,
  /\bcargo\s+(?:build|install|fetch|update)\b/,
  /\brustup\s+(?:install|update|toolchain\s+install)\b/,
  /\bgo\s+(?:build|install|get)\b/,
  /(?:^|[;&|]\s*)make(?:\s|$)/,
  /\bdocker\s+(?:build|pull|push)\b/,
  /\bdocker\s+compose\b[^\n;]*(?:build|pull|up)\b/,
  /\b(?:tar|unzip|7z)\b/,
];

/** Long downloads/builds are allowed to run while their observable output changes. */
export function classifyLongRunningWorkload(step: Pick<PlanStep, "title" | "description" | "command" | "runtimeClass">): LongRunningWorkload {
  if (step.runtimeClass === "progressive" || step.runtimeClass === "persistent_service") return "progressive";
  const command = step.command.toLocaleLowerCase();
  return PROGRESSIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    ? "progressive"
    : "bounded";
}

function ruleAdjustment(reason: string, summary: string): StepReview {
  return { decision: "adjust", source: "rules", reason, summary };
}

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
<<<<<<< HEAD
 * Starts a heartbeat and a 30-second advisory model review without running the
=======
 * Starts a heartbeat and 30-second runtime sampling without running the
>>>>>>> origin/master
 * postcondition concurrently. A finite command must first return its real exit
 * marker; only then may formal validation start. This prevents downloads and
 * installers from being mistaken for completed work based on partial output.
 */
export function startLongRunningMonitor(
  input: StartLongRunningMonitorInput,
): LongRunningMonitorController {
  const scheduler = input.scheduler ?? browserScheduler;
  const state: LongRunningMonitorState = {
    reviewRound: 0,
    validationPassed: false,
    workload: classifyLongRunningWorkload(input.step),
    outputFingerprint: semanticLongRunningOutputFingerprint(input.getStreamedOutput()),
    lastOutputChangeAt: new Date(scheduler.now()).toISOString(),
    noProgressSeconds: 0,
    noProgressReviewRounds: 0,
    consecutiveContinueRounds: 0,
    salientEvidence: mergeLongRunningSalientEvidence([], input.getStreamedOutput()),
    runtimeIdleReviewRounds: 0,
<<<<<<< HEAD
=======
    modelReviewCount: 0,
    skippedModelReviewCount: 0,
>>>>>>> origin/master
  };
  let stopped = false;
  let lastNoticeAt = 0;
  let lastReviewRound = 0;
  let reviewInFlight = false;
  let interruptionRequested = false;
  let lastReviewFingerprint = state.outputFingerprint;
  let lastOutputChangeAt = scheduler.now();
  let outputReviewCursor = initialLongRunningOutputCursor();
  const parsedStartedAt = input.step.startedAt
    ? new Date(input.step.startedAt).getTime()
    : scheduler.now();
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : scheduler.now();
<<<<<<< HEAD
=======
  let lastModelReviewAt = startedAt;
  let lastModelReviewedOutput = "";
>>>>>>> origin/master

  const elapsedSeconds = () => Math.max(
    0,
    Math.floor((scheduler.now() - startedAt) / 1000),
  );
  const maxContinueRounds = state.workload === "progressive"
    ? PROGRESSIVE_MAX_CONTINUE_ROUNDS
    : BOUNDED_MAX_CONTINUE_ROUNDS;
  const stopForAdjustment = async (review: StepReview, message: string) => {
    if (interruptionRequested || stopped || input.isCancelled()) return;
    interruptionRequested = true;
    state.decision = review;
    input.onEvent("assistant", message);
    input.onHeartbeat(
      elapsedSeconds(),
      "正在中断当前命令并等待终端确认；确认前不会执行后续步骤。",
    );
    try {
      await input.cancelExecution?.();
    } catch (error) {
      input.onError("长任务中断失败", String(error));
    }
  };
  const heartbeatTimer = scheduler.setInterval(() => {
    if (stopped || interruptionRequested || input.isCancelled()) return;
    const elapsed = elapsedSeconds();
    const currentOutput = input.getStreamedOutput();
    const currentFingerprint = semanticLongRunningOutputFingerprint(currentOutput);
    state.salientEvidence = mergeLongRunningSalientEvidence(
      state.salientEvidence,
      currentOutput.slice(-16_384),
    );
    if (currentFingerprint !== state.outputFingerprint) {
      state.outputFingerprint = currentFingerprint;
      lastOutputChangeAt = scheduler.now();
      state.lastOutputChangeAt = new Date(lastOutputChangeAt).toISOString();
      state.noProgressSeconds = 0;
    } else {
      state.noProgressSeconds = Math.max(0, Math.floor((scheduler.now() - lastOutputChangeAt) / 1000));
    }
    const hasStreamedOutput = currentOutput.trim().length > 0;
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

    const reviewRound = Math.floor(elapsed * 1000 / LONG_RUNNING_REVIEW_INTERVAL_MS);
    if (
      state.workload === "bounded"
      && elapsed >= BOUNDED_COMMAND_HARD_LIMIT_SECONDS
      && !interruptionRequested
    ) {
      const review = ruleAdjustment(
        `普通命令超过 ${BOUNDED_COMMAND_HARD_LIMIT_SECONDS} 秒仍未返回真实退出标记`,
        "当前命令疑似卡住，已停止等待；该步骤不会被判定为成功，将根据已保留证据生成调整计划。",
      );
      void stopForAdjustment(review, review.summary);
      return;
    }
    if (reviewRound < 1 || reviewRound <= lastReviewRound || reviewInFlight || interruptionRequested) return;
    lastReviewRound = reviewRound;
    state.reviewRound = reviewRound;
    const outputChangedSinceLastReview = currentFingerprint !== lastReviewFingerprint;
    state.noProgressReviewRounds = outputChangedSinceLastReview
      ? 0
      : state.noProgressReviewRounds + 1;
    if (outputChangedSinceLastReview) state.consecutiveContinueRounds = 0;
    lastReviewFingerprint = currentFingerprint;
    reviewInFlight = true;
    const priorRuntimeIoBytes = state.runtimeProgress?.ioBytes;
    const sample = input.sampleRuntimeProgress
      ? input.sampleRuntimeProgress().catch((error) => {
          input.onError("长任务运行态采样失败", String(error));
          return undefined;
        })
      : Promise.resolve(undefined);
    void sample.then(async (runtimeProgress) => {
      if (stopped || input.isCancelled() || interruptionRequested) return;
      const runtimeIoChanged = runtimeProgress !== undefined
        && priorRuntimeIoBytes !== undefined
        && runtimeProgress.ioBytes > priorRuntimeIoBytes;
      if (runtimeProgress) {
        state.runtimeProgress = runtimeProgress;
        const runtimeActivity = runtimeProgress.active && (
          runtimeProgress.cpuPercent >= 0.1
          || runtimeProgress.processCount > 1
          || runtimeIoChanged
        );
        state.runtimeIdleReviewRounds = runtimeActivity ? 0 : state.runtimeIdleReviewRounds + 1;
        if (state.workload === "progressive" && !runtimeProgress.active) {
          const review = ruleAdjustment(
            "远程 executionId 对应的进程组已不存在，但执行通道尚未返回真实退出码",
            "长任务进程已消失且通道未完成，已中断等待并进入执行通道恢复，不会把文本沉默误判为业务完成。",
          );
          await stopForAdjustment(review, review.summary);
          return;
        }
        if (state.workload === "progressive"
          && state.runtimeIdleReviewRounds >= PROGRESSIVE_MAX_STALLED_REVIEW_ROUNDS
          && state.noProgressReviewRounds >= PROGRESSIVE_MAX_STALLED_REVIEW_ROUNDS) {
          const review = ruleAdjustment(
            `长任务连续 ${state.runtimeIdleReviewRounds} 轮无文本、CPU、I/O 或子进程活动`,
            "下载、构建或安装过程的文本与运行态证据均连续无变化，当前进程疑似卡住；已中断并进入调整。",
          );
          await stopForAdjustment(review, review.summary);
          return;
        }
      }
<<<<<<< HEAD
=======
      const newOutput = currentOutput.startsWith(lastModelReviewedOutput)
        ? currentOutput.slice(lastModelReviewedOutput.length) : currentOutput;
      const measuredProgress = state.workload === "progressive"
        && runtimeProgress?.active === true
        && (runtimeProgress.cpuPercent >= 0.1 || runtimeIoChanged);
      // Process existence alone is insufficient. Keep sampling and retain a
      // periodic advisory decision even for busy processes to detect bad work.
      if (measuredProgress && !hasCriticalLongRunningEvidence(newOutput)
        && scheduler.now() - lastModelReviewAt < PROGRESSIVE_ADVISORY_INTERVAL_MS) {
        state.skippedModelReviewCount += 1;
        return;
      }
>>>>>>> origin/master
      const progress: LongRunningProgressStatus = {
        workload: state.workload,
        outputFingerprint: state.outputFingerprint,
        outputChangedSinceLastReview,
        lastOutputChangeAt: state.lastOutputChangeAt,
        noProgressSeconds: state.noProgressSeconds,
        noProgressReviewRounds: state.noProgressReviewRounds,
        consecutiveContinueRounds: state.consecutiveContinueRounds,
        maxConsecutiveContinueRounds: maxContinueRounds,
        hardLimitSeconds: state.workload === "bounded" ? BOUNDED_COMMAND_HARD_LIMIT_SECONDS : undefined,
        runtimeActive: runtimeProgress?.active,
        runtimeProcessCount: runtimeProgress?.processCount,
        runtimeCpuPercent: runtimeProgress?.cpuPercent,
        runtimeIoBytes: runtimeProgress?.ioBytes,
        runtimeIoChanged,
        runtimeIdleReviewRounds: state.runtimeIdleReviewRounds,
        stalledNotice: state.noProgressReviewRounds >= STALLED_REVIEW_NOTICE_ROUNDS
          ? state.workload === "progressive"
            ? "文本输出暂时沉默；必须同时参考 executionId 进程组的 CPU、I/O、子进程和存活证据，不得仅凭无日志返回 adjust。"
            : `已连续 ${state.noProgressSeconds} 秒无进展；若没有能够证明任务仍在推进的证据，应返回 adjust。`
          : undefined,
      };
      const observation = {
        passed: false,
        detail: "主命令尚未返回真实退出标记；为避免竞态，本轮只审阅实时输出和只读运行态采样，不并发执行正式后置校验。",
      };
      const { window: outputWindow, nextCursor: nextOutputReviewCursor } = buildLongRunningOutputWindow(
        currentOutput,
        outputReviewCursor,
      );
      const context = buildLongRunningReviewContext({
        task: input.task,
        step: input.step,
        reviewRound,
        elapsedSeconds: elapsed,
        observation,
        progress,
        outputWindow,
        salientEvidence: state.salientEvidence,
      });
      const reviewStep = input.reviewStep ?? backend.reviewStep.bind(backend);
<<<<<<< HEAD
=======
      state.modelReviewCount += 1;
      lastModelReviewAt = scheduler.now();
>>>>>>> origin/master
      const modelDecision = await reviewStep(
        compactReviewText(input.requirement, LONG_RUNNING_GOAL_CONTEXT_LIMIT),
        JSON.stringify(context),
        input.task.plan.some((step) => step.status === "pending"),
        input.runtimeModel,
      );
      if (stopped || input.isCancelled() || interruptionRequested) return;
      outputReviewCursor = nextOutputReviewCursor;
<<<<<<< HEAD
=======
      lastModelReviewedOutput = currentOutput;
>>>>>>> origin/master
      const runtimeShowsProgress = state.workload === "progressive"
        && runtimeProgress?.active === true
        && (runtimeProgress.cpuPercent >= 0.1 || runtimeProgress.processCount > 1 || runtimeIoChanged);
      const acceptedDecision = acceptsLongRunningDecision(modelDecision, false)
        && !(modelDecision.decision === "adjust" && runtimeShowsProgress);
      input.onAudit({ round: reviewRound, context, modelDecision, acceptedDecision });
      if (acceptedDecision && modelDecision.decision === "adjust") {
        await stopForAdjustment(
          modelDecision,
          `第 ${reviewRound} 次长任务复核建议停止当前等待并调整计划：${modelDecision.summary || modelDecision.reason}`,
        );
        return;
      }
      if (acceptedDecision && modelDecision.decision === "continue") {
        state.decision = modelDecision;
        state.consecutiveContinueRounds = outputChangedSinceLastReview
          ? 0
          : state.consecutiveContinueRounds + 1;
        if (state.workload === "bounded"
          && state.consecutiveContinueRounds >= maxContinueRounds
          && state.noProgressReviewRounds > 0) {
          const review = ruleAdjustment(
            `模型已连续 ${state.consecutiveContinueRounds} 轮建议等待，但期间没有足够的输出进展`,
            "模型 continue 已达到连续等待上限，当前命令疑似卡住；已中断并进入调整，不会判定为成功。",
          );
          await stopForAdjustment(review, review.summary);
          return;
        }
        input.onEvent(
          "assistant",
          `第 ${reviewRound} 次长任务复核建议继续等待：${modelDecision.summary || modelDecision.reason}`,
        );
        return;
      }
      input.onEvent(
        "system",
        modelDecision.decision === "complete"
          ? `第 ${reviewRound} 次长任务复核认为输出可能已满足目标，但主命令尚未返回真实退出码，继续等待后再正式校验。`
          : `第 ${reviewRound} 次长任务复核未形成可执行决策，继续等待真实退出。`,
      );
    }).catch((error) => {
      if (!stopped && !input.isCancelled()) {
        input.onError("长任务定期模型复核失败", String(error));
      }
    }).finally(() => {
      reviewInFlight = false;
    });
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
