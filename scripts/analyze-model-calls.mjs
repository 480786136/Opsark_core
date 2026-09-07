import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Usage: node scripts/analyze-model-calls.mjs [jsonl-path-or-logs-directory] [UTC-date] [taskId]
// No request bodies, command contents, credentials or response prose are printed.
const filename = process.argv[2] ?? '日志存储/developer-model-calls.jsonl';
let invalidLines = 0;
function logFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? logFiles(join(path, entry.name)) : entry.isFile() && /^model-calls(?:-\d+)?\.jsonl$/.test(entry.name)
      ? [join(path, entry.name)] : []);
}
const events = logFiles(filename).flatMap(path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { invalidLines++; return []; }
});
const requests = events.filter(e => e.event === 'request_sent' && Number.isFinite(e.timestampMs)
  && (!process.argv[4] || e.taskId === process.argv[4]));
if (!requests.length) throw new Error('No request_sent events with timestamps');
const date = process.argv[3] ?? new Date(Math.max(...requests.map(e => e.timestampMs))).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Expected UTC date YYYY-MM-DD');
const selected = requests.filter(e => new Date(e.timestampMs).toISOString().startsWith(date));
const responseMap = new Map(events.filter(e => ['response_received', 'response_failed', 'request_failed'].includes(e.event))
  .map(e => [e.callId, e]));
const size = value => JSON.stringify(value)?.length ?? 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function contextFromContent(content) {
  if (typeof content !== 'string') return undefined;
  // Requests wrap one JSON context in prose. Balance braces while respecting strings.
  const start = content.indexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(content.slice(start, i + 1)); } catch { return undefined; }
    }
  }
}

function contextFrom(messages) {
  return Object.assign({}, ...(messages ?? []).filter(message => message.role === 'user')
    .map(message => contextFromContent(message.content)).filter(Boolean));
}

const totals = () => ({ requests: 0, responsesWithUsage: 0, errors: 0, promptTokens: 0,
  completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, requestCharacters: 0 });
const aggregate = totals(), groups = {}, reviewTypes = {}, largest = [], duplicateBodies = new Set();
let repeatedRequestBodies = 0, repairRequests = 0, repeatedEvidenceCharacters = 0;
const errors = [];
for (const request of selected) {
  const response = responseMap.get(request.callId);
  const usage = response?.response?.usage;
  const group = groups[request.requestName] ??= totals();
  const error = response && (response.event !== 'response_received' || response.status >= 400);
  for (const target of [group, aggregate]) {
    target.requests++;
    target.responsesWithUsage += usage ? 1 : 0;
    target.errors += error ? 1 : 0;
    target.promptTokens += usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    target.completionTokens += usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    target.totalTokens += usage?.total_tokens ?? ((usage?.prompt_tokens ?? usage?.input_tokens ?? 0) + (usage?.completion_tokens ?? usage?.output_tokens ?? 0));
    target.cachedInputTokens += usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0;
    target.cacheCreationInputTokens += usage?.prompt_tokens_details?.cache_creation_input_tokens ?? usage?.cache_creation_input_tokens ?? 0;
    target.requestCharacters += size(request.request);
  }
  if (error) errors.push({ callId: request.callId, status: response.status,
    code: response.response?.error?.code, timestamp: new Date(request.timestampMs).toISOString() });
  const fingerprint = hash(request.request);
  if (duplicateBodies.has(fingerprint)) repeatedRequestBodies++;
  duplicateBodies.add(fingerprint);
  const context = contextFrom(request.request?.messages);
  if (JSON.stringify(request.request).includes('planGenerationRepair')) repairRequests++;
  if (request.requestName === '结果复核') {
    const type = context?.reviewPolicy?.commandExecutionFailed ? 'commandFailure'
      : context?.progress || context?.reviewRound ? 'longRunning'
      : context?.reviewPolicy?.postconditionReview || context?.postconditionReview ? 'postcondition' : 'other';
    reviewTypes[type] = (reviewTypes[type] ?? 0) + 1;
  }
  for (const step of [...(context?.knownExecutionFacts?.completedSteps ?? []), ...(context?.completedDiscovery ?? [])]) {
    for (const evidence of step.evidence ?? []) {
      if (step.output && evidence.rawOutput === step.output) repeatedEvidenceCharacters += size(evidence.rawOutput);
    }
  }
  largest.push({ callId: request.callId, requestName: request.requestName,
    promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    contextFields: Object.fromEntries(Object.entries(context ?? {}).map(([key, value]) => [key, size(value)])
      .sort((a, b) => b[1] - a[1]).slice(0, 4)) });
}
console.log(JSON.stringify({ date, dateZone: 'UTC', invalidLines, totals: aggregate, groups, reviewTypes,
  repeatedRequestBodies, repairRequests, repeatedEvidenceCharacters,
  note: 'Characters are serialized UTF-16 lengths, not tokens. Usage excludes requests whose provider returned no usage. Repeated bodies across requests are not automatically unnecessary.',
  errors, largest: largest.sort((a, b) => b.promptTokens - a.promptTokens).slice(0, 5) }, null, 2));
