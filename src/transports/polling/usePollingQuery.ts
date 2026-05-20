'use client';

import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';
import { getBatchFetcher } from './batch-fetcher';

interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
  /**
   * When set, appended as `?token=<encoded>` to every batch fetch.
   * Needed for clients that auth via query-string (Tauri WebView mobile
   * cross-origin to a JWT-gated endpoint), since the batch fetcher uses
   * bare `fetch` and can't carry Authorization headers.
   */
  tokenQueryParam?: string;
}

// Stable singleton empty array so consumers that depend on `data` reference
// equality (useMemo deps, useCallback deps) don't re-run when the query is
// loading. Without this, every render during loading returns a new `[]`,
// which cascades into infinite re-render loops in downstream components.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

export function createUsePollingQuery(config: PollingConfig) {
  // One batching fetcher per endpoint — every query refetch (initial
  // hydration, poll tick, SSE-invalidate wave) coalesces into a single
  // `POST /rest-query-batch` instead of ~40 parallel `GET`s that would
  // exhaust the browser's 6-connection-per-host HTTP/1.1 cap.
  const batchFetch = getBatchFetcher(config.restEndpoint, config.tokenQueryParam);

  return function usePollingQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    const { queryName, args = {}, pollIntervalMs, enabled = true, staleTime } = opts;
    const interval = pollIntervalMs ?? config.defaultPollIntervalMs;
    // Stable string key for the args object — useCallback dep that doesn't
    // churn on every render the way the `{}` default would.
    const argsKey = JSON.stringify(args);

    // Each fetcher invocation = a cache miss (network round-trip). Cache
    // hits (data returned without a fetch) are accounted below.
    const queryFn = useCallback(() => {
      syncMetrics.cacheMiss();
      return batchFetch(queryName, JSON.parse(argsKey));
    }, [queryName, argsKey]);

    const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
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
  const batchFetch = getBatchFetcher(config.restEndpoint, config.tokenQueryParam);
  return function prefetchSync(opts: SyncQueryOptions) {
    const { queryName, args = {} } = opts;
    void queryClient.prefetchQuery({
      queryKey: ['sync', queryName, args],
      queryFn: () => batchFetch(queryName, args),
      staleTime: 30_000,
    });
  };
}
