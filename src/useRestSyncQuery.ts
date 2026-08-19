'use client';

import { useContext } from 'react';
import { SyncContext } from './SyncContext';
import { getQueryClient } from './transports/polling/queryClient';
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
 * `useSyncQuery`, but never resolved against the Zero registry, so the call
 * site behaves identically no matter which transport the provider settled on.
 * On SSE and polling it reads through the provider's own hook (the same REST
 * fetcher, reached the way `useSyncQuery` reaches it); on WebSockets it goes
 * to REST directly, since that is the one rung whose hook would throw. Use it
 * for any name listed in `UNSYNCED_QUERY_REASONS`; keep using `useSyncQuery`
 * for names the registry actually serves, so those still get real-time
 * WebSocket sync.
 *
 * Outside a `<SyncProvider>` (or during the SSR/WS-probe window, where no
 * endpoint is known) it returns an inert loading result rather than throwing —
 * matching `useSyncQuery`'s no-provider behaviour.
 *
 * That last guarantee is why the QueryClient is passed EXPLICITLY rather than
 * read from a `QueryClientProvider`. `useRestQuery` calls `useQuery`
 * unconditionally, and a missing client is a THROW; the transport adapters all
 * mount a provider, but `PendingSyncAdapter` — the placeholder that covers SSR
 * and the WS-probe window on every first page load — mounts only a SyncContext.
 * Binding the singleton here means these call sites degrade to an empty read in
 * that window instead of crashing the subtree, which is what they did as
 * `useSyncQuery` calls before WI-39772. It is the same client the adapters put
 * on the context, so nothing changes where a provider does exist.
 */
export function useRestSyncQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
  const ctx = useContext(SyncContext);
  const restEndpoint = ctx?.restEndpoint;

  // Prefer the provider's own data hook on every rung EXCEPT WebSockets.
  //
  // On SSE and polling that hook IS this REST path — both adapters build it
  // with `createUsePollingQuery`, the same fetcher `useRestQuery` wraps — so
  // going through the context is the identical request while keeping the
  // adapter's batching, invalidation and endpoint/principal resolution. It is
  // also the seam consumers substitute (a stubbed `useDataImpl`, an SSR probe
  // provider); bypassing it made those substitutions silently ineffective.
  //
  // WebSockets is the exception this hook exists for: that impl resolves the
  // name against the Zero registry in a `useMemo` that runs BEFORE it consults
  // `enabled` (useWebSocketQuery.ts), so a name with no leaf throws
  // `Query '<name>' is not a function` even when disabled — WI-39763/WI-39772.
  // Nothing short of not calling it avoids that.
  //
  // Hook order is stable across the branch: every adapter hard-codes its
  // `transport` as a literal, and moving between adapters swaps the component
  // rendered above these children, remounting them.
  const contextImpl =
    ctx && ctx.transport !== 'WEBSOCKETS' && typeof ctx.useDataImpl === 'function'
      ? ctx.useDataImpl
      : null;

  const restResult = useRestQuery<T>(
    {
      restEndpoint: restEndpoint ?? NO_ENDPOINT,
      defaultPollIntervalMs: 10_000,
      tokenQueryParam: ctx?.tokenQueryParam,
      principal: ctx?.principal ?? null,
    },
    // Nothing to fetch when the context is already serving this call, or when
    // no endpoint is known. Disable rather than fire at a placeholder URL, but
    // still call the hook so its slot never moves.
    contextImpl || !restEndpoint ? { ...opts, enabled: false } : opts,
    getQueryClient(),
  );

  const contextResult = contextImpl ? contextImpl<T>(opts) : null;
  return contextResult ?? restResult;
}
