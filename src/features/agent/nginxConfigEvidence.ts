import type { ExecutionOperationRecord } from "@/services/executionLedger";
import type { ToolResult } from "@/features/tools/types";
import { enforceToolResult } from "@/features/tools/toolResultContract";
import { parseFileManifestOutput, type FileManifestResult } from "@/features/tools/fileManifestInspection";
import { canonicalExecutionJson, executionIntentMatches, sha256Utf8 } from "./planPreparation";
import { nginxLiteralReturn } from "./nginxLiteralReturn";

export interface NginxConfigBinding {
  taskId: string; roundId: string; workflowEpoch: number; serverId: string; connectionGeneration: number;
}
export interface NginxConfigTarget { address: string; port: number; serverName: string; uriPath: string }
export interface NginxConfigInput {
  binding: NginxConfigBinding; entryPath: string; prefix: string; target: NginxConfigTarget;
  /** Controller-supplied durable records, never model-submitted records or pasted content. */
  receipts: Array<{ operation: ExecutionOperationRecord; attemptId: string }>;
}
export interface NginxSourceRange { path: string; startByte: number; endByte: number }
export interface NginxConfigSource {
  path: string; stepId: string; operationId: string; attemptId: string; executionId: string; contentSha256: string; bytes: number;
  pathIdentity: "requested_path_only";
}
export interface NginxDirectiveEvidence { name: string; args: string[]; source: NginxSourceRange }
export interface NginxListenEvidence { address: string; port: number; defaultServer: boolean; tls: boolean; source: NginxSourceRange }
export interface NginxLocationEvidence {
  id: string; modifier: "" | "=" | "^~"; path: string; source: NginxSourceRange; directives: NginxDirectiveEvidence[];
}
export interface NginxServerEvidence {
  id: string; source: NginxSourceRange; fingerprint: string; listens: NginxListenEvidence[];
  serverNames: string[]; directives: NginxDirectiveEvidence[]; locations: NginxLocationEvidence[];
}
export interface NginxConfigEvidence {
  version: 1; binding: NginxConfigBinding; target: NginxConfigTarget; entryPath: string; prefix: string;
  status: "parsed" | "unknown"; reasons: Array<{ code: string; source?: NginxSourceRange }>;
  sources: NginxConfigSource[]; includes: Array<{ source: NginxSourceRange; requested: string; resolvedPath?: string; resolvedPaths?: string[]; covered: boolean;
    directoryCoverage?: { beforeOperationId: string; afterOperationId: string; manifestSha256: string } }>;
  servers: NginxServerEvidence[];
  selected?: { serverId: string; locationId?: string; root?: string; alias?: string; proxyPass?: string; proxySetHeaders: NginxHeaderEvidence[];
    terminalResponse?: NginxTerminalResponse };
  globalFingerprint?: string; nonTargetFingerprint?: string;
  configurationLoaded: false; objectIdentityVerified: false; limitations: string[];
}
export interface NginxHeaderEvidence {
  name: string; value: string;
  expression: { kind: "literal" } | { kind: "nginx_variables"; variables: string[]; runtimeValueKnown: false };
}
export interface NginxTerminalResponse {
  kind: "literal_return"; statusCode: number; declaredText?: string; context: "server" | "location";
  source: NginxSourceRange; terminatesRequest: true;
}

type Token = { value: string; start: number; end: number; punctuation?: ";" | "{" | "}" };
type Node = { name: string; args: string[]; start: number; end: number; path: string; children?: Node[]; openEnd?: number; closeStart?: number;
  included?: Node[]; inclusions?: Array<{ path: string; nodes: Node[] }> };
type File = { text: string; offsets: number[]; startedAt: number; completedAt: number; source: NginxConfigSource };
type ManifestReceipt = { operationId: string; attemptId: string; startedAt: number; completedAt: number; identityFingerprint: string; data: FileManifestResult };
const MAX_FILES = 64, MAX_TOTAL_BYTES = 2 * 1024 * 1024, MAX_TOKENS = 50_000, MAX_DEPTH = 32, MAX_EXPANSIONS = 256;
const utf8 = new TextEncoder();
const cleanPath = (path: string) => path.length <= 4096 && path.startsWith("/") && path !== "/" && !path.includes("//")
  && !path.split("/").some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f\\$*?\[\]]/.test(path);
