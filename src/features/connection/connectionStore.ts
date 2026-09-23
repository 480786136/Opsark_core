import { defineStore } from "pinia";
import { reactive } from "vue";
import { backend, type RuntimeConnection } from "@/services/backend";

export type ServerConnectionStatus = "idle" | "connecting" | "connected" | "suspect"
  | "reconnecting" | "manual" | "auth_failed" | "disconnected";

export interface ServerConnectionState {
  status: ServerConnectionStatus;
  phase: string;
  error?: string;
  attempt: number;
  startedAt?: number;
  lastSuccessAt?: number;
  generation: number;
  nextRetryAt?: number;
}

export const CONNECTION_POLICY = {
  healthIntervalMs: 10_000,
  healthTimeoutMs: 5_000,
  connectTimeoutMs: 15_000,
  retryDelaysMs: [2_000, 5_000, 10_000],
  recoveryBudgetMs: 60_000,
  stableWindowMs: 60_000,
} as const;

const MIN_BACKEND_TIMEOUT_MS = 250;
const monotonicNow = () => performance.now();

export function isAuthenticationFailure(reason: string) {
  return /SSH_AUTH_FAILED|用户名或密码不正确|身份认证失败|身份验证失败|authentication failed/i.test(reason);
}

export function isConnectionTransportFailure(reason: string) {
  return /SSH_(?:NETWORK|TIMEOUT|DNS|HANDSHAKE|AUTH)|SSH 网络|SSH 握手|身份认证|身份验证|用户名或密码|连接超时|连接已断|connection (?:timed out|reset|refused|closed)|host is down|no route to host|network (?:is unreachable|unreachable)|broken pipe|socket|transport|failure while draining incoming flow|连接.*失败|服务器.*失联|session.*disconnect/i.test(reason);
}

export function connectionErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^(?:Error:\s*)?SSH_[A-Z_]+:\s*/, "").slice(0, 600);
}

interface Runtime {
  credentials?: RuntimeConnection;
  lastProbeAt: number;
  failedProbes: number;
  recoveryStartedAt?: number;
  recoveryStartedWallAt?: number;
  nextRetryAt?: number;
  connectedSince?: number;
  automatic: boolean;
  intent: number;
  failureVersion: number;
  pending?: Promise<boolean>;
  request?: { credentials: RuntimeConnection; promise: Promise<boolean> };
}

function sameCredentials(left: RuntimeConnection | undefined, right: RuntimeConnection) {
  return Boolean(left && left.host === right.host && left.port === right.port
    && left.username === right.username && left.password === right.password);
}

