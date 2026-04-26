'use client';

import { createContext, useCallback, useContext } from 'react';
import type { SyncType, UseDataImpl, SyncQueryResult, SyncQueryOptions, PrefetchSyncFn } from './types';

interface SyncContextValue {
  transport: SyncType;
  useDataImpl: UseDataImpl;
  prefetch: PrefetchSyncFn;
}

export const SyncContext = createContext<SyncContextValue | null>(null);

export function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSyncQuery must be used within a <SyncProvider>');
  return ctx;
}

/**
 * Universal data hook — works in any transport mode.
 *
 * Consumers pass `queryName` + `args` (strings and plain objects only).
 * The active transport adapter resolves these to the right data source.
 */
export function useSyncQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
  const { useDataImpl } = useSyncContext();
  return useDataImpl<T>(opts);
}

/**
 * Returns a stable function that eagerly fetches a query into the cache.
 * When useSyncQuery later asks for the same queryName + args, the data is instant.
 */
export function useSyncPrefetch(): PrefetchSyncFn {
  const { prefetch } = useSyncContext();
  return prefetch;
}
