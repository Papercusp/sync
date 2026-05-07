/**
 * Sync metrics shim.
 *
 * Lightweight in-memory counters for the sync layer. Exposed on
 * `window.__sync_metrics__` so they're inspectable from DevTools without
 * any UI plumbing, and consumable later by a /api/sync-metrics POST shim
 * (deferred — wait for real signal before defining the wire format).
 *
 * Designed to be effectively free in the hot path: integer increments,
 * no allocations per event, no async work.
 *
 * Counters reset only on full page reload. If a longer-running aggregation
 * window is needed, the consumer reads `__sync_metrics__.snapshot()` on a
 * timer and computes deltas.
 */

export interface SyncMetricsSnapshot {
  /** ms since process start (performance.now-based) when this snapshot was taken. */
  takenAtMs: number;
  sse: {
    /** ms since the current connection opened, or null when disconnected. */
    connectedSinceMs: number | null;
    /** Total reconnect attempts since page load (excludes the first connect). */
    reconnectCount: number;
    /** Total SSE events received from the server. */
    eventsReceived: number;
    /** Latest server→client event latency in ms, or null if not yet measured.
     *  Requires server-side event timestamps; currently no-op until Pass 2.2. */
    lastEventLatencyMs: number | null;
    /** Total bytes received over the SSE stream (best-effort, JSON.length). */
    bytesReceived: number;
  };
  cache: {
    /** Queries served from the react-query cache without a network round-trip. */
    hits: number;
    /** Queries that triggered a network fetch (initial load + post-stale refetch). */
    misses: number;
  };
  invalidations: {
    /** Invalidations triggered by an SSE/WS push. */
    fromSse: number;
    /** Invalidations triggered by react-query's polling interval (timer). */
    fromTimer: number;
    /** Invalidations triggered explicitly via the result.invalidate() callback. */
    fromManual: number;
  };
}

interface MetricsState {
  sse: {
    connectedAt: number | null;
    reconnectCount: number;
    eventsReceived: number;
    lastEventLatencyMs: number | null;
    bytesReceived: number;
  };
  cache: { hits: number; misses: number };
  invalidations: { fromSse: number; fromTimer: number; fromManual: number };
}

const state: MetricsState = {
  sse: {
    connectedAt: null,
    reconnectCount: 0,
    eventsReceived: 0,
    lastEventLatencyMs: null,
    bytesReceived: 0,
  },
  cache: { hits: 0, misses: 0 },
  invalidations: { fromSse: 0, fromTimer: 0, fromManual: 0 },
};

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export const syncMetrics = {
  // SSE lifecycle
  sseConnected(): void {
    state.sse.connectedAt = now();
  },
  sseDisconnected(): void {
    state.sse.connectedAt = null;
  },
  sseReconnectAttempt(): void {
    state.sse.reconnectCount++;
  },
  sseEventReceived(byteLen: number, serverEmittedAtMs?: number): void {
    state.sse.eventsReceived++;
    state.sse.bytesReceived += byteLen;
    if (serverEmittedAtMs !== undefined) {
      // Server uses Date.now(); we use Date.now() here too so the math lines up
      // even though performance.now() is preferred elsewhere. Clock skew between
      // client and server makes this approximate; it's still useful for trends.
      const deltaMs = Date.now() - serverEmittedAtMs;
      state.sse.lastEventLatencyMs = deltaMs >= 0 ? deltaMs : 0;
    }
  },
  // Cache events
  cacheHit(): void {
    state.cache.hits++;
  },
  cacheMiss(): void {
    state.cache.misses++;
  },
  // Invalidation source
  invalidateFromSse(): void {
    state.invalidations.fromSse++;
  },
  invalidateFromTimer(): void {
    state.invalidations.fromTimer++;
  },
  invalidateFromManual(): void {
    state.invalidations.fromManual++;
  },
  // Snapshot for inspection / future POST
  snapshot(): SyncMetricsSnapshot {
    return {
      takenAtMs: now(),
      sse: {
        connectedSinceMs:
          state.sse.connectedAt !== null ? now() - state.sse.connectedAt : null,
        reconnectCount: state.sse.reconnectCount,
        eventsReceived: state.sse.eventsReceived,
        lastEventLatencyMs: state.sse.lastEventLatencyMs,
        bytesReceived: state.sse.bytesReceived,
      },
      cache: { ...state.cache },
      invalidations: { ...state.invalidations },
    };
  },
  // Test/debug only — wipe counters.
  __resetForTests(): void {
    state.sse.connectedAt = null;
    state.sse.reconnectCount = 0;
    state.sse.eventsReceived = 0;
    state.sse.lastEventLatencyMs = null;
    state.sse.bytesReceived = 0;
    state.cache.hits = 0;
    state.cache.misses = 0;
    state.invalidations.fromSse = 0;
    state.invalidations.fromTimer = 0;
    state.invalidations.fromManual = 0;
  },
};

/**
 * Install the metrics object on `window.__sync_metrics__`. Idempotent —
 * calling twice from different transport mounts won't re-install. Call from
 * each adapter's mount effect so the global is available regardless of which
 * transport is active.
 */
export function installSyncMetricsGlobal(): void {
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__sync_metrics__) return;
  w.__sync_metrics__ = {
    snapshot: () => syncMetrics.snapshot(),
    // Convenience: pretty-print to console.
    log: () => {
      // eslint-disable-next-line no-console
      console.table(syncMetrics.snapshot());
    },
  };
}
