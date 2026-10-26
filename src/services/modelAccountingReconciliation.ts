import type { TaskModelRequest } from "./taskModelRequests";

// Accounting has its own finite observation tail. It cannot extend a workflow,
// generate a candidate, approve a step, or turn an old response into execution.
export const ACCOUNTING_WINDOW_MS = 90_000;
const MAX_QUERIES = 12;
const MAX_CONCURRENT_QUERIES = 4;
const MAX_RECORD_AGE_MS = 900_000 + ACCOUNTING_WINDOW_MS; // native maximum operation age + tail
interface Job {
  request: TaskModelRequest;
  current(): TaskModelRequest | undefined;
  query(): Promise<unknown>;
  refresh(): Promise<unknown>;
}

interface Observation {
  job: Job;
  taskId: string;
  requestId: string;
  createdAtMs: number;
  deadline: number;
  count: number;
}

export function createOriginalAccountingReconciler() {
  const seen = new Set<string>();
  const ready: Observation[] = [];
  let active = 0;

  const eligible = (item: Observation) => {
    const current = item.job.current();
    const now = Date.now(), age = now - item.createdAtMs;
    return current && current.taskId === item.taskId && current.requestId === item.requestId
      && ["unknown", "accepted", "dispatching"].includes(current.state)
      && Number.isFinite(age) && age >= 0 && age <= MAX_RECORD_AGE_MS
      && item.count < MAX_QUERIES && now + 5000 <= item.deadline;
  };

  // A slot belongs to one GET/refresh pair, not an entire observation window.
  // Originals waiting between polls go to the tail so earlier unknowns cannot
  // monopolize all four slots. Admission time fixes the deadline even in queue.
  const pump = () => {
    while (active < MAX_CONCURRENT_QUERIES && ready.length) {
      const item = ready.shift()!;
      if (!eligible(item)) continue;
      active++;
      void run(item);
    }
  };
  const run = async (item: Observation) => {
    item.count++;
    try {
      await item.job.query();
      await item.job.refresh();
      if (eligible(item)) setTimeout(() => { ready.push(item); pump(); }, 2000);
    } catch {
      // Credentials/identity/status loss never authorizes another query.
    } finally {
      active--;
      pump();
    }
  };

  return {
    schedule(job: Job) {
      const original = job.request;
      const key = JSON.stringify([original.taskId, original.requestId]);
      const age = Date.now() - original.createdAtMs;
      if (!original.taskId || original.state !== "unknown" || !Number.isFinite(age) || age < 0 || age > MAX_RECORD_AGE_MS
        || seen.size >= 2048 || seen.has(key)) return;
      seen.add(key);
      ready.push({ job, taskId: original.taskId, requestId: original.requestId, createdAtMs: original.createdAtMs,
        deadline: Date.now() + ACCOUNTING_WINDOW_MS, count: 0 });
      setTimeout(pump, 0);
    },
  };
}
