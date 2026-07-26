/**
 * query-fetcher.test.ts — the single-query sync fetcher.
 *
 * RECURRENCE GUARD (drop-sync-batcher-2026-07-25 P-008). These replace the
 * WI-5851 batch-membership tests, which asserted something that no longer
 * exists ("an interactive query is never in the same HTTP request as a
 * background one"). The invariant underneath WI-5851 was never really about
 * lanes — it was HEAD-OF-LINE: a slow query must not delay an unrelated fast
 * one. The bundle could only approximate that by hand-labelling traffic into
 * two lanes; one request per query gives it structurally. So the guards here
 * assert the property, not the mechanism:
 *
 *   (a) in-flight requests never exceed the configured limit;
 *   (b) a slow query cannot delay an unrelated fast one;
 *   (c) an aborted query is cancelled — and, while queued, never even fires.
 *
 * Each was verified to BITE by temporarily regressing the code (a test that
 * cannot fail is worthless): (a) fails if the gate is bypassed, (b) fails if
 * the limit is 1 or if requests are re-coalesced into one response, (c) fails
 * if the signal is dropped on the way to `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_IN_FLIGHT,
  getFetchGate,
  getQueryFetcher,
  _resetQueryFetchersForTests,
} from './query-fetcher';
import { setSyncDeltaCodec, type SyncDeltaSlot } from '../../../delta-codec';

// The fetchers Map is module-level — isolate each test with a unique endpoint.
let epCounter = 0;
const ep = () => `http://qf-test-${++epCounter}`;

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** Query names in each request, in call order. */
const namesOf = (mockFetch: ReturnType<typeof vi.fn>): string[] =>
  mockFetch.mock.calls.map((c) => new URL(c[0] as string).searchParams.get('name') ?? '');

beforeEach(() => {
  _resetQueryFetchersForTests();
});
afterEach(() => {
  setSyncDeltaCodec(null);
  vi.unstubAllGlobals();
});

describe('getQueryFetcher — request shape', () => {
  it('sends ONE GET per query carrying name + args, and returns { rows, version }', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ rows: [{ id: 'a' }], version: 'v1' }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await getQueryFetcher(ep())('plans.attention', { limit: 5 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/rest-query');
    expect(url.searchParams.get('name')).toBe('plans.attention');
    expect(JSON.parse(url.searchParams.get('args')!)).toEqual({ limit: 5 });
    // No `delta` param without a codec — byte-identical to a pre-delta request.
    expect(url.searchParams.has('delta')).toBe(false);
    expect(result).toMatchObject({ rows: [{ id: 'a' }], version: 'v1' });
  });

  it('appends the token query param when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ rows: [], version: 'v1' }));
    vi.stubGlobal('fetch', mockFetch);
    await getQueryFetcher(ep(), 'tok123')('q', {});
    expect(new URL(mockFetch.mock.calls[0][0] as string).searchParams.get('token')).toBe('tok123');
  });

  it('rejects with the server error message on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'unknown queryName: nope' }),
    }));
    await expect(getQueryFetcher(ep())('nope', {})).rejects.toThrow(/HTTP 400.*unknown queryName: nope/);
  });

  it('still reports a usable error when the failure body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new Error('not json'); },
    }));
    await expect(getQueryFetcher(ep())('q', {})).rejects.toThrow(/HTTP 503/);
  });

  it('one query failing leaves every other query unaffected', async () => {
    // The bundle's per-slot error handling existed because a batch was one
    // response. Independent requests give this for free — pinned so a future
    // "let's coalesce again" change has to break a test to land.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const name = new URL(url).searchParams.get('name');
      return name === 'bad'
        ? { ok: false, status: 500, json: async () => ({ error: 'query boom' }) }
        : okResponse({ rows: [name], version: 'v1' });
    }));

    const fetcher = getQueryFetcher(ep());
    const [good, bad] = await Promise.allSettled([fetcher('good', {}), fetcher('bad', {})]);
    expect(good).toMatchObject({ status: 'fulfilled', value: { rows: ['good'] } });
    expect(bad).toMatchObject({ status: 'rejected' });
  });

  it('returns the same fetcher for the same endpoint, and independent ones per endpoint', () => {
    const e = ep();
    expect(getQueryFetcher(e)).toBe(getQueryFetcher(e));
    expect(getQueryFetcher(ep())).not.toBe(getQueryFetcher(ep()));
  });

  it('shares ONE gate per endpoint and retunes it in place', () => {
    const e = ep();
    getQueryFetcher(e);
    expect(getFetchGate(e)!.limit).toBe(DEFAULT_MAX_IN_FLIGHT);
    // A second caller (the prefetch helper / fetchSyncQuery) must not mint a
    // second gate — that would multiply the cap by the number of callers.
    getQueryFetcher(e, undefined, 4);
    expect(getFetchGate(e)!.limit).toBe(4);
  });
});

describe('getQueryFetcher — concurrency guard (P-008a)', () => {
  it('never exceeds the configured in-flight limit', async () => {
    let concurrent = 0;
    let peak = 0;
    const release = deferred();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await release.promise;
      concurrent -= 1;
      return okResponse({ rows: [], version: 'v' });
    }));

    const fetcher = getQueryFetcher(ep(), undefined, 5);
    const all = Promise.all(Array.from({ length: 40 }, (_, i) => fetcher(`q${i}`, {})));
    await tick();

    expect(peak).toBe(5);
    release.resolve();
    await all;
    expect(peak).toBe(5);
  });
});

