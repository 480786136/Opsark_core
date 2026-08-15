export interface FinalValidationOutput {
  stepOutput: string;
  validationOutput: string;
}

function appendOutputSection(
  currentOutput: string | undefined,
  title: string,
  sectionOutput: string | undefined,
): string {
  const normalizedCurrent = currentOutput ?? "";
  if (!sectionOutput) return normalizedCurrent;

  const separator = normalizedCurrent ? "\n\n" : "";
  return `${normalizedCurrent}${separator}--- ${title} ---\n${sectionOutput}`;
}

/** Appends output from the first failed independent validation attempt. */
export function appendFirstValidationFailureOutput(
  currentOutput: string | undefined,
  validationOutput: string | undefined,
): string {
  return appendOutputSection(currentOutput, "独立校验（首次未通过）", validationOutput);
}

/** Normalizes final validation output and appends it to the persisted step output. */
export function assembleFinalValidationOutput(
  currentOutput: string | undefined,
  validationOutput: string | undefined,
): FinalValidationOutput {
  const normalizedValidation = validationOutput ?? "";
  return {
    stepOutput: appendOutputSection(currentOutput, "独立校验", normalizedValidation),
    validationOutput: normalizedValidation,
  };
}
