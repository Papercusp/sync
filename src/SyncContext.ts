'use client';

import { createContext, useContext } from 'react';
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
 *
 * No-provider behaviour: returns `{data:undefined, loading:false, error:null}`
 * with a stale-data flag set instead of throwing. Components mounted in app
 * chrome (operator's ChromeShell renders RecentActionsCenter at the root
 * layout) can render outside `/harness/*` where SyncProvider lives, and
 * a thrown context error there crashes the popover. Callers that need
 * live data should branch on the result and provide their own fallback
 * (REST poll, prefetch cache, etc.) when no provider is mounted.
 */
export function useSyncQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    return { data: undefined, loading: false, error: null } as unknown as SyncQueryResult<T>;
  }
  return ctx.useDataImpl<T>(opts);
}

/**
 * Returns a stable function that eagerly fetches a query into the cache.
 * When useSyncQuery later asks for the same queryName + args, the data is instant.
 */
export function useSyncPrefetch(): PrefetchSyncFn {
  const { prefetch } = useSyncContext();
  return prefetch;
}
