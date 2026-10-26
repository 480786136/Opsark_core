import { afterEach, describe, expect, it } from "vitest";
import {
  getHostCapabilities, hostCapabilityContext, invalidateHostCapabilities, parseOperationsCapabilities,
  recordHostCapabilities, type HostCapabilityIdentity, type OperationsCapabilities,
  hostCapabilityEpoch, hostCapabilityContextForServer,
} from "./hostCapabilities";

const identity: HostCapabilityIdentity = { serverId: "a", host: "first.example", port: 22, username: "ops", connectionGeneration: 1 };
const facts: OperationsCapabilities = { version: 1, observedAt: "2099-01-01T00:00:00Z", facts: [
  { name: "python.runtime", supported: true, version: "3.6.8", executable: "/usr/bin/python3" },
  { name: "python.json", supported: true }, { name: "systemctl", supported: true },
  { name: "jq", supported: false }, { name: "ss", supported: false }, { name: "netstat", supported: true },
] };
afterEach(() => { invalidateHostCapabilities("a"); invalidateHostCapabilities("b"); });

describe("实际主机能力事实", () => {
  it("只接受唯一有界的原生报告，旧输出不伪造能力", () => {
    expect(parseOperationsCapabilities("OPSARK_RESULT {}\n")).toBeUndefined();
    const line = "OPSARK_CAPABILITIES " + JSON.stringify(facts);
    expect(parseOperationsCapabilities(line)).toEqual(facts);
    expect(() => parseOperationsCapabilities(line + "\n" + line)).toThrow();
    expect(() => parseOperationsCapabilities("OPSARK_CAPABILITIES " + JSON.stringify({ ...facts, facts: [{ name: "unknown", supported: true }] }))).toThrow();
    expect(() => parseOperationsCapabilities("OPSARK_CAPABILITIES " + JSON.stringify({ ...facts, facts: [facts.facts[0], facts.facts[0]] }))).toThrow();
    expect(() => parseOperationsCapabilities("OPSARK_CAPABILITIES " + JSON.stringify({ ...facts, facts: [{ name: "jq", supported: "yes" }] }))).toThrow();
  });

  it("主机、用户、端口、连接代次隔离，重连淘汰旧事实", () => {
    recordHostCapabilities(identity, facts, { toolCallId: "native-call-1" }, 1000);
    expect(getHostCapabilities(identity, 1001)?.source.toolCallId).toBe("native-call-1");
    for (const change of [{ host: "second.example" }, { username: "root" }, { port: 2222 }, { connectionGeneration: 2 }, { serverId: "b" }]) {
      expect(getHostCapabilities({ ...identity, ...change }, 1001)).toBeUndefined();
    }
    const next = { ...identity, connectionGeneration: 2 };
    recordHostCapabilities(next, facts, { toolCallId: "native-call-2" }, 1002);
    expect(getHostCapabilities(identity, 1003)).toBeUndefined();
    expect(getHostCapabilities(next, 1003)?.source.toolCallId).toBe("native-call-2");
  });

  it("本地TTL不受远端未来时间影响，写入失效不污染其他服务器", () => {
    recordHostCapabilities(identity, facts, { toolCallId: "a" }, 1000);
    recordHostCapabilities({ ...identity, serverId: "b" }, facts, { toolCallId: "b" }, 1000);
    const returned = getHostCapabilities(identity, 1001)!; returned.facts[0].supported = false;
    expect(getHostCapabilities(identity, 1002)!.facts[0].supported).toBe(true);
    invalidateHostCapabilities("a");
    expect(getHostCapabilities(identity, 1003)).toBeUndefined();
    expect(getHostCapabilities({ ...identity, serverId: "b" }, 300999)).toBeDefined();
    expect(getHostCapabilities({ ...identity, serverId: "b" }, 301000)).toBeUndefined();
  });

  it("只依据实测事实提供已存在替代，不推断--value支持或安装完成", () => {
    recordHostCapabilities(identity, facts, { toolCallId: "native-call" }, 1000);
    const context = hostCapabilityContext(identity, 1001)!;
    expect(context.alternatives.join("\n")).toContain("不需要--value");
    expect(context.alternatives.join("\n")).toContain("netstat");
    expect(context.alternatives.join("\n")).toContain("不重复jq");
    expect(context.instruction).toContain("不是软件安装完成或业务健康证据");
    expect(context.facts.find(fact => fact.name === "systemctl.show.properties")).toBeUndefined();
  });

  it("变更失效后的迟到探针不能重新写回旧事实，端点投影不跨主机", () => {
    const epoch = hostCapabilityEpoch(identity.serverId);
    invalidateHostCapabilities(identity.serverId);
    expect(recordHostCapabilities(identity, facts, { toolCallId: "late", epoch }, 1000)).toBeUndefined();
    recordHostCapabilities(identity, facts, { toolCallId: "fresh", epoch: hostCapabilityEpoch(identity.serverId) }, 1001);
    const server = { id: identity.serverId, host: identity.host, port: identity.port, username: identity.username };
    expect(hostCapabilityContextForServer(server, 1002)?.source.toolCallId).toBe("fresh");
    expect(hostCapabilityContextForServer({ ...server, host: "changed.example" }, 1002)).toBeUndefined();
  });
});
