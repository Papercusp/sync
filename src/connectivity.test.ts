/**
 * Connectivity store (EI-239) — offline flips after sustained network-level
 * failure, never on a single blip or an HTTP error response, and clears on
 * the first reachable report.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSyncConnectivityForTests,
  _resetSyncStaleOperatorForTests,
  getSyncConnectivity,
  getSyncStaleOperator,
  onSyncConnectivity,
  onSyncStaleOperator,
  reportSyncReachable,
  reportSyncStaleOperator,
  reportSyncUnreachable,
} from './connectivity';

beforeEach(() => {
  _resetSyncConnectivityForTests();
  _resetSyncStaleOperatorForTests();
});

describe('sync connectivity store', () => {
  it('starts online and a single failure does not flip it', () => {
    expect(getSyncConnectivity().offline).toBe(false);
    reportSyncUnreachable();
    expect(getSyncConnectivity().offline).toBe(false);
  });

  it('flips offline after two consecutive failures and records the start', () => {
    reportSyncUnreachable();
    reportSyncUnreachable();
    const s = getSyncConnectivity();
    expect(s.offline).toBe(true);
    expect(s.offlineSinceMs).toBeGreaterThan(0);
  });

  it('a reachable report between failures resets the streak (blip tolerance)', () => {
    reportSyncUnreachable();
    reportSyncReachable();
    reportSyncUnreachable();
    expect(getSyncConnectivity().offline).toBe(false);
  });

  it('recovers on the first reachable report and notifies subscribers', () => {
    const seen: boolean[] = [];
    const off = onSyncConnectivity(() => seen.push(getSyncConnectivity().offline));
    reportSyncUnreachable();
    reportSyncUnreachable();
    reportSyncReachable();
    expect(getSyncConnectivity()).toEqual({ offline: false, offlineSinceMs: 0 });
    expect(seen).toEqual([true, false]);
    off();
  });

  it('a throwing subscriber never blocks the store or other subscribers', () => {
    const calls: string[] = [];
    const offA = onSyncConnectivity(() => {
      calls.push('a');
      throw new Error('boom');
    });
    const offB = onSyncConnectivity(() => calls.push('b'));
    reportSyncUnreachable();
    reportSyncUnreachable();
    expect(getSyncConnectivity().offline).toBe(true);
    expect(calls).toEqual(['a', 'b']);
    offA();
    offB();
  });
});

describe('sync stale-operator store (WI-5956)', () => {
  it('starts not-stale', () => {
    expect(getSyncStaleOperator()).toEqual({ stale: false, queryNames: [] });
  });

  it('flips stale on the FIRST report — no debounce, no consecutive-count requirement', () => {
    reportSyncStaleOperator('plans.attentionItem');
    expect(getSyncStaleOperator()).toEqual({ stale: true, queryNames: ['plans.attentionItem'] });
  });

  it('accumulates distinct queryNames across multiple reports', () => {
    reportSyncStaleOperator('plans.attentionItem');
    reportSyncStaleOperator('work_items.detail');
    expect(getSyncStaleOperator().queryNames).toEqual(['plans.attentionItem', 'work_items.detail']);
  });

  it('is idempotent per queryName — a flapping panel retrying the same missing query does not notify twice', () => {
    const seen: string[][] = [];
    const off = onSyncStaleOperator(() => seen.push([...getSyncStaleOperator().queryNames]));
    reportSyncStaleOperator('plans.attentionItem');
    reportSyncStaleOperator('plans.attentionItem');
    reportSyncStaleOperator('plans.attentionItem');
    expect(seen).toEqual([['plans.attentionItem']]);
    off();
  });

  it('never auto-clears — unlike connectivity, there is no reportSyncOperatorFresh', () => {
    reportSyncStaleOperator('plans.attentionItem');
    expect(getSyncStaleOperator().stale).toBe(true);
    // No recovery path exists by design (see connectivity.ts doc comment) — a
    // version skew self-heals only via a real operator restart (full reload).
  });

  it('a throwing subscriber never blocks the store or other subscribers', () => {
    const calls: string[] = [];
    const offA = onSyncStaleOperator(() => {
      calls.push('a');
      throw new Error('boom');
    });
    const offB = onSyncStaleOperator(() => calls.push('b'));
    reportSyncStaleOperator('plans.attentionItem');
    expect(getSyncStaleOperator().stale).toBe(true);
    expect(calls).toEqual(['a', 'b']);
    offA();
    offB();
  });
});

describe('query-fetcher connectivity reporting', () => {
  it('reports unreachable when fetch rejects and reachable on any HTTP response', async () => {
    const { getQueryFetcher } = await import('./transports/polling/query-fetcher');

    // Network-level failure → unreachable ×2 → offline.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    const failing = getQueryFetcher('/conn-test-fail');
    await expect(failing('q1', {})).rejects.toThrow();
    await expect(failing('q2', {})).rejects.toThrow();
    expect(getSyncConnectivity().offline).toBe(true);

    // An HTTP 500 response = origin reachable → recovers, even though the
    // query itself still rejects.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    );
    const erroring = getQueryFetcher('/conn-test-500');
    await expect(erroring('q3', {})).rejects.toThrow(/HTTP 500/);
    expect(getSyncConnectivity().offline).toBe(false);

    vi.unstubAllGlobals();
  });

  it('does NOT report unreachable when the caller aborts its own request', async () => {
    const { getQueryFetcher } = await import('./transports/polling/query-fetcher');
    _resetSyncConnectivityForTests();

    // A cancelled request proves nothing about the origin. Reporting it as
    // unreachable would flip the whole app offline every time a panel unmounts
    // mid-fetch — the transport would announce an outage it invented.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        return Promise.reject(err);
      }),
    );
    const fetcher = getQueryFetcher('/conn-test-abort');
    const ac = new AbortController();
    ac.abort();
    await expect(fetcher('q1', {}, { signal: ac.signal })).rejects.toThrow();
    await expect(fetcher('q2', {}, { signal: ac.signal })).rejects.toThrow();
    expect(getSyncConnectivity().offline).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('query-fetcher stale-operator reporting (WI-5956)', () => {
  it('reports stale-operator on the exact "unknown queryName" 400 shape rest-query.ts uses', async () => {
    const { getQueryFetcher } = await import('./transports/polling/query-fetcher');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'unknown queryName: plans.attentionItem', name: 'plans.attentionItem' }), {
          status: 400,
        }),
      ),
    );
    const fetcher = getQueryFetcher('/stale-test-1');
    await expect(fetcher('plans.attentionItem', {})).rejects.toThrow(/unknown queryName/);
    expect(getSyncStaleOperator()).toEqual({ stale: true, queryNames: ['plans.attentionItem'] });
    // Reachable too — an HTTP response (even a 400) proves the origin is up,
    // same rule as every other HTTP error status.
    expect(getSyncConnectivity().offline).toBe(false);

    vi.unstubAllGlobals();
  });

  it('does NOT report stale-operator for an unrelated 400 (e.g. bad args) — exact prefix match only', async () => {
    const { getQueryFetcher } = await import('./transports/polling/query-fetcher');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid args (not JSON)' }), { status: 400 })),
    );
    const fetcher = getQueryFetcher('/stale-test-2');
    await expect(fetcher('some.query', {})).rejects.toThrow(/invalid args/);
    expect(getSyncStaleOperator()).toEqual({ stale: false, queryNames: [] });

    vi.unstubAllGlobals();
  });

  it('does NOT report stale-operator for a different status code, even with a similar-looking body', async () => {
    const { getQueryFetcher } = await import('./transports/polling/query-fetcher');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unknown queryName: q' }), { status: 500 })),
    );
    const fetcher = getQueryFetcher('/stale-test-3');
    await expect(fetcher('q', {})).rejects.toThrow();
    expect(getSyncStaleOperator().stale).toBe(false);

    vi.unstubAllGlobals();
  });
});
