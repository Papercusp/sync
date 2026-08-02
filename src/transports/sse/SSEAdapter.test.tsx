/**
 * @vitest-environment jsdom
 *
 * EI-278 pin: the SSE transport's refetch interval is a DRIFT-REPAIR tick,
 * not a freshness source. When it shared the polling transport's 5-10s
 * cadence, every subscribed query REST-refetched on that cadence ON TOP of
 * SSE pushes — measured ~3.2 fetches/s sustained on the operator /adv page
 * (162k fetches over 14h), the dominant workload behind a 16GB WebKitGTK
 * webview OOM kill. Freshness under SSE comes from invalidate-driven
 * refetches; the interval only repairs pushes lost to an SSE blip or a
 * table missing its invalidation bridge entry.
 */
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { SSE_DRIFT_REPAIR_DEFAULT_MS, hasScope } from './SSEAdapter';

/**
 * WI-6796 — "the accounts tab stopped updating".
 *
 * The adapter routes an invalidate two ways: a SCOPED event targets one cache key,
 * an unscoped one full-busts every entry under the name. That branch used to be a
 * bare truthiness check on `args`, and `{}` is truthy — so an empty bag scoped to
 * the key ['sync', name, {}], which cannot match a ['sync', name, undefined]
 * subscription. Since `useSyncQuery({ queryName })` with NO args is the common form
 * (the Accounts tab, the /adv Overview tiles) and 32 producer callsites pass a
 * literal {}, those invalidations silently did nothing.
 */
describe('invalidate scoping — empty args must full-bust (WI-6796)', () => {
  it('hasScope: only a NON-EMPTY args bag counts as scoped', () => {
    expect(hasScope(undefined)).toBe(false);
    expect(hasScope({})).toBe(false); // the bug: this used to read as "scoped"
    expect(hasScope({ id: 'x' })).toBe(true);
    expect(hasScope({ id: undefined })).toBe(true); // a declared key IS a scope
  });

  // Pins the @tanstack/query-core matching fact the whole fix rests on, so a future
  // library upgrade that changed these semantics fails HERE rather than as another
  // silently-stale panel.
  it('a {}-keyed invalidate MISSES a no-args subscriber — which is why {} must never be sent', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', undefined], [{ id: 'a' }]);
    qc.invalidateQueries({ queryKey: ['sync', 'accounts.pool', {}] });
    expect(qc.getQueryState(['sync', 'accounts.pool', undefined])?.isInvalidated).toBe(false);
  });

  it('the full-bust predicate reaches BOTH a no-args and an args-{} subscriber', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', undefined], [{ id: 'a' }]);
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'sync' && q.queryKey[1] === 'accounts.pool',
    });
    // Superset property: normalizing {} to full-bust can only ADD refreshes.
    expect(qc.getQueryState(['sync', 'accounts.pool', undefined])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(true);
  });
});

describe('SSE drift-repair interval (EI-278)', () => {
  it('defaults to minutes, never a seconds-scale poll cadence', () => {
    // ≥60s = the floor below which the "drift repair" tick degenerates back
    // into a poll storm across ~30+ live subscriptions. If you are lowering
    // this to "make a panel update faster", the correct fix is an
    // invalidation producer for its table (notifySyncInvalidate at the write
    // site, or a bridge entry in table-to-query-names.ts) — not a faster
    // global tick.
    expect(SSE_DRIFT_REPAIR_DEFAULT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('stays bounded so an unbridged table is never stale for more than a few minutes', () => {
    expect(SSE_DRIFT_REPAIR_DEFAULT_MS).toBeLessThanOrEqual(300_000);
  });
});
