import type { StepDispatchDecision } from "@/features/agent/executionDispatch";
import {
  failToolCommandParsing,
  failUnexpectedStep,
  waitForStepSecret,
} from "@/features/agent/stepInterruption";
import { transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";

export type StepExecutionEntry =
  | { kind: "tool"; call: Extract<StepDispatchDecision, { kind: "tool" }>["call"] }
  | {
      kind: "stop";
      taskStatus: "awaiting_input" | "needs_adjustment";
      eventMessage: string;
      pauseReason?: string;
      pendingSecretKey?: string;
    }
  | {
      kind: "command";
      taskStatus: "running";
      eventMessage: string;
      terminalHeader: string;
    };

export interface ApplyStepExecutionEntryInput {
  taskTitle: string;
  step: PlanStep;
  dispatch: StepDispatchDecision;
  startedAt: string;
  secretDescription?: string;
}

/** Applies deterministic entry state before tool or remote command side effects begin. */
export function applyStepExecutionEntry(input: ApplyStepExecutionEntryInput): StepExecutionEntry {
  const { step, dispatch } = input;
  if (dispatch.kind === "tool") return { kind: "tool", call: dispatch.call };

  if (dispatch.kind === "invalid") {
    const failure = failToolCommandParsing(step, dispatch.error);
    return { kind: "stop", taskStatus: "needs_adjustment", ...failure };
  }

  if (dispatch.kind === "await-secret") {
    waitForStepSecret(step, dispatch.key);
    const description = input.secretDescription ? `（${input.secretDescription}）` : "";
    return {
      kind: "stop",
      taskStatus: "awaiting_input",
      pendingSecretKey: dispatch.key,
      eventMessage: `本轮执行需要确认敏感变量 ${dispatch.key}${description}。请输入本轮应使用的值；不会发送给模型。`,
    };
  }

  transitionStep(step, "running");
  step.startedAt = input.startedAt;
  step.elapsedSeconds = 0;
  step.progressMessage = "正在建立远程执行通道…";
  return {
    kind: "command",
    taskStatus: "running",
    eventMessage: `执行 ${step.title}：${step.command}`,
    terminalHeader: `[智能任务 · ${input.taskTitle}] $ ${step.command}`,
  };
}

/** Converts an unexpected execution error into stable step and task coordination. */
export function applyStepExecutionException(step: PlanStep, error: unknown) {
  const failure = failUnexpectedStep(step, error);
  return { taskStatus: "needs_adjustment" as const, ...failure };
}
