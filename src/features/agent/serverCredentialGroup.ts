import type { UserInputField } from "@/features/tools/types";
import type { SecretMetadata } from "@/types";

export type ServerCredentialKind = NonNullable<SecretMetadata["credentialKind"]>;

export interface CredentialInputPair {
  usernameField: UserInputField;
  secretField: UserInputField;
  kind: ServerCredentialKind;
  target?: string;
  label: string;
}

export interface ServerCredentialGroup {
  id: string;
  serverId: string;
  kind: ServerCredentialKind;
  target?: string;
  label: string;
  username: SecretMetadata;
  secret: SecretMetadata;
}

const USERNAME_CONTEXT = /(?:user\s*name|login\s*(?:name|user)|account|用户名|登录名|账号|账户)/i;
const SECRET_CONTEXT = /(?:password|passwd|token|secret|credential|密码|口令|令牌|凭据)/i;
const DOMAIN_OR_IP = /(?:[a-z0-9-]+\.)+[a-z0-9-]+|(?:\d{1,3}\.){3}\d{1,3}/gi;

export function normalizeCredentialStorageKey(key: string) {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Credential usernames are values, but SSH usernames may also be expanded into a user@host token. */
export function credentialUsernameValidationError(kind: ServerCredentialKind, value: string) {
  if (!value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return "用户名不能为空或包含终端控制字符";
  if (kind === "ssh-password" && !/^[A-Za-z0-9._-]+$/.test(value)) {
    return "SSH 用户名只能包含字母、数字、点、下划线和连字符";
  }
  return undefined;
}

function credentialKind(context: string): ServerCredentialKind {
  if (/git|gitee|github|gitlab|仓库|源码/i.test(context)) return "git-https";
  if (/\bssh\b|\bscp\b|\bsftp\b|远程登录/i.test(context)) return "ssh-password";
  if (/mysql|mariadb|postgres|postgresql|database|数据库/i.test(context)) return "database";
  return "service";
}

function credentialTarget(context: string) {
  return (context.toLocaleLowerCase().match(DOMAIN_OR_IP) ?? [])[0]?.replace(/\.$/, "");
}

/** Detects a username/password pair that must become one durable server credential group. */
export function inferCredentialInputPair(title: string, fields: UserInputField[]): CredentialInputPair | undefined {
  const explicitFields = fields.filter((field) => field.credential);
  if (explicitFields.length > 0) {
    const groups = new Set(explicitFields.map((field) => field.credential!.group));
    if (groups.size !== 1 || explicitFields.length !== 2) return undefined;
    const usernameField = explicitFields.find((field) => field.credential?.role === "username");
    const secretField = explicitFields.find((field) => field.credential?.role === "secret");
    const descriptor = usernameField?.credential;
    if (!usernameField || !secretField || !descriptor
      || secretField.credential?.kind !== descriptor.kind
      || secretField.credential?.target !== descriptor.target) return undefined;
    return {
      usernameField,
      secretField,
      kind: descriptor.kind,
      target: descriptor.target,
      label: title.trim() || `${usernameField.label} / ${secretField.label}`,
    };
  }

  // Compatibility for persisted v5 forms. Roles are inferred from stable key
  // and label semantics first; prose mentioning "account password" must not
  // turn the secret field into a second username field.
  const usernameFields = fields.filter((field) => {
    if (field.type !== "text" && field.type !== "password") return false;
    const identity = `${field.key} ${field.label}`;
    if (SECRET_CONTEXT.test(identity)) return false;
    if (USERNAME_CONTEXT.test(identity)) return true;
    return USERNAME_CONTEXT.test(field.description) && !SECRET_CONTEXT.test(field.description);
  });
  const usernameKeys = new Set(usernameFields.map(({ key }) => key));
  const secretFields = fields.filter((field) => field.type === "password" && !usernameKeys.has(field.key));
  if (usernameFields.length !== 1 || secretFields.length !== 1) return undefined;
  const context = `${title} ${usernameFields[0].label} ${usernameFields[0].description} ${secretFields[0].label} ${secretFields[0].description}`;
  return {
    usernameField: usernameFields[0],
    secretField: secretFields[0],
    kind: credentialKind(context),
    target: credentialTarget(context),
    label: title.trim() || `${usernameFields[0].label} / ${secretFields[0].label}`,
  };
}

/** Returns only complete groups; an orphan field must never be injected on its own. */
export function collectServerCredentialGroups(metadata: SecretMetadata[], serverId?: string): ServerCredentialGroup[] {
  const grouped = new Map<string, SecretMetadata[]>();
  metadata.forEach((item) => {
    if (!item.credentialGroupId || !item.credentialKind || !item.credentialRole
      || (serverId && item.serverId !== serverId)) return;
    const groupingKey = `${item.serverId ?? ""}::${item.credentialGroupId}`;
    const fields = grouped.get(groupingKey) ?? [];
    fields.push(item);
    grouped.set(groupingKey, fields);
  });
  return [...grouped.values()].flatMap((fields) => {
    const usernames = fields.filter(({ credentialRole }) => credentialRole === "username");
    const secrets = fields.filter(({ credentialRole }) => credentialRole === "secret");
    const username = usernames[0];
    const secret = secrets[0];
    const seed = username ?? secret;
    if (usernames.length !== 1 || secrets.length !== 1 || fields.length !== 2
      || !username || !secret || !seed?.credentialKind || !seed.credentialGroupId) return [];
    if (fields.some((field) => field.serverId !== seed.serverId
      || field.credentialKind !== seed.credentialKind
      || (field.credentialTarget ?? "") !== (seed.credentialTarget ?? ""))) return [];
    return [{
      id: seed.credentialGroupId,
      serverId: seed.serverId,
      kind: seed.credentialKind,
      target: seed.credentialTarget,
      label: seed.credentialLabel || "服务器凭据",
      username,
      secret,
    }];
  });
}

export function findMatchingCredentialGroup(
  metadata: SecretMetadata[],
  scopedSecrets: Record<string, string>,
  pair: CredentialInputPair,
  username: string,
) {
  return collectServerCredentialGroups(metadata)
    .find((group) => group.kind === pair.kind
      && (group.target ?? "") === (pair.target ?? "")
      && scopedSecrets[group.username.key] === username);
}

/** Allocates the same numeric suffix to both fields, preserving older variable keys where possible. */
export function allocateCredentialPairKeys(
  metadata: SecretMetadata[],
  usernameFieldKey: string,
  secretFieldKey: string,
) {
  const used = new Set(metadata.map(({ key }) => key));
  const usernameBase = normalizeCredentialStorageKey(usernameFieldKey) || "USERNAME";
  const secretBase = normalizeCredentialStorageKey(secretFieldKey) || "CREDENTIAL";
  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? "" : `_${index}`;
    const usernameKey = `${usernameBase}${suffix}`;
    const secretKey = `${secretBase}${suffix}`;
    if (!used.has(usernameKey) && !used.has(secretKey)) return { usernameKey, secretKey };
  }
  throw new Error("无法为服务器凭据分配唯一变量名");
}

export function credentialGroupContext(metadata: SecretMetadata[], serverId: string) {
  return collectServerCredentialGroups(metadata, serverId).map((group) => ({
    ref: `server-credential:${group.id}`,
    kind: group.kind,
    target: group.target,
    label: group.label,
    usernamePlaceholder: `\${secret.${group.username.key}}`,
    secretPlaceholder: `\${secret.${group.secret.key}}`,
    instruction: "该凭据组已保存于当前服务器；用途匹配时直接引用，不得再向用户索取真实值。",
  }));
}
