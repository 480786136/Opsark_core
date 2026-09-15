import { describe, expect, it } from "vitest";
import { authenticationBlocker, classifyAuthenticationFailure, describeAuthentication, recordAuthentication } from "./authenticationEvidence";
import { normalizeAuthenticationTarget } from "./authenticationTarget";
import { credentialGroupContext } from "./serverCredentialGroup";
import type { OpsTask, PlanStep, SecretMetadata } from "@/types";

const command = 'mysql --protocol=TCP -h db.internal -P 3306 -u "${secret.DB_USER}" -p"${secret.DB_PASSWORD}" -e "SHOW DATABASES;"';
const step: PlanStep = { id: "s", title: "查询", description: "只读", command, validation: "", kind: "observe", risk: "low", expected: "结果", status: "pending" };
function fixture() {
  const task: OpsTask = { id: "t", serverId: "srv", title: "检查", status: "running", modelId: "m", permission: "managed", plan: [step], messages: [], createdAt: "now", updatedAt: "now" };
  const metadata: SecretMetadata[] = ["username", "secret"].map((role, i) => ({
    key: i ? "DB_PASSWORD" : "DB_USER", description: "凭据", scope: "server", serverId: "srv",
    credentialGroupId: "g", credentialKind: "database", credentialRole: role as "username" | "secret", credentialTarget: "db.internal:3306",
  }));
  return { task, metadata };
}

describe("authentication evidence", () => {
  it.each([
    ["Host 'client' is not allowed to connect", "route_rejected"],
    ["Access denied for user 'root' (using password: NO)", "material_missing"],
    ["Access denied for user 'root' (using password: YES)", "authentication_rejected"],
    ["SELECT command denied to user", "permission_denied"],
    ["connection refused", "connection_failed"],
  ])("distinguishes stage: %s", (output, stage) => expect(classifyAuthenticationFailure(output)).toBe(stage));

  it("preserves socket case and spaces but rejects unsafe target expressions", () => {
    expect(normalizeAuthenticationTarget("database", "/Run/My DB/mysql.sock")).toBe("/Run/My DB/mysql.sock");
    expect(normalizeAuthenticationTarget("database", "DB.Internal:3306")).toBe("db.internal:3306");
    for (const target of ["/tmp/../db.sock", "/tmp/*.sock", "/tmp/${SOCKET}", "https://user:pass@host", "/tmp/a\nb"]) {
      expect(() => normalizeAuthenticationTarget("database", target)).toThrow();
    }
    expect(() => normalizeAuthenticationTarget("ssh-password", "/run/socket")).toThrow();
  });

  it("only describes actual simple client invocations, never path mentions or compound scripts", () => {
    expect(describeAuthentication(command)).toMatchObject({ target: "db.internal:3306", materialProvided: true, credentialKeys: ["DB_PASSWORD", "DB_USER"] });
    expect(describeAuthentication('ls /var/lib/mysql/mysql.sock')).toBeUndefined();
    expect(describeAuthentication(`${command} && echo ok`)).toBeUndefined();
    expect(describeAuthentication('mysql --version')).toBeUndefined();
    expect(describeAuthentication(`${command} -h other.internal`)).toBeUndefined();
    expect(describeAuthentication(command.replace("--protocol=TCP", "--protocol=SOCKET"))).toBeUndefined();
    expect(describeAuthentication(command.replace("mysql ", "mysql --defaults-file=/tmp/client.conf "))).toBeUndefined();
  });

  it("preserves known credentials after route failure; blocks retry, identity and passwordless switches", () => {
    const { task, metadata } = fixture();
    expect(authenticationBlocker(task, step, metadata)).toBeUndefined();
    recordAuthentication(task, step, metadata, { success: false, exitCode: 1, output: "Host 'client' is not allowed to connect" }, "main", "e");
    expect(task.authenticationEvidence?.[0].outcome).toBe("route_rejected");
    expect(authenticationBlocker(task, step, metadata)).toContain("不能自动重复");
    expect(authenticationBlocker(task, { ...step, command: 'mysql --socket=/run/mysql.sock -u root -e "SHOW DATABASES;"' }, metadata)).toContain("免密");
    expect(authenticationBlocker(task, { ...step, command: command.replace("db.internal", "other.internal") }, metadata)).toContain("端点不同");
  });

  it("stores only scoped credential references, reuses a proven route, and expires it", () => {
    const { task, metadata } = fixture();
    const socketStep = { ...step, command: command.replace("--protocol=TCP -h db.internal -P 3306", "--socket=/Run/MySQL.sock") };
    expect(authenticationBlocker(task, socketStep, metadata)).toContain("端点不同");
    recordAuthentication(task, socketStep, metadata, { success: true, exitCode: 0, output: "Database\na" }, "main", "e");
    expect(credentialGroupContext(metadata, "srv")[0].recentAuthentication).toHaveLength(1);
    const next = { ...task, authenticationEvidence: [] };
    expect(authenticationBlocker(next, socketStep, metadata)).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("Database");
    metadata.forEach(m => m.authenticationEvidence!.forEach(e => { e.createdAt = "2000-01-01T00:00:00Z"; }));
    expect(authenticationBlocker(next, socketStep, metadata)).toContain("端点不同");
    expect(authenticationBlocker({ ...next, serverId: "other" }, socketStep, metadata)).toBeUndefined();
  });
  it("rejects stale approval fingerprints after command, round, target, session or credential changes", async () => {
    const { authenticationFingerprint } = await import("./authenticationEvidence");
    const { task } = fixture();
    const initial = authenticationFingerprint(task, step);
    for (const patch of [{ currentRoundId: "new" }, { executionTargetServerId: "other" },
      { agentSessionId: "new" }, { agentSessionGeneration: 2 }, { credentialRevision: 1 }]) {
      expect(authenticationFingerprint({ ...task, ...patch }, step)).not.toBe(initial);
    }
    expect(authenticationFingerprint(task, { ...step, command: `${command} --skip-column-names` })).not.toBe(initial);
  });
});
