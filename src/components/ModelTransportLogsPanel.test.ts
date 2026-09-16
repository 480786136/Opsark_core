// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { i18n } from "@/features/preferences/i18n";
import { backend } from "@/services/backend";
import ModelTransportLogsPanel from "./ModelTransportLogsPanel.vue";

function transportEvent(recordId: string, event: "request_sent" | "response_received", timestampMs: number) {
  return {
    recordId,
    event,
    timestampMs,
    callId: "call-shared",
    requestName: "Requirement processing",
    serverId: "server-1",
    taskId: "task-1",
    attempt: 1,
    ...(event === "response_received" ? { status: 200, durationMs: 42 } : {}),
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

describe("ModelTransportLogsPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    host.remove();
  });

  it("keeps the model-call view and clipboard restricted to safe metadata", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    vi.spyOn(backend, "queryTaskLogs").mockResolvedValue({
      items: [{
        ...transportEvent("record-request", "request_sent", Date.parse("2026-09-16T08:00:00.000Z")),
        contextMetrics: { requestBytes: 2048, sections: [{ role: "user", characters: 100, content: "SENTINEL_SECTION" }] },
        request: "SENTINEL_PROMPT",
        response: "SENTINEL_RESPONSE",
        error: "SENTINEL_ERROR",
      }],
      hasMore: false,
      total: 1,
      malformedLines: 0,
      oversizedLines: 0,
    });
    const app = createApp(ModelTransportLogsPanel).use(i18n);
    app.mount(host);
    await settle();

    expect(backend.queryTaskLogs).toHaveBeenCalledWith(expect.objectContaining({ stream: "model-calls", limit: 100 }));
    expect(host.textContent).toContain("Requirement processing");
    expect(host.textContent).not.toContain("SENTINEL_PROMPT");
    expect(host.textContent).not.toContain("SENTINEL_RESPONSE");
    expect(host.textContent).not.toContain("SENTINEL_ERROR");
    expect(host.textContent).not.toContain("SENTINEL_SECTION");

    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("复制元数据"));
    copy!.click();
    await settle();
    const copied = String(clipboard.writeText.mock.calls[0][0]);
    expect(copied).toContain("record-request");
    expect(copied).not.toContain("SENTINEL");
    app.unmount();
  });

  it("paginates and sends event, date, task, and search filters after one debounce", async () => {
    vi.useFakeTimers();
    vi.spyOn(backend, "queryTaskLogs")
      .mockResolvedValueOnce({
        items: [
          transportEvent("record-response", "response_received", Date.parse("2026-09-16T08:02:00.000Z")),
          transportEvent("record-request", "request_sent", Date.parse("2026-09-16T08:01:00.000Z")),
        ],
        nextCursor: "transport-page-2",
        hasMore: true,
        total: 3,
        malformedLines: 0,
        oversizedLines: 0,
      })
      .mockResolvedValueOnce({
        items: [{ ...transportEvent("record-old", "request_sent", Date.parse("2026-09-15T08:00:00.000Z")), taskId: "task-2" }],
        hasMore: false,
        total: 3,
        malformedLines: 0,
        oversizedLines: 0,
      })
      .mockResolvedValue({
        items: [transportEvent("record-filtered", "response_received", Date.parse("2026-09-16T09:00:00.000Z"))],
        hasMore: false,
        total: 1,
        malformedLines: 0,
        oversizedLines: 0,
      });
    const app = createApp(ModelTransportLogsPanel).use(i18n);
    app.mount(host);
    await settle();

    const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "加载更多");
    loadMore!.click();
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "transport-page-2" }));
    expect(host.querySelectorAll(".model-transport-event")).toHaveLength(3);

    const search = host.querySelector<HTMLInputElement>(".model-transport-toolbar .search-box input")!;
    const from = host.querySelector<HTMLInputElement>("[aria-label='开始日期']")!;
    const to = host.querySelector<HTMLInputElement>("[aria-label='结束日期']")!;
    await chooseParameterOption(host, "按传输事件筛选", "response_received");
    await chooseParameterOption(host, "按任务筛选", "task-1");
    search.value = "call-shared";
    search.dispatchEvent(new Event("input"));
    from.value = "2026-09-01";
    from.dispatchEvent(new Event("input"));
    to.value = "2026-09-30";
    to.dispatchEvent(new Event("input"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(249);
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(3);
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({
      stream: "model-calls",
      event: "response_received",
      taskId: "task-1",
      search: "call-shared",
      from: new Date("2026-09-01T00:00:00.000").toISOString(),
      to: new Date("2026-09-30T23:59:59.999").toISOString(),
    }));
    app.unmount();
  });

  it("does not combine an old cursor with filters waiting for a debounced reset", async () => {
    vi.useFakeTimers();
    const filteredResult = {
      items: [transportEvent("record-filtered", "response_received", Date.parse("2026-09-16T09:00:00.000Z"))],
      hasMore: false,
      total: 1,
      malformedLines: 0,
      oversizedLines: 0,
    };
    let finishFiltered!: (value: typeof filteredResult) => void;
    const filteredRequest = new Promise<typeof filteredResult>((resolve) => { finishFiltered = resolve; });
    vi.spyOn(backend, "queryTaskLogs")
      .mockResolvedValueOnce({
        items: [transportEvent("record-page-1", "request_sent", Date.parse("2026-09-16T08:00:00.000Z"))],
        nextCursor: "old-transport-cursor",
        hasMore: true,
        total: 2,
        malformedLines: 0,
        oversizedLines: 0,
      })
      .mockImplementationOnce(async () => filteredRequest);

    const app = createApp(ModelTransportLogsPanel).use(i18n);
    app.mount(host);
    await settle();

    const search = host.querySelector<HTMLInputElement>(".model-transport-toolbar .search-box input")!;
    search.value = "latest-transport-filter";
    search.dispatchEvent(new Event("input"));
    await nextTick();

    const pendingLoadMore = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "加载更多")!;
    expect(pendingLoadMore.disabled).toBe(true);
    pendingLoadMore.click();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    const latestQuery = vi.mocked(backend.queryTaskLogs).mock.calls[1][0];
    expect(latestQuery.search).toBe("latest-transport-filter");
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

  it("serializes scans and coalesces rapid filter changes into the latest query", async () => {
    vi.useFakeTimers();
    const emptyResult = { items: [], hasMore: false, total: 0, malformedLines: 0, oversizedLines: 0 };
    let finishFirst!: (value: typeof emptyResult) => void;
    const first = new Promise<typeof emptyResult>((resolve) => { finishFirst = resolve; });
    vi.spyOn(backend, "queryTaskLogs")
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(emptyResult);
    const app = createApp(ModelTransportLogsPanel).use(i18n);
    app.mount(host);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);

    const search = host.querySelector<HTMLInputElement>(".model-transport-toolbar .search-box input")!;
    search.value = "first";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(1);

    search.value = "latest";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    finishFirst(emptyResult);
    await settle();

    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    expect(backend.queryTaskLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: "latest" }));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(backend.queryTaskLogs).toHaveBeenCalledTimes(2);
    app.unmount();
  });
});
