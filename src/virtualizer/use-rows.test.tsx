/**
 * @vitest-environment jsdom
 *
 * use-rows.test.tsx — unit tests for the virtualizer's `useRows` slicing hook.
 *
 * `useRows` is the shared fetch+slice core behind useSyncVirtualizer. It calls
 * exactly FOUR useSyncQuery hooks unconditionally (hook rules) and reinterprets
 * each transport's `loading` / `fetching` / `data.length` into the
 * `complete` / `atStart` / `atEnd` / `permalinkNotFound` signals the virtualizer
 * consumes. An off-by-one in the windowing (rowAt / firstRowIndex /
 * paginatedRowsLength) shows up as phantom or missing rows on screen, so every
 * mode (forward / backward / permalink / permalink-not-found) plus the
 * enabled=false short-circuit and the loading skeleton gate gets a test.
 *
 * The SyncContext is mocked with a routed `useDataImpl` (same fake-transport
 * pattern as useOwnedSyncEntity.test.ts) so these stay pure-logic, no network.
 */
import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { SyncContext } from '../SyncContext';
import {
  useRows,
  type Anchor,
  type GetPageQuery,
  type GetSingleQuery,
  type SyncQueryRequest,
} from './use-rows';
import type { SyncQueryOptions, SyncQueryResult } from '../types';

type Row = { id: string; sort: number };
const toStartRow = (r: Row): number => r.sort;

// A single mocked query response (data + the inferred loading/fetching flags).
type QueryState = { data: Row[]; loading?: boolean; fetching?: boolean };

// A route matches an incoming useSyncQuery call by its resolved queryName+args.
type Route = { match: (opts: SyncQueryOptions) => boolean; state: QueryState };

const EMPTY: SyncQueryResult<Row> = {
  data: [],
  loading: false,
  fetching: false,
  transport: 'POLLING',
  invalidate: () => {},
  error: null,
};

/**
 * Builds a SyncContext value whose useDataImpl routes each enabled query to the
 * first matching Route. Disabled hooks (enabled=false, the library's way of
 * skipping a hook) always resolve to the inert EMPTY result — exactly what the
 * real adapters do for a disabled query.
 */
function makeCtx(routes: Route[]) {
  return {
    transport: 'POLLING' as const,
    prefetch: () => {},
    useDataImpl: (<T,>(opts: SyncQueryOptions): SyncQueryResult<T> => {
      if (opts.enabled === false) return EMPTY as unknown as SyncQueryResult<T>;
      const hit = routes.find((r) => r.match(opts));
      if (!hit) return EMPTY as unknown as SyncQueryResult<T>;
      return {
        data: hit.state.data,
        loading: hit.state.loading ?? false,
        fetching: hit.state.fetching ?? false,
        transport: 'POLLING',
        invalidate: () => {},
        error: null,
      } as unknown as SyncQueryResult<T>;
    }) as <T>(o: SyncQueryOptions) => SyncQueryResult<T>,
  };
}

const wrapperFor = (ctx: unknown) =>
  ({ children }: { children: ReactNode }) =>
    createElement(SyncContext.Provider, { value: ctx as never }, children);

// Fake query builders — encode the routing discriminators into queryName/args
// so the mocked useDataImpl can tell page-vs-single, and dir, apart.
const getPageQuery: GetPageQuery<number> = ({ limit, start, dir }): SyncQueryRequest => ({
  queryName: 'page',
  args: { dir, limit, start },
});
const getSingleQuery: GetSingleQuery = ({ id }): SyncQueryRequest => ({
  queryName: 'single',
  args: { id },
});

// Route helpers keyed on the discriminators above.
const pageDir = (dir: 'forward' | 'backward', state: QueryState): Route => ({
  match: (o) => o.queryName === 'page' && (o.args as { dir?: string }).dir === dir,
  state,
});
const single = (state: QueryState): Route => ({
  match: (o) => o.queryName === 'single',
  state,
});

