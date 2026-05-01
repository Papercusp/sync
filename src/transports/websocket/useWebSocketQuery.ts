'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@rocicorp/zero/react';
import { resolveQuery } from './resolveQuery';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

/**
 * Build a useWebSocketQuery hook bound to a specific named-query registry.
 * Created by WebSocketAdapter once at mount time and stored on the
 * SyncContext so call sites get a queries-aware hook without each call
 * having to thread the registry.
 */
export function createUseWebSocketQuery(queries: any) {
  return function useWebSocketQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    const { queryName, args = {}, enabled = true, ttl } = opts;

    // Stable argsKey prevents a new ZQL object on every render (which would
    // cause useQuery to see a new query reference every render → infinite loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const query = useMemo(() => resolveQuery(queryName, args, queries), [queryName, JSON.stringify(args)]);
    const [data] = useQuery(enabled ? query : undefined, ttl !== undefined ? { ttl: ttl as any } : undefined);

    return {
      data: (data ?? (EMPTY_ARRAY as unknown)) as T[],
      loading: data === undefined,
      fetching: false,
      transport: 'WEBSOCKETS',
      invalidate: useCallback(() => {}, []),
      error: null,
    };
  };
}
