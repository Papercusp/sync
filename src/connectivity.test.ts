/**
 * Connectivity store (EI-239) — offline flips after sustained network-level
 * failure, never on a single blip or an HTTP error response, and clears on
 * the first reachable report.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSyncConnectivityForTests,
  getSyncConnectivity,
  onSyncConnectivity,
  reportSyncReachable,
  reportSyncUnreachable,
} from './connectivity';

beforeEach(() => {
  _resetSyncConnectivityForTests();
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
