// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import { i18n } from "@/features/preferences/i18n";
import MetricsBar from "./MetricsBar.vue";

let app: App | undefined;
let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "zh-CN";
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { app?.unmount(); app = undefined; host.remove(); vi.restoreAllMocks(); });

function setup(server: string | undefined = "alpha") {
  const pinia = createPinia();
  const ops = useOpsStore(pinia);
  const serverId = ref<string | undefined>(server);
  app = createApp(defineComponent(() => () => h(MetricsBar, { serverId: serverId.value })));
  app.use(pinia).use(i18n).mount(host);
  return { ops, serverId };
}

function putSample(ops: ReturnType<typeof useOpsStore>, serverId: string, cpu: number) {
  const sampledAt = new Date().toISOString();
  ops.metricsByServer[serverId] = {
    sample: { cpu, memory: 41, disk: 58, networkIn: 0, networkOut: 1.5, sampledAt },
    loading: false, stale: false, requestVersion: 1, lastAttemptAt: Date.now(),
  };
  ops.serverConnection(serverId).status = "connected";
  return sampledAt;
}

describe("MetricsBar server ownership and sample validity", () => {
  it("shows em dashes while offline with no sample, without fabricating a time or zero", async () => {
    setup();
    await nextTick();
    expect([...host.querySelectorAll("strong")].map(item => item.textContent)).toEqual(["—", "—", "—", "—", "—"]);
    expect(host.textContent).toContain("尚未连接 · 无指标数据");
    expect(host.textContent).not.toContain("最后更新");
    expect(host.textContent).not.toContain("Invalid Date");
    expect(host.querySelector(".metrics-empty")).not.toBeNull();
  });

  it("selects the current server sample and never shows another server's retained values", async () => {
    const { ops, serverId } = setup();
    putSample(ops, "alpha", 12);
    putSample(ops, "beta", 83);
    await nextTick();
    expect(host.querySelector(".metric strong")?.textContent).toBe("12%");
    serverId.value = "beta";
    await nextTick();
    expect(host.querySelector(".metric strong")?.textContent).toBe("83%");
    serverId.value = "uncached";
    await nextTick();
    expect(host.querySelector(".metric strong")?.textContent).toBe("—");
    expect(host.textContent).not.toContain("83%");
    serverId.value = undefined;
    await nextTick();
    expect(host.querySelector(".metric strong")?.textContent).toBe("—");
  });

  it("retains the actual last sample time when offline or collection fails", async () => {
    const { ops } = setup();
    putSample(ops, "alpha", 0);
    await nextTick();
    expect(host.querySelector(".metric strong")?.textContent).toBe("0%");
    expect(host.querySelector(".metrics-paused")).toBeNull();
    const timestamp = host.querySelector(".metrics-time > span:nth-child(3)")?.textContent;
    ops.serverConnection("alpha").status = "manual";
    await nextTick();
    expect(host.textContent).toContain("采集已暂停");
    expect(host.textContent).toContain("过期样本");
    expect(host.querySelector(".metrics-time > span:nth-child(3)")?.textContent).toBe(timestamp);
    expect(host.querySelector(".metric strong")?.textContent).toBe("0%");
    ops.serverConnection("alpha").status = "connected";
    ops.metricsByServer.alpha.error = "指标命令执行失败";
    await nextTick();
    expect(host.textContent).toContain("采集已暂停");
    expect(host.querySelector("footer")?.title).toBe("指标命令执行失败");
    expect(host.querySelector(".metrics-time > span:nth-child(3)")?.textContent).toBe(timestamp);
  });

  it("marks aged samples stale until a new server sample arrives", async () => {
    const { ops } = setup();
    const sampledAt = putSample(ops, "alpha", 12);
    ops.connectionClock = Date.parse(sampledAt) + 31_000;
    await nextTick();
    expect(host.textContent).toContain("采集已暂停");
    ops.metricsByServer.alpha.sample!.sampledAt = new Date(ops.connectionClock).toISOString();
    await nextTick();
    expect(host.textContent).not.toContain("采集已暂停");
    expect(host.querySelector(".metrics-stale")).toBeNull();
  });
});
