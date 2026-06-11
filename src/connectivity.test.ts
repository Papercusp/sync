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

describe('batch-fetcher connectivity reporting', () => {
  it('reports unreachable when fetch rejects and reachable on any HTTP response', async () => {
    const { getBatchFetcher } = await import('./transports/polling/batch-fetcher');

    // Network-level failure → unreachable ×2 → offline.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    const failing = getBatchFetcher('/conn-test-fail');
    await expect(failing('q1', {})).rejects.toThrow();
    await expect(failing('q2', {})).rejects.toThrow();
    expect(getSyncConnectivity().offline).toBe(true);

    // An HTTP 500 response = origin reachable → recovers, even though the
    // batch itself still rejects.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    );
    const erroring = getBatchFetcher('/conn-test-500');
    await expect(erroring('q3', {})).rejects.toThrow(/HTTP 500/);
    expect(getSyncConnectivity().offline).toBe(false);

    vi.unstubAllGlobals();
  });
});
