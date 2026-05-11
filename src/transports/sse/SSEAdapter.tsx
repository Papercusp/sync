'use client';

/**
 * SSE Transport — desktop's PRIMARY push transport.
 *
 * Status (2026-05-11): production. The shipping desktop app (Tauri) mounts
 * this adapter via `syncType="SSE"` in HarnessZeroProvider whenever
 * runtime === 'tauri' (detected via `__TAURI_INTERNALS__` +
 * `/api/desktop/version` fingerprint). The server endpoint
 * `apps/operator/app/api/zero-harness/sse/route.ts` emits invalidate /
 * update / heartbeat events backed by PG LISTEN/NOTIFY. Resilience knobs
 * (jitter, zombie watchdog, heartbeat handling, Last-Event-ID-ready) are
 * load-bearing in production.
 *
 * Browser (test / dev) defaults to Zero WS; SSE acts as a fallback there
 * via useTransportFallback when WS fails. The webapp is not the production
 * user surface — see /CLAUDE.md "Deployment model".
 *
 * Earlier header for archival: an older doc-comment (2026-05-06) called this
 * adapter "preserved-but-frozen" alongside libs/sync/PASS_2_1_DECISION.md.
 * That stance was reversed 2026-05-07 when desktop committed to SSE as
 * primary; PASS_2_1_DECISION.md now carries a SUPERSEDED banner.
 *
 * Same fetcher as PollingAdapter (react-query against `${endpoint}/rest-query`)
 * plus an EventSource subscribed to `${endpoint}/sse` that pushes invalidation
 * events. When the server posts `invalidate` for a query name + args, we mark
 * the matching react-query cache key stale so it refetches on the next render.
 *
 * Falls back gracefully:
 *   - No EventSource (older runtimes) → behaves identically to polling.
 *   - EventSource open fails / connection drops → polling cadence still
 *     refreshes data; we reconnect with backoff.
 *
 * Server contract:
 *   GET ${endpoint}/sse
 *     event: invalidate
 *     data: { "name": "queryName", "args"?: {...}, "tsMs"?: <Date.now>  }
 *
 *     event: heartbeat                   ← required, every HEARTBEAT_INTERVAL_MS
 *     data: { "tsMs": <Date.now> }
 *
 *   If `args` is absent, every cached entry under `name` invalidates.
 *   `tsMs` (when present on invalidate) is used to populate
 *   syncMetrics.lastEventLatencyMs. Heartbeats reset the client zombie watchdog.
 *
 *   Reconnect-replay: server SHOULD honor the `Last-Event-ID` header on
 *   reconnect by replaying events with id > Last-Event-ID from a per-workspace
 *   ring buffer. Not yet shipped on the client side either — pass 2.3.
 *
 * Why polling cadence is kept: SSE-driven invalidation is best-effort. A
 * dropped connection or a server bug shouldn't freeze panels. Polling acts
 * as the floor; SSE narrows the staleness window from poll-interval to
 * event-latency when both work.
 *
 * Resilience knobs (pass 1.3):
 *   - Reconnect backoff with ±20% jitter — avoids thundering-herd reconnect
 *     when many tabs disconnect simultaneously (e.g. server restart).
 *   - Zombie watchdog — if no event AND no heartbeat for ZOMBIE_TIMEOUT_MS,
 *     the connection is presumed hung and we force-reconnect. EventSource's
 *     native `error` doesn't fire on quietly hung connections.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { SyncContext } from '../../SyncContext';
import { getQueryClient } from '../polling/queryClient';
import {
  createUsePollingQuery,
  createPrefetchSync,
} from '../polling/usePollingQuery';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';
import type { SyncType } from '../../types';

interface SSEAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  pollIntervalMs?: number;
  onTransportError?: (error: Error) => void;
  schema?: unknown;
  queries?: unknown;
  /** ?token=<value> appended to the SSE URL. EventSource can't carry headers. */
  tokenQueryParam?: string;
  /** Override the SSE endpoint path. Default: `${restEndpoint}/sse`. */
  endpointOverride?: string;
  /** Pause EventSource when document hidden >5min. */
  visibilityPause?: boolean;
}

const DEFAULT_REST_ENDPOINT = 'http://localhost:3100/zero';
const VISIBILITY_PAUSE_MS = 5 * 60_000;

