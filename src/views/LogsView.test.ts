// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import LogsView from "./LogsView.vue";

const { queryTaskLogsMock } = vi.hoisted(() => ({ queryTaskLogsMock: vi.fn() }));

vi.mock("@/services/backend", async () => {
  const actual = await vi.importActual<typeof import("@/services/backend")>("@/services/backend");
  return { ...actual, backend: { ...actual.backend, queryTaskLogs: queryTaskLogsMock } };
});

async function flushView() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function chooseParameterOption(host: HTMLElement, ariaLabel: string, value: string) {
  const trigger = host.querySelector<HTMLElement>(`.parameter-select summary[aria-label="${ariaLabel}"]`);
  expect(trigger).not.toBeNull();
  trigger!.click();
  await nextTick();
  const option = [...document.querySelectorAll<HTMLButtonElement>(".parameter-options [role='option']")]
    .find((candidate) => candidate.dataset.value === value);
  expect(option).not.toBeUndefined();
  option!.click();
  await nextTick();
}

describe("LogsView", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    queryTaskLogsMock.mockReset();
    queryTaskLogsMock.mockResolvedValue(null);
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("switches from audit logs to complete developer diagnostics", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.addDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "需求处理模型调用失败",
      summary: "模型响应缺少需求理解结果",
      trace: { attempts: [{ attempt: 1, response: { choices: [] } }] },
    });
    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("操作日志");
    expect(host.querySelector(".developer-log-panel")).toBeNull();

    host.querySelectorAll<HTMLButtonElement>(".log-mode-tabs button")[1].click();
    await nextTick();

    expect(host.textContent).toContain("开发者日志");
    expect(host.querySelector(".developer-log-panel")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("需求处理模型调用失败");
    app.unmount();
  });

  it("旧协议详情在操作日志中使用中性提示，开发者日志仍保留原始诊断", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const diagnostic = "PlanProtocolError: OBSERVE_COMMAND_MUTATION / steps[3].command / PROTOCOL_REPAIR_SCOPE_VIOLATION";
    const legacyAuditDetail = JSON.stringify({
      originalError: "RECOVERY_DIAGNOSE_MUTATION",
      repairError: "确定性拆分后的步骤仍需调整",
      fieldPath: "steps[3].command",
    });
    store.logs = [{
      id: "legacy-protocol-audit",
      category: "model",
      level: "error",
      title: "计划协议修复失败（未执行）",
      detail: legacyAuditDetail,
      serverId: "srv-protocol",
      serverName: "协议测试服务器",
      taskId: "task-protocol",
      taskTitle: "检查运行状态",
      createdAt: "2026-09-17T00:00:00.000Z",
    }];
    store.addDeveloperLog({
      level: "error",
      operation: "protocol_business_replan",
      title: "计划协议诊断",
      summary: diagnostic,
      error: diagnostic,
      serverId: "srv-protocol",
      taskId: "task-protocol",
    });

    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await flushView();
    host.querySelector<HTMLButtonElement>(".log-server-summary")!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    await nextTick();

    expect(host.textContent).toContain("当前检查结果和已完成步骤已保留");
    expect(host.textContent).not.toContain("OBSERVE_COMMAND_MUTATION");
    expect(host.textContent).not.toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
    expect(host.textContent).not.toContain("RECOVERY_DIAGNOSE_MUTATION");
    expect(host.textContent).not.toContain("steps[3].command");

    host.querySelectorAll<HTMLButtonElement>(".log-mode-tabs button")[1].click();
    await nextTick();
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("OBSERVE_COMMAND_MUTATION");
    expect(host.textContent).toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
    app.unmount();
  });

  it("keeps server lifecycle events separate from task execution logs", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.logs = [
      {
        id: "log-server-connected",
        category: "system",
        level: "success",
        title: "SSH 连接状态：SSH 已连接",
        detail: JSON.stringify({ status: "connected", generation: 2 }),
        serverId: "srv-production-01",
        serverName: "测试服务器",
        createdAt: "2026-09-15T06:48:10.550Z",
      },
      {
        id: "log-task-created",
        category: "task",
        level: "info",
        title: "正在理解需求并汇总服务器上下文…",
        detail: "",
        serverId: "srv-production-01",
        serverName: "测试服务器",
        taskId: "task-k8s",
        taskTitle: "部署一套k8s,将本机作为主节点",
        createdAt: "2026-09-15T03:24:33.279Z",
      },
    ];

    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("服务器事件");
    expect(host.textContent).toContain("部署一套k8s,将本机作为主节点");
    expect(host.textContent).not.toContain("未关联任务");

    host.querySelector<HTMLButtonElement>(".log-server-summary")!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    await nextTick();

    expect(host.querySelector(".server-task-list")?.textContent).toContain("服务器级事件");
    expect(host.querySelector(".server-task-list")?.textContent).toContain("task-k8s");
    expect(host.querySelector(".task-process-heading")?.textContent).toContain("服务器级事件");
    expect(host.querySelector(".task-process-heading")?.textContent).not.toContain("无任务 ID");
    app.unmount();
  });

  it("loads paged audit history from disk and merges live records by id", async () => {
    queryTaskLogsMock
      .mockResolvedValueOnce({
        items: [
          {
            id: "log-live",
            category: "task",
            level: "info",
            title: "stale disk snapshot",
            detail: "",
            serverId: "srv-1",
            serverName: "生产服务器",
            taskId: "task-live",
            taskTitle: "实时任务",
            createdAt: "2026-09-15T08:00:00.000Z",
          },
          {
            id: "log-disk-1",
            category: "system",
            level: "warning",
            title: "历史记录一",
            detail: "from disk",
            serverId: "srv-1",
            serverName: "生产服务器",
            createdAt: "2026-09-14T08:00:00.000Z",
          },
        ],
        nextCursor: "page-2",
        hasMore: true,
        total: 3,
        malformedLines: 1,
        oversizedLines: 2,
      })
      .mockResolvedValueOnce({
        items: [{
          id: "log-disk-2",
          category: "command",
          level: "success",
          title: "历史记录二",
          detail: "uptime\nup 10 days",
          serverId: "srv-1",
          serverName: "生产服务器",
          taskId: "task-old",
          taskTitle: "历史任务",
          createdAt: "2026-09-13T08:00:00.000Z",
        }],
        hasMore: false,
        total: 3,
        malformedLines: 1,
        oversizedLines: 2,
      });
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.logs = [{
      id: "log-live",
      category: "task",
      level: "success",
      title: "fresh live snapshot",
      detail: "",
      serverId: "srv-1",
      serverName: "生产服务器",
      taskId: "task-live",
      taskTitle: "实时任务",
      createdAt: "2026-09-15T08:00:00.000Z",
    }];

    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await flushView();

    expect(queryTaskLogsMock).toHaveBeenCalledWith(expect.objectContaining({ stream: "events", limit: 100 }));
    expect(host.querySelector(".log-summary strong")?.textContent).toBe("2");
    expect(host.querySelector(".audit-log-history-status")?.textContent).toContain("已从磁盘加载 2 / 3 条");
    expect(host.querySelector(".audit-log-history-warning")?.textContent).toContain("1 条损坏日志、2 条超大日志");

    host.querySelector<HTMLButtonElement>(".audit-log-load-more")!.click();
    await flushView();

    expect(queryTaskLogsMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" }));
    expect(host.querySelector(".log-summary strong")?.textContent).toBe("3");
    expect(host.querySelector(".audit-log-history-status")?.textContent).toContain("已从磁盘加载 3 / 3 条");
    expect(host.querySelector(".audit-log-load-more")).toBeNull();
    app.unmount();
  });

  it("queries filters and date range, debounces search, and applies a client-side fallback", async () => {
    vi.useFakeTimers();
    queryTaskLogsMock.mockResolvedValue({
      items: [{
        id: "wrong-category",
        category: "system",
        level: "info",
        title: "needle in an unfiltered backend result",
        detail: "",
        createdAt: "2026-09-15T08:00:00.000Z",
      }],
      hasMore: false,
      total: 1,
      malformedLines: 0,
      oversizedLines: 0,
    });
    const pinia = createPinia();
    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await flushView();

    await chooseParameterOption(host, "按类别筛选", "command");
    const from = host.querySelector<HTMLInputElement>("[aria-label='开始日期']")!;
    const to = host.querySelector<HTMLInputElement>("[aria-label='结束日期']")!;
    from.value = "2026-09-01";
    from.dispatchEvent(new Event("input"));
    to.value = "2026-09-30";
    to.dispatchEvent(new Event("input"));
    await flushView();

    expect(queryTaskLogsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      category: "command",
      from: new Date("2026-09-01T00:00:00.000").toISOString(),
      to: new Date("2026-09-30T23:59:59.999").toISOString(),
    }));
    expect(host.querySelector(".log-summary strong")?.textContent).toBe("0");

    const callsBeforeSearch = queryTaskLogsMock.mock.calls.length;
    const search = host.querySelector<HTMLInputElement>(".log-filters .search-box input")!;
    search.value = "needle";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    vi.advanceTimersByTime(299);
    await flushView();
    expect(queryTaskLogsMock).toHaveBeenCalledTimes(callsBeforeSearch);
    vi.advanceTimersByTime(1);
    await flushView();
    expect(queryTaskLogsMock).toHaveBeenCalledTimes(callsBeforeSearch + 1);
    expect(queryTaskLogsMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: "needle" }));
    app.unmount();
  });

  it("counts schema-invalid audit records instead of silently dropping them", async () => {
    queryTaskLogsMock.mockResolvedValue({
      items: [
        {
          id: "valid-audit",
          category: "system",
          level: "info",
          title: "valid history",
          detail: "safe",
          createdAt: "2026-09-15T08:00:00.000Z",
        },
        { id: "invalid-audit", category: "unknown", level: "info", title: "invalid history" },
      ],
      hasMore: false,
      total: 2,
      malformedLines: 0,
      oversizedLines: 0,
    });
    const app = createApp(LogsView).use(createPinia()).use(i18n);
    app.mount(host);
    await flushView();

    expect(host.querySelector(".log-summary strong")?.textContent).toBe("1");
    expect(host.querySelector(".audit-log-history-warning")?.textContent).toContain("1 条结构无效记录");
    app.unmount();
  });

  it("keeps live logs usable when disk history is unavailable and reports query failures", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.logs = [{
      id: "browser-live",
      category: "system",
      level: "info",
      title: "browser fallback log",
      detail: "",
      createdAt: "2026-09-15T08:00:00.000Z",
    }];
    const app = createApp(LogsView).use(pinia).use(i18n);
    app.mount(host);
    await flushView();

    expect(host.querySelector(".log-summary strong")?.textContent).toBe("1");
    expect(host.querySelector(".audit-log-history-status")).toBeNull();
    app.unmount();

    queryTaskLogsMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const failedApp = createApp(LogsView).use(createPinia()).use(i18n);
    failedApp.mount(host);
    await flushView();
    expect(host.querySelector(".audit-log-history-error")?.textContent).toContain("历史日志加载失败：disk unavailable");
    expect(host.querySelector(".audit-log-retry")).not.toBeNull();
    failedApp.unmount();
  });
});
