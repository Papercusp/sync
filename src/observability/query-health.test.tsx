/**
 * Query-health observer tests (WI-5412 defect class): the four warning shapes
 * fire on their signatures, once each, and never outside `enabled`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  configureQueryHealth,
  useQueryHealthObserver,
  __resetQueryHealthForTests,
} from './query-health';
import type { SyncQueryOptions, SyncQueryResult } from '../types';

const warn = vi.fn();

function res(over: Partial<SyncQueryResult<unknown>> = {}): SyncQueryResult<unknown> {
  return {
    data: [],
    loading: false,
    fetching: false,
    transport: 'SSE',
    invalidate: () => {},
    error: null,
    ...over,
  };
}

function opts(over: Partial<SyncQueryOptions> = {}): SyncQueryOptions {
  return { queryName: 'test.query', ...over };
}

beforeEach(() => {
  warn.mockReset();
  __resetQueryHealthForTests();
  configureQueryHealth({
    enabled: true,
    waterfallWindowMs: 3_000,
    payloadBytesWarn: 1_000,
    rowsWarn: 10,
    payloadCheckMinRows: 2,
    slowFetchMsWarn: 50,
    // High by default so the other suites never trip these; the churn/thrash
    // suites lower their own threshold locally.
    argsChurnWindowMs: 2_000,
    argsChurnCountWarn: 100,
    refetchWindowMs: 10_000,
    refetchCountWarn: 100,
    warn,
  });
});

describe('args-flip waterfall', () => {
  it('warns when args change right after a fetch already ran', () => {
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: {} }), r: res({ fetching: true, loading: true }) } },
    );
    rerender({ o: opts({ args: { hive: 'papercusp' } }), r: res({ fetching: true, loading: true }) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('thrown away');
    expect(warn.mock.calls[0][0]).toContain('enabled');
  });

  it('does NOT warn when the query was disabled while args settled (the correct gating)', () => {
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: {}, enabled: false }), r: res({ loading: true }) } },
    );
    rerender({ o: opts({ args: { hive: 'papercusp' } }), r: res({ fetching: true, loading: true }) });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns only once per query for the same shape', () => {
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: { a: 1 } }), r: res({ fetching: true }) } },
    );
    rerender({ o: opts({ args: { a: 2 } }), r: res({ fetching: true }) });
    rerender({ o: opts({ args: { a: 3 } }), r: res({ fetching: true }) });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('oversized results', () => {
  it('warns on row count over the threshold', () => {
    renderHook(() =>
      useQueryHealthObserver(opts(), res({ data: Array.from({ length: 11 }, (_, i) => ({ i })) })),
    );
    expect(warn.mock.calls.some(([m]) => String(m).includes('11 rows'))).toBe(true);
  });

  it('warns on payload bytes over the threshold', () => {
    const fat = Array.from({ length: 3 }, (_, i) => ({ i, pad: 'x'.repeat(600) }));
    renderHook(() => useQueryHealthObserver(opts(), res({ data: fat })));
    expect(warn.mock.calls.some(([m]) => String(m).includes('KB parsed'))).toBe(true);
  });

  it('skips the size estimate below payloadCheckMinRows', () => {
    renderHook(() => useQueryHealthObserver(opts(), res({ data: [{ pad: 'x'.repeat(5_000) }] })));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('slow first load', () => {
  it('warns when the fetch → settled span exceeds the threshold', async () => {
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts(), r: res({ fetching: true, loading: true }) } },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    rerender({ o: opts(), r: res({ fetching: false, data: [{ ok: 1 }] }) });
    expect(warn.mock.calls.some(([m]) => String(m).includes('time the resolver'))).toBe(true);
  });
});

describe('args-identity churn', () => {
  it('warns when args change more than the threshold in the window', () => {
    configureQueryHealth({ argsChurnCountWarn: 2 });
    // fetching:false throughout ⇒ no fetch tracked ⇒ waterfall cannot fire,
    // isolating the churn signal. Three arg changes trip the count>2 threshold.
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: { a: 1 } }), r: res() } },
    );
    rerender({ o: opts({ args: { a: 2 } }), r: res() });
    rerender({ o: opts({ args: { a: 3 } }), r: res() });
    rerender({ o: opts({ args: { a: 4 } }), r: res() });
    expect(warn.mock.calls.some(([m]) => String(m).includes('unstable'))).toBe(true);
  });
});

describe('refetch thrash', () => {
  it('warns when the same query fetches more than the threshold in the window', () => {
    configureQueryHealth({ refetchCountWarn: 2 });
    // Stable args ⇒ no waterfall/churn; toggling fetching false→true is a fetch
    // start. Three starts trip the count>2 threshold.
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: { a: 1 } }), r: res({ fetching: true }) } },
    );
    rerender({ o: opts({ args: { a: 1 } }), r: res({ fetching: false }) });
    rerender({ o: opts({ args: { a: 1 } }), r: res({ fetching: true }) });
    rerender({ o: opts({ args: { a: 1 } }), r: res({ fetching: false }) });
    rerender({ o: opts({ args: { a: 1 } }), r: res({ fetching: true }) });
    expect(warn.mock.calls.some(([m]) => String(m).includes('thrash'))).toBe(true);
  });
});

describe('blank arg on an enabled query (P-027)', () => {
  it('warns once per blank arg while the query is enabled', () => {
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: { potSlug: '' } }), r: res() } },
    );
    rerender({ o: opts({ args: { potSlug: '' } }), r: res() });
    rerender({ o: opts({ args: { potSlug: '' } }), r: res() });
    const blanks = warn.mock.calls.filter(([m]) => String(m).includes('blank id/slug'));
    expect(blanks).toHaveLength(1);
    expect(blanks[0][0]).toContain('enabled: Boolean(potSlug)');
  });

  it('warns separately for each blank arg name', () => {
    renderHook(() => useQueryHealthObserver(opts({ args: { id: '', harnessSlug: '' } }), res()));
    expect(warn.mock.calls.filter(([m]) => String(m).includes('blank id/slug'))).toHaveLength(2);
  });

  it('stays silent for a correctly gated `id ?? ""` call site', () => {
    // The whole point: `{ id: id ?? '' }` behind `enabled: Boolean(id)` is the
    // CORRECT shape. A detector that flags it would be noise, and the noise is
    // what gets the check switched off.
    renderHook(() => useQueryHealthObserver(opts({ args: { id: '' }, enabled: false }), res()));
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores non-empty args, zeroes and nulls', () => {
    renderHook(() =>
      useQueryHealthObserver(opts({ args: { id: 'WI-1', beforeSeq: 0, owner: null } }), res()),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('honours the blankArgAllow exemption list', () => {
    configureQueryHealth({ blankArgAllow: ['q'] });
    renderHook(() => useQueryHealthObserver(opts({ args: { q: '' } }), res()));
    expect(warn).not.toHaveBeenCalled();
    configureQueryHealth({ blankArgAllow: [] });
  });
});

describe('kill switch', () => {
  it('does nothing when disabled', () => {
    configureQueryHealth({ enabled: false });
    const { rerender } = renderHook(
      ({ o, r }: { o: SyncQueryOptions; r: SyncQueryResult<unknown> }) => useQueryHealthObserver(o, r),
      { initialProps: { o: opts({ args: {} }), r: res({ fetching: true }) } },
    );
    rerender({ o: opts({ args: { hive: 'x' } }), r: res({ data: Array.from({ length: 50 }, () => ({})) }) });
    expect(warn).not.toHaveBeenCalled();
  });
});