interface InvalidateEvent {
  name: string;
  args?: Record<string, unknown>;
}

interface UpdateEvent {
  name: string;
  args?: Record<string, unknown>;
  data: unknown[];
}

function SSESubscriber({
  endpoint,
  onError,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
}: {
  endpoint: string;
  onError?: (e: Error) => void;
  tokenQueryParam?: string;
  endpointOverride?: string;
  visibilityPause?: boolean;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    installSyncMetricsGlobal();

    // Build the SSE URL once; both the initial open and reconnects use it.
    const baseUrl = endpointOverride ?? `${endpoint}/sse`;
    const sseUrl = tokenQueryParam
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(tokenQueryParam)}`
      : baseUrl;

    let es: EventSource | null = null;
    let backoffMs = 1_000;
    const MAX_BACKOFF_MS = 30_000;
    // ZOMBIE_TIMEOUT_MS must be > server HEARTBEAT_INTERVAL_MS (15s) by enough
    // margin to absorb network jitter; 30s gives one missed heartbeat of grace
    // before we force-reconnect.
    const ZOMBIE_TIMEOUT_MS = 30_000;
    // After this many consecutive connection failures with zero successful
    // open events, escalate via onError so useTransportFallback can move
    // to POLLING. Without this, an SSE adapter mounted against a missing
    // server endpoint retries forever and the chain stalls.
    const MAX_CONSECUTIVE_FAILURES = 3;
    let consecutiveFailures = 0;
    let escalated = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let zombieTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let firstConnect = true;

    /** ±20% jitter on the next backoff so simultaneously-disconnected tabs
     *  don't reconnect in lockstep (thundering herd against a recovering server). */
    const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

    /** Reset the zombie watchdog after any signal of liveness (event or heartbeat). */
    const resetZombieWatchdog = () => {
      if (zombieTimer) clearTimeout(zombieTimer);
      zombieTimer = setTimeout(() => {
        if (cancelled) return;
        // No event + no heartbeat in ZOMBIE_TIMEOUT_MS — force-rebuild even
        // though EventSource hasn't fired `error`. This catches the proxy-
        // hung-the-stream case where the browser thinks the socket is fine.
        syncMetrics.sseDisconnected();
        es?.close();
        es = null;
        const wait = jitter(backoffMs);
        reconnectTimer = setTimeout(connect, wait);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }, ZOMBIE_TIMEOUT_MS);
    };

    const connect = () => {
      if (cancelled) return;
      if (!firstConnect) syncMetrics.sseReconnectAttempt();
      firstConnect = false;
      try {
        es = new EventSource(sseUrl);
      } catch (e) {
        onError?.(e as Error);
        return;
      }

      es.addEventListener('open', () => {
        backoffMs = 1_000; // reset backoff on successful connect
        consecutiveFailures = 0;
        syncMetrics.sseConnected();
        resetZombieWatchdog();
      });

      es.addEventListener('heartbeat', () => {
        // Heartbeats carry no payload of interest beyond proving liveness;
        // we don't bump eventsReceived because they aren't application events.
        resetZombieWatchdog();
      });

      es.addEventListener('invalidate', (raw) => {
        const data = (raw as MessageEvent).data as string;
        resetZombieWatchdog();
        try {
          const ev = JSON.parse(data) as InvalidateEvent & { tsMs?: number };
          if (!ev?.name) {
            syncMetrics.sseEventReceived(data?.length ?? 0);
            return;
          }
          syncMetrics.sseEventReceived(data?.length ?? 0, ev.tsMs);
          syncMetrics.invalidateFromSse();
          if (ev.args) {
            queryClient.invalidateQueries({
              queryKey: ['sync', ev.name, ev.args],
            });
          } else {
            queryClient.invalidateQueries({
              predicate: (q) =>
                Array.isArray(q.queryKey) &&
                q.queryKey[0] === 'sync' &&
                q.queryKey[1] === ev.name,
            });
          }
        } catch {
          syncMetrics.sseEventReceived(data?.length ?? 0);
        }
      });

      // Phase 1 payload-on-invalidate: server sends full result set inline,
      // we drop straight into the cache (no refetch round-trip). Same name+args
      // matching as `event: invalidate`. Cache value envelope `{rows, version}`
      // matches what the polling fetcher returns from /rest-query.
      es.addEventListener('update', (raw) => {
        const data = (raw as MessageEvent).data as string;
        resetZombieWatchdog();
        try {
          const ev = JSON.parse(data) as UpdateEvent & { tsMs?: number };
          if (!ev?.name || !Array.isArray(ev.data)) {
            syncMetrics.sseEventReceived(data?.length ?? 0);
            return;
          }
          syncMetrics.sseEventReceived(data?.length ?? 0, ev.tsMs);
          syncMetrics.invalidateFromSse();
          const cacheValue = { rows: ev.data, version: String(Date.now()) };
          if (ev.args) {
            queryClient.setQueryData(['sync', ev.name, ev.args], cacheValue);
          } else {
            queryClient.setQueriesData(
              {
                predicate: (q) =>
                  Array.isArray(q.queryKey) &&
                  q.queryKey[0] === 'sync' &&
                  q.queryKey[1] === ev.name,
              },
              cacheValue,
            );
          }
        } catch {
          syncMetrics.sseEventReceived(data?.length ?? 0);
        }
      });

      es.addEventListener('error', () => {
        // Browser auto-reconnects, but on hard failures it stops; rebuild.
        if (cancelled) return;
        syncMetrics.sseDisconnected();
        es?.close();
        es = null;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !escalated) {
          escalated = true;
          // Bubble to useTransportFallback so the chain advances to POLLING.
          // Don't return — we still set a (long) reconnect timer in case the
          // server comes back later; a successful connection resets escalated
          // so the chain wouldn't re-fire repeatedly.
          onError?.(
            new Error(
              `SSE connection to ${sseUrl} failed ${consecutiveFailures} consecutive times`,
            ),
          );
        }
        const wait = jitter(backoffMs);
        reconnectTimer = setTimeout(connect, wait);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      });
    };

    // Visibility-pause: when the document hits hidden for VISIBILITY_PAUSE_MS,
    // close the EventSource. Reopen on visibility return. Saves battery on
    // phones and idle background tabs without affecting the polling fallback
    // (which still ticks per pollIntervalMs while paused).
    let hiddenSinceTimer: ReturnType<typeof setTimeout> | null = null;
    let pausedByVisibility = false;
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        if (hiddenSinceTimer) return;
        hiddenSinceTimer = setTimeout(() => {
          hiddenSinceTimer = null;
          if (cancelled) return;
          if (!es) return;
          pausedByVisibility = true;
          syncMetrics.sseDisconnected();
          es.close();
          es = null;
          if (zombieTimer) { clearTimeout(zombieTimer); zombieTimer = null; }
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        }, VISIBILITY_PAUSE_MS);
      } else {
        if (hiddenSinceTimer) { clearTimeout(hiddenSinceTimer); hiddenSinceTimer = null; }
        if (pausedByVisibility) {
          pausedByVisibility = false;
          // Reset backoff so we connect immediately on return.
          backoffMs = 1_000;
          connect();
        }
      }
    };
    if (visibilityPause && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (zombieTimer) clearTimeout(zombieTimer);
      if (hiddenSinceTimer) clearTimeout(hiddenSinceTimer);
      if (visibilityPause && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      syncMetrics.sseDisconnected();
      es?.close();
    };
  }, [endpoint, queryClient, onError, tokenQueryParam, endpointOverride, visibilityPause]);

  return null;
}

export function SSEAdapter({
  children,
  restEndpoint,
  server,
  pollIntervalMs = 10_000,
  onTransportError,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
}: SSEAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () =>
      createUsePollingQuery({
        restEndpoint: endpoint,
        defaultPollIntervalMs: pollIntervalMs,
        tokenQueryParam,
      }),
    [endpoint, pollIntervalMs, tokenQueryParam],
  );

  const prefetch = useMemo(
    () =>
      createPrefetchSync(
        { restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs, tokenQueryParam },
        queryClient,
      ),
    [endpoint, pollIntervalMs, tokenQueryParam, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'SSE' as SyncType, useDataImpl, prefetch }),
    [useDataImpl, prefetch],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SyncContext.Provider value={ctxValue}>
        <SSESubscriber
          endpoint={endpoint}
          onError={onTransportError}
          tokenQueryParam={tokenQueryParam}
          endpointOverride={endpointOverride}
          visibilityPause={visibilityPause}
        />
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
