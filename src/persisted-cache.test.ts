/**
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
