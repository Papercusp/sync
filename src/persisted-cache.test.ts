/**
 * @vitest-environment jsdom
 *
 * WI-3318 — persisted sync cache round-trip + guard rails. Hermetic: an
 * in-memory Storage stands in for localStorage, explicit QueryClients stand
 * in for the transport singleton (the `client` option), fake timers drive the
 * debounce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  restorePersistedSyncCache,
  startSyncCachePersistence,
  type SyncCacheStorage,
} from './persisted-cache';

function memoryStorage(): SyncCacheStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const KEY = 'papercusp:sync-cache:v1';

let clients: QueryClient[] = [];
function track(c: QueryClient): QueryClient {
  clients.push(c);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const c of clients) c.clear();
  clients = [];
  vi.useRealTimers();
});

describe('persisted sync cache', () => {
  it('round-trips: a flushed snapshot hydrates a fresh client with data + timestamps', () => {
    const storage = memoryStorage();
    const rows = { rows: [{ id: 'WI-1', title: 'first' }] };
    const source = track(new QueryClient());
    // Subscribe FIRST (matching the real wiring: enable runs at module-eval,
    // before any query lands), then let data arrive and the debounce elapse.
    const stop = startSyncCachePersistence({ client: source, storage });
    source.setQueryData(['sync', 'work_items', {}], rows);
    const before = source.getQueryState(['sync', 'work_items', {}])!.dataUpdatedAt;
    vi.advanceTimersByTime(1000);
    stop();
    expect(storage.map.has(KEY)).toBe(true);

    const target = track(new QueryClient());
    const restored = restorePersistedSyncCache({ client: target, storage });
    expect(restored).toBe(true);
    expect(target.getQueryData(['sync', 'work_items', {}])).toEqual(rows);
    // dataUpdatedAt survives, so staleTime math (⇒ immediate background
    // revalidate) works from the ORIGINAL fetch time, not the reload time.
    expect(target.getQueryState(['sync', 'work_items', {}])!.dataUpdatedAt).toBe(before);
  });

  it('debounces: many cache events in one window produce one write', () => {
    const storage = memoryStorage();
    const setSpy = vi.spyOn(storage, 'setItem');
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage });
    for (let i = 0; i < 25; i++) client.setQueryData(['sync', 'q', { i }], { rows: [i] });
    vi.advanceTimersByTime(1000);
    expect(setSpy).toHaveBeenCalledTimes(1);
    stop();
  });

  it('WI-5983: repeated debounce cycles with UNCHANGED content write only once (no perpetual identical-write loop)', () => {
    // The regression this guards: with no backend reachable, EVERY query
    // stays non-success forever, so the dehydrated snapshot never changes —
    // but the query cache still fires `subscribe` on every failed-retry state
    // transition, re-arming the debounce every cycle. Before the WI-5983 fix,
    // that meant one localStorage write per debounce window, FOREVER, even
    // though the persisted content was byte-identical every time (observed in
    // the wild as an unbounded WAL-growth leak on a clean-room VM).
    const storage = memoryStorage();
    const setSpy = vi.spyOn(storage, 'setItem');
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage });
    client.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    expect(setSpy).toHaveBeenCalledTimes(1);

    // Simulate many more debounce cycles firing with NO change to the
    // persistable state (e.g. only failed/errored queries churning) — each
    // cycle still invokes flush(), but none should write again.
    for (let cycle = 0; cycle < 20; cycle++) {
      client.getQueryCache().notify({ type: 'observerResultsUpdated' } as never);
      vi.advanceTimersByTime(1000);
    }
    expect(setSpy).toHaveBeenCalledTimes(1);

    // A REAL change still writes.
    client.setQueryData(['sync', 'q', {}], { rows: [1, 2] });
    vi.advanceTimersByTime(1000);
    expect(setSpy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('drops a snapshot written under a different buster', () => {
    const storage = memoryStorage();
    const source = track(new QueryClient());
    const stop = startSyncCachePersistence({ client: source, storage, buster: 'sha-old' });
    source.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    stop();
    expect(storage.map.has(KEY)).toBe(true); // the sha-old snapshot really landed

    const target = track(new QueryClient());
    expect(restorePersistedSyncCache({ client: target, storage, buster: 'sha-new' })).toBe(false);
    expect(target.getQueryData(['sync', 'q', {}])).toBeUndefined();
    expect(storage.map.has(KEY)).toBe(false); // stale-buster entry is cleaned up
  });

  it('drops a snapshot older than maxAgeMs', () => {
    const storage = memoryStorage();
    const source = track(new QueryClient());
    const stop = startSyncCachePersistence({ client: source, storage });
    source.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    stop();
    expect(storage.map.has(KEY)).toBe(true); // snapshot really landed

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // 25h later
    const target = track(new QueryClient());
    expect(restorePersistedSyncCache({ client: target, storage })).toBe(false);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('tolerates a corrupt stored entry: restore returns false and removes it', () => {
    const storage = memoryStorage();
    storage.map.set(KEY, '{not json');
    const target = track(new QueryClient());
    expect(restorePersistedSyncCache({ client: target, storage })).toBe(false);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('excludes queries marked meta.persist:false and non-success queries', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    client.setQueryData(['sync', 'keep', {}], { rows: [1] });
    // meta rides the query options; set it via fetchQuery's queryFn wrapper.
    void client.prefetchQuery({
      queryKey: ['sync', 'secret', {}],
      queryFn: () => Promise.resolve({ rows: ['sensitive'] }),
      meta: { persist: false },
    });
    return vi
      .runAllTimersAsync()
      .then(() => {
        const stop = startSyncCachePersistence({ client, storage });
        client.setQueryData(['sync', 'keep', {}], { rows: [1, 2] }); // trigger an event
        vi.advanceTimersByTime(1000);
        stop();

        const target = track(new QueryClient());
        expect(restorePersistedSyncCache({ client: target, storage })).toBe(true);
        expect(target.getQueryData(['sync', 'keep', {}])).toEqual({ rows: [1, 2] });
        expect(target.getQueryData(['sync', 'secret', {}])).toBeUndefined();
      });
  });

  it('skips the write (keeping the last good snapshot) when over maxBytes', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage, maxBytes: 10 });
    client.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    stop();
    expect(storage.map.has(KEY)).toBe(false); // never written — over budget from the start
  });

  it('flushes synchronously on pagehide (no debounce-window tail loss)', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage });
    client.setQueryData(['sync', 'late', {}], { rows: ['tail'] });
    // No timer advance — simulate the tab closing inside the debounce window.
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.map.has(KEY)).toBe(true);
    stop();

    const target = track(new QueryClient());
    expect(restorePersistedSyncCache({ client: target, storage })).toBe(true);
    expect(target.getQueryData(['sync', 'late', {}])).toEqual({ rows: ['tail'] });
  });

  // ---------------------------------------------------------------- WI-6502
  // Recurrence guards for the owner-reported typing lag. The persister ran a
  // full dehydrate + replacer-stringify of a 3236KB cache on EVERY cache event
  // (~1/s) — ~36ms of main-thread block that keystrokes then queued behind —
  // and, because every write threw QuotaExceededError and the catch reset the
  // dedup key, it persisted nothing at all while doing it. Each test below
  // fails if one of those three defects returns.

  it('does not re-serialize when a cache event changes no persistable data', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    // Count the work: stringify is the expensive step the flush used to pay
    // unconditionally, so spy on it rather than on the (deduped) write.
    const stop = startSyncCachePersistence({ client, storage });
    client.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    expect(storage.map.has(KEY)).toBe(true);

    // Non-vacuity check FIRST: a real data change must still serialize, so a
    // zero below means "the gate short-circuited", not "the flush never ran".
    const spy = vi.spyOn(JSON, 'stringify');
    client.setQueryData(['sync', 'q', {}], { rows: [1, 2] });
    vi.advanceTimersByTime(1000);
    const whenDataChanged = spy.mock.calls.length;

    spy.mockClear();
    // A cache event that touches no persistable DATA: an invalidate marks the
    // query stale and notifies subscribers, but dataUpdatedAt does not move.
    client.invalidateQueries({ queryKey: ['sync', 'q', {}] });
    vi.advanceTimersByTime(1000);
    const whenNothingChanged = spy.mock.calls.length;
    spy.mockRestore();
    stop();

    expect(whenDataChanged).toBeGreaterThan(0); // the flush path is live
    expect(whenNothingChanged).toBe(0); // ...and the gate short-circuits before serializing
  });

  it('still writes when data actually changes (the gate is not just "never flush")', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage });
    client.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000);
    client.setQueryData(['sync', 'q', {}], { rows: [1, 2] });
    vi.advanceTimersByTime(1000);
    stop();
    const target = track(new QueryClient());
    restorePersistedSyncCache({ client: target, storage });
    expect(target.getQueryData(['sync', 'q', {}])).toEqual({ rows: [1, 2] });
  });

  it('gives up after repeated write failures instead of retrying every cache event', () => {
    const map = new Map<string, string>();
    let attempts = 0;
    const failing: SyncCacheStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: () => {
        attempts += 1;
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => void map.delete(k),
    };
    const client = track(new QueryClient());
    const stop = startSyncCachePersistence({ client, storage: failing });
    for (let i = 0; i < 12; i++) {
      client.setQueryData(['sync', 'q', {}], { rows: Array.from({ length: i + 1 }, (_, n) => n) });
      vi.advanceTimersByTime(1000);
    }
    stop();
    // Before the fix the catch reset the dedup key, so all 12 data changes
    // re-serialized and re-attempted the write, forever.
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it('measures the size budget in BYTES, not UTF-16 code units', () => {
    const storage = memoryStorage();
    const client = track(new QueryClient());
    // ~1200 chars of payload => ~2400 bytes. A 2000-BYTE budget must reject it;
    // the old `.length > maxBytes` comparison would have accepted it.
    const stop = startSyncCachePersistence({ client, storage, maxBytes: 2000 });
    client.setQueryData(['sync', 'big', {}], { rows: ['x'.repeat(1200)] });
    vi.advanceTimersByTime(1000);
    stop();
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('returns false with no storage available (SSR / storage-disabled webview)', () => {
    const target = track(new QueryClient());
    // jsdom HAS localStorage; force the no-storage path via an explicit null-ish seam.
    const throwing: SyncCacheStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(restorePersistedSyncCache({ client: target, storage: throwing })).toBe(false);
    const stop = startSyncCachePersistence({ client: target, storage: throwing });
    target.setQueryData(['sync', 'q', {}], { rows: [1] });
    vi.advanceTimersByTime(1000); // flush throws internally — must not escape
    stop();
  });
});