const hash = (value: unknown) => "sha256:" + sha256Utf8(canonicalExecutionJson(value));
const standardHeaderVariables = new Set(["host", "http_host", "remote_addr", "proxy_add_x_forwarded_for", "scheme"]);
function headerExpression(value: string): NginxHeaderEvidence["expression"] | undefined {
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (!value.includes("$")) return { kind: "literal" };
  const variables = [...value.matchAll(/\$([A-Za-z0-9_]+)/g)].map(match => match[1]!);
  if (value.replace(/\$([A-Za-z0-9_]+)/g, "").includes("$") || variables.some(name => !standardHeaderVariables.has(name))) return undefined;
  return { kind: "nginx_variables", variables: [...new Set(variables)], runtimeValueKnown: false };
}
function offsets(text: string) {
  const result = Array<number>(text.length + 1).fill(0); let bytes = 0;
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i)!, width = point > 0xffff ? 2 : 1;
    result[i] = bytes; if (width === 2) result[i + 1] = bytes;
    bytes += utf8.encode(String.fromCodePoint(point)).length; i += width; result[i] = bytes;
  }
  return result;
}
class ParseFailure extends Error { constructor(readonly code: string) { super(code); } }
function tokenize(text: string): Token[] {
  const tokens: Token[] = []; let i = 0;
  while (i < text.length) {
    if (/[ \t\r\n]/.test(text[i]!)) { i++; continue; }
    if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (";{}".includes(text[i]!)) {
      const punctuation = text[i] as ";" | "{" | "}"; tokens.push({ value: punctuation, start: i, end: ++i, punctuation });
    } else {
      const start = i; let value = "", quote: string | undefined, consumed = false;
      while (i < text.length) {
        const char = text[i]!;
        if (!quote && (/[ \t\r\n]/.test(char) || ";{}".includes(char))) break;
        consumed = true;
        if (char === "\\") {
          const next = text[++i]; if (next === undefined) throw new ParseFailure("unfinished_escape");
          if (!["\\", "\"", "'", "n", "r", "t"].includes(next)) throw new ParseFailure("unsupported_escape");
          value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next; i++; continue;
        }
        if (quote) {
          if (char === quote) {
            quote = undefined; i++;
            if (i < text.length && !/[ \t\r\n;{]/.test(text[i]!)) throw new ParseFailure("quoted_token_needs_separator");
            break;
          }
          value += char; i++; continue;
        }
        if (char === "\"" || char === "'") {
          if (i !== start) throw new ParseFailure("mixed_quote_unsupported");
          quote = char; i++; continue;
        }
        value += char; i++;
      }
      if (quote) throw new ParseFailure("unfinished_quote");
      if (!consumed) throw new ParseFailure("invalid_token");
      if (utf8.encode(value).length > 4096) throw new ParseFailure("token_byte_limit");
      tokens.push({ value, start, end: i });
    }
    if (tokens.length > MAX_TOKENS) throw new ParseFailure("token_limit");
  }
  return tokens;
}
function parse(text: string, path: string, budget: { tokens: number }): Node[] {
  const tokens = tokenize(text); let at = 0;
  budget.tokens += tokens.length;
  if (budget.tokens > MAX_TOKENS) throw new ParseFailure("token_limit");
  const block = (depth: number, nested: boolean): Node[] => {
    if (depth > MAX_DEPTH) throw new ParseFailure("nesting_limit");
    const nodes: Node[] = [];
    while (at < tokens.length) {
      if (tokens[at]!.punctuation === "}") {
        if (!nested) throw new ParseFailure("unexpected_close");
        return nodes;
      }
      const words: Token[] = [];
      while (at < tokens.length && !tokens[at]!.punctuation) words.push(tokens[at++]!);
      if (words.length > 129) throw new ParseFailure("directive_argument_limit");
      const delimiter = tokens[at++];
      if (!words.length || !delimiter || delimiter.punctuation === "}") throw new ParseFailure("unfinished_directive");
      const first = words[0]!;
      const node: Node = { name: first.value, args: words.slice(1).map(token => token.value), start: first.start, end: delimiter.end, path };
      if (delimiter.punctuation === "{") {
        node.openEnd = delimiter.end; node.children = block(depth + 1, true);
        const close = tokens[at++]; if (close?.punctuation !== "}") throw new ParseFailure("unfinished_block");
        node.closeStart = close.start; node.end = close.end;
      }
      nodes.push(node);
    }
    if (nested) throw new ParseFailure("unfinished_block");
    return nodes;
  };
  return block(0, false);
}

/** Interpret a finite static declaration only. This never runs nginx or grants a change. */
export function analyzeNginxConfigEvidence(input: NginxConfigInput): NginxConfigEvidence {
  const result: NginxConfigEvidence = { version: 1, binding: { ...input.binding }, target: { ...input.target }, entryPath: input.entryPath, prefix: input.prefix,
    status: "unknown", reasons: [], sources: [], includes: [], servers: [], configurationLoaded: false, objectIdentityVerified: false,
    limitations: ["static_declarations_only", "not_nginx_syntax_or_load_acceptance", "requested_paths_not_inode_or_symlink_chain", "independent_reads_not_atomic_snapshot", "no_runtime_route_or_backend_delivery_proof"] };
  const files = new Map<string, File>(), manifests: ManifestReceipt[] = [];
  const issue = (code: string, source?: NginxSourceRange) => {
    if (result.reasons.length < 128) result.reasons.push({ code, ...(source ? { source } : {}) });
    else if (result.reasons.length === 128) result.reasons.push({ code: "further_reasons_omitted" });
  };
  const source = (node: Node): NginxSourceRange => ({ path: node.path, startByte: files.get(node.path)!.offsets[node.start]!, endByte: files.get(node.path)!.offsets[node.end]! });
  const { binding, target } = input;
  if (!binding.taskId || !binding.roundId || !binding.serverId || !Number.isSafeInteger(binding.workflowEpoch) || binding.workflowEpoch < 0
    || !Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 0 || !cleanPath(input.entryPath)
    || !(input.prefix === "/" || cleanPath(input.prefix)) || !Array.isArray(input.receipts) || input.receipts.length > MAX_FILES) {
    issue("invalid_scope_or_limits"); return result;
  }
  let totalBytes = 0, manifestBytes = 0, endpointFingerprint: string | undefined;
  for (const receipt of input.receipts) {
    const op = receipt.operation, attempt = op?.attempts?.find(item => item.id === receipt.attemptId), action = op?.intent?.semantic?.action;
    try {
      if (!op || op.taskId !== binding.taskId || op.roundId !== binding.roundId || op.workflowEpoch !== binding.workflowEpoch
        || op.phase !== "tool" || op.effect !== "read" || op.state !== "succeeded" || op.cancelRequested
        || !executionIntentMatches(op.intent, op.intent) || op.intentDigest !== op.intent.digest
        || op.intent.semantic.taskId !== binding.taskId || op.intent.semantic.stepId !== op.stepId
        || op.intent.semantic.effect !== "read" || !op.intent.semantic.targets.length
        || op.intent.semantic.targets.some(item => item.serverId !== binding.serverId || item.connectionGeneration !== binding.connectionGeneration || item.role === "interaction")
        || !action || action.type !== "tool" || !["files.read_content", "files.inspect_manifest"].includes(action.toolId)
        || !attempt || op.attempts[op.attempts.length - 1] !== attempt || attempt.operationId !== op.operationId || attempt.status !== "succeeded"
        || attempt.late || attempt.cancelRequested || attempt.outcome?.status !== "succeeded" || !Number.isFinite(attempt.startedAt)
        || !attempt.completedAt || attempt.completedAt < attempt.startedAt
        || !attempt.projectionAppliedAt || !attempt.outcome.evidenceRefs.length) throw new ParseFailure("unbound_or_incomplete_receipt");
      const endpoints = op.intent.semantic.targets.map(item => hash({ host: item.host, port: item.port, username: item.username }));
      if (endpoints.some(value => value !== endpoints[0]) || endpointFingerprint && endpointFingerprint !== endpoints[0]) throw new ParseFailure("endpoint_identity_mismatch");
      endpointFingerprint = endpoints[0];
      if (action.toolId === "files.inspect_manifest") {
        const value = attempt.outcome.result as ToolResult | undefined;
        if (!value || value.callId !== attempt.executionId || value.toolId !== action.toolId || value.success !== true || value.truncated === true) throw new ParseFailure("invalid_manifest_receipt");
        const serialized = JSON.stringify(value.data); manifestBytes += utf8.encode(serialized).length;
        if (manifestBytes > 8 * 1024 * 1024) throw new ParseFailure("manifest_byte_limit");
        const data = parseFileManifestOutput(action.arguments, `OPSARK_FILE_MANIFEST ${serialized}`);
        if (data.request.source !== "directory" || data.status !== "complete" || !data.coverageComplete || data.truncated || data.observationsRedacted) throw new ParseFailure("incomplete_directory_manifest");
        const identityFingerprint = hash({ root: data.rootIdentity, entries: [...data.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
        manifests.push({ operationId: op.operationId, attemptId: attempt.id, startedAt: attempt.startedAt, completedAt: attempt.completedAt, identityFingerprint, data });
        continue;
      }
      const call = { id: attempt.executionId, toolId: action.toolId, arguments: action.arguments };
      const validated = enforceToolResult(call, attempt.outcome.result as ToolResult);
      if (!validated.success || validated.truncated || !validated.data || typeof validated.data !== "object") throw new ParseFailure("invalid_read_receipt");
      const data = validated.data as Record<string, unknown>;
      if (typeof data.path !== "string" || !cleanPath(data.path) || typeof data.content !== "string" || data.encoding !== "utf-8"
        || data.truncated !== false || data.returnedBytes !== data.totalBytes || utf8.encode(data.content).length !== data.returnedBytes
        || /\[REDACTED\]|•{4,}|\uFFFD|\uFEFF|\u0000/.test(data.content)) throw new ParseFailure("partial_redacted_or_nonexact_bytes");
      if (files.has(data.path)) throw new ParseFailure("duplicate_path_receipts");
      totalBytes += Number(data.totalBytes); if (totalBytes > MAX_TOTAL_BYTES) throw new ParseFailure("input_byte_limit");
      const identity: NginxConfigSource = { path: data.path, stepId: op.stepId, operationId: op.operationId, attemptId: attempt.id, executionId: attempt.executionId,
        bytes: Number(data.totalBytes), contentSha256: "sha256:" + sha256Utf8(data.content), pathIdentity: "requested_path_only" };
      files.set(data.path, { text: data.content, offsets: offsets(data.content), startedAt: attempt.startedAt, completedAt: attempt.completedAt, source: identity }); result.sources.push(identity);
    } catch (error) { issue(error instanceof ParseFailure ? error.code : "invalid_read_receipt"); }
  }
  if (result.reasons.length) return result;
  if (!files.has(input.entryPath)) { issue("entry_receipt_missing"); return result; }
  // nginx's conf_prefix is the main configuration directory, not runtime prefix
  // and not the directory of each recursively included file.
  const configurationPrefix = input.entryPath.slice(0, input.entryPath.lastIndexOf("/")) || "/";
  const resolve = (name: string, prefix: string) => name.startsWith("/") ? name : (prefix === "/" ? "" : prefix.replace(/\/$/, "")) + "/" + name;
  const resolveInclude = (name: string) => resolve(name, configurationPrefix);
  type GlobCoverage = { paths: string[]; directoryCoverage: { beforeOperationId: string; afterOperationId: string; manifestSha256: string } };
  const globCache = new Map<string, GlobCoverage>();
  const globCoverage = (pattern: string): GlobCoverage => {
    const cached = globCache.get(pattern); if (cached) return cached;
    const slash = pattern.lastIndexOf("/"), directory = pattern.slice(0, slash) || "/", basename = pattern.slice(slash + 1);
    if (!(directory === "/" || cleanPath(directory)) || !basename.includes("*") || /[$?\[\]\\\u0000-\u001f]/.test(basename)) throw new ParseFailure("unsupported_glob_pattern");
    const matcher = new RegExp("^" + basename.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "u");
    const candidates = manifests.filter(item => item.data.request.path === directory);
    for (const before of candidates) for (const after of candidates) {
      if (before === after || before.operationId === after.operationId || before.completedAt > after.startedAt
        || before.data.manifestSha256 !== after.data.manifestSha256 || before.identityFingerprint !== after.identityFingerprint) continue;
      const ordered = (value: FileManifestResult) => [...value.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      // The published manifest digest intentionally omits inode/times; compare
      // those separately so equal content cannot hide replacement of a member.
      const matched = ordered(before.data).filter(item => !item.path.includes("/") && (basename.startsWith(".") || !item.path.startsWith(".")) && matcher.test(item.path));
      if (matched.some(item => item.kind !== "regular" || item.status !== "complete" || !item.identity || !item.sha256)) continue;
      const paths = matched.map(item => (directory === "/" ? "" : directory) + "/" + item.path);
      if (matched.some((item, i) => {
        const file = files.get(paths[i]!);
        return !file || file.source.bytes !== item.sizeBytes || file.source.contentSha256 !== "sha256:" + item.sha256
          || file.startedAt < before.completedAt || file.completedAt > after.startedAt;
      })) continue;
      const value = { paths, directoryCoverage: { beforeOperationId: before.operationId, afterOperationId: after.operationId, manifestSha256: before.data.manifestSha256! } };
      globCache.set(pattern, value); return value;
    }
    throw new ParseFailure("glob_directory_coverage_unproven");
  };
  let expansions = 0, expandedBytes = 0;
  const parseBudget = { tokens: 0 };
  const load = (path: string, stack: string[]): Node[] => {
    if (++expansions > MAX_EXPANSIONS || stack.length > 16) throw new ParseFailure("include_expansion_limit");
    if (stack.includes(path)) throw new ParseFailure("include_cycle");
    const file = files.get(path); if (!file) throw new ParseFailure("include_receipt_missing");
    expandedBytes += file.source.bytes;
    if (expandedBytes > 4 * 1024 * 1024) throw new ParseFailure("include_byte_limit");
    const nodes = parse(file.text, path, parseBudget);
    const expand = (items: Node[]) => {
      for (const node of items) {
        if (node.name === "include") {
          const requested = node.args[0] ?? "", path = node.args.length === 1 ? resolveInclude(node.args[0]!) : "";
          if (result.includes.length >= 4096) throw new ParseFailure("include_projection_limit");
          const entry: NginxConfigEvidence["includes"][number] = { source: source(node), requested, ...(cleanPath(path) ? { resolvedPath: path } : {}), covered: false }; result.includes.push(entry);
          if (node.children || !path) { issue("invalid_include", source(node)); continue; }
          let paths: string[];
          if (path.includes("*")) {
            try { const coverage = globCoverage(path); paths = coverage.paths; entry.resolvedPaths = paths; entry.directoryCoverage = coverage.directoryCoverage; }
            catch (error) { issue(error instanceof ParseFailure ? error.code : "invalid_glob_coverage", source(node)); continue; }
          } else if (!cleanPath(path)) { issue("dynamic_or_glob_include_uncovered", source(node)); continue; }
          else if (!files.has(path)) { issue("include_receipt_missing", source(node)); continue; }
          else paths = [path];
          node.inclusions = paths.map(path => ({ path, nodes: load(path, [...stack, node.path]) }));
          node.included = node.inclusions.flatMap(item => item.nodes); entry.covered = true;
        }
        if (node.children) expand(node.children);
      }
    };
    expand(nodes); return nodes;
  };
  let tree: Node[];
  try { tree = load(input.entryPath, []); }
  catch (error) { issue(error instanceof ParseFailure ? error.code : "parse_error"); return result; }
  const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => node.name === "include" ? node.included ? flatten(node.included) : [] : [node]);
  const countNodes = (nodes: Node[]): number => nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []) + countNodes(node.included ?? []), 0);
  if (countNodes(tree) > 4096) { issue("projection_node_limit"); return result; }
  const directive = (node: Node): NginxDirectiveEvidence => ({ name: node.name, args: [...node.args], source: source(node) });
  const raw = (node: Node) => files.get(node.path)!.text.slice(node.start, node.end);
  const expandedRaw = (node: Node): unknown => ({ raw: raw(node),
    ...(node.inclusions ? { includedFiles: node.inclusions.map(item => ({ path: item.path, sha256: files.get(item.path)!.source.contentSha256 })) } : {}),
    includes: (node.included ?? []).map(expandedRaw), children: node.children?.map(expandedRaw) });
  const passive: Record<string, Set<string>> = {
    main: new Set(["user", "worker_processes", "worker_rlimit_nofile", "pid", "error_log"]),
    events: new Set(["worker_connections", "multi_accept", "accept_mutex", "use"]),
    http: new Set(["default_type", "access_log", "error_log", "log_format", "sendfile", "tcp_nopush", "tcp_nodelay", "keepalive_timeout", "server_tokens", "gzip", "include"]),
    server: new Set(["access_log", "error_log", "ssl_certificate", "ssl_certificate_key", "ssl_protocols", "ssl_ciphers", "index", "charset"]),
    location: new Set(["access_log", "error_log", "index", "charset"]),
  };
  const routing = new Set(["listen", "server_name", "root", "alias", "proxy_pass", "proxy_set_header"]);
  const validate = (nodes: Node[], context: string) => {
    for (const node of flatten(nodes)) {
      if (node.children) {
        const allowed = context === "main" && ["events", "http"].includes(node.name)
          || context === "http" && ["server", "types"].includes(node.name) || context === "server" && node.name === "location";
        if (!allowed) issue("unsupported_block", source(node));
        if (node.name === "location" && context === "server") {
          if (node.args.length > 2 || !node.args.length || (node.args.length === 2 && !["=", "^~"].includes(node.args[0]!))) issue("regex_or_complex_location", source(node));
          const path = node.args[node.args.length - 1] ?? "";
          if (!path.startsWith("/") || /[$%?#\u0000-\u0020\u007f]/.test(path)) issue("dynamic_location", source(node));
        } else if (node.args.length) issue("unexpected_block_arguments", source(node));
        validate(node.children, node.name); continue;
      }
      if (context === "types") continue; // MIME mappings are preserved, not treated as routing directives.
      if (node.name === "return") {
        if (!["server", "location"].includes(context)) issue("directive_context_mismatch", source(node));
        else if (!nginxLiteralReturn(node.args)) issue("unsupported_return", source(node));
        continue;
      }
      if (routing.has(node.name)) {
        const allowed = node.name === "listen" || node.name === "server_name" ? context === "server"
          : node.name === "alias" || node.name === "proxy_pass" ? context === "location" : ["http", "server", "location"].includes(context);
        if (!allowed) issue("directive_context_mismatch", source(node));
        if (node.name === "proxy_set_header" && node.args.length === 2) {
          if (!headerExpression(node.args[1]!)) issue("unsupported_header_expression", source(node));
        } else if (node.args.some(value => value.includes("$"))) issue("dynamic_route_value", source(node));
      } else if (node.name === "index" && node.args.some(value => value.includes("$"))) issue("dynamic_route_value", source(node));
      else if (!passive[context]?.has(node.name)) issue("unsupported_directive", source(node));
    }
  };
  validate(tree, "main");
  const httpNodes = flatten(tree).filter(node => node.name === "http" && node.children);
  if (httpNodes.length !== 1) { issue("http_scope_ambiguous"); return result; }
  const http = httpNodes[0]!, serverNodes = flatten(http.children!).filter(node => node.name === "server" && node.children);
  if (serverNodes.length > 128) { issue("server_limit"); return result; }
  const listenAddress = (value: string) => {
    let address: string, port: number;
    if (/^\d+$/.test(value)) { address = "0.0.0.0"; port = Number(value); }
    else {
      const ipv6 = value.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/), ipv4 = value.match(/^(\*|(?:\d{1,3}\.){3}\d{1,3}):(\d+)$/);
      if (ipv6) {
        try { address = new URL(`http://[${ipv6[1]}]`).hostname.slice(1, -1); } catch { return undefined; }
        port = Number(ipv6[2]);
      }
      else if (ipv4) { address = ipv4[1] === "*" ? "0.0.0.0" : ipv4[1]!; port = Number(ipv4[2]); }
      else return undefined;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (!address.includes(":") && address.split(".").some(part => Number(part) > 255 || part.length > 1 && part.startsWith("0")))) return undefined;
    return { address, port };
  };
  for (const [index, node] of serverNodes.entries()) {
    const direct = flatten(node.children!), directives = direct.filter(child => !child.children).map(directive);
    const server: NginxServerEvidence = { id: `server:${index}`, source: source(node), fingerprint: hash(expandedRaw(node)), listens: [], serverNames: [], directives, locations: [] };
    for (const child of direct) {
      if (child.name === "listen") {
        const address = listenAddress(child.args[0] ?? "");
        if (!address || child.args.slice(1).some(arg => !["default_server", "ssl"].includes(arg))) issue("unsupported_listen", source(child));
        else server.listens.push({ ...address, defaultServer: child.args.includes("default_server"), tls: child.args.includes("ssl"), source: source(child) });
      } else if (child.name === "server_name") {
        if (!child.args.length || child.args.some(name => /[*~$]/.test(name))) issue("complex_server_name", source(child));
        else if (server.serverNames.length + child.args.length > 4096) issue("server_names_limit", source(child));
        else server.serverNames.push(...child.args.map(name => name.toLowerCase()));
      } else if (child.name === "location" && child.children) {
        const args = child.args;
        // Unsupported selectors retain their diagnostic source above, never a
        // falsely narrowed typed static location (or an invalid tool receipt).
        const path = args[args.length - 1] ?? "";
        if (args.length < 1 || args.length > 2 || args.length === 2 && !["=", "^~"].includes(args[0]!)
          || !path.startsWith("/") || /[$%?#\u0000-\u0020\u007f]/.test(path)) continue;
        server.locations.push({ id: `${server.id}:location:${server.locations.length}`, modifier: args.length === 2 ? args[0] as "=" | "^~" : "",
          path, source: source(child), directives: flatten(child.children).filter(item => !item.children).map(directive) });
      }
    }
    if (!server.listens.length) issue("implicit_listen_unsupported", source(node));
    if (!server.serverNames.length) server.serverNames.push("");
    result.servers.push(server);
  }
  // Preserve exact non-server bytes, including comments and include spelling.
  // Server placeholders retain count/order without treating target byte-length changes as unrelated edits.
  const projectBytes = (nodes: Node[], path: string, omit: (node: Node) => boolean, start = 0, end = files.get(path)!.text.length): string => {
    const text = files.get(path)!.text; let pos = start, output = "";
    for (const node of nodes) {
      output += text.slice(pos, node.start);
      if (omit(node)) output += "\u0000EXCLUDED_BLOCK\u0000";
      else if (node.inclusions) output += raw(node) + node.inclusions.map(item => projectBytes(item.nodes, item.path, omit)).join("");
      else if (node.children) output += text.slice(node.start, node.openEnd) + projectBytes(node.children, path, omit, node.openEnd, node.closeStart) + text.slice(node.closeStart, node.end);
      else output += raw(node);
      pos = node.end;
    }
    return output + text.slice(pos, end);
  };
  result.globalFingerprint = hash(projectBytes(tree, input.entryPath, node => node.name === "server" && !!node.children));
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !listenAddress(`${target.address.includes(":") ? `[${target.address}]` : target.address}:${target.port}`)
    || !target.uriPath.startsWith("/") || /[$%?#\u0000-\u0020]/.test(target.uriPath) || target.uriPath.includes("//") || target.uriPath.split("/").some(part => part === "." || part === "..")
    || /[*~$\s/:]/.test(target.serverName)) { issue("invalid_target_identity"); return result; }
  const address = listenAddress(`${target.address.includes(":") ? `[${target.address}]` : target.address}:${target.port}`)!.address, host = target.serverName.toLowerCase();
  const matchesAddress = (listener: NginxListenEvidence) => listener.port === target.port
    && (listener.address === address || listener.address === (address.includes(":") ? "::" : "0.0.0.0"));
  let candidates = result.servers.filter(server => server.listens.some(matchesAddress));
  const exact = candidates.filter(server => server.listens.some(listener => listener.port === target.port && listener.address === address));
  if (exact.length) candidates = exact;
  const named = candidates.filter(server => server.serverNames.includes(host));
  const defaults = candidates.filter(server => server.listens.some(listener => (exact.length
    ? listener.port === target.port && listener.address === address : matchesAddress(listener)) && listener.defaultServer));
  const selected = named.length === 1 ? named[0] : !named.length && defaults.length === 1 ? defaults[0] : undefined;
  if (!selected || defaults.length > 1) { issue("server_target_ambiguous_or_unmatched"); return result; }
  const exactLocations = selected.locations.filter(location => location.modifier === "=" && location.path === target.uriPath);
  const prefixLocations = selected.locations.filter(location => location.modifier !== "=" && target.uriPath.startsWith(location.path)).sort((a, b) => b.path.length - a.path.length);
  if (exactLocations.length > 1 || !exactLocations.length && prefixLocations.length > 1 && prefixLocations[0]!.path.length === prefixLocations[1]!.path.length) {
    issue("location_target_ambiguous"); return result;
  }
  // Server rewrite directives run before location lookup. In this supported
  // subset there is no conditional/rewrite/break; the first return terminates.
  const serverReturn = selected.directives.find(node => node.name === "return");
  const location = serverReturn ? undefined : exactLocations[0] ?? prefixLocations[0];
  const returnNode = serverReturn ?? location?.directives.find(node => node.name === "return");
  const returned = returnNode && nginxLiteralReturn(returnNode.args);
  const terminalResponse: NginxTerminalResponse | undefined = returnNode && returned
    ? { kind: "literal_return", ...returned, context: serverReturn ? "server" : "location", source: returnNode.source, terminatesRequest: true } : undefined;
  const levels = [flatten(http.children!).filter(node => !node.children).map(directive), selected.directives, ...(location ? [location.directives] : [])];
  const value = (name: string): string | undefined => {
    let found: string | undefined;
    for (const level of levels) {
      const nodes = level.filter(node => node.name === name);
      if (nodes.length > 1 || nodes.some(node => node.args.length !== 1)) issue("duplicate_or_invalid_" + name, nodes[0]?.source);
      if (nodes[0]?.args.length === 1) found = nodes[0].args[0];
    }
    return found;
  };
  let root: string | undefined, alias: string | undefined;
  for (const level of levels) {
    const paths = level.filter(node => node.name === "root" || node.name === "alias");
    if (paths.length > 1 || paths.some(node => node.args.length !== 1)) issue("root_alias_conflict", paths[0]?.source);
    if (paths[0]?.args.length === 1) {
      root = paths[0].name === "root" ? paths[0].args[0] : undefined;
      alias = paths[0].name === "alias" ? paths[0].args[0] : undefined;
    }
  }
  const proxyPass = value("proxy_pass");
  if (root && !cleanPath(resolve(root, input.prefix)) || alias && !cleanPath(resolve(alias, input.prefix))) issue("unsupported_document_path");
  if (proxyPass) {
    try { const url = new URL(proxyPass); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || proxyPass.includes("$")) issue("unsupported_proxy_pass"); }
    catch { issue("unsupported_proxy_pass"); }
  }
  let headers: NginxHeaderEvidence[] = [];
  for (const level of levels) {
    const nodes = level.filter(node => node.name === "proxy_set_header");
    if (nodes.length) headers = nodes.flatMap(node => {
      const expression = node.args.length === 2 ? headerExpression(node.args[1]!) : undefined;
      if (!expression || !/^[A-Za-z0-9_-]+$/.test(node.args[0]!)) { issue("invalid_proxy_set_header", node.source); return []; }
      return [{ name: node.args[0]!, value: node.args[1]!, expression }];
    });
  }
  const selectedNode = serverNodes[result.servers.indexOf(selected)]!;
  const protectedRemainder = location ? projectBytes([selectedNode], selectedNode.path, node => {
    const range = source(node);
    return node.name === "location" && range.path === location.source.path && range.startByte === location.source.startByte && range.endByte === location.source.endByte;
  }, selectedNode.start, selectedNode.end) : undefined;
  result.nonTargetFingerprint = hash({ otherServers: result.servers.filter(server => server !== selected).map(server => ({ path: server.source.path, fingerprint: server.fingerprint })),
    ...(protectedRemainder === undefined ? {} : { selectedServerOutsideLocation: protectedRemainder }) });
  if (!terminalResponse && headers.some(header => header.expression.kind === "nginx_variables")) result.limitations.push("header_expressions_are_not_observed_runtime_values");
  if (terminalResponse) result.limitations.push("return_text_is_declaration_not_observed_response");
  if (!result.reasons.length) {
    result.status = "parsed"; result.selected = { serverId: selected.id, ...(location ? { locationId: location.id } : {}),
      ...(terminalResponse ? { terminalResponse, proxySetHeaders: [] } : {
        ...(root ? { root: resolve(root, input.prefix) } : {}), ...(alias ? { alias: resolve(alias, input.prefix) } : {}), ...(proxyPass ? { proxyPass } : {}), proxySetHeaders: headers }) };
  }
  return result;
}
