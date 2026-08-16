/**
 * paging-reducer.test.ts — pure-logic tests for pagingReducer (Plan 1 P-024).
 *
 * pagingReducer backs useSyncVirtualizer — a wrong state transition there
 * causes visual glitches (wrong scroll position, phantom rows, off-by-one
 * totalRows). Every action type has at least one test.
 */
import { describe, expect, it } from 'vitest';
import { pagingReducer, type PagingState, type PagingAction } from './paging-reducer';

type S = PagingState<{ sort: string }, string>;

function mkState(overrides?: Partial<S>): S {
  return {
    estimatedTotal: 100,
    hasReachedStart: false,
    hasReachedEnd: false,
    queryAnchor: {
      anchor: { index: 0, kind: 'forward', startRow: undefined },
      listContextParams: { sort: 'asc' },
    },
    pagingPhase: 'idle',
    pendingScrollAdjustment: 0,
    ...overrides,
  };
}

describe('pagingReducer', () => {
  it('UPDATE_ESTIMATED_TOTAL only grows the total', () => {
    const s = mkState({ estimatedTotal: 50 });
    const next = pagingReducer(s, { type: 'UPDATE_ESTIMATED_TOTAL', newTotal: 80 });
    expect(next.estimatedTotal).toBe(80);
    // Shrinking is ignored.
    const again = pagingReducer(next, { type: 'UPDATE_ESTIMATED_TOTAL', newTotal: 20 });
    expect(again.estimatedTotal).toBe(80);
  });

  it('UPDATE_ESTIMATED_TOTAL returns same reference when unchanged', () => {
    const s = mkState({ estimatedTotal: 100 });
    const next = pagingReducer(s, { type: 'UPDATE_ESTIMATED_TOTAL', newTotal: 50 });
    expect(next).toBe(s); // identity-stable when no change
  });

  it('REACHED_START sets hasReachedStart', () => {
    const s = mkState({ hasReachedStart: false });
    const next = pagingReducer(s, { type: 'REACHED_START' });
    expect(next.hasReachedStart).toBe(true);
    expect(next.hasReachedEnd).toBe(false);
  });

  it('REACHED_END sets hasReachedEnd', () => {
    const s = mkState({ hasReachedEnd: false });
    const next = pagingReducer(s, { type: 'REACHED_END' });
    expect(next.hasReachedEnd).toBe(true);
    expect(next.hasReachedStart).toBe(false);
  });

  it('UPDATE_ANCHOR replaces the anchor only', () => {
    const s = mkState();
    const newAnchor = { index: 5, kind: 'forward' as const, startRow: 'row5' };
    const next = pagingReducer(s, { type: 'UPDATE_ANCHOR', anchor: newAnchor });
    expect(next.queryAnchor.anchor).toEqual(newAnchor);
    expect(next.queryAnchor.listContextParams).toEqual({ sort: 'asc' }); // unchanged
    expect(next.estimatedTotal).toBe(100); // unchanged
  });

  it('SHIFT_ANCHOR_DOWN sets adjusting phase + pendingScrollAdjustment', () => {
    const s = mkState();
    const newAnchor = { index: 10, kind: 'forward' as const, startRow: 'row10' };
    const next = pagingReducer(s, { type: 'SHIFT_ANCHOR_DOWN', offset: 200, newAnchor });
    expect(next.pagingPhase).toBe('adjusting');
    expect(next.pendingScrollAdjustment).toBe(200);
    expect(next.queryAnchor.anchor).toEqual(newAnchor);
  });

  it('RESET_TO_TOP sets anchor to index 0 + adjusting phase', () => {
    const s = mkState({ queryAnchor: { anchor: { index: 50, kind: 'forward', startRow: 'r50' }, listContextParams: { sort: 'asc' } } });
    const next = pagingReducer(s, { type: 'RESET_TO_TOP', offset: 50 });
    expect(next.queryAnchor.anchor.index).toBe(0);
    expect(next.pagingPhase).toBe('adjusting');
    expect(next.pendingScrollAdjustment).toBe(50);
  });

  it('SCROLL_ADJUSTED applies pendingScrollAdjustment to estimatedTotal + moves to skipping', () => {
    const s = mkState({ estimatedTotal: 100, pendingScrollAdjustment: 30, pagingPhase: 'adjusting' });
    const next = pagingReducer(s, { type: 'SCROLL_ADJUSTED' });
    expect(next.estimatedTotal).toBe(130);
    expect(next.pendingScrollAdjustment).toBe(0);
    expect(next.pagingPhase).toBe('skipping');
  });

  it('PAGING_COMPLETE resets pagingPhase to idle', () => {
    const s = mkState({ pagingPhase: 'skipping' });
    const next = pagingReducer(s, { type: 'PAGING_COMPLETE' });
    expect(next.pagingPhase).toBe('idle');
  });

  it('RESET_STATE replaces all core fields + sets skipping phase', () => {
    const s = mkState({ estimatedTotal: 100, hasReachedStart: true, hasReachedEnd: true, pagingPhase: 'idle' });
    const newAnchor = { index: 0, kind: 'forward' as const, startRow: undefined };
    const next = pagingReducer(s, {
      type: 'RESET_STATE',
      estimatedTotal: 200,
      hasReachedStart: false,
      hasReachedEnd: false,
      anchor: newAnchor,
      listContextParams: { sort: 'desc' },
    });
    expect(next.estimatedTotal).toBe(200);
    expect(next.hasReachedStart).toBe(false);
    expect(next.hasReachedEnd).toBe(false);
    expect(next.pagingPhase).toBe('skipping');
    expect(next.queryAnchor.listContextParams).toEqual({ sort: 'desc' });
  });

  it('sequence: SHIFT_ANCHOR_DOWN → SCROLL_ADJUSTED → PAGING_COMPLETE', () => {
    let s = mkState({ estimatedTotal: 100 });
    const anchor = { index: 3, kind: 'forward' as const, startRow: 'r3' };
    s = pagingReducer(s, { type: 'SHIFT_ANCHOR_DOWN', offset: 108, newAnchor: anchor });
    expect(s.pagingPhase).toBe('adjusting');
    s = pagingReducer(s, { type: 'SCROLL_ADJUSTED' });
    expect(s.estimatedTotal).toBe(208);
    expect(s.pagingPhase).toBe('skipping');
    s = pagingReducer(s, { type: 'PAGING_COMPLETE' });
    expect(s.pagingPhase).toBe('idle');
  });
});
