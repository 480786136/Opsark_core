import rules from "../../shared/recovery-rules.json";

export interface RecoveryProtocolIssue {
  code: string;
  stepIndex: number;
  stepId?: string;
  fieldPath: string;
  matchedToken?: string;
  expected: string;
  allowedRepairPaths: string[];
  ruleVersion: number;
}

export const RECOVERY_RULE_VERSION = rules.version;

export class RecoveryProtocolError extends Error {
  constructor(readonly issue: RecoveryProtocolIssue) {
    super(`${issue.code} / ${issue.fieldPath}${issue.matchedToken ? ` / matchedToken=${issue.matchedToken}` : ""}：${issue.expected}`);
    this.name = "RecoveryProtocolError";
  }
}

/** Rust sends the same issue inside a JSON error envelope; never infer fields from prose. */
export function readRecoveryProtocolError(error: unknown): RecoveryProtocolIssue | undefined {
  if (error instanceof RecoveryProtocolError) return error.issue;
  if (error instanceof Error) return readRecoveryProtocolError((error as Error & { issue?: unknown }).issue ?? error.message);
  if (typeof error === "string") {
    try { return readRecoveryProtocolError(JSON.parse(error)); } catch { return undefined; }
  }
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  if (value.issue) return readRecoveryProtocolError(value.issue);
  if (typeof value.code !== "string" || !Number.isInteger(value.stepIndex) || Number(value.stepIndex) < 0
    || typeof value.fieldPath !== "string" || typeof value.expected !== "string"
    || !Number.isInteger(value.ruleVersion) || !Array.isArray(value.allowedRepairPaths)
    || !value.allowedRepairPaths.every(path => typeof path === "string")) return undefined;
  return value as unknown as RecoveryProtocolIssue;
}

type RuleCode = keyof typeof rules.errors;
type RecoveryStep = { id?: string; kind?: string; command: string; status?: string; recovery?: unknown; recoveryRuleVersion?: number };

function issueFor(code: RuleCode, step: RecoveryStep, stepIndex: number, matchedToken?: string): RecoveryProtocolIssue {
  const rule = rules.errors[code];
  return { code, stepIndex, ...(step.id ? { stepId: step.id } : {}),
    fieldPath: `steps[${stepIndex}].${rule.field}`, expected: rule.expected,
    allowedRepairPaths: rule.repairFields.map(field => `steps[${stepIndex}].${field}`),
    ruleVersion: rules.version, ...(matchedToken ? { matchedToken } : {}) };
}

export function recoveryMetadataIssue(step: RecoveryStep, stepIndex = 0): RecoveryProtocolIssue | undefined {
  const observeIssue = () => {
    if (step.kind !== "observe" || (step.status && step.status !== "pending")) return undefined;
    const mutation = commandMutation(step.command);
    return mutation ? issueFor("OBSERVE_COMMAND_MUTATION", step, stepIndex, mutation) : undefined;
  };
  if (step.recovery === undefined || step.recovery === null) return observeIssue();
  if (step.recoveryRuleVersion !== undefined && step.recoveryRuleVersion !== rules.version)
    return issueFor("RECOVERY_RULE_VERSION_MISMATCH", step, stepIndex);
  const relation = step.recovery as Record<string, unknown>;
  if (typeof relation !== "object" || Array.isArray(relation)
    || Object.keys(relation).some(key => !rules.recoveryFields.includes(key))
    || typeof relation.failedStepId !== "string" || !relation.failedStepId.trim()
    || typeof relation.targetContext !== "string" || !relation.targetContext.trim()
    || typeof relation.purpose !== "string" || !Object.prototype.hasOwnProperty.call(rules.purposeRules, relation.purpose)
    || relation.failedStepId === step.id) return issueFor("RECOVERY_INVALID_METADATA", step, stepIndex);
  const purpose = rules.purposeRules[relation.purpose as keyof typeof rules.purposeRules];
  if ("kind" in purpose && step.kind !== purpose.kind) return issueFor("RECOVERY_KIND_MISMATCH", step, stepIndex);
  if (purpose.readonly) {
    const mutation = commandMutation(step.command);
    if (mutation) return issueFor("RECOVERY_DIAGNOSE_MUTATION", step, stepIndex, mutation);
  }
  return observeIssue();
}

type Token = { value: string; operator: boolean };
const shell = rules.shell;
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const writeTargetSafe = (word: string) => shell.safeWriteTargets.includes(word) || /^&(?:\d+|-)$/.test(word);

/** A bounded shell lexer, not a sandbox. Quoted text is data; substitutions are code.
 * Policy data and conformance cases are shared with Rust. Unknown script execution
 * stays conservative; execution authorization and command safety remain separate. */
