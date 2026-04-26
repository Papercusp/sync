'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@rocicorp/zero/react';
import { resolveQuery } from './resolveQuery';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';

// Stable singleton empty array so callers that use `data` as a useMemo /
// useCallback dep don't re-run on every render while the query is loading.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

export function useWebSocketQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
  const { queryName, args = {}, enabled = true, ttl } = opts;

  // Stable argsKey prevents a new ZQL object on every render (which would
  // cause useQuery to see a new query reference every render → infinite loop).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(() => resolveQuery(queryName, args), [queryName, JSON.stringify(args)]);
  // ttl is passed per-render (no memoization needed — primitive value).
  const [data] = useQuery(enabled ? query : undefined, ttl !== undefined ? { ttl: ttl as any } : undefined);

  return {
    data: (data ?? (EMPTY_ARRAY as unknown)) as T[],
    loading: data === undefined,
    fetching: false,
    transport: 'WEBSOCKETS',
    invalidate: useCallback(() => {}, []), // No-op — Zero auto-updates
    error: null,
  };
}
