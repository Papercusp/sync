/**
 * batch-fetcher.test.ts — unit tests for getBatchFetcher (Plan 1 P-024).
 *
 * The batch fetcher coalesces rapid parallel calls into one POST
 * /rest-query-batch per flush window (12ms). Tests cover:
 *   - coalescing: multiple calls in one window → one fetch
 *   - independent dispatch: calls to different endpoints never share a batch
 *   - result routing: each caller gets its own resolved result
 *   - error propagation: HTTP errors reject all pending
 *   - per-query server error: a single errored result rejects only that caller
 *   - large batch chunking: >200 queries → multiple fetch calls
 *   - singleton cache: getBatchFetcher returns the same function for the same endpoint
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBatchFetcher } from './batch-fetcher';
import { setSyncDeltaCodec, type SyncDeltaSlot } from '../../delta-codec';

// The batchers Map is module-level — isolate each test suite by using unique endpoint names.
let epCounter = 0;
const ep = () => `http://test-${++epCounter}`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeOkFetch(results: Array<{ rows?: unknown[]; version?: string; error?: string }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ results }),
  });
}

describe('getBatchFetcher', () => {
  it('coalesces parallel calls into a single fetch', async () => {
    const endpoint = ep();
    const mockFetch = makeOkFetch([
      { rows: [1], version: 'v1' },
      { rows: [2], version: 'v2' },
    ]);
    global.fetch = mockFetch;

    const fetcher = getBatchFetcher(endpoint);
    const p1 = fetcher('query.a', {});
    const p2 = fetcher('query.b', { id: 1 });

    vi.advanceTimersByTime(20);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r1.rows).toEqual([1]);
    expect(r2.rows).toEqual([2]);
  });

  it('routes each result to the correct caller', async () => {
    const endpoint = ep();
    global.fetch = makeOkFetch([
      { rows: ['alpha'], version: 'v1' },
      { rows: ['beta'], version: 'v2' },
      { rows: ['gamma'], version: 'v3' },
    ]);

    const fetcher = getBatchFetcher(endpoint);
    const [ra, rb, rc] = await Promise.all([
      (fetcher('a', {}), vi.advanceTimersByTime(20), fetcher('a', {})),
      fetcher('b', {}),
      fetcher('c', {}),
    ].map(async (p) => { vi.advanceTimersByTime(20); return p; }));

    // Simpler: just confirm 3 independent promises resolve
    const f2 = getBatchFetcher(endpoint + '-route');
    global.fetch = makeOkFetch([
      { rows: ['x'], version: 'v1' },
      { rows: ['y'], version: 'v2' },
      { rows: ['z'], version: 'v3' },
    ]);
    const px = f2('q1', {});
    const py = f2('q2', {});
    const pz = f2('q3', {});
    vi.advanceTimersByTime(20);
    const [rx, ry, rz] = await Promise.all([px, py, pz]);
    expect(rx.rows).toEqual(['x']);
    expect(ry.rows).toEqual(['y']);
    expect(rz.rows).toEqual(['z']);
  });

  it('rejects all callers on HTTP error', async () => {
    const endpoint = ep();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const fetcher = getBatchFetcher(endpoint);
    const p1 = fetcher('q1', {});
    const p2 = fetcher('q2', {});
    vi.advanceTimersByTime(20);

    await expect(p1).rejects.toThrow('503');
    await expect(p2).rejects.toThrow('503');
  });

  it('rejects only the errored query when results[i].error is set', async () => {
    const endpoint = ep();
    global.fetch = makeOkFetch([
      { rows: ['ok'], version: 'v1' },
      { error: 'query boom' },
    ]);

    const fetcher = getBatchFetcher(endpoint);
    const pOk = fetcher('good', {});
    const pErr = fetcher('bad', {});
    vi.advanceTimersByTime(20);

    await expect(pOk).resolves.toMatchObject({ rows: ['ok'] });
    await expect(pErr).rejects.toThrow('query boom');
  });

  it('rejects if a batch result is missing for a query', async () => {
    const endpoint = ep();
    // Only 1 result but 2 queries.
    global.fetch = makeOkFetch([{ rows: [1], version: 'v1' }]);

    const fetcher = getBatchFetcher(endpoint);
    const p1 = fetcher('q1', {});
    const p2 = fetcher('q2', {});
    vi.advanceTimersByTime(20);

    await expect(p1).resolves.toMatchObject({ rows: [1] });
    await expect(p2).rejects.toThrow('batch result missing');
  });

  it('returns the same function for the same endpoint (singleton cache)', () => {
    const endpoint = ep();
    const f1 = getBatchFetcher(endpoint);
    const f2 = getBatchFetcher(endpoint);
    expect(f1).toBe(f2);
  });

  it('different endpoints get independent batchers', () => {
    const a = getBatchFetcher(ep());
    const b = getBatchFetcher(ep());
    expect(a).not.toBe(b);
  });

  it('appends token query param when provided', async () => {
    const endpoint = ep();
    const mockFetch = makeOkFetch([{ rows: [], version: 'v1' }]);
    global.fetch = mockFetch;

    const fetcher = getBatchFetcher(endpoint, 'tok123');
    const p = fetcher('q', {});
    vi.advanceTimersByTime(20);
    await p;

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('token=tok123');
  });

  it('chunks batches larger than 200 into multiple fetches', async () => {
    const endpoint = ep();
    const N = 250;
    const chunk1Results = Array.from({ length: 200 }, (_, i) => ({ rows: [i], version: 'v' }));
    const chunk2Results = Array.from({ length: 50 }, (_, i) => ({ rows: [200 + i], version: 'v' }));

    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ results: call++ === 0 ? chunk1Results : chunk2Results }),
    }));

    const fetcher = getBatchFetcher(endpoint);
    const promises = Array.from({ length: N }, (_, i) => fetcher(`q${i}`, {}));
    vi.advanceTimersByTime(20);
    const results = await Promise.all(promises);

    expect((global.fetch as any).mock.calls.length).toBe(2);
    expect(results[0].rows).toEqual([0]);
    expect(results[200].rows).toEqual([200]);
  });
});

describe('getBatchFetcher — rows-delta (P-006)', () => {
  afterEach(() => {
    setSyncDeltaCodec(null);
    vi.unstubAllGlobals();
  });

  it('no codec → no `delta` field sent (byte-identical request)', async () => {
    const mockFetch = makeOkFetch([{ rows: [{ id: 'a' }], version: '1' }]);
    vi.stubGlobal('fetch', mockFetch);
    const p = getBatchFetcher(ep())('plans.attention', { x: 1 });
    await vi.runAllTimersAsync();
    expect((await p).rows).toEqual([{ id: 'a' }]);
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body).queries[0]).toEqual({
      name: 'plans.attention',
      args: { x: 1 },
    });
  });

  it('a delta-enabled query sends its cursor + returns the codec-decoded rows', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ rows: [{ id: 'a' }], version: '1', delta: { mode: 'full', cursor: 'c1', itemKeyField: 'id' } }],
      }),
    });
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
    const p = getBatchFetcher(ep())('plans.attention', {});
    await vi.runAllTimersAsync();
    expect((await p).rows).toEqual([{ id: 'a' }]);
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body).queries[0].delta).toBe(''); // cold opt-in
    expect(seen[0].delta?.mode).toBe('full');
  });

  it('refetches a clean full when the codec signals a checksum mismatch', async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        results: [
          ++call === 1
            ? { changes: [], version: '1', delta: { mode: 'delta', cursor: 'c2' } }
            : { rows: [{ id: 'fresh' }], version: '2', delta: { mode: 'full', cursor: 'c3' } },
        ],
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);
    setSyncDeltaCodec({
      enabled: () => true,
      viewKey: () => 'v',
      cursorFor: () => 'c1', // warm → a mismatch must trigger a full refetch
      decodeResult: (_vk, slot) =>
        slot.delta?.mode === 'delta'
          ? { rows: [], refetchFull: true }
          : { rows: slot.rows ?? [], refetchFull: false },
    });
    const p = getBatchFetcher(ep())('plans.list', {});
    await vi.runAllTimersAsync();
    expect((await p).rows).toEqual([{ id: 'fresh' }]);
    expect(mockFetch.mock.calls.length).toBe(2);
  });
});