const mkRows = (n: number, base = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${base + i}`, sort: base + i }));

function render(anchor: Anchor<number>, routes: Route[], opts?: { pageSize?: number; enabled?: boolean }) {
  return renderHook(
    () =>
      useRows<Row, number>({
        pageSize: opts?.pageSize ?? 4,
        anchor,
        settled: true,
        getPageQuery,
        getSingleQuery,
        toStartRow,
        enabled: opts?.enabled ?? true,
      }),
    { wrapper: wrapperFor(makeCtx(routes)) },
  ).result;
}

// ── forward mode ────────────────────────────────────────────────────────────
describe('useRows — forward mode', () => {
  it('rowAt(anchorIndex+i) returns page rows; undefined past paginatedRowsLength', () => {
    const rows = mkRows(3, 100); // r100..r102, fewer than pageSize=4
    const r = render({ index: 10, kind: 'forward' }, [pageDir('forward', { data: rows })]);

    expect(r.current.rowAt(10)).toEqual(rows[0]);
    expect(r.current.rowAt(11)).toEqual(rows[1]);
    expect(r.current.rowAt(12)).toEqual(rows[2]);
    // Past the end of the available page → undefined.
    expect(r.current.rowAt(13)).toBeUndefined();
    // Before the anchor → undefined (forward only renders forward).
    expect(r.current.rowAt(9)).toBeUndefined();

    expect(r.current.rowsLength).toBe(3);
    expect(r.current.rowsEmpty).toBe(false);
    expect(r.current.firstRowIndex).toBe(10);
    expect(r.current.permalinkNotFound).toBe(false);
  });

  it('rowsLength caps at pageSize when data exceeds pageSize (hasMoreRows → atEnd=false)', () => {
    // pageSize=4 → query asks for pageSize+1=5; returning 5 means "there is more".
    const rows = mkRows(5, 0);
    const r = render({ index: 0, kind: 'forward' }, [pageDir('forward', { data: rows })]);

    expect(r.current.rowsLength).toBe(4); // capped at pageSize
    expect(r.current.rowAt(3)).toEqual(rows[3]);
    expect(r.current.rowAt(4)).toBeUndefined(); // the +1 "more" sentinel is not exposed
    // complete2 = !loading && !fetching (both false here) → true, but hasMoreRows → atEnd=false.
    expect(r.current.complete).toBe(true);
    expect(r.current.atEnd).toBe(false);
  });

  it('atStart honors pageStart === null (no startRow) and anchorIndex === 0', () => {
    const rows = mkRows(2, 0);
    // startRow undefined → pageStart === null → atStart true even at a non-zero index.
    const a = render({ index: 7, kind: 'forward' }, [pageDir('forward', { data: rows })]);
    expect(a.current.atStart).toBe(true);

    // startRow present but anchorIndex === 0 → still atStart.
    const b = render({ index: 0, kind: 'forward', startRow: 5 }, [pageDir('forward', { data: rows })]);
    expect(b.current.atStart).toBe(true);

    // startRow present AND anchorIndex !== 0 → not atStart.
    const c = render({ index: 3, kind: 'forward', startRow: 5 }, [pageDir('forward', { data: rows })]);
    expect(c.current.atStart).toBe(false);
  });

  it('exactly pageSize rows with no more → atEnd true, complete true', () => {
    const rows = mkRows(4, 0); // == pageSize, no +1 → no more
    const r = render({ index: 0, kind: 'forward' }, [pageDir('forward', { data: rows })]);
    expect(r.current.rowsLength).toBe(4);
    expect(r.current.atEnd).toBe(true);
    expect(r.current.complete).toBe(true);
  });
});

// ── backward mode ─────────────────────────────────────────────────────────
describe('useRows — backward mode', () => {
  it('rowAt(index) reads typedPageRows at (anchorIndex-index-1); firstRowIndex = anchorIndex - paginatedRowsLength', () => {
    // Backward page comes back newest-first; rowAt walks it in reverse so the
    // row immediately before the anchor (index anchorIndex-1) is rows[0].
    const rows = mkRows(3, 50); // r50, r51, r52
    const anchorIndex = 20;
    const r = render({ index: anchorIndex, kind: 'backward', startRow: 999 }, [
      pageDir('backward', { data: rows }),
    ]);

    expect(r.current.rowAt(anchorIndex - 1)).toEqual(rows[0]); // i = 0
    expect(r.current.rowAt(anchorIndex - 2)).toEqual(rows[1]); // i = 1
    expect(r.current.rowAt(anchorIndex - 3)).toEqual(rows[2]); // i = 2
    expect(r.current.rowAt(anchorIndex - 4)).toBeUndefined(); // i = 3, past page
    expect(r.current.rowAt(anchorIndex)).toBeUndefined(); // i = -1, at/after anchor

    expect(r.current.rowsLength).toBe(3);
    expect(r.current.firstRowIndex).toBe(anchorIndex - 3); // anchorIndex - paginatedRowsLength
    expect(r.current.atEnd).toBe(false); // backward never reports atEnd
  });

  it('atStart reflects complete2 && !hasMoreRows', () => {
    // 3 < pageSize+1 → no more rows → at the start of the list.
    const fewer = render({ index: 10, kind: 'backward', startRow: 5 }, [
      pageDir('backward', { data: mkRows(3, 0) }),
    ]);
    expect(fewer.current.atStart).toBe(true);

    // pageSize+1=5 rows → hasMoreRows → NOT at the start yet.
    const more = render({ index: 10, kind: 'backward', startRow: 5 }, [
      pageDir('backward', { data: mkRows(5, 0) }),
    ]);
    expect(more.current.atStart).toBe(false);
    expect(more.current.rowsLength).toBe(4); // capped at pageSize

    // Still loading → complete2 false → not yet atStart.
    const loading = render({ index: 10, kind: 'backward', startRow: 5 }, [
      pageDir('backward', { data: [], loading: true }),
    ]);
    expect(loading.current.atStart).toBe(false);
  });

  it('asserts pageStart !== null — a backward anchor with a null startRow throws', () => {
    // The backward branch ends in `assert(pageStart !== null)`. A backward anchor
    // is typed to require startRow, but a runtime null must still trip the assert.
    const bad = { index: 1, kind: 'backward', startRow: null } as unknown as Anchor<number>;
    expect(() =>
      render(bad, [pageDir('backward', { data: mkRows(2, 0) })]),
    ).toThrow();
  });
});

// ── permalink mode ───────────────────────────────────────────────────────
describe('useRows — permalink mode', () => {
  it('asserts pageSize is even', () => {
    expect(() =>
      render({ index: 5, kind: 'permalink', id: 'p' }, [], { pageSize: 5 }),
    ).toThrow();
  });

  it('pivot returned at anchorIndex; rows before (backward) / after (forward) windowed by halfPageSize / halfPageSize-1; firstRowIndex = anchorIndex - rowsBeforeSize', () => {
    // pageSize=6 → halfPageSize=3. Hook2(before) limit=4, windowed to <=3.
    // Hook3(after) limit=3, windowed to <=halfPageSize-1=2.
    const pivot: Row = { id: 'pivot', sort: 500 };
    const before = mkRows(4, 600); // 4 rows, capped to halfPageSize=3
    const after = mkRows(3, 700); // 3 rows, capped to halfPageSize-1=2
    const anchorIndex = 40;
    const r = render({ index: anchorIndex, kind: 'permalink', id: 'pivot' }, [
      single({ data: [pivot] }),
      pageDir('backward', { data: before }),
      pageDir('forward', { data: after }),
    ], { pageSize: 6 });

    // Pivot at the anchor.
    expect(r.current.rowAt(anchorIndex)).toEqual(pivot);
    // After the pivot: rows3[i] for i = index-anchorIndex-1, capped at 2.
    expect(r.current.rowAt(anchorIndex + 1)).toEqual(after[0]);
    expect(r.current.rowAt(anchorIndex + 2)).toEqual(after[1]);
    expect(r.current.rowAt(anchorIndex + 3)).toBeUndefined(); // i=2 >= rowsAfterSize(2)
    // Before the pivot: rows2[i] for i = anchorIndex-index-1, capped at 3.
    expect(r.current.rowAt(anchorIndex - 1)).toEqual(before[0]);
    expect(r.current.rowAt(anchorIndex - 3)).toEqual(before[2]);
    expect(r.current.rowAt(anchorIndex - 4)).toBeUndefined(); // i=3 >= rowsBeforeSize(3)

    // rowsLength = before(3) + after(2) + pivot(1).
    expect(r.current.rowsLength).toBe(3 + 2 + 1);
    expect(r.current.rowsEmpty).toBe(false);
    expect(r.current.permalinkNotFound).toBe(false);
    expect(r.current.firstRowIndex).toBe(anchorIndex - 3); // anchorIndex - rowsBeforeSize
  });
});

// ── permalinkNotFound path ──────────────────────────────────────────────────
describe('useRows — permalink not found', () => {
  it('single-row query settles empty → rowsLength 0, rowsEmpty/atStart/atEnd true, firstRowIndex = anchorIndex, hooks 2/3 disabled', () => {
    const anchorIndex = 12;
    let hook2Hit = false;
    let hook3Hit = false;
    const r = render({ index: anchorIndex, kind: 'permalink', id: 'ghost' }, [
      single({ data: [] }), // settles empty (not loading) → not found
      {
        match: (o) => {
          if (o.queryName === 'page' && o.enabled !== false) {
            if ((o.args as { dir?: string }).dir === 'backward') hook2Hit = true;
            if ((o.args as { dir?: string }).dir === 'forward') hook3Hit = true;
          }
          return false;
        },
        state: { data: [] },
      },
    ], { pageSize: 6 });

    expect(r.current.permalinkNotFound).toBe(true);
    expect(r.current.rowsLength).toBe(0);
    expect(r.current.rowsEmpty).toBe(true);
    expect(r.current.atStart).toBe(true);
    expect(r.current.atEnd).toBe(true);
    expect(r.current.firstRowIndex).toBe(anchorIndex);
    expect(r.current.complete).toBe(true);
    // Hooks 2/3 must be disabled (never reach an enabled page query).
    expect(hook2Hit).toBe(false);
    expect(hook3Hit).toBe(false);
    // rowAt for the pivot is undefined (no pivot row).
    expect(r.current.rowAt(anchorIndex)).toBeUndefined();
  });

  it('does NOT report not-found while the single-row query is still loading', () => {
    const r = render({ index: 0, kind: 'permalink', id: 'maybe' }, [
      single({ data: [], loading: true }),
    ], { pageSize: 4 });
    expect(r.current.permalinkNotFound).toBe(false);
    expect(r.current.complete).toBe(false);
  });
});

// ── enabled=false short-circuit ─────────────────────────────────────────────
describe('useRows — enabled=false short-circuit', () => {
  for (const anchor of [
    { index: 5, kind: 'forward' as const, startRow: 9 },
    { index: 5, kind: 'backward' as const, startRow: 9 },
    { index: 5, kind: 'permalink' as const, id: 'x' },
  ]) {
    it(`returns inert result regardless of anchor kind=${anchor.kind}`, () => {
      const r = render(anchor as Anchor<number>, [
        single({ data: [{ id: 'x', sort: 1 }] }),
        pageDir('forward', { data: mkRows(5, 0) }),
        pageDir('backward', { data: mkRows(5, 0) }),
      ], { enabled: false, pageSize: 4 });

      expect(r.current.rowsLength).toBe(0);
      expect(r.current.complete).toBe(true);
      expect(r.current.rowsEmpty).toBe(true);
      expect(r.current.atStart).toBe(true);
      expect(r.current.atEnd).toBe(true);
      expect(r.current.permalinkNotFound).toBe(false);
      expect(r.current.firstRowIndex).toBe(0);
      expect(r.current.rowAt(5)).toBeUndefined();
    });
  }
});

// ── loading gating (skeleton window) ────────────────────────────────────────
describe('useRows — loading gate', () => {
  it('forward: rowAt returns undefined while loading2 and rows are empty, then data once they arrive', () => {
    const loading = render({ index: 0, kind: 'forward' }, [
      pageDir('forward', { data: [], loading: true }),
    ]);
    expect(loading.current.rowAt(0)).toBeUndefined(); // skeleton window
    expect(loading.current.rowsLength).toBe(0);
    expect(loading.current.complete).toBe(false); // complete2 = !loading && !fetching

    const rows = mkRows(2, 0);
    const loaded = render({ index: 0, kind: 'forward' }, [pageDir('forward', { data: rows })]);
    expect(loaded.current.rowAt(0)).toEqual(rows[0]);
    expect(loaded.current.complete).toBe(true);
  });

  it('forward: complete is false while only fetching (background refetch), even with rows present', () => {
    const rows = mkRows(2, 0);
    const r = render({ index: 0, kind: 'forward' }, [
      pageDir('forward', { data: rows, loading: false, fetching: true }),
    ]);
    // Rows already render (loading is false)…
    expect(r.current.rowAt(0)).toEqual(rows[0]);
    // …but complete2 = !loading && !fetching → false while a refetch is in flight.
    expect(r.current.complete).toBe(false);
    expect(r.current.atEnd).toBe(false); // atEnd gated on complete2
  });

  it('permalink: rowAt past the pivot returns undefined while hook3 loads with empty rows, data once present', () => {
    // sort must be truthy: the source gates hooks 2/3 on `singleStart` being
    // truthy (a falsy toStartRow result disables the before/after windows).
    const pivot: Row = { id: 'pivot', sort: 5 };
    const anchorIndex = 0;
    const loadingAfter = render({ index: anchorIndex, kind: 'permalink', id: 'pivot' }, [
      single({ data: [pivot] }),
      pageDir('backward', { data: [] }),
      pageDir('forward', { data: [], loading: true }),
    ], { pageSize: 4 });
    // Pivot is available immediately…
    expect(loadingAfter.current.rowAt(anchorIndex)).toEqual(pivot);
    // …but the "after" window is still a skeleton.
    expect(loadingAfter.current.rowAt(anchorIndex + 1)).toBeUndefined();

    const after = mkRows(1, 7);
    const loadedAfter = render({ index: anchorIndex, kind: 'permalink', id: 'pivot' }, [
      single({ data: [pivot] }),
      pageDir('backward', { data: [] }),
      pageDir('forward', { data: after }),
    ], { pageSize: 4 });
    expect(loadedAfter.current.rowAt(anchorIndex + 1)).toEqual(after[0]);
  });
});
