export { SyncProvider } from './SyncProvider';
export { onSyncBusEvent, emitSyncBusEvent, type SyncBusEvent } from './bus-tap';
export {
  useSyncConnectivity,
  getSyncConnectivity,
  onSyncConnectivity,
  reportSyncReachable,
  reportSyncUnreachable,
  _resetSyncConnectivityForTests,
  type SyncConnectivity,
  useSyncStaleOperator,
  getSyncStaleOperator,
  onSyncStaleOperator,
  reportSyncStaleOperator,
  _resetSyncStaleOperatorForTests,
  type SyncStaleOperator,
} from './connectivity';
export {
  lazyWithRetry,
  shouldAutoReloadChunkFailure,
  isChunkLoadError,
  CHUNK_LOAD_ERROR_RE,
} from './lazy-with-retry';
export { useSyncQuery, useSyncMutate, useSyncPrefetch, useSyncContext, SyncContext } from './SyncContext';
export { fetchSyncQuery } from './transports/polling/usePollingQuery';
export {
  DEFAULT_MAX_IN_FLIGHT,
  CONNECTION_CAPPED_MAX_IN_FLIGHT,
  // Published because a CALLER cannot set its own ceiling correctly without it:
  // any caller-side timeout must sit ABOVE this one, or it pre-empts the sync
  // layer's real rejection message with an opaque timeout of its own (P-009 /
  // WI-6559). The ordering is load-bearing, so the number has to be readable
  // rather than duplicated as a literal at each call site.
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './transports/polling/query-fetcher';
export { useOwnedSyncEntity, selectOwnedData } from './useOwnedSyncEntity';
export type { UseOwnedSyncEntityOptions, UseOwnedSyncEntityResult } from './useOwnedSyncEntity';
export { syncMetrics, installSyncMetricsGlobal } from './observability/metrics';
export type { SyncMetricsSnapshot } from './observability/metrics';
export { configureQueryHealth } from './observability/query-health';
export type { QueryHealthConfig } from './observability/query-health';

// Persisted sync cache (WI-3318): host-app opt-in reload hydration of the sync
// QueryClient — call enablePersistedSyncCache() at module-eval time.
export {
  enablePersistedSyncCache,
  restorePersistedSyncCache,
  startSyncCachePersistence,
} from './persisted-cache';
export type { PersistedSyncCacheOptions, SyncCacheStorage } from './persisted-cache';

// Rows-delta CLIENT seam (agent-tool-delta-client-rollout-2026-06-23 P-006) — the host
// (operator) injects a codec backed by the tooldef DeltaToolClient; no codec = full, as today.
export { setSyncDeltaCodec, getSyncDeltaCodec } from './delta-codec';
export type { SyncDeltaCodec, SyncDeltaMeta, SyncDeltaSlot } from './delta-codec';
export type {
  SyncType,
  SyncProviderProps,
  SyncQueryOptions,
  SyncQueryResult,
  PrefetchSyncFn,
  MutateImpl,
} from './types';

export {
  useSyncVirtualizer,
  useHistoryScrollState,
  useHistoryState,
  type UseSyncVirtualizerOptions,
  type SyncVirtualizerResult,
  type ScrollHistoryState,
  type Anchor,
  type GetPageQuery,
  type GetPageQueryOptions,
  type GetSingleQuery,
  type GetSingleQueryOptions,
  type SyncQueryRequest,
} from './virtualizer';
