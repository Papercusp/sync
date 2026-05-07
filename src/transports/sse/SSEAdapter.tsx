'use client';

/**
 * SSE Transport — real implementation.
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
 *     data: { "name": "queryName", "args"?: {...} }
 *
 *   If `args` is absent, every cached entry under `name` invalidates.
 *
 * Why polling cadence is kept: SSE-driven invalidation is best-effort. A
 * dropped connection or a server bug shouldn't freeze panels. Polling acts
 * as the floor; SSE narrows the staleness window from poll-interval to
 * event-latency when both work.
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
}

const DEFAULT_REST_ENDPOINT = 'http://localhost:3100/zero';

interface InvalidateEvent {
  name: string;
  args?: Record<string, unknown>;
}

function SSESubscriber({
  endpoint,
  onError,
}: {
  endpoint: string;
  onError?: (e: Error) => void;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    installSyncMetricsGlobal();

    let es: EventSource | null = null;
    let backoffMs = 1_000;
    const MAX_BACKOFF_MS = 30_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let firstConnect = true;

    const connect = () => {
      if (cancelled) return;
      if (!firstConnect) syncMetrics.sseReconnectAttempt();
      firstConnect = false;
      try {
        es = new EventSource(`${endpoint}/sse`);
      } catch (e) {
        onError?.(e as Error);
        return;
      }

      es.addEventListener('open', () => {
        backoffMs = 1_000; // reset backoff on successful connect
        syncMetrics.sseConnected();
      });

      es.addEventListener('invalidate', (raw) => {
        const data = (raw as MessageEvent).data as string;
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
            // Drop all cached entries for this query name regardless of args.
            queryClient.invalidateQueries({
              predicate: (q) =>
                Array.isArray(q.queryKey) &&
                q.queryKey[0] === 'sync' &&
                q.queryKey[1] === ev.name,
            });
          }
        } catch {
          syncMetrics.sseEventReceived(data?.length ?? 0);
          /* malformed event — counter only, no invalidate */
        }
      });

      es.addEventListener('error', () => {
        // Browser auto-reconnects, but on hard failures it stops; rebuild.
        if (cancelled) return;
        syncMetrics.sseDisconnected();
        es?.close();
        es = null;
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      syncMetrics.sseDisconnected();
      es?.close();
    };
  }, [endpoint, queryClient, onError]);

  return null;
}

export function SSEAdapter({
  children,
  restEndpoint,
  server,
  pollIntervalMs = 10_000,
  onTransportError,
}: SSEAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () =>
      createUsePollingQuery({
        restEndpoint: endpoint,
        defaultPollIntervalMs: pollIntervalMs,
      }),
    [endpoint, pollIntervalMs],
  );

  const prefetch = useMemo(
    () =>
      createPrefetchSync(
        { restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs },
        queryClient,
      ),
    [endpoint, pollIntervalMs, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'SSE' as SyncType, useDataImpl, prefetch }),
    [useDataImpl, prefetch],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SyncContext.Provider value={ctxValue}>
        <SSESubscriber endpoint={endpoint} onError={onTransportError} />
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
