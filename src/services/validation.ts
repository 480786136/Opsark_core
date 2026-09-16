import type {
  ExecutionEvidence,
  ObservationStatus,
  PlanStep,
  StepResult,
  StepValidator,
  ValidatorType,
} from "@/types";
import {
  expectedSkillDiagnosticExit,
  analyzeSkillCommandFailure,
  analyzeSkillOutputSignals,
  parseSkillObservation,
  validStatesForSkillValidator,
  type SkillOutputSignals,
} from "@/features/skills/validationAdapters";
import { buildStepScopeEvidence } from "@/features/agent/executionScope";
import { recordedSupplementalAcceptance, validationHasAcceptanceCheck } from "@/features/agent/planSafety";
import { commandMutation } from "@/services/recoveryRules";

export type NormalizedPlanStep = PlanStep & { validator: StepValidator };

export interface CommandSnapshot {
  output: string;
  success: boolean;
  exitCode?: number;
  emptyResult?: boolean;
}

export interface ValidationSnapshot {
  passed: boolean;
  detail: string;
  output?: string;
  exitCode?: number;
  emptyResult?: boolean;
}

const evidenceId = (source: string) =>
  `evidence-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function outputLines(output = "") {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !line.startsWith("$ ")
      && !line.startsWith("[exit:")
      && !line.startsWith("--- 独立校验 ---")
      && line !== "命令未产生输出"
      && !line.includes("未发现匹配项（命令正常完成）"),
    );
}

function mainOutput(output: string) {
  return output.split("\n--- 独立校验 ---")[0];
}

export function analyzeCommandFailure(output: string) {
  return analyzeSkillCommandFailure(mainOutput(output));
}

export function isMutatingStepCommand(command: string) {
  return commandMutation(command) !== undefined;
}

export function isReadOnlyStep(step: PlanStep) {
  return step.kind === "observe" || !isMutatingStepCommand(step.command);
}

export function inferValidatorType(step: Pick<PlanStep, "title" | "description" | "command" | "validation">): ValidatorType {
  // Arbitrary Shell output has no registered business-output contract.
  // Neither prose nor a keyword inside a path establishes such a contract.
  void step;
  return "command";
}

function defaultValidStates(type: ValidatorType): ObservationStatus[] {
  return validStatesForSkillValidator(type);
}

export function ensureStepValidator(step: PlanStep): NormalizedPlanStep {
  if (step.validator && /^opsark-tool\s/.test(step.command.trim())) {
    return {
      ...step,
      validator: {
        ...step.validator,
        command: step.validation,
      },
    };
  }
  const type = inferValidatorType(step);
  return {
    ...step,
    validator: {
      type,
      command: step.validation,
      validStates: defaultValidStates(type),
    },
  };
}

function parseObservation(
  step: PlanStep,
  execution: CommandSnapshot,
): { facts: Record<string, unknown>; status: ObservationStatus } {
  const validator = step.validator ?? ensureStepValidator(step).validator;
  const output = mainOutput(execution.output);
  const lines = outputLines(output);
  const emptyResult = Boolean(execution.emptyResult || output.includes("未发现匹配项"));
  return parseSkillObservation(validator.type, lines, emptyResult, step);
}

function expectedDiagnosticExit(type: ValidatorType, exitCode?: number) {
  return expectedSkillDiagnosticExit(type, exitCode);
}

export function classifyStepResult(
  rawStep: PlanStep,
  execution: CommandSnapshot,
  validation: ValidationSnapshot,
  scopeTarget?: { targetId: string; sessionId?: string; generation?: number; shell?: string; cwd?: string },
): { result: StepResult; evidence: ExecutionEvidence[]; accepted: boolean; needsModelReview: boolean } {
  const step = ensureStepValidator(rawStep);
  const commandResultOnly = step.kind === "observe";
  const validator = step.validator;
  const mainParsed = parseObservation(step, execution);
  const semantic = "";
  const mainSignals = analyzeSkillOutputSignals(outputLines(mainOutput(execution.output)), semantic);
  const validationSignals = commandResultOnly
    ? { facts: {}, warnings: [], blocking: false } as SkillOutputSignals
    : analyzeSkillOutputSignals(outputLines(validation.output ?? ""), semantic);
  const outputSignals: SkillOutputSignals = {
    status: mainSignals.status === "unhealthy" || validationSignals.status === "unhealthy"
      ? "unhealthy"
      : mainSignals.status ?? validationSignals.status,
    facts: {
      ...validationSignals.facts,
      ...mainSignals.facts,
      engineIncompatible: Boolean(mainSignals.facts.engineIncompatible || validationSignals.facts.engineIncompatible),
      explicitTooOld: Boolean(mainSignals.facts.explicitTooOld || validationSignals.facts.explicitTooOld),
      platformIncompatible: Boolean(mainSignals.facts.platformIncompatible || validationSignals.facts.platformIncompatible),
      networkFailure: Boolean(mainSignals.facts.networkFailure || validationSignals.facts.networkFailure),
      missingAbiSymbols: [...new Set([
        ...((mainSignals.facts.missingAbiSymbols as string[] | undefined) ?? []),
        ...((validationSignals.facts.missingAbiSymbols as string[] | undefined) ?? []),
      ])],
      category: mainSignals.facts.category ?? validationSignals.facts.category,
      runtimeCheck: mainSignals.facts.runtimeCheck ?? validationSignals.facts.runtimeCheck,
      platformCheck: mainSignals.facts.platformCheck ?? validationSignals.facts.platformCheck,
    },
    warnings: [...new Set([...mainSignals.warnings, ...validationSignals.warnings])],
    blocking: mainSignals.blocking || validationSignals.blocking,
  };
  const validationLines = outputLines(validation.output ?? "");
  let validationParsed = !commandResultOnly && validation.output
    ? parseObservation(ensureStepValidator({ ...step, command: step.validation, validation: "", validator: undefined }), {
        output: validation.output,
        success: validation.passed,
        exitCode: validation.exitCode,
        emptyResult: validation.emptyResult,
      })
    : undefined;
  if (validationParsed && validationLines.length === 0 && validator.type !== "command") {
    validationParsed = {
      facts: validationParsed.facts,
      status: validation.passed
        ? validator.type === "http" || validator.type === "service" ? "healthy" : "matched"
        : ["http", "service"].includes(validator.type) ? "unhealthy" : "not_found",
    };
  }
  const readOnly = isReadOnlyStep(step);
  let parsed = !readOnly && validationParsed
    ? validationParsed
    : mainParsed.status === "unknown" && validationParsed && validationParsed.status !== "unknown"
      ? validationParsed
      : mainParsed;
  if (
    outputSignals.status
    || outputSignals.facts.platformCheck
    || outputSignals.facts.runtimeCheck
    || Number(outputSignals.facts.warningCount ?? 0) > 0
  ) {
    parsed = {
      status: outputSignals.status ?? parsed.status,
      facts: {
        ...parsed.facts,
        ...outputSignals.facts,
      },
    };
  }
  const validationAccepted = commandResultOnly || validation.passed
    || (readOnly && expectedDiagnosticExit(validator.type, validation.exitCode));
  const diagnosticFailureConsistent =
    !validation.passed
    && (
      parsed.status === "not_found"
      || parsed.status === "unhealthy"
      || parsed.status === "warning"
    );
  const semanticConflict = Boolean(
    readOnly
    &&
    validationParsed
    && (
      (mainParsed.status === "matched" && validationParsed.status === "not_found")
      || (mainParsed.status === "not_found" && validationParsed.status === "matched")
      || (mainParsed.status === "healthy" && validationParsed.status === "unhealthy")
      || (mainParsed.status === "unhealthy" && validationParsed.status === "healthy")
    ),
  );
  const evidenceConflict = !commandResultOnly && (
    (execution.success && !validation.passed)
    ||
    (!validation.passed && validationAccepted && !diagnosticFailureConsistent)
    || semanticConflict
  );
  const accepted = execution.success && validationAccepted;
  const warnings = [
    ...outputSignals.warnings,
    ...(parsed.status === "warning" ? ["发现异常线索，需结合后续证据确认影响范围。"] : []),
    ...(parsed.status === "unhealthy" ? ["观察到非健康状态，但诊断命令已正常完成。"] : []),
    ...(evidenceConflict ? ["主命令输出与独立校验结果存在冲突。"] : []),
  ];
  const collectedAt = new Date().toISOString();
  const verificationCommand = commandResultOnly ? step.command : step.validation;
  const supplemental = step.recovery?.purpose === "verify"
    ? recordedSupplementalAcceptance(verificationCommand) : undefined;
  const recoveryAcceptance = supplemental && step.recovery ? {
    ...supplemental, expected: step.expected,
    failedStepId: step.recovery.failedStepId, targetContext: step.recovery.targetContext,
  } : undefined;
  const acceptanceFacts = step.recovery?.purpose === "verify" ? {
    acceptanceBasis: supplemental ? "supplemental_original_predicates"
      : validationHasAcceptanceCheck(verificationCommand) ? "shell_exit_assertion" : "unproven",
    acceptancePassed: Boolean((supplemental || validationHasAcceptanceCheck(verificationCommand))
      && (commandResultOnly ? execution.success && execution.exitCode === 0 : validation.passed && validation.exitCode === 0)),
    recoveryAcceptance,
  } : {};
  const mainEvidence: ExecutionEvidence = {
    id: evidenceId("main"),
    type: validator.type,
    source: "main",
    facts: { ...mainParsed.facts, ...(commandResultOnly ? acceptanceFacts : {}) },
    rawOutput: execution.output,
    collectedAt,
    scope: scopeTarget ? buildStepScopeEvidence(step, "main", scopeTarget) : undefined,
  };
  const validationEvidence: ExecutionEvidence = {
    id: evidenceId("validation"),
    type: validator.type,
    source: "validation",
    facts: {
      ...acceptanceFacts,
      passed: validation.passed,
      exitCode: validation.exitCode,
      acceptedDiagnosticState: validationAccepted && !validation.passed,
      detail: validation.detail,
      observationStatus: validationParsed?.status,
      observationFacts: validationParsed?.facts,
    },
    rawOutput: validation.output ?? "",
    collectedAt,
    scope: scopeTarget ? buildStepScopeEvidence(step, "validation", scopeTarget) : undefined,
  };
  const evidence = commandResultOnly ? [mainEvidence] : [mainEvidence, validationEvidence];
  return {
    accepted,
    // Uninterpreted raw output is not an execution failure. Overall-goal review
    // still receives the raw evidence; do not loop on a missing domain parser.
    needsModelReview: accepted && ((parsed.status === "unknown" && validator.type !== "command") || evidenceConflict || outputSignals.blocking),
    evidence,
    result: {
      executionStatus: execution.success ? "success" : "failed",
      observationStatus: parsed.status,
      exitCode: execution.exitCode,
      facts: {
        ...parsed.facts,
        ...acceptanceFacts,
        interpretation: validator.type === "command" ? "raw" : "structured",
        proves: "command_execution_only",
        mainObservationStatus: mainParsed.status,
        verificationMode: commandResultOnly ? "command_result" : "postcondition",
        validationObservationStatus: validationParsed?.status,
        validatorType: validator.type,
        validationPassed: commandResultOnly ? undefined : validation.passed,
        evidenceConflict,
        blockingSignal: outputSignals.blocking,
      },
      warnings,
      evidenceIds: evidence.map((item) => item.id),
      failureReason: accepted
        ? undefined
        : outputSignals.facts.platformIncompatible
          ? outputSignals.warnings.find((warning) => warning.includes("ABI") || warning.includes("平台"))
          : outputSignals.facts.networkFailure
            ? outputSignals.warnings.find((warning) => warning.includes("网络") || warning.includes("下载"))
            : validation.detail,
    },
  };
}

export function observationText(status?: ObservationStatus) {
  const labels: Record<ObservationStatus, string> = {
    matched: "已获得结果",
    not_found: "未发现目标",
    healthy: "状态正常",
    unhealthy: "状态异常",
    warning: "发现异常线索",
    unknown: "证据待解释",
  };
  return status ? labels[status] : "尚未观察";
}
