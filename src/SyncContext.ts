'use client';

import { createContext, useCallback, useContext } from 'react';
import { useQueryHealthObserver } from './observability/query-health';
import type { SyncType, UseDataImpl, SyncQueryResult, SyncQueryOptions, PrefetchSyncFn, MutateImpl } from './types';

interface SyncContextValue {
  transport: SyncType;
  useDataImpl: UseDataImpl;
  prefetch: PrefetchSyncFn;
  /** Zero custom-mutator dispatcher (WS only); absent ⇒ writes use the REST fallback. */
  mutate?: MutateImpl | null;
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
  // (Hook-after-branch matches the existing useDataImpl pattern: ctx presence
  // is stable for the life of the mount.)
  const result = ctx.useDataImpl<T>(opts);
  // Dev-time guardrails for the recurring fetch-defect class (waterfall /
  // oversized payload / oversized row count / slow first load) — a no-op
  // outside development. See observability/query-health.ts.
  useQueryHealthObserver(opts, result as SyncQueryResult<unknown>);
  return result;
}

/**
 * Returns a stable function that eagerly fetches a query into the cache.
 * When useSyncQuery later asks for the same queryName + args, the data is instant.
 */
export function useSyncPrefetch(): PrefetchSyncFn {
  const { prefetch } = useSyncContext();
  return prefetch;
}

function resolveMutator(
  mutate: MutateImpl | null | undefined,
  path: string,
): ((args: any) => Promise<unknown>) | null {
  if (!mutate) return null;
  const [ns, name] = path.split('.');
  const group = ns ? mutate[ns] : undefined;
  const fn = group && name ? group[name] : undefined;
  return typeof fn === 'function' ? fn.bind(group) : null;
}

/**
 * Returns a write function for a namespaced Zero custom mutator (e.g.
 * `'cart.addItem'`). On the WebSocket transport the mutator runs
 * OPTIMISTICALLY through the Zero client (instant local apply, then server
 * reconcile / rollback). On polling/SSE — where no Zero client exists — it
 * calls `restFallback` so the surface works on every transport. Pass a
 * stable `restFallback` (e.g. a `useCallback`).
 */
export function useSyncMutate<A = unknown, R = unknown>(
  path: string,
  restFallback: (args: A) => Promise<R>,
): (args: A) => Promise<R> {
  // Tolerate being used OUTSIDE a <SyncProvider>: with no context there is no
  // Zero client, so every call takes the REST fallback. This lets call sites
  // (e.g. add-to-cart islands) adopt useSyncMutate without being wrapped in a
  // provider yet — behavior-identical to a direct fetch until a provider + WS
  // are added, at which point the same call site becomes optimistic for free.
  const ctx = useContext(SyncContext);
  const mutate = ctx?.mutate;
  return useCallback(
    async (args: A): Promise<R> => {
      const fn = resolveMutator(mutate, path);
      if (fn) return (await fn(args)) as R;
      return restFallback(args);
    },
    // path is constant per call site; restFallback expected stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate, path],
  );
}
