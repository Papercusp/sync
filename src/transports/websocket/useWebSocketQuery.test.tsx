// @vitest-environment jsdom
//
// useWebSocketQuery — the WS-transport query hook factory. The contract its call
// sites depend on: data defaults to a stable [] (never undefined), loading is
// exactly `data === undefined`, transport is 'WEBSOCKETS', and the query is
// resolved once per (queryName, JSON(args)) — a new ZQL object every render would
// make useQuery loop. The zero `useQuery` primitive + resolveQuery are mocked so
// the test pins the mapping/memoization, not the WS stack.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  data: undefined as unknown,
  useQuery: vi.fn((_q: unknown, _o: unknown) => [h.data] as const),
  resolveQuery: vi.fn((name: string) => ({ q: name })),
}));
vi.mock('@rocicorp/zero/react', () => ({ useQuery: (q: unknown, o: unknown) => h.useQuery(q, o) }));
vi.mock('./resolveQuery', () => ({ resolveQuery: (n: string, a: unknown, q: unknown) => h.resolveQuery(n, a as never, q as never) }));

import { createUseWebSocketQuery } from './useWebSocketQuery';

beforeEach(() => {
  h.data = undefined;
  h.useQuery.mockClear();
  h.resolveQuery.mockClear();
});
afterEach(cleanup);

describe('createUseWebSocketQuery', () => {
  it('maps undefined data to a stable empty array + loading=true', () => {
    h.data = undefined;
    const useWS = createUseWebSocketQuery({});
    const { result } = renderHook(() => useWS({ queryName: 'rows', args: { a: 1 } }));
    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.transport).toBe('WEBSOCKETS');
    expect(result.current.error).toBeNull();
    expect(result.current.fetching).toBe(false);
  });

  it('passes through resolved data with loading=false', () => {
    h.data = [{ id: 1 }, { id: 2 }];
    const useWS = createUseWebSocketQuery({});
    const { result } = renderHook(() => useWS({ queryName: 'rows', args: {} }));
    expect(result.current.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.current.loading).toBe(false);
  });

  it('disables the query (undefined to useQuery) when enabled=false', () => {
    const useWS = createUseWebSocketQuery({});
    renderHook(() => useWS({ queryName: 'rows', args: {}, enabled: false }));
    expect(h.useQuery).toHaveBeenCalled();
    expect(h.useQuery.mock.calls[0][0]).toBeUndefined();
  });

  it('forwards ttl as the useQuery option', () => {
    const useWS = createUseWebSocketQuery({});
    renderHook(() => useWS({ queryName: 'rows', args: {}, ttl: '5m' as never }));
    expect(h.useQuery.mock.calls[0][1]).toEqual({ ttl: '5m' });
  });

  it('memoizes the resolved query across re-renders with equal args (no render-loop churn)', () => {
    const useWS = createUseWebSocketQuery({});
    const { rerender } = renderHook(({ a }) => useWS({ queryName: 'rows', args: { a } }), {
      initialProps: { a: 1 },
    });
    rerender({ a: 1 }); // same args → must reuse the memoized query
    expect(h.resolveQuery).toHaveBeenCalledTimes(1);
    rerender({ a: 2 }); // changed args → resolve again
    expect(h.resolveQuery).toHaveBeenCalledTimes(2);
  });
});
