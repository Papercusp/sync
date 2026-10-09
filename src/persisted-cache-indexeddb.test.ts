/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { QueryClient } from '@tanstack/react-query';
import { IndexedDbKvPersistence } from '@papercusp/kv-persist-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enablePersistedSyncCache } from './persisted-cache';

type Snapshot = { id: string; v: number; value: string };
const KEY = 'papercusp:sync-cache:v1';
const QUERY = ['sync', 'accounts.pool', {}];
const clients: QueryClient[] = [];
const disposers: Array<() => void> = [];
const browserStorage = {
  getItem: vi.fn<Storage['getItem']>(() => null),
  setItem: vi.fn<Storage['setItem']>(),
  removeItem: vi.fn<Storage['removeItem']>(),
};
const client = () => {
  const value = new QueryClient();
  clients.push(value);
  return value;
};
const backing = () => new IndexedDbKvPersistence<Snapshot>({
  dbName: 'papercusp-sync-cache', storeName: 'snapshots', writeDebounceMs: 0,
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  // The test setup can expose Node's non-browser localStorage placeholder.
  vi.stubGlobal('localStorage', browserStorage);
  browserStorage.setItem.mockClear();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const value of clients.splice(0)) value.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('default IndexedDB sync-cache persistence', () => {
  it('persists changing data across reloads without touching the localStorage WAL', async () => {
    const writes = browserStorage.setItem;
    const source = client();
    const stop = enablePersistedSyncCache({ client: source, debounceMs: 0 });
    disposers.push(stop);
    await stop.ready;
    expect(enablePersistedSyncCache({ client: source })).toBe(stop);
    for (let version = 1; version <= 3; version++) {
      source.setQueryData(QUERY, { rows: [{ readingAgeMs: version }], version: String(version) });
      await vi.waitFor(async () => {
        const [record] = await backing().load();
        const data = record && JSON.parse(record.value).state.queries[0].state.data;
        expect(data?.version).toBe(String(version));
      });
    }
    expect(writes).not.toHaveBeenCalled();
    stop();
    const target = client();
    const restored = enablePersistedSyncCache({ client: target, debounceMs: 0 });
    disposers.push(restored);
    await restored.ready;
    expect(target.getQueryData(QUERY)).toEqual({ rows: [{ readingAgeMs: 3 }], version: '3' });
    expect(target.getQueryState(QUERY)?.isInvalidated).toBe(true);
  });

  it('preserves a newer live response that arrives while the disk read is pending', async () => {
    const source = client();
    const seed = enablePersistedSyncCache({ client: source, debounceMs: 0 });
    disposers.push(seed);
    await seed.ready;
    source.setQueryData(QUERY, { rows: ['disk'] }, { updatedAt: 1 });
    await vi.waitFor(async () => expect((await backing().load())[0]?.id).toBe(KEY));
    seed();
    const target = client();
    const stop = enablePersistedSyncCache({ client: target });
    disposers.push(stop);
    target.setQueryData(QUERY, { rows: ['live'] }, { updatedAt: Date.now() });
    await stop.ready;
    expect(target.getQueryData(QUERY)).toEqual({ rows: ['live'] });
    expect(target.getQueryState(QUERY)?.isInvalidated).toBe(false);
  });

  it('disposal during an asynchronous load prevents a late writer from starting', async () => {
    let finish!: (rows: Snapshot[]) => void;
    vi.spyOn(IndexedDbKvPersistence.prototype, 'load').mockImplementation(() =>
      new Promise<Snapshot[]>((resolve) => { finish = resolve; }));
    const save = vi.spyOn(IndexedDbKvPersistence.prototype, 'save');
    const source = client();
    const stop = enablePersistedSyncCache({ client: source, debounceMs: 0 });
    disposers.push(stop);
    stop();
    finish([]);
    await stop.ready;
    source.setQueryData(QUERY, { rows: ['late'] });
    window.dispatchEvent(new Event('pagehide'));
    expect(save).not.toHaveBeenCalled();
  });

  it('unavailable IndexedDB keeps the app usable without falling back to localStorage', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const writes = browserStorage.setItem;
    try {
      const source = client();
      const stop = enablePersistedSyncCache({ client: source, debounceMs: 0 });
      disposers.push(stop);
      await stop.ready;
      source.setQueryData(QUERY, { rows: ['live'] });
      window.dispatchEvent(new Event('pagehide'));
      expect(source.getQueryData(QUERY)).toEqual({ rows: ['live'] });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
