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
