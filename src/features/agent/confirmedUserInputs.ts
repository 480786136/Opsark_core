import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import type { OpsTask, SubmittedTaskInput } from "@/types";

const CONFIRMED_INPUT_ITEM_LIMIT = 16;
const CONFIRMED_INPUT_CONTEXT_CHARACTER_LIMIT = 6_000;
const CONFIRMED_INPUT_KEY_LIMIT = 96;
const CONFIRMED_INPUT_VALUE_LIMIT = 480;
const SENSITIVE_INPUT_SEGMENTS = new Set([
  "password", "passwd", "passphrase", "token", "secret", "credential", "authorization", "cookie",
]);

function isSensitiveInputKey(key: string) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (segments.some(segment => SENSITIVE_INPUT_SEGMENTS.has(segment))) return true;
  const compact = segments.join("");
  return /(?:password|passwd|passphrase|apikey|privatekey|clientsecret|accesstoken|refreshtoken|registrytoken|authtoken|bearertoken|credential|authorization|sessioncookie)/.test(compact);
}

function compactExactText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const marker = `…[已压缩，原始 ${value.length} 字符，指纹 ${textFingerprint(value)}]…`;
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available * 0.4);
  const tailLength = Math.max(0, available - headLength);
  return `${value.slice(0, headLength)}${marker}${tailLength ? value.slice(-tailLength) : ""}`;
}

function isConfirmedNonSensitiveInput(value: unknown): value is SubmittedTaskInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<SubmittedTaskInput>;
  return (input.type === "text" || input.type === "number" || input.type === "select")
    && (typeof input.value === "string" || (typeof input.value === "number" && Number.isFinite(input.value)))
    && typeof input.label === "string"
    && typeof input.description === "string"
    && typeof input.groupId === "string"
    && typeof input.groupTitle === "string"
    && typeof input.submittedAt === "string";
}

function projectedInput(key: string, input: SubmittedTaskInput) {
  const stringValue = typeof input.value === "string" ? input.value : undefined;
  return {
    key: compactExactText(key, CONFIRMED_INPUT_KEY_LIMIT),
    keyTruncated: key.length > CONFIRMED_INPUT_KEY_LIMIT || undefined,
    value: stringValue === undefined
      ? input.value
      : compactExactText(stringValue, CONFIRMED_INPUT_VALUE_LIMIT),
    valueTruncated: stringValue !== undefined && stringValue.length > CONFIRMED_INPUT_VALUE_LIMIT || undefined,
    valueFingerprint: stringValue !== undefined && stringValue.length > CONFIRMED_INPUT_VALUE_LIMIT
      ? textFingerprint(stringValue)
      : undefined,
    type: input.type,
    label: compactExactText(input.label, 120),
    description: compactExactText(input.description, 240),
    groupTitle: compactExactText(input.groupTitle, 160),
    submittedAt: compactExactText(input.submittedAt, 48),
    sourceStepId: input.scope?.sourceStepId,
  };
}

type InputContextTask = Pick<OpsTask, "id" | "serverId" | "executionTargetServerId" | "rootGoal" | "title" | "submittedInputs" | "plan">;

export function confirmedInputScope(task: InputContextTask, sourceStepId: string): NonNullable<SubmittedTaskInput["scope"]> {
  return {
    taskId: task.id,
    serverId: task.executionTargetServerId || task.serverId,
    goalFingerprint: textFingerprint(task.rootGoal?.trim() || task.title),
    sourceStepId,
  };
}

function scopeStatus(task: InputContextTask, input: SubmittedTaskInput) {
  const scope = input.scope;
  // Legacy values remain in durable storage, but their server/goal cannot be
  // proven from a label or the current target. Never silently grant reuse.
  if (!scope || [scope.taskId, scope.serverId, scope.goalFingerprint, scope.sourceStepId]
    .some(value => typeof value !== "string" || !value.trim())) return "unverified_legacy";
  const current = confirmedInputScope(task, scope.sourceStepId);
  return scope.taskId === current.taskId && scope.serverId === current.serverId
    && scope.goalFingerprint === current.goalFingerprint ? "active" : "out_of_scope";
}

/** Exact, current, non-sensitive decisions for local policy; never use the bounded model projection as authority. */
export function activeConfirmedInputEntries(task: InputContextTask) {
  return Object.entries(task.submittedInputs ?? {})
    .filter((entry): entry is [string, SubmittedTaskInput] => !isSensitiveInputKey(entry[0])
      && isConfirmedNonSensitiveInput(entry[1]) && scopeStatus(task, entry[1]) === "active");
}

/**
 * Projects the task's durable, non-sensitive user decisions into model context.
 * Secret bindings are deliberately not inspected: credential material remains
 * available only through secretVariables/serverCredentialGroups references.
 */
export function confirmedUserInputsContext(task: InputContextTask) {
  const eligible = Object.entries(task.submittedInputs ?? {})
    .filter(([key, input]) => !isSensitiveInputKey(key) && isConfirmedNonSensitiveInput(input))
    .map(([key, input], index) => ({ key, input, index }))
    .sort((left, right) => left.input.submittedAt.localeCompare(right.input.submittedAt)
      || left.index - right.index);
  if (!eligible.length) return undefined;

  const active = eligible.filter(({ input }) => scopeStatus(task, input) === "active");
  const pendingText = task.plan.filter(step => step.status === "pending")
    .map(step => `${step.command}\n${step.description}`).join("\n");
  // Relevance affects detail selection only; it never changes scope/authority.
  const candidates = [...active].reverse().sort((left, right) =>
    Number(pendingText.includes(right.key)) - Number(pendingText.includes(left.key)));
  const selected: ReturnType<typeof projectedInput>[] = [];
  let usedCharacters = 0;
  for (const { key, input } of candidates) {
    if (selected.length >= CONFIRMED_INPUT_ITEM_LIMIT) break;
    const item = projectedInput(key, input);
    const itemCharacters = JSON.stringify(item).length;
    if (selected.length && usedCharacters + itemCharacters > CONFIRMED_INPUT_CONTEXT_CHARACTER_LIMIT) continue;
    selected.push(item);
    usedCharacters += itemCharacters;
  }
  selected.reverse();
  const includedKeys = new Set(selected.map(item => item.key));

  return {
    totalItems: eligible.length,
    activeItems: active.length,
    includedItems: selected.length,
    omittedItems: Math.max(0, eligible.length - selected.length),
    // A complete, value-free index makes older decisions visible without
    // injecting their full descriptions/values into every model request.
    index: eligible.map(({ key, input }) => ({
      key: compactExactText(key, CONFIRMED_INPUT_KEY_LIMIT),
      status: scopeStatus(task, input),
      included: includedKeys.has(compactExactText(key, CONFIRMED_INPUT_KEY_LIMIT)),
      sourceStepId: input.scope?.sourceStepId,
      valueFingerprint: textFingerprint(String(input.value)),
    })),
    items: selected,
    instruction: "仅 active 输入是当前任务、目标和服务器下已确认的非敏感决定，完整值必须复用，不得重复询问。unverified_legacy/out_of_scope 不可直接复用，必要时针对性确认；原值仍保存在本地。index 保留全部非敏感决定，items 只展开相关/最近详情。缺少完整值时可读取来源步骤的归档证据（若可用），否则仅确认必要字段；不得执行已压缩的 key/value 或猜测省略值。用户输入不代表额外授权或目标完成。",
  };
}
