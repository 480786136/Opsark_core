import { RECOVERY_RULE_VERSION, RecoveryProtocolError } from "@/services/recoveryRules";

/** Argument paths come from the validator, never from model-authored error text. */
export class ToolArgumentValidationError extends Error {
  constructor(message: string, readonly argumentPath?: string) {
    super(message);
    this.name = "ToolArgumentValidationError";
  }
}

export function argumentPropertyPath(parent: string | undefined, key: string) {
  if (parent === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    || ["__proto__", "prototype", "constructor"].includes(key)) return undefined;
  return parent ? `${parent}.${key}` : key;
}

/** Add the local plan position without broadening an unknown/cross-field repair. */
export class ToolArgumentProtocolError extends RecoveryProtocolError {
  constructor(error: unknown, stepIndex: number, stepId?: string) {
    const path = error instanceof ToolArgumentValidationError ? error.argumentPath : undefined;
    const fieldPath = `steps[${stepIndex}].command.arguments${path ? `.${path}` : ""}`;
    super({ code: "TOOL_ARGUMENT_INVALID", stepIndex, stepId, fieldPath,
      expected: `第 ${stepIndex + 1} 个计划步骤的工具参数无效：${error instanceof Error ? error.message : String(error)}`,
      allowedRepairPaths: path ? [fieldPath] : [], ruleVersion: RECOVERY_RULE_VERSION });
    this.name = "ToolArgumentProtocolError";
  }
}
