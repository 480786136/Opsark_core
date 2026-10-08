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
type RecoveryStep = { action?: { type: string; command?: string }; id?: string; kind?: string; command: string; status?: string; recovery?: unknown; recoveryRuleVersion?: number };

function issueFor(code: RuleCode, step: RecoveryStep, stepIndex: number, matchedToken?: string): RecoveryProtocolIssue {
  const rule = rules.errors[code];
  return { code, stepIndex, ...(step.id ? { stepId: step.id } : {}),
    fieldPath: `steps[${stepIndex}].${rule.field === "command" && step.action?.type === "shell" ? "action.command" : rule.field}`, expected: rule.expected,
    allowedRepairPaths: rule.repairFields.map(field => `steps[${stepIndex}].${field === "command" && step.action?.type === "shell" ? "action.command" : field}`),
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

/** Recognize option spellings only for the explicitly configured CLI families.
 * Consume values before inspecting flags, so header/script/URL data is not code. */
function commandOptions(args: string[], rule: { shortValueOptions: string[]; longValueOptions: string[] }) {
  const options: { name: string; value?: string }[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") { positional.push(...args.slice(index + 1)); break; }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = equal < 0 ? arg : arg.slice(0, equal);
      const value = equal >= 0 ? arg.slice(equal + 1)
        : rule.longValueOptions.includes(name) ? args[++index] : undefined;
      options.push({ name, value });
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let offset = 1; offset < arg.length; offset += 1) {
        const name = `-${arg[offset]}`;
        if (rule.shortValueOptions.includes(name)) {
          options.push({ name, value: arg.slice(offset + 1) || args[++index] });
          break;
        }
        options.push({ name });
      }
    } else positional.push(arg);
  }
  return { options, positional };
}

/** Allow a single, explicit query, plus selectors. An unknown/mixed option is not
 * made read-only merely because another argument contains --query or --list. */
function firewallQueryArguments(args: string[]): boolean {
  let queries = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (shell.firewallReadOnlyOptions.includes(arg)) { queries += 1; continue; }
    if (arg === "--permanent" || arg === "--quiet") continue;
    if (arg === "--zone" || arg.startsWith("--zone=")) {
      const value = arg === "--zone" ? args[++index] : arg.slice("--zone=".length);
      if (!value || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) return false;
      continue;
    }
    if (arg === "--query-port" || arg.startsWith("--query-port=")) {
      const value = arg === "--query-port" ? args[++index] : arg.slice("--query-port=".length);
      if (!value || !/^\d+(?:-\d+)?\/(?:tcp|udp|sctp|dccp)$/.test(value)) return false;
      queries += 1; continue;
    }
    return false;
  }
  return queries === 1;
}

/** Deliberately narrow exemption for the whole script, not a shell sandbox.
 * Reuse the recovery lexer so substitutions, branches and output captures cannot
 * conceal a mutation behind a query. Unsupported execution stays high-risk. */
export function isReadOnlyFirewallScript(command: string): boolean {
  return command.includes("firewall-cmd") && commandMutation(command, 0, true) === undefined;
}

function readOnlyFirewallSegment(segment: string[]): boolean {
  let at = 0;
  while (["if", "then", "elif", "else", "!"].includes(segment[at])) at += 1;
  const words = segment.slice(at);
  if (!words.length) return true;
  // Local result captures are supported. Do not exempt environment setup or
  // assignment prefixes that could change how the following executable runs.
  if (words.every(assignment)) return words.every(word => {
    const [name] = word.split("=", 1);
    return !/^(?:PATH|IFS|ENV|BASH.*|SHELL.*|CDPATH|GLOBIGNORE|LD_.*|DYLD_.*|PYTHON.*|PERL.*|RUBY.*|NODE_.*|PS[0-4]|PROMPT_COMMAND)$/.test(name);
  });
  if (words[0] === "sudo") {
    words.shift();
    while (["-n", "--non-interactive", "--"].includes(words[0])) words.shift();
  }
  const name = words[0]; const args = words.slice(1);
  if (["firewall-cmd", "/usr/bin/firewall-cmd", "/bin/firewall-cmd"].includes(name)) return firewallQueryArguments(args);
  if (["echo", "printf", "test", "[", ":", "true", "false", "exit"].includes(name)) {
    // No computed printf destination or arithmetic test expressions.
    return !(name === "printf" && args[0]?.startsWith("-v"))
      && !(["test", "["].includes(name) && args.some(arg => ["-eq", "-ne", "-gt", "-ge", "-lt", "-le"].includes(arg)));
  }
  if (name === "set") return args.length > 0 && args.every((arg, index) =>
    /^[-+][eu]+$/.test(arg) || (/^-[eu]*o$/.test(arg) && args[index + 1] === "pipefail")
      || (arg === "pipefail" && /^-[eu]*o$/.test(args[index - 1] ?? "")));
  return name === "fi" && args.length === 0;
}

