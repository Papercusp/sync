'use client';

import { useContext } from 'react';
import { SyncContext } from './SyncContext';
import { useRestQuery } from './transports/polling/usePollingQuery';
import type { SyncQueryOptions, SyncQueryResult } from './types';

/** Never fetched from — a stable placeholder so hook order stays unconditional
 *  when there is no provider (SSR / the WS-probe window) and the query is
 *  disabled anyway. */
const NO_ENDPOINT = 'about:blank';

/**
 * Read a query that is deliberately NOT in the Zero registry, over REST, on
 * EVERY transport.
 *
 * Some names in the sync contract can never become Zero queries: COUNT/DISTINCT
 * aggregates, fan-in composites over several services, and reads whose
 * authority is a service rather than a replicated table. They are listed in
 * `UNSYNCED_QUERY_REASONS` (libs/zero/src/queries.ts) precisely so nobody adds
 * a registry leaf for them.
 *
 * `useSyncQuery` cannot serve those names on WEBSOCKETS: the Zero client
 * resolves a name against the registry and throws
 * `Query '<name>' is not a function` when there is no leaf. The polling and SSE
 * adapters forward the name straight to REST without consulting the registry,
 * which is why such a call site looks healthy on those rungs and breaks the
 * moment a client reaches WebSockets — WI-39763 (one call site) and WI-39772
 * (the other seven).
 *
 * This hook is the fix for that class: same options, same result shape as
 * `useSyncQuery`, but always resolved through the batching REST fetcher, so the
 * call site behaves identically no matter which transport the provider settled
 * on. Use it for any name listed in `UNSYNCED_QUERY_REASONS`; keep using
 * `useSyncQuery` for names the registry actually serves, so those still get
 * real-time WebSocket sync.
 *
 * Outside a `<SyncProvider>` (or during the SSR/WS-probe window, where no
 * endpoint is known) it returns an inert loading result rather than throwing —
 * matching `useSyncQuery`'s no-provider behaviour.
 */
export function useRestSyncQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
  const ctx = useContext(SyncContext);
  const restEndpoint = ctx?.restEndpoint;
  return useRestQuery<T>(
    {
      restEndpoint: restEndpoint ?? NO_ENDPOINT,
      defaultPollIntervalMs: 10_000,
      tokenQueryParam: ctx?.tokenQueryParam,
      principal: ctx?.principal ?? null,
    },
    // No endpoint ⇒ nothing to fetch. Disable rather than fire at a
    // placeholder URL, but still call the hook so order stays stable.
    restEndpoint ? opts : { ...opts, enabled: false },
  );
}
