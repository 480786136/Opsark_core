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
  inferSkillValidator,
  parseSkillObservation,
  validStatesForSkillValidator,
  type SkillOutputSignals,
} from "@/features/skills/validationAdapters";

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
  return /(?:^|[;&|]\s*|\bsudo\s+)(?:apt(?:-get)?|yum|dnf|rpm|dpkg|npm|pnpm|yarn|pip)\s+(?:install|ci|add|remove|upgrade|update|run|build)|\b(?:nvm|fnm|volta|asdf)\s+(?:install|use|global|alias|default)\b|\bcurl\b[\s\S]*\|\s*(?:ba)?sh\b|\bmvn\b.*\b(?:install|deploy)\b|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)|\bservice\s+\S+\s+(?:start|stop|restart|reload)|\b(?:reboot|shutdown|kill|pkill|killall)\b|\b(?:rm|mv|cp|chmod|chown|ln)\s|\bsed\s+-i\b|\b(?:tee|truncate)\s|\bdocker\s+(?:run|start|stop|restart|rm|compose\s+up)|\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i
    .test(command);
}

export function isReadOnlyStep(step: PlanStep) {
  return !isMutatingStepCommand(step.command);
}

export function inferValidatorType(step: Pick<PlanStep, "title" | "description" | "command" | "validation">): ValidatorType {
  return inferSkillValidator(step).type;
}

function defaultValidStates(type: ValidatorType): ObservationStatus[] {
  return validStatesForSkillValidator(type);
}

export function ensureStepValidator(step: PlanStep): NormalizedPlanStep {
  if (step.validator) {
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
): { result: StepResult; evidence: ExecutionEvidence[]; accepted: boolean; needsModelReview: boolean } {
  const step = ensureStepValidator(rawStep);
  const validator = step.validator;
  const mainParsed = parseObservation(step, execution);
  const semantic = `${step.title}\n${step.description}\n${step.expected}`;
  const mainSignals = analyzeSkillOutputSignals(outputLines(mainOutput(execution.output)), semantic);
  const validationSignals = analyzeSkillOutputSignals(outputLines(validation.output ?? ""), semantic);
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
  let validationParsed = validation.output
    ? parseObservation(step, {
        output: validation.output,
        success: validation.passed,
        exitCode: validation.exitCode,
        emptyResult: validation.emptyResult,
      })
    : undefined;
  if (validationParsed && validationLines.length === 0) {
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
  const validationAccepted = validation.passed
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
  const evidenceConflict =
    (!validation.passed && validationAccepted && !diagnosticFailureConsistent)
    || semanticConflict;
  const accepted = execution.success && validationAccepted;
  const warnings = [
    ...outputSignals.warnings,
    ...(parsed.status === "warning" ? ["发现异常线索，需结合后续证据确认影响范围。"] : []),
    ...(parsed.status === "unhealthy" ? ["观察到非健康状态，但诊断命令已正常完成。"] : []),
    ...(evidenceConflict ? ["主命令输出与独立校验结果存在冲突。"] : []),
  ];
  const collectedAt = new Date().toISOString();
  const mainEvidence: ExecutionEvidence = {
    id: evidenceId("main"),
    type: validator.type,
    source: "main",
    facts: parsed.facts,
    rawOutput: execution.output,
    collectedAt,
  };
  const validationEvidence: ExecutionEvidence = {
    id: evidenceId("validation"),
    type: validator.type,
    source: "validation",
    facts: {
      passed: validation.passed,
      exitCode: validation.exitCode,
      acceptedDiagnosticState: validationAccepted && !validation.passed,
      detail: validation.detail,
      observationStatus: validationParsed?.status,
      observationFacts: validationParsed?.facts,
    },
    rawOutput: validation.output ?? "",
    collectedAt,
  };
  return {
    accepted,
    needsModelReview: accepted && (parsed.status === "unknown" || evidenceConflict || outputSignals.blocking),
    evidence: [mainEvidence, validationEvidence],
    result: {
      executionStatus: execution.success ? "success" : "failed",
      observationStatus: parsed.status,
      exitCode: execution.exitCode,
      facts: {
        ...parsed.facts,
        mainObservationStatus: mainParsed.status,
        validationObservationStatus: validationParsed?.status,
        validatorType: validator.type,
        validationPassed: validation.passed,
        evidenceConflict,
        blockingSignal: outputSignals.blocking,
      },
      warnings,
      evidenceIds: [mainEvidence.id, validationEvidence.id],
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