/** A bounded shell lexer, not a sandbox. Quoted text is data; substitutions are code.
 * Policy data and conformance cases are shared with Rust. Unknown script execution
 * stays conservative; execution authorization and command safety remain separate. */
export function commandMutation(command: string, depth = 0, firewallReadOnly = false): string | undefined {
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
    if (firewallReadOnly && ((char === "$" && ["{", "("].includes(command[i + 1]) && (command[i + 1] === "{" || command[i + 2] === "("))
      || (["<", ">"].includes(char) && command[i + 1] === "("))) return "unsupported:expansion";
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
      if (firewallReadOnly && end >= command.length) return "unsupported:substitution";
      const mutation = commandMutation(nested, depth + 1, firewallReadOnly);
      if (mutation) return mutation;
      word += "__substitution__"; i = end; continue;
    }
    if (quote) { word += char; continue; }
    if (char === "#" && !word) { while (i < command.length && command[i] !== "\n") i += 1; flush(); tokens.push({ value: "\n", operator: true }); continue; }
    // Here-documents can feed executable scripts. Until this lexer models their
    // expansion/delimiter semantics, decline them rather than scan data as code.
    const unsupported = shell.unsupportedShellOperators.find(op => command.startsWith(op, i));
    if (unsupported) return `unsupported:${unsupported}`;
    if (firewallReadOnly && ((char === "&" && command[i + 1] !== "&" && command[i - 1] !== "&")
      || (char === "|" && command[i + 1] !== "|" && command[i - 1] !== "|") || char === "<")) return `unsupported:${char}`;
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
  if (firewallReadOnly && quote) return "unsupported:quote";
  flush();
  let segment: string[] = [];
  let piped = false;
  const inspect = (): string | undefined => {
    if (firewallReadOnly) return readOnlyFirewallSegment(segment) ? undefined : "unsupported:firewall-query-script";
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
    if (name === "firewall-cmd") return firewallQueryArguments(args) ? undefined : name;
    if (shell.readOnlyCommandRules.some(rule => rule.commands.includes(name)
      && (("noArguments" in rule && rule.noArguments && args.length === 0)
        || ("options" in rule && args.some(arg => rule.options?.includes(arg)))))) return undefined;
    if (shell.mutationCommands.includes(name)) return name;
    if (shell.opaqueInterpreters.includes(name)) {
      const options = shell.interpreterReadOnlyOptions as Record<string, string[]>;
      return args.length === 1 && (shell.safeInterpreterOptions.includes(args[0]) || options[name]?.includes(args[0])) ? undefined : name;
    }
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
      if ("shortValueOptions" in rule && rule.shortValueOptions && rule.longValueOptions) {
        const parsed = commandOptions(args, rule);
        if (parsed.options.some(option => ("words" in rule && rule.words?.includes(option.name))
          || ("optionPrefixes" in rule && rule.optionPrefixes?.some(prefix => option.name.startsWith(prefix)))
          || ("outputOptions" in rule && rule.outputOptions?.includes(option.name)
            && !["-", ...shell.safeWriteTargets].includes(option.value ?? ""))
          || ("writeMethods" in rule && ["-X", "--request"].includes(option.name)
            && rule.writeMethods?.includes((option.value ?? "").toUpperCase())))
          || ("assignmentArguments" in rule && rule.assignmentArguments
            && parsed.positional.some(arg => /^[A-Za-z_][A-Za-z0-9_./-]*=/.test(arg)))) return name;
        continue;
      }
      if (("always" in rule && rule.always) || ("words" in rule && args.some(arg => rule.words?.includes(arg)))) return name;
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