describe('getQueryFetcher — head-of-line guard (P-008b)', () => {
  it('a slow query does not delay an unrelated fast one', async () => {
    // THE REGRESSION THIS PINS: under the batcher, a 4ms detail read that
    // landed in the same 12ms window as a poll wave inherited that wave's
    // latency — measured at 2.7-3.3s against the live operator. The bundle was
    // indivisible, so no window size could fix it; only independent dispatch
    // can. Asserting completion ORDER (not timing) keeps this honest across
    // any future retuning of the cap.
    const slow = deferred();
    const settled: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const name = new URL(url).searchParams.get('name')!;
      if (name === 'learning.soakReport') await slow.promise;
      return okResponse({ rows: [name], version: 'v' });
    }));

    const fetcher = getQueryFetcher(ep(), undefined, 8);
    const slowCall = fetcher('learning.soakReport', {}).then(() => settled.push('slow'));
    const fastCall = fetcher('conversations.messageDetail', { id: 'm1' }).then(() => settled.push('fast'));

    await fastCall;
    expect(settled).toEqual(['fast']); // the fast read landed while the slow one is still open

    slow.resolve();
    await slowCall;
    expect(settled).toEqual(['fast', 'slow']);
  });

  it('a failing slow query does not fail its neighbours (no shared fate)', async () => {
    const slow = deferred();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const name = new URL(url).searchParams.get('name')!;
      if (name === 'slow.boom') {
        await slow.promise;
        throw new TypeError('Load failed');
      }
      return okResponse({ rows: [name], version: 'v' });
    }));

    const fetcher = getQueryFetcher(ep(), undefined, 8);
    const doomed = fetcher('slow.boom', {});
    await expect(fetcher('fast.ok', {})).resolves.toMatchObject({ rows: ['fast.ok'] });
    slow.resolve();
    await expect(doomed).rejects.toThrow();
  });
});

describe('getQueryFetcher — cancellation (P-008c)', () => {
  it('passes the AbortSignal through to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ rows: [], version: 'v' }));
    vi.stubGlobal('fetch', mockFetch);
    const ac = new AbortController();
    await getQueryFetcher(ep())('q', {}, { signal: ac.signal });
    expect((mockFetch.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });

  it('a query aborted while QUEUED never reaches the network', async () => {
    // The batcher could not do this at all: a batch is indivisible, so an
    // unmounted panel's query was still resolved server-side and thrown away.
    // With a 6MB wave that is real work spent on nobody.
    const hold = deferred();
    const mockFetch = vi.fn().mockImplementation(async () => {
      await hold.promise;
      return okResponse({ rows: [], version: 'v' });
    });
    vi.stubGlobal('fetch', mockFetch);

    const fetcher = getQueryFetcher(ep(), undefined, 1);
    const inFlight = fetcher('holding.the.slot', {});
    await tick();
    expect(namesOf(mockFetch)).toEqual(['holding.the.slot']);

    const ac = new AbortController();
    const queued = fetcher('unmounted.panel', {}, { signal: ac.signal });
    await tick();
    ac.abort();

    await expect(queued).rejects.toBeDefined();
    hold.resolve();
    await inFlight;
    // The aborted query never became a request.
    expect(namesOf(mockFetch)).toEqual(['holding.the.slot']);
  });

  it('rejects without firing when the signal is already aborted', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const ac = new AbortController();
    ac.abort();
    await expect(getQueryFetcher(ep())('q', {}, { signal: ac.signal })).rejects.toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('getQueryFetcher — rows-delta (P-006 codec)', () => {
  it('no codec → no `delta` param sent', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ rows: [{ id: 'a' }], version: '1' }));
    vi.stubGlobal('fetch', mockFetch);
    const r = await getQueryFetcher(ep())('plans.attention', { x: 1 });
    expect(r.rows).toEqual([{ id: 'a' }]);
    expect(new URL(mockFetch.mock.calls[0][0] as string).searchParams.has('delta')).toBe(false);
  });

  it('a delta-enabled query sends its cursor + returns the codec-decoded rows', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      okResponse({ rows: [{ id: 'a' }], version: '1', delta: { mode: 'full', cursor: 'c1', itemKeyField: 'id' } }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const seen: SyncDeltaSlot[] = [];
    setSyncDeltaCodec({
      enabled: (n) => n === 'plans.attention',
      viewKey: (n, a) => n + JSON.stringify(a),
      cursorFor: () => undefined, // cold
      decodeResult: (_vk, slot) => {
        seen.push(slot);
        return { rows: slot.rows ?? [], refetchFull: false };
      },
    });

    const r = await getQueryFetcher(ep())('plans.attention', {});
    expect(r.rows).toEqual([{ id: 'a' }]);
    // cold opt-in: `delta` present and empty
    expect(new URL(mockFetch.mock.calls[0][0] as string).searchParams.get('delta')).toBe('');
    expect(seen[0].delta?.mode).toBe('full');
  });

  it('refetches a clean full when the codec signals a checksum mismatch', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      okResponse(
        ++call === 1
          ? { changes: [], version: '1', delta: { mode: 'delta', cursor: 'c2' } }
          : { rows: [{ id: 'fresh' }], version: '2', delta: { mode: 'full', cursor: 'c3' } },
      ),
    ));
    setSyncDeltaCodec({
      enabled: () => true,
      viewKey: () => 'v',
      cursorFor: () => 'c1', // warm → a mismatch must trigger a full refetch
      decodeResult: (_vk, slot) =>
        slot.delta?.mode === 'delta'
          ? { rows: [], refetchFull: true }
          : { rows: slot.rows ?? [], refetchFull: false },
    });

    const r = await getQueryFetcher(ep())('plans.list', {});
    expect(r.rows).toEqual([{ id: 'fresh' }]);
    expect(call).toBe(2);
  });
});
