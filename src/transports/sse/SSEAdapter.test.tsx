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
import { SSE_DRIFT_REPAIR_DEFAULT_MS } from './SSEAdapter';

/**
 * Pins the invalidation-matching contract this transport depends on, because it is
 * counter-intuitive enough that WI-6796 got it backwards for a while and nearly
 * "fixed" a bug that does not exist.
 *
 * The subtlety: `useSyncQuery({ queryName })` with NO args does NOT key on
 * `undefined` — `createUsePollingQuery` defaults `args = {}` (usePollingQuery.ts),
 * so the key is `['sync', name, {}]`. That is exactly what a producer's
 * `notifySyncInvalidate(name, {})` targets, so the common no-args pairing matches
 * and there is nothing to repair. What genuinely does NOT match is a NON-EMPTY
 * args-scoped invalidate against a no-args subscription — the documented gotcha in
 * agent-insights/adding-a-sync-query.
 */
describe('invalidate key matching (the WI-6796 contract pin)', () => {
  it('an args-{} invalidate DOES reach a no-args subscription — they share the {} key', () => {
    const qc = new QueryClient();
    // How createUsePollingQuery keys `useSyncQuery({ queryName: 'accounts.pool' })`.
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.invalidateQueries({ queryKey: ['sync', 'accounts.pool', {}] });
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(true);
  });

  it('a NON-EMPTY args-scoped invalidate does NOT reach a no-args subscription (the real gotcha)', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.invalidateQueries({ queryKey: ['sync', 'accounts.pool', { workspaceId: 'w' }] });
    // Emit name-only (or the SAME args the consumer subscribes with) for these.
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(false);
  });

  it('the name-only predicate branch reaches every arg variant, including {}', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.setQueryData(['sync', 'accounts.pool', { workspaceId: 'w' }], [{ id: 'b' }]);
    qc.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'sync' && q.queryKey[1] === 'accounts.pool',
    });
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['sync', 'accounts.pool', { workspaceId: 'w' }])?.isInvalidated).toBe(true);
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
