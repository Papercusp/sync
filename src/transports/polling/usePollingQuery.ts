'use client';

import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';
import { syncMetrics, installSyncMetricsGlobal } from '../../observability/metrics';

interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
}

const fetcher = async (
  url: string,
  signal?: AbortSignal,
): Promise<{ rows: any[]; version: string }> => {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`Polling query failed: HTTP ${res.status}`);
  return res.json();
};

// Stable singleton empty array so consumers that depend on `data` reference
// equality (useMemo deps, useCallback deps) don't re-run when the query is
// loading. Without this, every render during loading returns a new `[]`,
// which cascades into infinite re-render loops in downstream components.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);
export function createUsePollingQuery(config: PollingConfig) {
  return function usePollingQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    const { queryName, args = {}, pollIntervalMs, enabled = true, staleTime } = opts;
    const interval = pollIntervalMs ?? config.defaultPollIntervalMs;

    const url = `${config.restEndpoint}/rest-query?${new URLSearchParams({
      name: queryName,
      args: JSON.stringify(args),
    }).toString()}`;

    // Counter-attribution: each fetcher invocation = a cache miss (network
    // round-trip). Initial mounts that hit the cache without a fetch are
    // accounted as hits below. This undercounts fetches that originate from
    // sources we don't observe (e.g. invalidateQueries from another tab via
    // BroadcastChannel) — acceptable at this granularity.
    //
    // The `signal` argument here is what makes clearPollingCache() actually
    // cancel in-flight network requests on the WS-takeover path. Without it,
    // react-query's cancelQueries discards the result client-side but the
    // server still completes ~10 SQL queries during the probe window for
    // nothing. With it, fetch() rejects on the abort and the server-side
    // request handler is killed (NextJS forwards req.signal).
    const queryFn = useCallback(({ signal }: { signal: AbortSignal }) => {
      syncMetrics.cacheMiss();
      return fetcher(url, signal);
    }, [url]);

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
      data: (data?.rows ?? (EMPTY_ARRAY as unknown)) as T[],
      loading: isLoading,
      fetching: isPlaceholderData && isFetching,
      transport: 'POLLING',
      invalidate,
      error: error as Error | null,
    };
  };
}


export function createPrefetchSync(config: PollingConfig, queryClient: QueryClient) {
  return function prefetchSync(opts: SyncQueryOptions) {
    const { queryName, args = {} } = opts;
    const url = `${config.restEndpoint}/rest-query?${new URLSearchParams({
      name: queryName,
      args: JSON.stringify(args),
    }).toString()}`;
    void queryClient.prefetchQuery({
      queryKey: ['sync', queryName, args],
      queryFn: ({ signal }) => fetcher(url, signal),
      staleTime: 30_000,
    });
  };
}