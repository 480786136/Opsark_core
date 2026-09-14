// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, type RuntimeConnection } from "@/services/backend";
import { calculateTransferMetrics, useTransferQueueStore } from "./transferQueueStore";
import { useOpsStore } from "@/stores/ops";

const connection: RuntimeConnection = {
  host: "127.0.0.1",
  port: 22,
  username: "tester",
  password: "memory-only",
};

describe("transferQueueStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    const ops = useOpsStore();
    ops.serverConnection("server-1").status = "connected";
    vi.spyOn(ops, "getRuntimeConnection").mockReturnValue(connection);
    vi.spyOn(ops, "reportConnectionFailure").mockImplementation(() => undefined);
  });

  it("根据实际字节和耗时计算速度与剩余时间", () => {
    const metrics = calculateTransferMetrics(2 * 1024 * 1024, 6 * 1024 * 1024, 2_000);
    expect(metrics.speedBytesPerSecond).toBe(1024 * 1024);
    expect(metrics.remainingSeconds).toBe(4);
  });

  it("空进度不会产生无限或负数剩余时间", () => {
    const metrics = calculateTransferMetrics(0, 10, 0);
    expect(metrics.speedBytesPerSecond).toBe(0);
    expect(metrics.remainingSeconds).toBeUndefined();
  });

  it("串行处理队列并使用后端事件更新真实进度", async () => {
    const starts: string[] = [];
    vi.spyOn(backend, "uploadSftpTransfer").mockImplementation(async (_connection, id, _path, data, onProgress) => {
      starts.push(id);
      onProgress({
        transferId: id,
        direction: "upload",
        transferredBytes: data.byteLength,
        totalBytes: data.byteLength,
        status: "completed",
      });
    });
    const queue = useTransferQueueStore();
    queue.enqueueUpload("server-1", connection, "a.txt", "/a.txt", new Uint8Array(10));
    queue.enqueueUpload("server-1", connection, "b.txt", "/b.txt", new Uint8Array(20));

    await vi.waitFor(() => expect(queue.tasks.every(({ status }) => status === "completed")).toBe(true));
    expect(starts).toHaveLength(2);
    expect(queue.tasks.map(({ transferredBytes }) => transferredBytes)).toEqual([20, 10]);
  });

  it("保留失败任务的内存载荷以便重试", async () => {
    const upload = vi.spyOn(backend, "uploadSftpTransfer")
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const queue = useTransferQueueStore();
    const taskId = queue.enqueueUpload("server-1", connection, "a.txt", "/a.txt", new Uint8Array(4));
    await vi.waitFor(() => expect(queue.tasks[0].status).toBe("failed"));

    queue.retry(taskId);

    await vi.waitFor(() => expect(queue.tasks[0].status).toBe("completed"));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("断线后阻止排队传输和重试，迟到上传结果标记待确认", async () => {
    let resolve!: () => void;
    const upload = vi.spyOn(backend, "uploadSftpTransfer").mockImplementation(() => new Promise<undefined>((done) => { resolve = () => done(undefined); }));
    const ops = useOpsStore();
    const queue = useTransferQueueStore();
    const completed = vi.fn();
    const first = queue.enqueueUpload("server-1", connection, "a.txt", "/a.txt", new Uint8Array(4), completed);
    const second = queue.enqueueUpload("server-1", connection, "b.txt", "/b.txt", new Uint8Array(4));
    ops.serverConnection("server-1").status = "suspect";
    resolve();
    await vi.waitFor(() => expect(queue.tasks.every(({ status }) => status === "failed")).toBe(true));
    expect(completed).not.toHaveBeenCalled();
    expect(queue.tasks.find(({ id }) => id === first)?.error).toContain("RESULT_UNCONFIRMED");
    queue.retry(second);
    expect(upload).toHaveBeenCalledTimes(1);
    ops.serverConnection("server-1").status = "connected";
    queue.retry(first);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
