/** Executor-owned observation time. Model prose and SSH preparation are not samples. */
export interface ObservationBinding {
  taskId: string; roundId?: string; workflowEpoch: number; stepId: string; executionId: string;
}
export interface ObservationPolicy {
  windowMs: number;
  intervalMs: number;
  probeTimeoutMs: number;
  absoluteDeadlineAt?: number;
}
export interface ObservationProbeResult {
  status: "valid" | "unsupported" | "invalid";
  matched: boolean;
  executionId: string;
  facts?: Record<string, unknown>;
}
export interface ObservationSample extends ObservationProbeResult {
  index: number;
  dispatchedAt: number;
  probeStartedAt?: number;
  startedOffsetMs?: number;
  receivedAt: number;
  late: boolean;
}
export type ObservationState = "preparing" | "observing" | "matched" | "window_elapsed"
  | "absolute_deadline" | "cancelled" | "unsupported" | "invalid" | "probe_timeout" | "interrupted";
export interface ObservationRuntimeRecord {
  version: 1;
  binding: ObservationBinding;
  policy: ObservationPolicy;
  preparationStartedAt: number;
  startedAt: number;
  firstValidProbeAt?: number;
  preparationElapsedMs?: number;
  observationElapsedMs: number;
  /** Actual gaps between valid probe starts; intervalMs is a minimum, not a
   * promise that a slow atomic probe can overlap another request. */
  maxSampleGapMs: number;
  finishedAt?: number;
  /** Recovery time is not the unknown original stop time. */
  interruptedAt?: number;
  state: ObservationState;
  /** Elapsed span and a valid sample in its final interval; inspect the actual
   * sample gaps separately. This never proves continuous availability. */
  windowSatisfied: boolean;
  samples: ObservationSample[];
  persistenceError?: string;
}
export interface ObservationClock {
  wallNow(): number;
  monotonicNow(): number;
  sleep(milliseconds: number): Promise<void>;
}
export interface ObservationRuntimeDependencies {
  probe(context: { sampleIndex: number; timeoutMs: number; signal: AbortSignal; markStarted(): void }): Promise<ObservationProbeResult>;
  persist(record: ObservationRuntimeRecord): Promise<void> | void;
  isCancelled(): boolean;
  clock?: ObservationClock;
  /** A late receipt is still retained in memory when its durable save fails. */
  onPersistenceError?(error: unknown, record: ObservationRuntimeRecord): void;
}
const systemClock: ObservationClock = {
  wallNow: () => Date.now(), monotonicNow: () => performance.now(),
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Process restart cannot resume a performance.now clock or invent an end. */
export function interruptRestoredObservationWindows(task: { observationWindows?: ObservationRuntimeRecord[] },
  restoredAt = Date.now()): number {
  let changed = 0;
  for (const record of task.observationWindows ?? []) {
    if (!["preparing", "observing"].includes(record.state)) continue;
    record.state = "interrupted";
    record.interruptedAt = restoredAt;
    record.windowSatisfied = false;
    // No finishedAt is added: the last durable observation is not a stop event.
    changed += 1;
  }
  return changed;
}

export function observationRuntimeRecordValid(value: unknown, taskId: string): value is ObservationRuntimeRecord {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const optionalCount = (value: unknown) => value === undefined || count(value);
  if (!object(value) || value.version !== 1 || !object(value.binding) || value.binding.taskId !== taskId
    || !text(value.binding.stepId) || !text(value.binding.executionId)
    || !Number.isSafeInteger(value.binding.workflowEpoch) || Number(value.binding.workflowEpoch) < 0
    || value.binding.roundId !== undefined && !text(value.binding.roundId) || !object(value.policy)
    || !count(value.preparationStartedAt) || !count(value.startedAt) || Number(value.preparationStartedAt) > Number(value.startedAt)
    || !count(value.observationElapsedMs) || !count(value.maxSampleGapMs) || typeof value.windowSatisfied !== "boolean"
    || !optionalCount(value.firstValidProbeAt) || !optionalCount(value.preparationElapsedMs)
    || (value.firstValidProbeAt === undefined) !== (value.preparationElapsedMs === undefined)
    || !optionalCount(value.finishedAt) || !optionalCount(value.interruptedAt)
    || value.persistenceError !== undefined && !text(value.persistenceError)
    || !["preparing", "observing", "matched", "window_elapsed", "absolute_deadline", "cancelled", "unsupported", "invalid", "probe_timeout", "interrupted"].includes(String(value.state))
    || !Array.isArray(value.samples) || value.samples.length > 1000) return false;
  try { validateObservationPolicy(value.policy as unknown as ObservationPolicy); } catch { return false; }
  const active = ["preparing", "observing"].includes(String(value.state));
  if (active && (value.finishedAt !== undefined || value.interruptedAt !== undefined)
    || value.state === "interrupted" && (value.finishedAt !== undefined || value.interruptedAt === undefined)
    || !active && value.state !== "interrupted" && value.finishedAt === undefined) return false;
  if (!value.samples.every((sample, index) => object(sample) && sample.index === index && text(sample.executionId)
    && ["valid", "unsupported", "invalid"].includes(String(sample.status)) && typeof sample.matched === "boolean"
    && typeof sample.late === "boolean" && count(sample.dispatchedAt) && count(sample.receivedAt)
    && optionalCount(sample.probeStartedAt) && optionalCount(sample.startedOffsetMs)
    && (sample.status !== "valid" || sample.probeStartedAt !== undefined)
    && (!sample.matched || sample.status === "valid")
    && (sample.facts === undefined || object(sample.facts)))) return false;
  const record = value as unknown as ObservationRuntimeRecord;
  const valid = record.samples.filter(sample => sample.status === "valid" && !sample.late);
  if (record.state === "matched" && (record.firstValidProbeAt === undefined || !valid.some(sample => sample.matched))) return false;
  if (record.windowSatisfied && (record.state !== "window_elapsed" || record.observationElapsedMs < record.policy.windowMs
    || record.firstValidProbeAt === undefined || !valid.length
    || (valid[valid.length - 1].startedOffsetMs ?? -Infinity) < record.policy.windowMs - record.policy.intervalMs)) return false;
  return true;
}

export function validateObservationPolicy(policy: ObservationPolicy): void {
  for (const [name, value, minimum, maximum] of [
    ["windowMs", policy.windowMs, 1, 3_600_000],
    ["intervalMs", policy.intervalMs, 1, 60_000],
    ["probeTimeoutMs", policy.probeTimeoutMs, 1, 60_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`观察参数 ${name} 超出支持范围`);
  }
  if (policy.intervalMs > policy.windowMs || Math.ceil(policy.windowMs / policy.intervalMs) > 1000) {
    throw new Error("观察间隔大于窗口或需要超过 1000 个样本；必须调整明确参数，不能静默缩短观察");
  }
  if (policy.absoluteDeadlineAt !== undefined && (!Number.isSafeInteger(policy.absoluteDeadlineAt) || policy.absoluteDeadlineAt < 0)) {
    throw new Error("绝对任务截止时间无效");
  }
}

/** The caller supplies a fixed, read-only atomic probe and identifies its real
 * start from an executor-controlled marker. A valid negative result (503 or
 * connection refused) counts; unsupported and incomplete protocol do not.
 * Recovered snapshots are evidence only: never resume this clock after restart.
 */
export async function runObservationWindow(input: {
  binding: ObservationBinding; policy: ObservationPolicy; preparationStartedAt: number;
}, dependencies: ObservationRuntimeDependencies): Promise<ObservationRuntimeRecord> {
  validateObservationPolicy(input.policy);
  if (!Number.isFinite(input.preparationStartedAt) || input.preparationStartedAt < 0
    || !input.binding.taskId || !input.binding.stepId || !input.binding.executionId
    || !Number.isSafeInteger(input.binding.workflowEpoch) || input.binding.workflowEpoch < 0) throw new Error("观察归属或准备开始时间无效");
  const clock = dependencies.clock ?? systemClock;
  const startedAt = clock.wallNow(), startedMono = clock.monotonicNow();
  if (input.preparationStartedAt > startedAt) throw new Error("观察准备时间晚于执行开始，无法建立可信计时");
  const policy = copy(input.policy);
  const absoluteMono = policy.absoluteDeadlineAt === undefined ? Infinity
    : startedMono + Math.max(0, policy.absoluteDeadlineAt - startedAt);
  const record: ObservationRuntimeRecord = { version: 1, binding: copy(input.binding), policy,
    preparationStartedAt: input.preparationStartedAt, startedAt, observationElapsedMs: 0, maxSampleGapMs: 0,
    state: "preparing", windowSatisfied: false, samples: [] };
  let firstValidMono: number | undefined, lastMono = startedMono;
  let persistence = Promise.resolve();
  const mono = () => {
    const value = clock.monotonicNow();
    if (!Number.isFinite(value) || value < lastMono) throw new Error("观察单调时钟异常，不能继续推断窗口");
    lastMono = value; return value;
  };
  const persist = () => {
    const snapshot = copy(record);
    persistence = persistence.then(() => dependencies.persist(snapshot));
    return persistence.catch(error => { record.persistenceError = "观察证据保存失败"; throw error; });
  };
  const elapsed = () => firstValidMono === undefined ? 0 : Math.max(0, mono() - firstValidMono);
  const finish = async (state: ObservationState) => {
    record.state = state; record.finishedAt = clock.wallNow(); record.observationElapsedMs = elapsed();
    const valid = record.samples.filter(sample => sample.status === "valid" && !sample.late);
    record.windowSatisfied = state === "window_elapsed" && record.observationElapsedMs >= policy.windowMs
      && !!valid.length && (valid[valid.length - 1].startedOffsetMs ?? -Infinity) >= policy.windowMs - policy.intervalMs;
    await persist(); return record;
  };
  const stopReason = (): ObservationState | undefined => {
    if (dependencies.isCancelled()) return "cancelled";
    if (mono() >= absoluteMono || policy.absoluteDeadlineAt !== undefined && clock.wallNow() >= policy.absoluteDeadlineAt) return "absolute_deadline";
    if (firstValidMono !== undefined && elapsed() >= policy.windowMs) return "window_elapsed";
    return undefined;
  };
  const remaining = () => Math.max(0, Math.min(absoluteMono - mono(),
    policy.absoluteDeadlineAt === undefined ? Infinity : policy.absoluteDeadlineAt - clock.wallNow(),
    firstValidMono === undefined ? Infinity : policy.windowMs - elapsed()));
  await persist();
  for (let index = 0; index < 1000; index += 1) {
    const stopped = stopReason();
    if (stopped) return finish(stopped);
    const controller = new AbortController();
    const dispatchedAt = clock.wallNow(), dispatchMono = mono();
    const timeoutMs = Math.min(policy.probeTimeoutMs, remaining());
    let probeStart: { wall: number; mono: number } | undefined;
    let detached = false, settled: { result: ObservationProbeResult; receivedAt: number } | undefined;
    const append = (result: ObservationProbeResult, receivedAt: number, late: boolean) => {
      const validIdentity = typeof result.executionId === "string" && result.executionId.length > 0;
      const valid = result.status === "valid" && !!probeStart && validIdentity && typeof result.matched === "boolean";
      const status = valid ? "valid" : result.status === "unsupported" ? "unsupported" : "invalid";
      if (valid && !late && firstValidMono === undefined) {
        firstValidMono = probeStart!.mono;
        record.firstValidProbeAt = probeStart!.wall;
        // Include prior planning/preparation once, then use only monotonic duration.
        record.preparationElapsedMs = Math.max(0, startedAt - input.preparationStartedAt) + probeStart!.mono - startedMono;
      }
      const previousSample = [...record.samples].reverse().find(sample => sample.status === "valid" && !sample.late);
      if (valid && !late && previousSample?.startedOffsetMs !== undefined && firstValidMono !== undefined) {
        record.maxSampleGapMs = Math.max(record.maxSampleGapMs, probeStart!.mono - firstValidMono - previousSample.startedOffsetMs);
      }
      record.samples.push({ ...copy(result), status, matched: valid && result.matched, index,
        dispatchedAt, probeStartedAt: probeStart?.wall,
        startedOffsetMs: probeStart && firstValidMono !== undefined ? probeStart.mono - firstValidMono : undefined,
        receivedAt, late });
      if (record.finishedAt === undefined) record.observationElapsedMs = elapsed();
    };
    // Install both handlers immediately: a cancelled probe may reject later.
    const probing = Promise.resolve().then(() => {
      if (stopReason()) return { status: "invalid" as const, matched: false, executionId: input.binding.executionId, facts: { reason: "not_dispatched" } };
      return dependencies.probe({ sampleIndex: index, timeoutMs,
      signal: controller.signal, markStarted: () => {
        if (!probeStart && !controller.signal.aborted) probeStart = { wall: clock.wallNow(), mono: mono() };
      } });
    }).then(result => ({ result, receivedAt: clock.wallNow() }), () => ({
        result: { status: "invalid" as const, matched: false, executionId: input.binding.executionId,
          facts: { reason: "probe_failed" } }, receivedAt: clock.wallNow(),
      })).then(async value => {
        settled = value;
        if (detached) {
          append(value.result, value.receivedAt, true);
          try { await persist(); } catch (error) { dependencies.onPersistenceError?.(error, copy(record)); }
        }
      });
    while (!settled) {
      const reason = stopReason();
      const timeout = mono() - dispatchMono >= timeoutMs;
      if (reason || timeout) {
        detached = true; controller.abort();
        return finish(reason ?? "probe_timeout");
      }
      await Promise.race([probing, clock.sleep(Math.min(100, timeoutMs - (mono() - dispatchMono), remaining()))]);
    }
    const reason = stopReason();
    const tooLate = mono() - dispatchMono > timeoutMs;
    append(settled.result, settled.receivedAt, !!reason || tooLate);
    if (reason || tooLate) { controller.abort(); return finish(reason ?? "probe_timeout"); }
    const sample = record.samples[record.samples.length - 1];
    if (sample.status !== "valid") return finish(sample.status);
    // First valid response can itself arrive after its observation window.
    if (elapsed() > policy.windowMs) return finish("window_elapsed");
    if (sample.matched) return finish("matched");
    record.state = "observing";
    await persist();
    const nextSampleAt = probeStart!.mono + policy.intervalMs;
    while (mono() < nextSampleAt) {
      const reason = stopReason();
      if (reason) return finish(reason);
      await clock.sleep(Math.min(100, nextSampleAt - mono(), remaining()));
    }
  }
  // Validation prevents this except a broken clock/probe; never call it coverage.
  return finish(stopReason() ?? "invalid");
}
