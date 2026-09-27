import { operationsOutputSchemas } from "./operationsContracts";
import { fullSchemaPattern, schemaNonWhitespace } from "./toolSchemaPatterns";
/** Compiled adapter contracts. Remote configuration cannot widen these outputs. */
const text = { type: "string" };
const nonempty = { type: "string", minLength: 1 };
const flag = { type: "boolean" };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const path = { type: "string", pattern: fullSchemaPattern("/[^\\u0000]*"), maxLength: 4096 };
const port = { type: "integer", minimum: 1, maximum: 65535 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const schemas: Record<string, Record<string, unknown>> = {
  ...operationsOutputSchemas,
  "context.expand": object({ skillId: nonempty }),
  "evidence.read": object({
    evidenceId: { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") }, historical: { const: true },
    // Historical metadata is intentionally extensible; it never proves live remote state.
    metadata: { type: "object" }, text, offset: count, totalCharacters: count,
    nextOffset: { anyOf: [count, { type: "null" }] }, instruction: nonempty,
  }),
  "server.resolve_connection": {
    ...object({ found: flag, serverId: nonempty, host: nonempty, port, username: nonempty,
      credentialAvailable: flag, credentialRef: { type: "string", pattern: fullSchemaPattern(`(managed-server|server-credential):${schemaNonWhitespace}+`) },
    }, ["found", "host", "port", "credentialAvailable"]),
    if: { properties: { credentialAvailable: { const: true } }, required: ["credentialAvailable"] },
    then: { required: ["credentialRef"], properties: { found: { const: true } } },
    else: { not: { required: ["credentialRef"] } },
  },
  "server.connect": object({ serverId: nonempty, name: nonempty, host: nonempty, port,
    username: nonempty, connected: { const: true },
    // Informational metadata only; connection success comes from connected=true.
    info: { type: "object" },
  }),
  "user.request_input": object({ title: nonempty, values: {
    type: "object", propertyNames: { pattern: fullSchemaPattern("[A-Za-z][A-Za-z0-9_]*") },
    additionalProperties: { anyOf: [text, { type: "number" }] },
  } }),
  "files.get_structure": {
    ...object({ rootPath: path, pathStatus: { type: "string", enum: ["directory", "missing"] },
      tree: text, truncated: flag, warnings: { type: "array", items: text },
    }, ["rootPath", "tree", "truncated", "warnings"]),
    if: { properties: { pathStatus: { const: "missing" } }, required: ["pathStatus"] },
    then: { properties: { tree: { const: "" }, truncated: { const: false }, warnings: { type: "array", maxItems: 0 } } },
    else: { properties: { tree: nonempty } },
  },
  "files.read_content": object({ path, content: text, totalBytes: count, returnedBytes: count,
    truncated: flag, encoding: { const: "utf-8" },
  }),
  "software.check": object({ items: { type: "array", minItems: 1, maxItems: 20, items: {
    ...object({ name: { type: "string", pattern: fullSchemaPattern("[A-Za-z0-9+._-]+") }, installed: flag, path, version: text }, ["name", "installed"]),
    if: { properties: { installed: { const: true } }, required: ["installed"] },
    then: { required: ["path"] }, else: { not: { required: ["path"] } },
  } } }),
  "files.transfer_between_servers": object({ sourcePath: path, targetPath: path, transferredBytes: count,
    sha256: { type: "string", pattern: fullSchemaPattern("[a-f0-9]{64}") }, targetServerId: nonempty,
  }),
};
export const toolOutputSchemas = Object.fromEntries(Object.entries(schemas).map(([id, schema]) =>
  [id, { $schema: "http://json-schema.org/draft-07/schema#", ...schema }])) as Record<string, Record<string, unknown>>;

export const serverConnectPartialSchema = object({
  ...Object.fromEntries(["connectionCheckDispatched", "connectionChecked", "directoryUpdated", "connected", "taskTargetUpdated",
    "agentSessionPrepared", "agentSessionCreationDispatched", "credentialStorageDispatched", "credentialStored"].map(key => [key, flag])),
  serverId: { type: "string", pattern: fullSchemaPattern("[A-Za-z0-9_-]{1,128}") },
}, []);

/** Generic envelopes are checked independently of each tool's business result. */
export const toolResultSchema: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...object({ callId: nonempty, toolId: nonempty, success: flag, data: { type: "object" },
    error: object({ code: nonempty, message: text,
      category: { type: "string", enum: ["arguments", "unavailable", "authentication", "permission", "network", "timeout", "rate_limit", "business", "output"] },
      dispatchState: { type: "string", enum: ["not_sent", "sent", "unknown"] }, argumentPath: text,
      retryAfterMs: { type: "number", minimum: 0 },
    }, ["code", "message"]),
    truncated: flag,
    attempts: { type: "array", items: object({ number: { type: "integer", minimum: 1 }, code: text,
      category: text, dispatchState: { type: "string", enum: ["not_sent", "sent", "unknown"] },
    }, ["number"]) },
  }, ["callId", "toolId", "success"]),
  oneOf: [
    { properties: { success: { const: true } }, required: ["data"], not: { required: ["error"] } },
    { properties: { success: { const: false } }, required: ["error"], anyOf: [
      { not: { required: ["data"] } },
      { properties: { toolId: { const: "server.connect" }, data: serverConnectPartialSchema } },
    ] },
  ],
};
