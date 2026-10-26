import { describe, expect, it, vi } from "vitest";
import { authenticationBlocker, authenticationContext, authenticationFingerprint, describeAuthentication, recordAuthentication } from "./authenticationEvidence";
import type { OpsTask, PlanStep, SecretMetadata } from "@/types";

const command = "psql -X -w -h '/Run/Database socket' -p 15432 -U reader -d orders -v ON_ERROR_STOP=1 -P pager=off -c 'SELECT count(*) FROM public.orders;'";
const step: PlanStep = { id: "query", title: "读取业务结果", description: "只读", command, validation: "", kind: "observe", risk: "low", expected: "真实查询", status: "pending" };
const taskFixture = (): OpsTask => ({ id: "database-task", serverId: "server", title: "数据库查询", status: "running", modelId: "m", permission: "managed", plan: [], messages: [], createdAt: "now", updatedAt: "now", currentRoundId: "round", agentSessionId: "session", agentSessionGeneration: 7, credentialRevision: 3 });
const approve = (task: OpsTask, candidate: PlanStep) => ({ ...candidate, authenticationGate: { approved: true, reason: "用户确认本次身份与方式", fingerprint: authenticationFingerprint(task, candidate) } });

describe("B03 数据库连接证据实际复用边界", () => {
  it("psql socket目录与端口、数据库、长用户名参数构成准确连接身份", () => {
    expect(describeAuthentication(command)).toMatchObject({ target: "/Run/Database socket", transport: "socket", port: 15432, database: "orders", evidenceVersion: 2 });
    expect(describeAuthentication(command.replace("-U reader", "--username=reader"))).toMatchObject({ accountRef: describeAuthentication(command)!.accountRef });
    expect(describeAuthentication(command.replace("-p 15432", "-p 15433"))).not.toMatchObject({ port: 15432 });
  });

  it("已确认peer方式只在真实连接成功后复用同一作用域，读取连接说明无效", () => {
    const task = taskFixture();
    const manual = { ...step, command: "sed -n '1,20p' /opt/数据库交接.md" };
    expect(recordAuthentication(task, manual, [], { output: "psql socket reader", success: true, exitCode: 0 }, "main", "handoff")).toBeUndefined();
    expect(authenticationBlocker(task, step, [])).toContain("确认");
    recordAuthentication(task, approve(task, step), [], { output: "4", success: true, exitCode: 0 }, "main", "query-success");
    expect(authenticationBlocker(task, { ...step, command: command.replace("count(*)", "count(id)") }, [])).toBeUndefined();
    expect(authenticationContext(task).attempts).toHaveLength(1);
  });

  it("不会从成功退出但未确认的peer来源推断重复使用许可", () => {
    const task = taskFixture();
    recordAuthentication(task, step, [], { output: "4", success: true, exitCode: 0 }, "main", "unconfirmed");
    expect(authenticationBlocker(task, step, [])).toContain("确认");
  });

  it("已确认peer证据不跨库、端口、账户、主机、会话或凭据版本", () => {
    const task = taskFixture();
    recordAuthentication(task, approve(task, step), [], { output: "4", success: true, exitCode: 0 }, "main", "success");
    for (const candidate of [command.replace("-d orders", "-d restored"), command.replace("15432", "15433"), command.replace("-U reader", "-U admin"), command.replace("/Run/Database socket", "/Other/socket")]) {
      expect(authenticationBlocker(task, { ...step, command: candidate }, [])).toBeDefined();
    }
    for (const change of [{ credentialRevision: 4 }, { agentSessionId: "new" }, { agentSessionGeneration: 8 }, { serverId: "other" }, { id: "other-task" }]) {
      expect(authenticationBlocker({ ...task, ...change }, step, [])).toBeDefined();
    }
  });

  it("PGOPTIONS只读前缀不再丢失真实客户端，但不能从env补目标身份", () => {
    expect(describeAuthentication("PGOPTIONS='-c default_transaction_read_only=on' " + command)).toMatchObject({ database: "orders", transport: "socket" });
    for (const prefix of ["PGHOST=/other ", "PGPORT=5433 ", "PGSERVICE=other ", "PGOPTIONS='-c role=admin' "]) {
      expect(describeAuthentication(prefix + command)).toBeUndefined();
    }
  });

  it.each([
    command + " -c '\\connect other'",
    command.replace("-d orders", "-d 'host=other dbname=orders'"),
    command.replace("-h '/Run/Database socket'", "-h first,second"),
    command.replace("-X ", ""),
    command + " --help",
    command + " --file=/tmp/query.sql",
    command + " --host=other",
  ])("歧义客户端不能被当作同一连接：%s", value => expect(describeAuthentication(value)).toBeUndefined());

  it("过期、未知退出与后续认证拒绝都会阻止peer成功复用", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
      const task = taskFixture();
      recordAuthentication(task, approve(task, step), [], { output: "4", success: true, exitCode: 0 }, "main", "ok");
      vi.setSystemTime(new Date("2026-10-12T10:31:00Z"));
      expect(authenticationBlocker(task, step, [])).toBeDefined();
      recordAuthentication(task, approve(task, step), [], { output: "partial", success: true }, "main", "unknown");
      expect(authenticationBlocker(task, step, [])).toBeDefined();
      recordAuthentication(task, approve(task, step), [], { output: "password authentication failed", success: false, exitCode: 2 }, "main", "denied");
      expect(authenticationBlocker(task, step, [])).toContain("不能自动重复");
    } finally { vi.useRealTimers(); }
  });

  it("metadata的旧凭据版本成功不能绕过新版本的目标限制", () => {
    const task = taskFixture();
    const mysql = { ...step, command: 'mysql --socket=/run/mysql.sock -u "${secret.DB_USER}" -p"${secret.DB_PASSWORD}" -e "SELECT 1;"' };
    const metadata: SecretMetadata[] = ["DB_USER", "DB_PASSWORD"].map((key, i) => ({ key, description: "数据库凭据", serverId: "server", scope: "server", credentialGroupId: "g", credentialKind: "database", credentialRole: i ? "secret" : "username", credentialTarget: "db.invalid:3306" }));
    recordAuthentication(task, mysql, metadata, { output: "1", success: true, exitCode: 0 }, "main", "prior");
    expect(authenticationBlocker({ ...task, credentialRevision: 4, authenticationEvidence: [] }, mysql, metadata)).toContain("端点不同");
  });

  it("旧证据和缺执行会话身份的证据不能升级为可复用连接", () => {
    const task = taskFixture();
    recordAuthentication(task, approve(task, step), [], { output: "4", success: true, exitCode: 0 }, "main", "legacy");
    delete task.authenticationEvidence![0].evidenceVersion;
    expect(authenticationBlocker(task, step, [])).toBeDefined();
    task.authenticationEvidence![0].evidenceVersion = 2;
    task.agentSessionId = undefined;
    task.authenticationEvidence![0].agentSessionId = undefined;
    expect(authenticationBlocker(task, step, [])).toBeDefined();
    expect(authenticationContext(task).reusableConnections).toEqual([]);
  });

  it("凭据版本改变后的迟到成功仍归属于原执行版本", () => {
    const task = taskFixture();
    const approved = approve(task, { ...step, authenticationAttempt: { channel: "noninteractive", credentialRevision: 3 } });
    task.credentialRevision = 4;
    const evidence = recordAuthentication(task, approved, [], { output: "4", success: true, exitCode: 0 }, "main", "late");
    expect(evidence?.credentialRevision).toBe(3);
    expect(authenticationContext(task).reusableConnections).toEqual([]);
    expect(authenticationBlocker(task, step, [])).toBeDefined();
  });

  it("不明脚本与引号包裹客户端不能因为当前没有凭据就绕过确认", () => {
    const task = taskFixture();
    for (const value of ["'/opt/bin/psql' -X -w -f /tmp/script.sql", 'PGHOST=other psql -c "SELECT 1"', "psql -X -w -c 'SELECT 1' && echo ok"]) {
      expect(authenticationBlocker(task, { ...step, command: value }, [])).toContain("无法可靠解析");
    }
  });
});