/** One logical connection coordinator per server. Credentials never enter persisted state. */
export const useConnectionStore = defineStore("server-connections", () => {
  const states = reactive<Record<string, ServerConnectionState>>({});
  const runtimes = new Map<string, Runtime>();

  function state(serverId: string): ServerConnectionState {
    states[serverId] ??= { status: "idle", phase: "等待连接", attempt: 0, generation: 0 };
    // Read back through Vue's proxy: the assignment expression itself returns
    // the raw initializer and would leave first-render consumers non-reactive.
    return states[serverId];
  }

  function runtime(serverId: string) {
    let value = runtimes.get(serverId);
    if (!value) {
      value = { lastProbeAt: 0, failedProbes: 0, automatic: false, intent: 0, failureVersion: 0 };
      runtimes.set(serverId, value);
    }
    return value;
  }

  function isConnected(serverId: string) { return state(serverId).status === "connected"; }

  function connection(serverId: string): RuntimeConnection | undefined {
    const credentials = runtime(serverId).credentials;
    return isConnected(serverId) && credentials ? { ...credentials } : undefined;
  }

  function manual(serverId: string, reason: string) {
    const current = state(serverId);
    const run = runtime(serverId);
    current.status = isAuthenticationFailure(reason) ? "auth_failed" : "manual";
    current.phase = current.status === "auth_failed" ? "身份验证失败" : "等待手动重连";
    current.error = connectionErrorMessage(reason);
    current.nextRetryAt = undefined;
    run.nextRetryAt = undefined;
    run.connectedSince = undefined;
    run.automatic = false;
  }

  function online(serverId: string) {
    const current = state(serverId);
    const run = runtime(serverId);
    const now = monotonicNow();
    current.status = "connected";
    current.phase = "SSH 已连接";
    current.error = undefined;
    current.lastSuccessAt = Date.now();
    current.nextRetryAt = undefined;
    run.nextRetryAt = undefined;
    run.lastProbeAt = now;
    run.failedProbes = 0;
    run.connectedSince ??= now;
  }

  function scheduleRecovery(serverId: string, reason: string) {
    const current = state(serverId);
    const run = runtime(serverId);
    if (isAuthenticationFailure(reason) || /SSH_INVALID_CONFIG/.test(reason)) {
      manual(serverId, reason);
      return;
    }
    if (!run.automatic || !run.credentials) { manual(serverId, reason); return; }
    const now = monotonicNow();
    run.recoveryStartedAt ??= now;
    run.recoveryStartedWallAt ??= Date.now();
    run.connectedSince = undefined;
    const remaining = CONNECTION_POLICY.recoveryBudgetMs - (now - run.recoveryStartedAt);
    if (current.attempt >= CONNECTION_POLICY.retryDelaysMs.length
      || remaining < MIN_BACKEND_TIMEOUT_MS) {
      manual(serverId, reason);
      return;
    }
    current.status = "reconnecting";
    current.phase = "等待自动重连";
    current.error = connectionErrorMessage(reason);
    current.startedAt = run.recoveryStartedWallAt;
    const delay = Math.min(CONNECTION_POLICY.retryDelaysMs[current.attempt], remaining);
    run.nextRetryAt = now + delay;
    current.nextRetryAt = Date.now() + delay;
  }

  // The Rust command has the same total deadline. Adding grace time here would
  // extend the recovery budget; generation checks reject late bridge results.
  async function boundedCheck(credentials: RuntimeConnection, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        backend.checkSshConnection(credentials, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("SSH_TIMEOUT: SSH 连接确认超时")), timeoutMs);
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function attemptConnection(serverId: string, automatic: boolean): Promise<boolean> {
    const current = state(serverId);
    const run = runtime(serverId);
    if (run.pending) return run.pending;
    if (!run.credentials) { manual(serverId, "未找到 SSH 凭据，请填写密码后连接"); return Promise.resolve(false); }
    const now = monotonicNow();
    const budget = automatic
      ? CONNECTION_POLICY.recoveryBudgetMs - (now - (run.recoveryStartedAt ?? now))
      : CONNECTION_POLICY.connectTimeoutMs;
    if (budget < MIN_BACKEND_TIMEOUT_MS) {
      manual(serverId, current.error || "自动重连时间已耗尽");
      return Promise.resolve(false);
    }
    const timeoutMs = Math.floor(Math.min(CONNECTION_POLICY.connectTimeoutMs, budget));
    const deadline = now + timeoutMs;
    const generation = ++current.generation;
    const intent = run.intent;
    current.status = automatic ? "reconnecting" : "connecting";
    current.phase = "正在验证 SSH 连接";
    current.startedAt = automatic ? run.recoveryStartedWallAt : Date.now();
    current.nextRetryAt = undefined;
    run.nextRetryAt = undefined;
    if (automatic) current.attempt += 1;
    const credentials = { ...run.credentials };
    const isCurrent = () => state(serverId).generation === generation
      && run.intent === intent && run.automatic;
    let pending!: Promise<boolean>;
    pending = (async () => {
      try {
        await boundedCheck(credentials, timeoutMs);
        if (!isCurrent()) return false;
        if (monotonicNow() >= deadline) throw new Error("SSH_TIMEOUT: SSH 连接确认超时");
        online(serverId);
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        // Initial network failures share the bounded automatic recovery policy;
        // authentication failures stop without repeating rejected credentials.
        scheduleRecovery(serverId, String(error));
        return false;
      } finally { if (run.pending === pending) run.pending = undefined; }
    })();
    run.pending = pending;
    return pending;
  }

  function connect(serverId: string, credentials: RuntimeConnection): Promise<boolean> {
    const run = runtime(serverId);
    const current = state(serverId);
    if (run.automatic && run.request && sameCredentials(run.request.credentials, credentials)) {
      return run.request.promise;
    }
    if (run.automatic && !run.request && run.pending && sameCredentials(run.credentials, credentials)) {
      return run.pending;
    }
    // Different credentials represent a new intent, not a double click. Reject
    // old results immediately, but serialize the latest request behind bounded
    // in-flight work. Intermediate queued requests must never win afterward.
    const outstanding = run.pending;
    const intent = ++run.intent;
    current.generation += 1;
    run.credentials = { ...credentials };
    run.automatic = true;
    run.failedProbes = 0;
    run.recoveryStartedAt = undefined;
    run.recoveryStartedWallAt = undefined;
    run.nextRetryAt = undefined;
    run.connectedSince = undefined;
    current.attempt = 0;
    current.error = undefined;
    current.status = "connecting";
    current.phase = outstanding ? "等待上一轮连接结束" : "正在验证 SSH 连接";
    current.startedAt = Date.now();
    current.nextRetryAt = undefined;
    let promise!: Promise<boolean>;
    promise = (async () => {
      if (outstanding) await outstanding;
      if (run.intent !== intent || !run.automatic) return false;
      return await attemptConnection(serverId, false);
    })().finally(() => {
      if (run.request?.promise === promise) run.request = undefined;
    });
    run.request = { credentials: { ...credentials }, promise };
    return promise;
  }

  function checkHealth(serverId: string): Promise<boolean> {
    const current = state(serverId);
    const run = runtime(serverId);
    if (run.pending) return run.pending;
    if (!run.automatic || !run.credentials || !["connected", "suspect"].includes(current.status)) {
      return Promise.resolve(false);
    }
    const generation = current.generation;
    const intent = run.intent;
    const failureVersion = run.failureVersion;
    run.lastProbeAt = monotonicNow();
    const deadline = run.lastProbeAt + CONNECTION_POLICY.healthTimeoutMs;
    const isCurrent = () => state(serverId).generation === generation
      && run.intent === intent && run.automatic;
    let pending!: Promise<boolean>;
    pending = (async () => {
      try {
        await boundedCheck({ ...run.credentials! }, CONNECTION_POLICY.healthTimeoutMs);
        if (!isCurrent()) return false;
        if (monotonicNow() >= deadline) throw new Error("SSH_TIMEOUT: SSH 连接确认超时");
        // A later transport failure needs a fresh check; an older in-flight
        // success cannot erase that newer evidence or reset stability.
        if (run.failureVersion !== failureVersion) {
          run.lastProbeAt = Number.NEGATIVE_INFINITY;
          return false;
        }
        online(serverId);
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        run.failedProbes += 1;
        run.connectedSince = undefined;
        current.error = connectionErrorMessage(error);
        if (isAuthenticationFailure(String(error)) || run.failedProbes >= 2) {
          current.generation += 1;
          scheduleRecovery(serverId, String(error));
        } else {
          current.status = "suspect";
          current.phase = "正在确认连接";
        }
        return false;
      } finally { if (run.pending === pending) run.pending = undefined; }
    })();
    run.pending = pending;
    return pending;
  }

  function reportFailure(serverId: string, reason: string) {
    const current = state(serverId);
    if (!["connected", "suspect"].includes(current.status)) return;
    const run = runtime(serverId);
    run.connectedSince = undefined;
    run.failureVersion += 1;
    if (isAuthenticationFailure(reason)) {
      current.generation += 1;
      manual(serverId, reason);
      return;
    }
    current.status = "suspect";
    current.phase = "正在确认连接";
    current.error = connectionErrorMessage(reason);
    void checkHealth(serverId);
  }

  function tick(serverIds: readonly string[], force = false) {
    const now = monotonicNow();
    for (const serverId of serverIds) {
      const current = state(serverId);
      const run = runtime(serverId);
      if (!run.automatic) continue;
      // Focus/visibility events request a background check, not a failure.
      // Keep healthy sessions online and reuse any check already in flight.
      // Only actual transport/probe failures may enter the suspect state.
      if (run.recoveryStartedAt !== undefined
        && now - run.recoveryStartedAt >= CONNECTION_POLICY.recoveryBudgetMs
        && ["reconnecting", "suspect"].includes(current.status)) {
        current.generation += 1;
        manual(serverId, current.error || "自动重连时间已耗尽");
        continue;
      }
      if (run.pending || run.request) continue;
      if (current.status === "connected" && run.connectedSince !== undefined
        && now - run.connectedSince >= CONNECTION_POLICY.stableWindowMs) {
        current.attempt = 0;
        run.recoveryStartedAt = undefined;
        run.recoveryStartedWallAt = undefined;
      }
      if (["connected", "suspect"].includes(current.status)
        && (force || now - run.lastProbeAt >= CONNECTION_POLICY.healthIntervalMs)) {
        void checkHealth(serverId);
      } else if (current.status === "reconnecting" && run.nextRetryAt !== undefined
        && now >= run.nextRetryAt) {
        void attemptConnection(serverId, true);
      }
    }
  }

  function disconnect(serverId: string) {
    const current = state(serverId);
    const run = runtime(serverId);
    current.generation += 1;
    current.status = "disconnected";
    current.phase = "已断开连接";
    current.error = undefined;
    current.nextRetryAt = undefined;
    run.intent += 1;
    run.automatic = false;
    run.credentials = undefined;
    run.connectedSince = undefined;
    run.nextRetryAt = undefined;
  }

  function forget(serverId: string) {
    disconnect(serverId);
    // Keep generation and intent tombstones until outstanding callbacks finish.
  }

  return { states, state, isConnected, connection, connect, checkHealth, reportFailure, tick, disconnect, forget };
});
