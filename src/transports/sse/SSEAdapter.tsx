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
import { createResilientEventSource } from '@papercusp/sse';
import { SyncContext } from '../../SyncContext';
import { getQueryClient } from '../polling/queryClient';
import {
  createUsePollingQuery,
  createPrefetchSync,
} from '../polling/usePollingQuery';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';
import { emitSyncBusEvent, type SyncBusEvent } from '../../bus-tap';
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

    // Resilience (jitter, zombie watchdog, backoff, escalation, visibility
    // pause) lives in @papercusp/sse's createResilientEventSource. This
    // subscriber only owns the react-query invalidation/setQueryData
    // wiring + syncMetrics calls. Behavior preserved verbatim against
    // the pre-extraction implementation (libs/sse/src/client/resilient-event-source.ts
    // is the literal port).
    let firstConnect = true;

    const handlePayload = (data: string, parse: 'update' | 'invalidate') => {
      try {
        const ev = JSON.parse(data) as (InvalidateEvent | UpdateEvent) & { tsMs?: number };
        if (!ev?.name) {
          syncMetrics.sseEventReceived(data?.length ?? 0);
          return;
        }
        if (parse === 'update' && !Array.isArray((ev as UpdateEvent).data)) {
          syncMetrics.sseEventReceived(data?.length ?? 0);
          return;
        }
        syncMetrics.sseEventReceived(data?.length ?? 0, ev.tsMs);
        syncMetrics.invalidateFromSse();
        // Fan the raw event out to app-level listeners (bus-tap) so consumers
        // like attention notifiers share THIS stream instead of opening their
        // own EventSource against the same route (each standing stream costs a
        // per-host browser socket).
        emitSyncBusEvent(ev as SyncBusEvent);
        if (parse === 'update') {
          const upd = ev as UpdateEvent;
          const cacheValue = { rows: upd.data, version: String(Date.now()) };
          if (upd.args) {
            queryClient.setQueryData(['sync', upd.name, upd.args], cacheValue);
          } else {
            queryClient.setQueriesData(
              {
                predicate: (q) =>
                  Array.isArray(q.queryKey) &&
                  q.queryKey[0] === 'sync' &&
                  q.queryKey[1] === upd.name,
              },
              cacheValue,
            );
          }
        } else {
          if (ev.args) {
            queryClient.invalidateQueries({ queryKey: ['sync', ev.name, ev.args] });
          } else {
            queryClient.invalidateQueries({
              predicate: (q) =>
                Array.isArray(q.queryKey) &&
                q.queryKey[0] === 'sync' &&
                q.queryKey[1] === ev.name,
            });
          }
        }
      } catch {
        syncMetrics.sseEventReceived(data?.length ?? 0);
      }
    };

    const source = createResilientEventSource({
      url: sseUrl,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      jitter: 0.2,
      // ZOMBIE_TIMEOUT_MS must be > server HEARTBEAT_INTERVAL_MS (15s) by
      // enough margin to absorb network jitter; 30s = one missed-beat grace.
      zombieTimeoutMs: 30_000,
      // After 3 consecutive failures with zero successful opens, escalate
      // via onError so useTransportFallback can move to POLLING.
      maxConsecutiveFailures: 3,
      visibilityPause,
      visibilityPauseMs: VISIBILITY_PAUSE_MS,
      handlers: {
        heartbeat: () => { /* watchdog reset is handled inside the wrapper */ },
        invalidate: (data) => handlePayload(data, 'invalidate'),
        update:     (data) => handlePayload(data, 'update'),
      },
      onOpen: () => {
        syncMetrics.sseConnected();
      },
      onStatusChange: (s) => {
        if (s === 'connecting' && !firstConnect) syncMetrics.sseReconnectAttempt();
        if (s === 'failing' || s === 'closed') syncMetrics.sseDisconnected();
        // 'idle' after firstConnect=false means we transitioned from a live
        // connection (visibility-pause); the metric needs to fire so dashboards
        // see the drop. Initial 'idle' (before any connect) is skipped.
        if (s === 'idle' && !firstConnect) syncMetrics.sseDisconnected();
        if (s !== 'idle' && s !== 'closed') firstConnect = false;
      },
      onError,
    });

    return () => {
      syncMetrics.sseDisconnected();
      source.close();
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
