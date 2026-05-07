import { QueryClient } from '@tanstack/react-query';

let queryClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!queryClient) {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5_000,
          // gcTime: 1 hour. Queries survive subscriber unmount so navigating
          // away and back in genuine polling mode shows cached data instantly.
          // WebSocketAdapter calls clearPollingCache() on mount to stop any
          // probe-window polls the moment WS takes over, so long gcTime does
          // not cause background REST leakage in WS mode.
          gcTime: 60 * 60 * 1000,
          refetchOnWindowFocus: false,
          structuralSharing: true, // preserves unchanged refs across refetches
          // Skip re-renders triggered by metadata-only flips (dataUpdatedAt,
          // fetchStatus, failureCount, isStale). Consumers care about data,
          // error, and the loading/fetching flags exposed via SyncQueryResult.
          // Without this, a background refetch that returns structurally-equal
          // data still flips dataUpdatedAt and fans out a render to every
          // subscriber. Listed flags must include every property usePollingQuery
          // reads from useQuery's return.
          notifyOnChangeProps: ['data', 'error', 'isLoading', 'isFetching', 'isPlaceholderData'],
        },
      },
    });
  }
  return queryClient;
}

/**
 * Immediately cancels all in-flight queries and removes them from cache.
 * Called by WebSocketAdapter on mount so that probe-window polling stops
 * the moment WS takes over, without sacrificing normal gcTime for the
 * genuine-polling-fallback path.
 */
export function clearPollingCache(): void {
  if (!queryClient) return;
  queryClient.cancelQueries();
  queryClient.clear();
}