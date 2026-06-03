export type SyncType = 'WEBSOCKETS' | 'SSE' | 'POLLING';

export interface SyncProviderProps {
  syncType?: SyncType;
  children: React.ReactNode;
  /** User ID for the sync connection. */
  userId?: string;
  /** Server URL for Zero (WS mode) or REST endpoint base (polling mode). */
  server?: string;
  /** REST endpoint base URL for polling. Default: server value or '/zero'. */
  restEndpoint?: string;
  /** Polling interval in ms. Default: 10_000 (10s). */
  pollIntervalMs?: number;
  /** Seconds of WS disconnection before fallback. Default: 10_000 (10s). */
  fallbackDelayMs?: number;
  /**
   * Zero schema for the WebSocket transport. Required when syncType is
   * 'WEBSOCKETS'. Polling-only consumers can omit it.
   *
   * Caller imports their app-specific schema package directly (e.g.
   * `@papercusp/zero` for shop, `@papercusp/zero-harness` for harness) so
   * @papercusp/sync stays schema-agnostic.
   */
  schema?: any;
  /**
   * Named-query registry matching `schema`. Required for WebSockets.
   * Used to translate queryName → ZQL.
   */
  queries?: any;
  /**
   * When set, the SSE EventSource URL gets `?token=<value>` appended.
   * For environments that auth via a query-string token because
   * EventSource can't carry custom headers (e.g. mobile + JWT-gated
   * `/api/device/sync/sse`).
   *
   * Only applied to the SSE transport; ignored by WS / polling.
   */
  tokenQueryParam?: string;
  /**
   * Override the default SSE endpoint path (which is `${restEndpoint}/sse`).
   * Use the absolute path you want hit, e.g. `/api/device/sync/sse`.
   *
   * The polling fetcher still goes to `${restEndpoint}/rest-query` —
   * this only affects the EventSource URL.
   */
  endpointOverride?: string;
  /**
   * When true, the SSE adapter pauses (closes the EventSource) once
   * `document.visibilityState === 'hidden'` for VISIBILITY_PAUSE_MS,
   * and reopens on next visibility return.
   *
   * Saves battery on phones and idle background tabs without breaking
   * the polling fallback (which still ticks per `pollIntervalMs`).
   * Default: false (preserves prior always-on behavior).
   */
  visibilityPause?: boolean;
  /**
   * Zero custom-mutator registry (`createMutators()`) enabling optimistic
   * writes on the WebSocket transport. Only used by WEBSOCKETS; polling/SSE
   * route writes through the per-call REST fallback in `useSyncMutate`.
   */
  mutators?: any;
}

export interface SyncQueryOptions {
  /** Dot-separated query name from the registry: 'products.page', 'shopOrders.byCustomer' */
  queryName: string;
  /** Arguments passed to the parameterized query. */
  args?: Record<string, unknown>;
  /** Polling interval override for this specific query. */
  pollIntervalMs?: number;
  /** Whether this query is enabled. Default: true. */
  enabled?: boolean;
  /**
   * Time-to-live for the materialized query, used by the WebSocket transport.
   * Accepts the same values as `@rocicorp/zero`'s `TTL`: a number of ms,
   * 'forever', 'none', or a string like `'5m'`, `'1h'`.
   *
   * Honored by the WebSocket transport (threaded into `useQuery(query, { ttl })`).
   * Ignored by the polling transport (polling is stateless — the materialized
   * view concept does not apply; cadence is controlled by `pollIntervalMs`).
   */
  ttl?: string | number;
  /**
   * Override the cache freshness window for this query (polling/SSE
   * transports). When the cached entry is younger than `staleTime`, react-query
   * serves it without a network round-trip on remount/refocus. Defaults to the
   * QueryClient's global staleTime (5s). Use higher values (e.g. 30_000) for
   * human-cadence data where a few seconds of staleness is acceptable; use 0
   * for queries that must always refetch on key change.
   *
   * Ignored by the WebSocket transport (Zero materialized views are always
   * fresh by construction).
   */
  staleTime?: number;
}

export interface SyncQueryResult<T = any> {
  /** The current data — always an array, never undefined. */
  data: T[];
  /** True only on initial load when no data is available yet. */
  loading: boolean;
  /** True whenever a fetch is in-flight (including background refetches and key changes). */
  fetching: boolean;
  /** Current active transport. */
  transport: SyncType;
  /** Force an immediate refetch (polling mode) or no-op (WS mode). */
  invalidate: () => void;
  /** Error from the last fetch attempt, if any. */
  error: Error | null;
}

/** Internal: the hook implementation injected by each transport adapter. */
export type UseDataImpl = <T = any>(opts: SyncQueryOptions) => SyncQueryResult<T>;

/** Eagerly cache a query result so a future useSyncQuery with the same key is instant. */
export type PrefetchSyncFn = (opts: SyncQueryOptions) => void;

/**
 * Zero's `zero.mutate` dispatcher — namespaced custom mutators
 * (`mutate.cart.addItem(args)`). Present only on the WebSocket transport;
 * `null`/absent on polling/SSE (writes fall back to REST).
 */
export type MutateImpl = Record<string, Record<string, (args: any) => Promise<unknown>>>;
