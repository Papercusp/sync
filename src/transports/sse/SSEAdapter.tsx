'use client';

/**
 * SSE Transport — SideStage's PRIMARY push transport in the deployed stack.
 *
 * Status (2026-08-17): production. The web app at sidestage.papercusp.com IS
 * the production user surface (alongside mobile v1.0.0). It mounts
 * `SyncProvider` with `syncType="WEBSOCKETS"` (`apps/web/src/main.tsx:41`),
 * but that names a PREFERENCE, not the active rung: the up-front WS handshake
 * probe only succeeds when a zero-cache is listening at the configured origin
 * (`${window.location.origin}/zero` in a deployed build). Nothing serves that
 * origin today, so the probe fails within WS_PROBE_MS and every client steps
 * down to this adapter (`SyncProvider.tsx:296-299`). SSE therefore carries
 * real user traffic, and its resilience knobs (jitter, zombie watchdog,
 * heartbeat handling, Last-Event-ID-ready) are load-bearing in production.
 *
 * The server endpoint is the API's `@Sse('sse')` route
 * (`apps/api/src/sync/sync.controller.ts:65`).
 *
 * Earlier header for archival: an older doc-comment (2026-05-06) called this
 * adapter "preserved-but-frozen" alongside libs/sync/PASS_2_1_DECISION.md;
 * that stance was reversed when SSE became the transport actually serving
 * users. PASS_2_1_DECISION.md now carries a SUPERSEDED banner.
 *
 * NOTE (2026-08-17): the previous header was BORROWED papercusp text and was
 * wrong for this repo in every deployment particular — it described a Tauri
 * desktop app mounting `syncType="SSE"` via HarnessZeroProvider, cited
 * `apps/operator/app/api/zero-harness/sse/route.ts`, and pointed at
 * /CLAUDE.md "Deployment model" to claim the webapp is NOT the production
 * surface. None of those exist here: `apps/` holds only `api` and `web`,
 * there is no CLAUDE.md anywhere in the tree, and `__TAURI_INTERNALS__`
 * appeared nowhere but in that comment. Verified against the tree, and the
 * surface question ruled by the fleet leader, 2026-08-17 (D-006 item 7).
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
import type { SyncType } from '../../types';
import {
  appendDemoPrincipalQuery,
  normalizeDemoPrincipal,
  syncQueryKey,
  type DemoPrincipal,
} from '../../principal';

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
  principal,
}: {
  endpoint: string;
  onError?: (e: Error) => void;
  tokenQueryParam?: string;
  endpointOverride?: string;
  visibilityPause?: boolean;
  principal: DemoPrincipal;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    installSyncMetricsGlobal();

    // Build the SSE URL once; both the initial open and reconnects use it.
    const baseUrl = endpointOverride ?? `${endpoint}/sse`;
    const authenticatedUrl = tokenQueryParam
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(tokenQueryParam)}`
      : baseUrl;
    const sseUrl = appendDemoPrincipalQuery(authenticatedUrl, principal);

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
        if (parse === 'update') {
          const upd = ev as UpdateEvent;
          const cacheValue = { rows: upd.data, version: String(Date.now()) };
          if (upd.args) {
            queryClient.setQueryData(syncQueryKey(principal, upd.name, upd.args), cacheValue);
          } else {
            queryClient.setQueriesData(
              {
                predicate: (q) =>
                  Array.isArray(q.queryKey) &&
                  q.queryKey[0] === 'sync' &&
                  q.queryKey[1] === principal &&
                  q.queryKey[2] === upd.name,
              },
              cacheValue,
            );
          }
        } else {
          if (ev.args) {
            queryClient.invalidateQueries({ queryKey: syncQueryKey(principal, ev.name, ev.args) });
          } else {
            queryClient.invalidateQueries({
              predicate: (q) =>
                Array.isArray(q.queryKey) &&
                q.queryKey[0] === 'sync' &&
                q.queryKey[1] === principal &&
                q.queryKey[2] === ev.name,
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
  }, [endpoint, queryClient, onError, tokenQueryParam, endpointOverride, visibilityPause, principal]);

  return null;
}

export function SSEAdapter({
  children,
  userId,
  restEndpoint,
  server,
  pollIntervalMs = 10_000,
  onTransportError,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
}: SSEAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  const principal = normalizeDemoPrincipal(userId);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () =>
      createUsePollingQuery({
        restEndpoint: endpoint,
        defaultPollIntervalMs: pollIntervalMs,
        tokenQueryParam,
        principal,
      }),
    [endpoint, pollIntervalMs, principal, tokenQueryParam],
  );

  const prefetch = useMemo(
    () =>
      createPrefetchSync(
        { restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs, tokenQueryParam, principal },
        queryClient,
      ),
    [endpoint, pollIntervalMs, principal, tokenQueryParam, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'SSE' as SyncType, principal, useDataImpl, prefetch }),
    [principal, useDataImpl, prefetch],
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
          principal={principal}
        />
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