export function commandMutation(command: string, depth = 0): string | undefined {
  if (depth > shell.maxNestedDepth) return "nested-shell";
  const tokens: Token[] = [];
  let word = "";
  let quote = "";
  const flush = () => { if (word) { tokens.push({ value: word, operator: false }); word = ""; } };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\" && quote !== "'") { if (command[i + 1] !== "\n") word += command[i + 1] ?? ""; i += 1; continue; }
    if (char === quote) { quote = ""; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
    if (quote === "'") { word += char; continue; }
    if ((["$", "<", ">"].includes(char) && command[i + 1] === "(" && (!quote || char === "$")) || char === "`") {
      const backtick = char === "`";
      let nested = ""; let nesting = 1; let nestedQuote = ""; let end = i + (backtick ? 1 : 2);
      for (; end < command.length; end += 1) {
        const current = command[end];
        if (current === "\\") { nested += current + (command[++end] ?? ""); continue; }
        if (backtick && current === "`") break;
        if (current === nestedQuote) nestedQuote = "";
        else if (!nestedQuote && (current === "'" || current === '"')) nestedQuote = current;
        else if (!nestedQuote && !backtick && current === "(") nesting += 1;
        else if (!nestedQuote && !backtick && current === ")" && --nesting === 0) break;
        nested += current;
      }
      const mutation = commandMutation(nested, depth + 1);
      if (mutation) return mutation;
      word += "__substitution__"; i = end; continue;
    }
    if (quote) { word += char; continue; }
    if (char === "#" && !word) { while (i < command.length && command[i] !== "\n") i += 1; flush(); tokens.push({ value: "\n", operator: true }); continue; }
    // Here-documents can feed executable scripts. Until this lexer models their
    // expansion/delimiter semantics, decline them rather than scan data as code.
    const unsupported = shell.unsupportedShellOperators.find(op => command.startsWith(op, i));
    if (unsupported) return `unsupported:${unsupported}`;
    if (char === ">") {
      if (/^\d+$/.test(word)) word = ""; else flush();
      let op = ">";
      if ([">", "|"].includes(command[i + 1])) op += command[++i];
      if (command[i + 1] === "&") { i += 1; word = "&"; }
      tokens.push({ value: op, operator: true }); continue;
    }
    if (shell.separators.includes(char) || char === "<") { flush(); tokens.push({ value: char, operator: true }); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    word += char;
  }
  flush();
  let segment: string[] = [];
  let piped = false;
  const inspect = (): string | undefined => {
    let at = 0;
    while (at < segment.length) {
      const value = basename(segment[at]);
      if (assignment(segment[at]) || shell.prefixWords.includes(value)) { at += 1; continue; }
      if (shell.wrappers.includes(value)) {
        at += 1;
        while (at < segment.length && (segment[at].startsWith("-") || assignment(segment[at]))) {
          if (shell.wrapperValueOptions.includes(segment[at])) at += 1;
          at += 1;
        }
        continue;
      }
      break;
    }
    if (at >= segment.length) return undefined;
    const name = basename(segment[at]); const args = segment.slice(at + 1);
    if (shell.readOnlyCommandRules.some(rule => rule.commands.includes(name)
      && (("noArguments" in rule && rule.noArguments && args.length === 0)
        || ("options" in rule && args.some(arg => rule.options?.includes(arg)))))) return undefined;
    if (shell.mutationCommands.includes(name)) return name;
    if (shell.opaqueInterpreters.includes(name)) return args.length === 1 && shell.safeInterpreterOptions.includes(args[0]) ? undefined : name;
    if (shell.shells.includes(name)) {
      const flag = args.findIndex(arg => /^-[^-]*c/.test(arg));
      return flag >= 0 ? commandMutation(args[flag + 1] ?? "", depth + 1)
        : (piped || args.some(arg => !arg.startsWith("-"))) ? name : undefined;
    }
    if (name === "tee") return args.some(arg => !arg.startsWith("-") && !writeTargetSafe(arg)) ? name : undefined;
    if (shell.cacheQueryCommands.includes(name) && args.some(arg => shell.cacheQueryWords.includes(arg))
      && !args.some(arg => shell.cacheOnlyOptions.includes(arg))) return name;
    if (shell.sqlClients.includes(name) && args.some(arg => arg.split(/[^A-Za-z]+/).some(part => shell.sqlMutationWords.includes(part.toUpperCase())))) return name;
    for (const rule of shell.commandRules) {
      if (!rule.commands.includes(name)) continue;
      if (("always" in rule && rule.always) || ("words" in rule && args.some(arg => rule.words?.includes(arg)))
        || ("optionPrefixes" in rule && args.some(arg => rule.optionPrefixes?.some(prefix => arg.startsWith(prefix))))) return name;
      if ("outputOptions" in rule && args.some((arg, index) => rule.outputOptions?.some(option =>
        arg === option ? !["-", ...shell.safeWriteTargets].includes(args[index + 1] ?? "")
          : arg.startsWith(`${option}=`) && !["-", ...shell.safeWriteTargets].includes(arg.slice(option.length + 1))))) return name;
      if ("writeMethods" in rule && args.some((arg, index) => ["-X", "--request"].includes(arg) && rule.writeMethods?.includes(args[index + 1]))) return name;
    }
    return undefined;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.operator) { segment.push(token.value); continue; }
    if (token.value.startsWith(">")) {
      const mutation = inspect(); if (mutation) return mutation;
      const target = tokens[++i];
      if (!target || target.operator || !writeTargetSafe(target.value)) return token.value;
      continue;
    }
    if (token.value === "<") { i += 1; continue; }
    const mutation = inspect(); if (mutation) return mutation;
    segment = []; piped = token.value === "|";
  }
  return inspect();
}
