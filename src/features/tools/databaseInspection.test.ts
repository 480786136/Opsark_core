import { describe, expect, it } from "vitest";
import { describeAuthentication } from "../agent/authenticationEvidence";
import { buildDatabaseAuthenticationCommand, buildDatabaseInspectionCommand, databaseInspectionResultIssue, normalizeDatabaseInspectionRequest, parseDatabaseInspectionOutput, type DatabaseInspectionResult } from "./databaseInspection";
import { DATABASE_INSPECTION_LIMITATIONS } from "./databaseInspectionContracts";

const input = () => ({ clientPath: "/opt/pg/bin/psql", transport: "socket", host: "/run/pg", port: 15432, database: "orders", auth: "socket_identity", username: "reader", tables: [{ schema: "public", name: "orders" }] });
const request = () => normalizeDatabaseInspectionRequest(input());
function receipt(): DatabaseInspectionResult {
  return { version: 1, request: request(), status: "complete", reason: "", coverageComplete: true, truncated: false, connectionVerified: true,
    connection: { requestedHost: "/run/pg", transport: "socket", port: 15432, database: "orders", sessionUser: "reader", currentUser: "reader", serverAddress: null, tls: false,
      serverVersionNum: 160004, readOnly: true, isolation: "repeatable read", snapshot: "3:3:", observedAt: "2026-10-12T00:00:00.000Z" },
    tables: [{ schema: "public", name: "orders", status: "complete", reason: "", rowCount: 0, dataSha256: "a".repeat(64), dataBytes: 0,
      columns: [{ name: "id", type: "integer", nullable: false, default: null, identity: "", generated: "", collation: null }], constraints: [], indexes: [], structureSha256: "b".repeat(64) }],
    snapshotScope: "single_database", limitations: [...DATABASE_INSPECTION_LIMITATIONS], readBytes: 1800, elapsedMs: 10 };
}
const encoded = (result: DatabaseInspectionResult) => "OPSARK_POSTGRES_RESULT " + JSON.stringify(result);

describe("PostgreSQL explicit bounded inspection", () => {
  it("builds a public authentication descriptor for the same complete connection", () => {
    const command = buildDatabaseAuthenticationCommand(input());
    expect(describeAuthentication(command)).toMatchObject({ client: "psql", target: "/run/pg", transport: "socket", port: 15432, database: "orders", authenticationMethod: "confirmed_socket_identity" });
    const passwordInput = { ...input(), auth: "password", username: undefined, usernameSecretKey: "PG_READER", passwordSecretKey: "PG_PASSWORD" };
    delete passwordInput.username;
    expect(describeAuthentication(buildDatabaseAuthenticationCommand(passwordInput))).toMatchObject({ credentialKeys: ["PG_PASSWORD", "PG_READER"], accountRef: "PG_READER", authenticationMethod: "tracked_secret" });
  });
  it("preserves quoted Chinese table identifiers and safely quotes private credentials", () => {
    const value = { ...input(), auth: "password", usernameSecretKey: "PG_USER", passwordSecretKey: "PG_PASS", tables: [{ schema: "public", name: '中 文"表' }] };
    delete (value as Partial<typeof value>).username;
    const command = buildDatabaseInspectionCommand(value, { username: "read'er", password: "a'$(touch /tmp/forbidden)\npass" });
    expect(command).toContain("'read'\"'\"'er'");
    expect(command).toContain("'a'\"'\"'$(touch /tmp/forbidden)\npass'");
    expect(buildDatabaseAuthenticationCommand(value)).not.toContain("touch");
    expect(normalizeDatabaseInspectionRequest(value).tables[0].name).toBe('中 文"表');
  });
  it.each([
    { database: "host=other dbname=orders" }, { database: "postgresql://other/orders" }, { host: "/run/../pg" }, { host: "/run/pg\n\\connect evil" },
    { clientPath: "psql" }, { sql: "SELECT 1" }, { tables: [{ schema: "public", name: "a\\gexec" }] },
    { tables: [{ schema: "public", name: "中".repeat(22) }] }, { maxRowsPerTable: 10001 }, { maxDataBytes: 16777217 }, { timeoutSeconds: 0 },
    { auth: "password", usernameSecretKey: "PG_USER", passwordSecretKey: "PG_USER" }, { transport: "tcp", host: "db.example" },
    { transport: "tcp", host: "db.example", sslRootCertPath: "/etc/ca.crt" },
  ])("rejects ambiguous or unauthorized request %j", patch => {
    expect(() => normalizeDatabaseInspectionRequest({ ...input(), ...patch })).toThrow();
  });
  it("requires exact private socket identity and actual password material", () => {
    expect(() => buildDatabaseInspectionCommand(input(), { username: "other" })).toThrow();
    const value = { ...input(), auth: "password", usernameSecretKey: "PG_USER", passwordSecretKey: "PG_PASS" };
    delete (value as Partial<typeof value>).username;
    expect(() => buildDatabaseInspectionCommand(value, { username: "reader" })).toThrow();
  });
  it("accepts a complete per-table receipt without claiming cross-database atomicity", () => {
    const value = receipt();
    expect(parseDatabaseInspectionOutput(encoded(value), input())).toEqual(value);
    expect(value.limitations).toContain("not_restore_acceptance");
    expect(value.limitations).toContain("not_cross_database_atomic");
  });
  it.each(["scope", "account", "port", "tls", "table", "missing_digest", "missing_columns", "truncated", "row_limit", "missing_limitation"])("rejects contradictory receipt: %s", mutation => {
    const value = receipt();
    if (mutation === "scope") value.request.database = "other";
    if (mutation === "account") value.connection!.currentUser = "other";
    if (mutation === "port") value.connection!.port++;
    if (mutation === "tls") value.connection!.tls = true;
    if (mutation === "table") value.tables[0].name = "other";
    if (mutation === "missing_digest") value.tables[0].dataSha256 = null;
    if (mutation === "missing_columns") value.tables[0].columns = [];
    if (mutation === "truncated") value.truncated = true;
    if (mutation === "row_limit") value.tables[0].rowCount = 1001;
    if (mutation === "missing_limitation") value.limitations.pop();
    expect(() => parseDatabaseInspectionOutput(encoded(value), input())).toThrow();
  });
  it("keeps a failed later query unknown even when connection was verified", () => {
    const value = receipt();
    Object.assign(value, { status: "error", reason: "client_or_query_failed", coverageComplete: false, truncated: true, tables: [] });
    expect(parseDatabaseInspectionOutput(encoded(value), input()).connectionVerified).toBe(true);
    expect(databaseInspectionResultIssue(input(), value)).toBeUndefined();
  });
  it("does not accept duplicated receipts or raw rows in place of a digest", () => {
    const value = receipt();
    expect(() => parseDatabaseInspectionOutput(encoded(value) + "\n" + encoded(value), input())).toThrow();
    expect(() => parseDatabaseInspectionOutput(encoded({ ...value, rows: ["secret"] } as DatabaseInspectionResult), input())).toThrow();
    expect(() => parseDatabaseInspectionOutput(encoded({ ...value, observationsRedacted: true }), input())).toThrow();
  });
});
