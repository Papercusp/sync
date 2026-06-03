import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { SyncContext } from './SyncContext';
import { useOwnedSyncEntity, selectOwnedData } from './useOwnedSyncEntity';
import type { SyncType } from './types';

// ── Pure core (invariant a — no React) ──────────────────────────────────────
describe('selectOwnedData', () => {
  const cfg = { map: (r: { n: number }) => ({ mapped: r.n }), empty: null as { mapped: number } | null };
  it('keeps the current value while the query is loading (seed precedence)', () => {
    expect(selectOwnedData({ mapped: -1 }, { loading: true, row: { n: 1 } }, cfg)).toEqual({ mapped: -1 });
  });
  it('maps the row once loaded', () => {
    expect(selectOwnedData(null, { loading: false, row: { n: 5 } }, cfg)).toEqual({ mapped: 5 });
  });
  it('returns empty when loaded with no row', () => {
    expect(selectOwnedData({ mapped: 9 }, { loading: false, row: undefined }, cfg)).toBe(null);
  });
});

// ── Hook orchestration (fake transport) ─────────────────────────────────────
type Row = { id: string; n: number };
type Shape = { kind: string; n?: number };

function fakeCtx(transport: SyncType, query: { data: Row[]; loading: boolean }) {
  return {
    transport,
    useDataImpl: () => ({ data: query.data, loading: query.loading, fetching: false, transport, invalidate: () => {}, error: null }),
    prefetch: () => {},
  };
}
const wrapperFor = (ctx: unknown) =>
  ({ children }: { children: ReactNode }) => createElement(SyncContext.Provider, { value: ctx as never }, children);

describe('useOwnedSyncEntity', () => {
  it('WS: shows the bootstrap seed, then the mapped Zero row; refresh is a no-op', async () => {
    const query = { data: [] as Row[], loading: true };
    const read = vi.fn(async (): Promise<Shape> => ({ kind: 'read' }));
    const { result, rerender } = renderHook(
      () => useOwnedSyncEntity<Row, Shape>({
        queryName: 'x.current',
        readId: () => 'cid',
        bootstrap: async () => ({ kind: 'seed' }),
        read,
        map: (r) => ({ kind: 'mapped', n: r.n }),
      }),
      { wrapper: wrapperFor(fakeCtx('WEBSOCKETS', query)) },
    );

    // bootstrap resolved → seed shown (query still loading ⇒ seed kept, invariant a)
    await waitFor(() => expect(result.current.data).toEqual({ kind: 'seed' }));
    expect(result.current.transport).toBe('WEBSOCKETS');

    // Zero query emits a row → mapped takes over
    query.data = [{ id: 'cid', n: 7 }];
    query.loading = false;
    await act(async () => { rerender(); });
    await waitFor(() => expect(result.current.data).toEqual({ kind: 'mapped', n: 7 }));

    // invariant b — refresh never REST-pulls on WS
    await act(async () => { await result.current.refresh(); });
    expect(read).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ kind: 'mapped', n: 7 });
  });

  it('WS: reload re-runs bootstrap even though refresh is a no-op', async () => {
    const query = { data: [] as Row[], loading: true };
    const bootstrap = vi.fn(async (): Promise<Shape> => ({ kind: 'seed' }));
    const read = vi.fn(async (): Promise<Shape> => ({ kind: 'read' }));
    const { result } = renderHook(
      () => useOwnedSyncEntity<Row, Shape>({
        queryName: 'x.current',
        readId: () => 'cid',
        bootstrap,
        read,
        map: (r) => ({ kind: 'mapped', n: r.n }),
      }),
      { wrapper: wrapperFor(fakeCtx('WEBSOCKETS', query)) },
    );

    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1)); // mount bootstrap
    await act(async () => { await result.current.refresh(); });
    expect(read).not.toHaveBeenCalled();        // invariant (b): refresh is inert on WS

    await act(async () => { await result.current.reload(); });
    expect(bootstrap).toHaveBeenCalledTimes(2);  // explicit retry DOES re-bootstrap
    expect(read).not.toHaveBeenCalled();
  });

  it('POLLING: bootstrap seeds, refresh re-pulls via read', async () => {
    const read = vi.fn(async (): Promise<Shape> => ({ kind: 'read' }));
    const { result } = renderHook(
      () => useOwnedSyncEntity<Row, Shape>({
        queryName: 'x.current',
        readId: () => 'cid',
        bootstrap: async () => ({ kind: 'seed' }),
        read,
        map: (r) => ({ kind: 'mapped', n: r.n }),
      }),
      { wrapper: wrapperFor(fakeCtx('POLLING', { data: [], loading: false })) },
    );

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'seed' }));
    expect(result.current.transport).toBe('POLLING');

    await act(async () => { await result.current.refresh(); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ kind: 'read' });
  });

  it('enabled:false is inert — no bootstrap; flipping true mounts it', async () => {
    const bootstrap = vi.fn(async (): Promise<Shape> => ({ kind: 'seed' }));
    const { result, rerender } = renderHook(
      ({ enabled }) => useOwnedSyncEntity<Row, Shape>({
        queryName: 'x.current',
        readId: () => 'cid',
        bootstrap,
        map: (r) => ({ kind: 'mapped', n: r.n }),
        enabled,
      }),
      {
        wrapper: wrapperFor(fakeCtx('POLLING', { data: [], loading: false })),
        initialProps: { enabled: false },
      },
    );

    // disabled: no bootstrap, settles to not-loading (so a hidden surface doesn't spin)
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(bootstrap).not.toHaveBeenCalled();

    // flip enabled true → bootstrap mounts (e.g. navigating off /wholesale)
    await act(async () => { rerender({ enabled: true }); });
    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    expect(result.current.data).toEqual({ kind: 'seed' });
  });
});
