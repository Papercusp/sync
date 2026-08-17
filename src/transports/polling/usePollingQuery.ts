'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';
import { normalizeDemoPrincipal, syncQueryKey } from '../../principal';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';
import { getBatchFetcher } from './batch-fetcher';

export interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
  /**
   * When set, appended as `?token=<encoded>` to every batch fetch.
   * Needed for clients that auth via query-string (Tauri WebView mobile
   * cross-origin to a JWT-gated endpoint), since the batch fetcher uses
   * bare `fetch` and can't carry Authorization headers.
   */
  tokenQueryParam?: string;
  principal?: string | null;
}

// Stable singleton empty array so consumers that depend on `data` reference
// equality (useMemo deps, useCallback deps) don't re-run when the query is
// loading. Without this, every render during loading returns a new `[]`,
// which cascades into infinite re-render loops in downstream components.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

/**
 * Resolve one `queryName` + `args` over REST, with batching, polling and the
 * react-query cache. This is the whole polling transport, factored out as a
 * plain hook so it can be reached from TWO places:
 *
 *  - `createUsePollingQuery` below, which binds it to an adapter's config and
 *    is what `useSyncQuery` calls on the POLLING/SSE transports;
 *  - `useRestSyncQuery` (../../useRestSyncQuery), which binds it to the
 *    SyncContext's endpoint so a call site can force the REST path on ANY
 *    transport — including WEBSOCKETS, where the Zero registry has no leaf
 *    for the name and `resolveQuery` would throw (WI-39772).
 *
 * Requires a `QueryClientProvider` above it; every adapter mounts one.
 */
export function useRestQuery<T = any>(
  config: PollingConfig,
  opts: SyncQueryOptions,
): SyncQueryResult<T> {
  const { queryName, args = {}, pollIntervalMs, enabled = true, staleTime } = opts;
  const interval = pollIntervalMs ?? config.defaultPollIntervalMs;

  // One batching fetcher per (endpoint, token, principal) — every query
  // refetch (initial hydration, poll tick, SSE-invalidate wave) coalesces into
  // a single `POST /rest-query-batch` instead of ~40 parallel `GET`s that
  // would exhaust the browser's 6-connection-per-host HTTP/1.1 cap.
  // `getBatchFetcher` is memoized on that key, so calling it per render is
  // cheap and returns a stable reference.
  const principal = normalizeDemoPrincipal(config.principal);
  const batchFetch = getBatchFetcher(config.restEndpoint, config.tokenQueryParam, principal);

  // Stable string key for the args object — useCallback dep that doesn't
  // churn on every render the way the `{}` default would.
  const argsKey = JSON.stringify(args);

  // Each fetcher invocation = a cache miss (network round-trip). Cache
  // hits (data returned without a fetch) are accounted below.
  const queryFn = useCallback(() => {
    syncMetrics.cacheMiss();
    return batchFetch(queryName, JSON.parse(argsKey));
  }, [batchFetch, queryName, argsKey]);

  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
    queryKey: syncQueryKey(principal, queryName, args),
    queryFn,
    refetchInterval: interval,
    enabled,
    // Keep placeholder data only within the same principal. TanStack's
    // unconditional keepPreviousData crosses query-key changes and briefly
    // rendered the previous demo user's private rows during impersonation.
    placeholderData: (previousData, previousQuery) => (
      previousQuery?.queryKey[1] === principal ? previousData : undefined
    ),
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
    // How the DATA was resolved, not which provider is mounted: this is the
    // REST/batch path either way, which is what `POLLING` has always meant
    // here. A `useRestSyncQuery` call under WEBSOCKETS reports POLLING for
    // that reason.
    transport: 'POLLING',
    invalidate,
    error: error as Error | null,
  };
}

export function createUsePollingQuery(config: PollingConfig) {
  return function usePollingQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    return useRestQuery<T>(config, opts);
  };
}

export function createPrefetchSync(config: PollingConfig, queryClient: QueryClient) {
  const principal = normalizeDemoPrincipal(config.principal);
  const batchFetch = getBatchFetcher(config.restEndpoint, config.tokenQueryParam, principal);
  return function prefetchSync(opts: SyncQueryOptions) {
    const { queryName, args = {} } = opts;
    void queryClient.prefetchQuery({
      queryKey: syncQueryKey(principal, queryName, args),
      queryFn: () => batchFetch(queryName, args),
      staleTime: 30_000,
    });
  };
}
