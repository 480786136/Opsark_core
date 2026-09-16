// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import type { DeveloperLogEntry } from "@/types";
import DeveloperLogsPanel from "./DeveloperLogsPanel.vue";

function developerLog(id: string, title: string, createdAt: string): DeveloperLogEntry {
  return {
    id,
    level: "success",
    operation: "model_call",
    title,
    summary: `${title} summary`,
    serverId: "server-1",
    serverName: "Primary",
    taskId: "task-1",
    taskTitle: "Deploy service",
    createdAt,
  };
}

async function settle() {
  await Promise.resolve();
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

describe("DeveloperLogsPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(backend, "queryTaskLogs").mockResolvedValue(null);
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    host.remove();
  });

  it("opens the server/task workspace and shows full diagnostics with token usage", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.addDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "需求处理模型调用失败",
      summary: "模型响应缺少需求理解结果",
      request: { requirement: "再次尝试" },
      trace: { attempts: [{ attempt: 1, response: { choices: [] } }] },
      response: { intent: "execute" },
      error: "ModelInvocationError: missing result",
      taskId: "task-1",
      modelName: "DeepSeek V4 Flash",
      durationMs: 84,
    });

    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).not.toContain("再次尝试");
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();

    expect(host.textContent).toContain("需求处理模型调用失败");
    expect(host.textContent).toContain("DeepSeek V4 Flash");
    expect(host.textContent).toContain("完整请求（不含鉴权头）");
    expect(host.textContent).toContain("再次尝试");
    expect(host.textContent).toContain('"choices": []');
    expect(host.textContent).toContain("ModelInvocationError: missing result");
    expect(host.textContent).toContain("估算用量");
    expect([...host.querySelectorAll<HTMLElement>(".developer-detail-card pre")].every((block) => block.tabIndex === 0)).toBe(true);
    app.unmount();
  });

  it("merges disk pages with live logs by id and reports skipped lines", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const live = { ...developerLog("dev-live", "Live copy", "2026-09-16T08:03:00.000Z"), summary: "live wins" };
    store.developerLogs = [live];
    vi.mocked(backend.queryTaskLogs).mockReset()
      .mockResolvedValueOnce({
        items: [
          { ...live, summary: "stale disk copy" },
          developerLog("dev-old-1", "Older call", "2026-09-16T08:02:00.000Z"),
        ],
        nextCursor: "page-2",
        hasMore: true,
        total: 3,
        malformedLines: 1,
        oversizedLines: 0,
      })
      .mockResolvedValueOnce({
        items: [developerLog("dev-old-2", "Oldest call", "2026-09-16T08:01:00.000Z")],
        hasMore: false,
        total: 3,
        malformedLines: 1,
        oversizedLines: 1,
      });

    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();

    expect(host.textContent).toContain("磁盘已加载 2 / 3");
    expect(host.querySelector(".developer-log-hint strong")?.textContent).toContain("2");
    expect(backend.queryTaskLogs).toHaveBeenCalledWith(expect.objectContaining({
      stream: "developer-events",
      limit: 100,
    }));

    host.querySelector<HTMLButtonElement>(".developer-log-toolbar:last-child button")!.click();
    await settle();

    expect(host.textContent).toContain("磁盘已加载 3 / 3");
    expect(host.textContent).toContain("已跳过 2 条无法读取的日志");
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" }));

    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("live wins");
    expect(host.textContent).not.toContain("stale disk copy");
    app.unmount();
  });

  it("debounces search and filter changes into one disk query", async () => {
    vi.useFakeTimers();
    vi.mocked(backend.queryTaskLogs).mockReset().mockResolvedValue({
      items: [developerLog("dev-filter", "Filter option", "2026-09-16T08:03:00.000Z")],
      hasMore: false, total: 1, malformedLines: 0, oversizedLines: 0,
    });
    const pinia = createPinia();
    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);

    const input = host.querySelector<HTMLInputElement>(".search-box input")!;
    input.value = "timeout";
    input.dispatchEvent(new Event("input"));
    await chooseParameterOption(host, "开发者操作类型", "model_call");
    await chooseParameterOption(host, "按级别筛选", "error");
    const from = host.querySelector<HTMLInputElement>("[aria-label='开始日期']")!;
    const to = host.querySelector<HTMLInputElement>("[aria-label='结束日期']")!;
    from.value = "2026-09-01";
    from.dispatchEvent(new Event("input"));
    to.value = "2026-09-30";
    to.dispatchEvent(new Event("input"));
    await nextTick();

    await vi.advanceTimersByTimeAsync(179);
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({
      stream: "developer-events",
      search: "timeout",
      operation: "model_call",
      level: "error",
      from: new Date("2026-09-01T00:00:00.000").toISOString(),
      to: new Date("2026-09-30T23:59:59.999").toISOString(),
    }));
    app.unmount();
  });

  it("keeps a pending filter reset ahead of load more and starts the latest query at page one", async () => {
    vi.useFakeTimers();
    const filteredResult = {
      items: [developerLog("dev-filtered", "Filtered", "2026-09-16T08:04:00.000Z")],
      hasMore: false,
      total: 1,
      malformedLines: 0,
      oversizedLines: 0,
    };
    let finishFiltered!: (value: typeof filteredResult) => void;
    const filteredRequest = new Promise<typeof filteredResult>((resolve) => { finishFiltered = resolve; });
    vi.mocked(backend.queryTaskLogs).mockReset()
      .mockResolvedValueOnce({
        items: [developerLog("dev-page-1", "Page one", "2026-09-16T08:03:00.000Z")],
        nextCursor: "old-cursor",
        hasMore: true,
        total: 2,
        malformedLines: 0,
        oversizedLines: 0,
      })
      .mockImplementationOnce(async () => filteredRequest);

    const pinia = createPinia();
    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();

    const search = host.querySelector<HTMLInputElement>(".search-box input")!;
    search.value = "latest-filter";
    search.dispatchEvent(new Event("input"));
    await nextTick();

    const pendingLoadMore = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "加载更多")!;
    expect(pendingLoadMore.disabled).toBe(true);
    pendingLoadMore.click();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    const latestQuery = vi.mocked(backend.queryTaskLogs).mock.calls[1][0];
    expect(latestQuery.search).toBe("latest-filter");
    expect(latestQuery.cursor).toBeUndefined();

    const loadingButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "正在读取…")!;
    expect(loadingButton.disabled).toBe(true);
    loadingButton.click();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);

    finishFiltered(filteredResult);
    await settle();
    app.unmount();
  });

  it("rejects malformed disk records and tolerates invalid optional token data", async () => {
    vi.mocked(backend.queryTaskLogs).mockReset().mockResolvedValue({
      items: [
        { ...developerLog("dev-safe", "Safe legacy record", "2026-09-16T08:03:00.000Z"), tokenUsage: { input: "bad", output: 2, total: 2, source: "api" } },
        { level: "error", operation: "broken", title: "Missing required fields" },
        { id: "bad-level", level: { toString: null }, operation: "broken", title: "Bad level", summary: "bad", createdAt: "2026-09-16T08:02:00.000Z" },
      ],
      hasMore: false,
      total: 3,
      malformedLines: 0,
      oversizedLines: 0,
    });
    const pinia = createPinia();
    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();

    expect(host.textContent).toContain("磁盘已加载 1 / 3");
    expect(host.textContent).toContain("已跳过 2 条无法读取的日志");
    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("Safe legacy record");
    expect(host.textContent).toContain("Token 用量不可用");
    app.unmount();
  });

  it("keeps live logs visible when disk history cannot be read", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.developerLogs = [developerLog("dev-live", "Still available", "2026-09-16T08:03:00.000Z")];
    vi.mocked(backend.queryTaskLogs).mockReset()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce({ items: [], hasMore: false, total: 0, malformedLines: 0, oversizedLines: 0 });

    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();

    expect(host.textContent).toContain("读取磁盘日志失败，请稍后重试");
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "重试");
    expect(retry).toBeTruthy();
    retry!.click();
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("读取磁盘日志失败");

    host.querySelector<HTMLButtonElement>(".developer-server-summary")!.click();
    await nextTick();
    expect(host.textContent).toContain("Still available");
    app.unmount();
  });

  it("loads raw model-call files only through the metadata-only source", async () => {
    vi.mocked(backend.queryTaskLogs).mockReset().mockImplementation(async (query) => {
      if (query.stream === "developer-events") {
        return { items: [], hasMore: false, total: 0, malformedLines: 0, oversizedLines: 0 };
      }
      return {
        items: [
          {
            recordId: "transport-request",
            event: "request_sent",
            timestampMs: Date.parse("2026-09-16T08:03:00.000Z"),
            callId: "shared-call",
            requestName: "Requirement processing",
            request: "SENTINEL_RAW_PROMPT",
          },
          {
            recordId: "transport-response",
            event: "response_received",
            timestampMs: Date.parse("2026-09-16T08:03:01.000Z"),
            callId: "shared-call",
            requestName: "Requirement processing",
            status: 200,
            response: "SENTINEL_RAW_RESPONSE",
          },
        ],
        hasMore: false,
        total: 2,
        malformedLines: 0,
        oversizedLines: 0,
      };
    });
    const pinia = createPinia();
    const app = createApp(DeveloperLogsPanel).use(pinia).use(i18n);
    app.mount(host);
    await settle();

    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({ stream: "developer-events" }));
    expect(backend.queryTaskLogs).not.toHaveBeenCalledWith(expect.objectContaining({ stream: "model-calls" }));

    host.querySelectorAll<HTMLButtonElement>(".developer-log-source-tabs button")[1].click();
    await settle();

    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({ stream: "model-calls" }));
    expect(host.querySelectorAll(".model-transport-event")).toHaveLength(2);
    expect(host.textContent).toContain("Requirement processing");
    expect(host.textContent).toContain("Rust 强制只向此页返回元数据");
    expect(host.textContent).not.toContain("SENTINEL_RAW_PROMPT");
    expect(host.textContent).not.toContain("SENTINEL_RAW_RESPONSE");
    expect(host.textContent).not.toContain("日志在写入前会移除 API Key");
    app.unmount();
  });
});
