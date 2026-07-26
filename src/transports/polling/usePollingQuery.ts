'use client';

import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';
import { DEFAULT_MAX_IN_FLIGHT, getQueryFetcher } from './query-fetcher';
import { getQueryClient } from './queryClient';

interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
  /**
   * When set, appended as `?token=<encoded>` to every sync fetch.
   * Needed for clients that auth via query-string (Tauri WebView mobile
   * cross-origin to a JWT-gated endpoint), since the fetcher uses
   * bare `fetch` and can't carry Authorization headers.
   */
  tokenQueryParam?: string;
  /**
   * Max sync requests in flight against this endpoint at once
   * (default `DEFAULT_MAX_IN_FLIGHT` = 24). Shared by the hook, the prefetch
   * helper and `fetchSyncQuery` — see query-fetcher.ts for why a cap is kept
   * even though desktop IPC has no per-host connection limit.
   */
  maxInFlightFetches?: number;
}

// Stable singleton empty array so consumers that depend on `data` reference
// equality (useMemo deps, useCallback deps) don't re-run when the query is
// loading. Without this, every render during loading returns a new `[]`,
// which cascades into infinite re-render loops in downstream components.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

export function createUsePollingQuery(config: PollingConfig) {
  // One fetcher (and one shared concurrency gate) per endpoint. Each query is
  // its own `GET /rest-query`: a refetch wave of ~95 finishes faster this way
  // than as one bundle AND paints incrementally, because a slow query occupies
  // one slot instead of holding the whole wave's results hostage
  // (drop-sync-batcher-2026-07-25 D-001). The gate is what keeps that safe on
  // the two paths where a per-host connection cap is still real: the desktop's
  // pre-`PAPERCUSP_IPC_READY` HTTP fallback, and the `:3055` dev browser.
  const fetchQuery = getQueryFetcher(
    config.restEndpoint,
    config.tokenQueryParam,
    config.maxInFlightFetches ?? DEFAULT_MAX_IN_FLIGHT,
  );

  return function usePollingQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    const { queryName, args = {}, pollIntervalMs, enabled = true, staleTime } = opts;
    const interval = pollIntervalMs ?? config.defaultPollIntervalMs;
    // Stable string key for the args object — useCallback dep that doesn't
    // churn on every render the way the `{}` default would.
    const argsKey = JSON.stringify(args);

    // Each fetcher invocation = a cache miss (network round-trip). Cache
    // hits (data returned without a fetch) are accounted below.
    //
    // Destructuring `signal` is load-bearing, not decoration: react-query only
    // marks a query as abort-signal-consuming when the queryFn *reads* that
    // getter, and only then does it cancel the in-flight request when the last
    // observer unsubscribes. Reading it here is what makes an unmounted panel
    // stop paying for a fetch nobody will render.
    const queryFn = useCallback(
      ({ signal }: { signal: AbortSignal }) => {
        syncMetrics.cacheMiss();
        return fetchQuery(queryName, JSON.parse(argsKey), { signal });
      },
      [queryName, argsKey],
    );

    const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
      // The raw args object is safe here: TanStack v5 hashes query keys
      // structurally (sorted keys), so content-equal args from non-memoized
      // callers map to the same query — no refetch churn (pinned by
      // usePollingQuery.test.tsx, audit P-066). Keep it an OBJECT: the
      // SSEAdapter's exact-match setQueryData/invalidateQueries build keys
      // from server-emitted args objects, which match structurally; a
      // JSON.stringify'd string key would be key-order-sensitive and break
      // that cross-source matching.
      queryKey: ['sync', queryName, args],
      queryFn,
      refetchInterval: interval,
      enabled,
      placeholderData: keepPreviousData,
      ...(staleTime !== undefined ? { staleTime } : {}),
    });

    // Track cache hits: when the hook returns data on the first render without
    // having gone through queryFn (e.g. another subscriber filled the cache,
    // or staleTime kept the entry fresh across a remount). Latched per mount
    // so we don't repeatedly bump the counter on re-renders.
    const recordedRef = useRef(false);
    if (!recordedRef.current && enabled) {
      installSyncMetricsGlobal();
      if (data !== undefined && !isFetching) {
        syncMetrics.cacheHit();
        recordedRef.current = true;
      } else if (!isLoading && !isFetching) {
        // Disabled or no data and not fetching — neither hit nor miss.
        recordedRef.current = true;
      }
    }

    const invalidate = useCallback(() => {
      syncMetrics.invalidateFromManual();
      refetch();
    }, [refetch]);

    return {
      data: ((data as { rows?: T[] } | undefined)?.rows ?? (EMPTY_ARRAY as unknown)) as T[],
      loading: isLoading,
      fetching: isPlaceholderData && isFetching,
      transport: 'POLLING',
      invalidate,
      error: error as Error | null,
    };
  };
}

export function createPrefetchSync(config: PollingConfig, queryClient: QueryClient) {
  const fetchQuery = getQueryFetcher(
    config.restEndpoint,
    config.tokenQueryParam,
    config.maxInFlightFetches ?? DEFAULT_MAX_IN_FLIGHT,
  );
  return function prefetchSync(opts: SyncQueryOptions) {
    const { queryName, args = {} } = opts;
    void queryClient.prefetchQuery({
      queryKey: ['sync', queryName, args],
      queryFn: ({ signal }) => fetchQuery(queryName, args, { signal }),
      staleTime: 30_000,
    });
  };
}

/** Imperative access to the same named-query cache used by useSyncQuery.
 * Useful for async store interfaces (dock layouts) that cannot call hooks. */
export async function fetchSyncQuery<T = unknown>(opts: SyncQueryOptions & {
  restEndpoint?: string;
  tokenQueryParam?: string;
  maxInFlightFetches?: number;
}): Promise<T[]> {
  const {
    queryName,
    args = {},
    staleTime = 30_000,
    restEndpoint = '/api/zero-harness',
    tokenQueryParam,
    maxInFlightFetches,
  } = opts;
  const fetchQuery = getQueryFetcher(restEndpoint, tokenQueryParam, maxInFlightFetches ?? DEFAULT_MAX_IN_FLIGHT);
  const result = await getQueryClient().fetchQuery({
    queryKey: ['sync', queryName, args],
    queryFn: ({ signal }) => fetchQuery(queryName, args, { signal }),
    staleTime,
  });
  return result.rows as T[];
}
