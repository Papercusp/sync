/**
 * Persisted sync cache (WI-3318) — app-wide stale-while-revalidate across
 * reloads. Snapshots the sync QueryClient's successful queries to
 * `localStorage` (debounced, size-capped) and hydrates them back BEFORE the
 * first component mounts, so a reload paints every panel from disk instantly
 * while the normal staleTime/SSE-invalidate machinery revalidates in the
 * background.
 *
 * Hand-rolled on react-query's own `dehydrate`/`hydrate` instead of
 * `@tanstack/react-query-persist-client`: the QueryClient here is a lib
 * singleton (SSEAdapter mounts its own `QueryClientProvider` around
 * `getQueryClient()` — there is no app-level provider to wrap in a
 * `PersistQueryClientProvider`), restore must be SYNCHRONOUS to beat the
 * first `useQuery` mount, and no new dependency is needed.
 *
 * Opt-in: nothing here runs unless the HOST APP calls
 * `enablePersistedSyncCache()` at module-eval time (the same
 * before-any-component-mounts slot the desktop IPC polyfills use — see
 * apps/operator RootSyncProvider). Other consumers of @papercusp/sync are
 * untouched.
 *
 * Failure posture: best-effort cache. Every storage/parse failure degrades to
 * "no persisted cache" (bad entries are removed), never to a thrown error on
 * the boot path.
 */
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import { getQueryClient } from './transports/polling/queryClient';

/** Minimal storage seam (localStorage-shaped) so tests inject an in-memory one. */
export type SyncCacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PersistedSyncCacheOptions {
  /** Storage key. Default `papercusp:sync-cache:v1`. */
  key?: string;
  /**
   * Cache-buster: persisted snapshots written under a different buster are
   * dropped on restore. Bump (or pass a build id) when row shapes change
   * incompatibly.
   */
  buster?: string;
  /** Drop snapshots older than this on restore. Default 24h. */
  maxAgeMs?: number;
  /**
   * Skip the write when the serialized snapshot exceeds this many chars
   * (~bytes for JSON) — localStorage quota is ~5MB and a QuotaExceededError
   * inside the subscriber would otherwise fire on every cache event.
   * Default 4 MiB.
   */
  maxBytes?: number;
  /** Debounce between cache-event and write. Default 1000ms. */
  debounceMs?: number;
  /** Default `window.localStorage`. */
  storage?: SyncCacheStorage;
  /** Default: the sync transports' singleton (`getQueryClient()`). */
  client?: QueryClient;
}

interface Envelope {
  v: number;
  buster: string;
  ts: number;
  state: ReturnType<typeof dehydrate>;
}

const ENVELOPE_VERSION = 1;
const DEFAULT_KEY = 'papercusp:sync-cache:v1';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 1000;

function resolveStorage(opts?: PersistedSyncCacheOptions): SyncCacheStorage | null {
  if (opts?.storage) return opts.storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Sandboxed frame / storage-disabled webview: localStorage GETTER throws.
  }
  return null;
}

/**
 * Hydrate the persisted snapshot into the client. Synchronous — call before
 * the first `useQuery` mounts. Returns true when a snapshot was applied.
 */
export function restorePersistedSyncCache(opts: PersistedSyncCacheOptions = {}): boolean {
  const storage = resolveStorage(opts);
  if (!storage) return false;
  const key = opts.key ?? DEFAULT_KEY;
  try {
    const raw = storage.getItem(key);
    if (!raw) return false;
    const env = JSON.parse(raw) as Envelope;
    const fresh =
      env &&
      env.v === ENVELOPE_VERSION &&
      env.buster === (opts.buster ?? '') &&
      typeof env.ts === 'number' &&
      Date.now() - env.ts <= (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS) &&
      env.state != null;
    if (!fresh) {
      storage.removeItem(key);
      return false;
    }
    hydrate(opts.client ?? getQueryClient(), env.state);
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* storage gone mid-flight — nothing to clean */
    }
    return false;
  }
}

/**
 * Subscribe to the query cache and write a debounced snapshot on change
 * (plus a final synchronous flush on pagehide). Returns a dispose fn.
 * Persists only SUCCESSFUL queries, and skips any query whose
 * `meta.persist === false`.
 */
export function startSyncCachePersistence(opts: PersistedSyncCacheOptions = {}): () => void {
  const storage = resolveStorage(opts);
  if (!storage) return () => {};
  const key = opts.key ?? DEFAULT_KEY;
  const client = opts.client ?? getQueryClient();
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const flush = () => {
    try {
      const state = dehydrate(client, {
        shouldDehydrateQuery: (q) => q.state.status === 'success' && q.meta?.persist !== false,
      });
      const serialized = JSON.stringify({
        v: ENVELOPE_VERSION,
        buster: opts.buster ?? '',
        ts: Date.now(),
        state,
      } satisfies Envelope);
      if (serialized.length > maxBytes) return; // over budget — keep the last good snapshot
      storage.setItem(key, serialized);
    } catch {
      // Quota / serialization failure: drop the stored snapshot so restore
      // never resurrects a half-written or perpetually-oversized entry.
      try {
        storage.removeItem(key);
      } catch {
        /* storage gone — nothing to clean */
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  };

  const unsubscribe = client.getQueryCache().subscribe(scheduleFlush);
  // Debounce leaves up to debounceMs of tail loss on navigation/close —
  // pagehide (the reliable unload signal, fires on tab close AND bfcache
  // entry) gets a final synchronous write.
  const onPageHide = () => flush();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return () => {
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
  };
}

let activeDispose: (() => void) | null = null;

/**
 * Restore + start persistence in one call (idempotent — a second call is a
 * no-op returning the active dispose). The host app calls this once at
 * module-eval time, before any component mounts.
 */
export function enablePersistedSyncCache(opts: PersistedSyncCacheOptions = {}): () => void {
  if (activeDispose) return activeDispose;
  restorePersistedSyncCache(opts);
  const stop = startSyncCachePersistence(opts);
  activeDispose = () => {
    stop();
    activeDispose = null;
  };
  return activeDispose;
}
