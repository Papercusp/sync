'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SyncContext, useSyncQuery } from './SyncContext';
import type { SyncType } from './types';

/**
 * useOwnedSyncEntity — a client-owned mutable store keyed by a client-readable
 * id cookie, with a getOrCreate bootstrap. The write-side companion to the
 * read-cache `useVersionedResource`: it makes optimistic Zero writes *reflect*
 * (the writes themselves stay at the call site via `useSyncMutate`).
 *
 * It centralizes three load-bearing correctness invariants that were otherwise
 * hand-copied across every owned-store surface (and were the bugs the cart /
 * quote-cart work actually hit):
 *
 *   (a) Keep the bootstrap seed until the Zero query loads — never flash empty.
 *   (b) On WebSockets, NEVER REST-refresh — a focus/route re-pull clobbers
 *       optimistic Zero state. (Zero keeps the entity fresh.)
 *   (c) Bootstrap (getOrCreate) sets the id cookie, THEN we re-read it into
 *       reactive state so the `useSyncQuery` subscription attaches.
 *
 * On polling/SSE there's no Zero client: the bootstrap + `read` REST path drives
 * the entity, behaviour-identical to a plain getCart-style hook.
 */

export interface UseOwnedSyncEntityOptions<TRow, TShape> {
  /** Named query for the entity's reactive read (e.g. 'cart.current'). */
  queryName: string;
  /** Read the entity id from its client-readable cookie. '' when absent. */
  readId: () => string;
  /** Build the query args from the id. Default: `(id) => ({ id })`. The cart
   *  uses `(id) => ({ cartId: id })`, the quote-cart `({ quoteCartId: id })`. */
  buildArgs?: (id: string) => Record<string, unknown>;
  /** MOUNT only: getOrCreate — creates the row + SETS the id cookie — returns
   *  the first-paint seed. */
  bootstrap: () => Promise<TShape>;
  /** Side-effect-free re-pull, wired to focus/route changes on polling. Defaults
   *  to `bootstrap` (fine when getOrCreate is idempotent, as getCart is today). */
  read?: () => Promise<TShape>;
  /** Map a present Zero row → the domain shape. Pure (no call-site override
   *  state — surfaces that need that, e.g. CartShell's qty-0 mask, layer it over
   *  `data` themselves). */
  map: (row: TRow) => TShape;
  /** Shape when there's no id / no row yet. Default `null`. */
  empty?: TShape | null;
}

export interface UseOwnedSyncEntityResult<TShape> {
  /** The entity, or `empty`/null when there's none. */
  data: TShape | null;
  /** True until the first bootstrap/query result. Does not re-flip on refresh. */
  loading: boolean;
  error: Error | null;
  transport: SyncType;
  /** Polling/SSE: re-pull via `read`. No-op on WS (Zero keeps it fresh) — invariant (b). */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
}

/**
 * Pure WS data transition — invariant (a). While the query is loading, keep the
 * current value (the bootstrap seed); once loaded, the mapped row is the source
 * of truth (or `empty` when there's no row). Extracted so it's unit-testable
 * without React (mirrors the data-fetch package's pure-core pattern).
 */
export function selectOwnedData<TRow, TShape>(
  current: TShape | null,
  q: { loading: boolean; row: TRow | null | undefined },
  cfg: { map: (row: TRow) => TShape; empty: TShape | null },
): TShape | null {
  if (q.loading) return current;
  return q.row != null ? cfg.map(q.row) : cfg.empty;
}

export function useOwnedSyncEntity<TRow = unknown, TShape = unknown>(
  opts: UseOwnedSyncEntityOptions<TRow, TShape>,
): UseOwnedSyncEntityResult<TShape> {
  const ctx = useContext(SyncContext);
  const transport: SyncType = ctx?.transport ?? 'POLLING';
  const onWs = transport === 'WEBSOCKETS';

  // Read callbacks via a ref so inline closures don't churn effect deps / loop
  // (the same hardening the data-fetch hook uses for its fetcher).
  const ref = useRef(opts);
  ref.current = opts;

  const [id, setId] = useState<string>(() => opts.readId());
  const [data, setData] = useState<TShape | null>(opts.empty ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const args = useMemo(
    () => (ref.current.buildArgs ?? ((x: string) => ({ id: x })))(id),
    [id],
  );
  const q = useSyncQuery<TRow>({ queryName: opts.queryName, args, enabled: onWs && id.length > 0 });

  // Invariant (a): seed until the query loads, then map.
  useEffect(() => {
    if (!onWs) return;
    setData((prev) =>
      selectOwnedData(prev, { loading: q.loading, row: q.data?.[0] }, { map: ref.current.map, empty: ref.current.empty ?? null }),
    );
    // Only the (enabled) query clears loading; for an absent id we wait for bootstrap.
    if (!q.loading && id.length > 0) { setLoading(false); setError(null); }
  }, [onWs, q.data, q.loading, id]);

  const runFetch = useCallback(async (kind: 'bootstrap' | 'read') => {
    const fn = kind === 'read' ? (ref.current.read ?? ref.current.bootstrap) : ref.current.bootstrap;
    try {
      const shape = await fn();
      setData(shape);
      setId(ref.current.readId()); // invariant (c): pick up the cookie the bootstrap set
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false); // never re-set true → refreshes don't flicker the UI
    }
  }, []);

  // Invariant (b): on WS the Zero subscription keeps the entity fresh — a REST
  // re-pull would clobber optimistic state, so refresh is a no-op there.
  const refresh = useCallback(
    () => (onWs ? Promise.resolve() : runFetch('read')),
    [onWs, runFetch],
  );

  // Bootstrap on mount (both transports — it's the identity/cookie bootstrap +
  // first-paint seed). Polling-only focus/route re-pull.
  useEffect(() => {
    void runFetch('bootstrap');
    if (typeof window === 'undefined') return;
    const reRead = () => { if (!onWs) void runFetch('read'); };
    window.addEventListener('focus', reRead);
    document.addEventListener('astro:page-load', reRead);
    return () => {
      window.removeEventListener('focus', reRead);
      document.removeEventListener('astro:page-load', reRead);
    };
  }, [onWs, runFetch]);

  return { data, loading, error, transport, refresh };
}
