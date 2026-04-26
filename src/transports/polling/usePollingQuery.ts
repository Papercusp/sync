'use client';

import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';

interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
}

const fetcher = async (url: string): Promise<{ rows: any[]; version: string }> => {
  const res = await fetch(url);
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
    const { queryName, args = {}, pollIntervalMs, enabled = true } = opts;
    const interval = pollIntervalMs ?? config.defaultPollIntervalMs;

    const url = `${config.restEndpoint}/rest-query?${new URLSearchParams({
      name: queryName,
      args: JSON.stringify(args),
    }).toString()}`;

    const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
      queryKey: ['sync', queryName, args],
      queryFn: () => fetcher(url),
      refetchInterval: interval,
      enabled,
      placeholderData: keepPreviousData,
    });

    const invalidate = useCallback(() => { refetch(); }, [refetch]);

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
      queryFn: () => fetcher(url),
      staleTime: 30_000,
    });
  };
}