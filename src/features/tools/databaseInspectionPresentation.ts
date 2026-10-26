import type { DatabaseInspectionResult } from "./databaseInspection";

/** Connection matching happens on the private receipt before this function.
 * Returned account names use references, never resolved credential material. */
export function redactDatabaseInspection(result: DatabaseInspectionResult, redact: (value: string) => string) {
  let changed = false;
  if (result.connection && result.request.auth === "password") {
    const reference = `\${secret.${result.request.usernameSecretKey}}`;
    result.connection.sessionUser = reference; result.connection.currentUser = reference;
    // Replacing a protected account with its exact declared reference does not
    // alter the table evidence; redacted definitions below do invalidate reuse.
  }
  const rewrite = (value: string) => {
    const next = redact(value); if (next !== value) changed = true; return next;
  };
  // Observed names are not request identities. Mask the whole identifier when
  // it contains protected material so replacement cannot exceed its 63-char cap.
  const rewriteIdentifier = (value: string) => rewrite(value) === value ? value : "[REDACTED]";
  result.reason = rewrite(result.reason);
  for (const table of result.tables) {
    table.reason = rewrite(table.reason);
    for (const column of table.columns) {
      column.name = rewriteIdentifier(column.name);
      column.type = rewrite(column.type);
      column.identity = rewrite(column.identity);
      column.generated = rewrite(column.generated);
      if (column.default !== null) column.default = rewrite(column.default);
      if (column.collation !== null) column.collation = rewrite(column.collation);
    }
    for (const constraint of table.constraints) {
      constraint.name = rewriteIdentifier(constraint.name);
      constraint.type = rewrite(constraint.type);
      constraint.definition = rewrite(constraint.definition);
    }
    for (const index of table.indexes) {
      index.name = rewriteIdentifier(index.name);
      index.definition = rewrite(index.definition);
    }
  }
  if (changed) result.observationsRedacted = true;
  return result;
}

export function databaseInspectionEvidenceFacts(result: DatabaseInspectionResult) {
  const complete = result.coverageComplete && !result.truncated && result.connectionVerified && result.observationsRedacted !== true;
  return { evidenceKind: "database_inspection" as const, evidenceScope: JSON.stringify(result.request), evidenceComplete: complete,
    inspectionStatus: result.status,
    connectionVerified: result.connectionVerified, database: result.request.database,
    inspectedTables: result.tables.map(table => ({ schema: table.schema, name: table.name, status: table.status,
      ...(complete ? { rowCount: table.rowCount, dataSha256: table.dataSha256, structureSha256: table.structureSha256 } : {}) })),
    snapshotScope: result.snapshotScope, limitations: result.limitations, restoreVerified: false, sourceUnchangedVerified: false };
}
