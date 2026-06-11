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
import { SSE_DRIFT_REPAIR_DEFAULT_MS } from './SSEAdapter';

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
