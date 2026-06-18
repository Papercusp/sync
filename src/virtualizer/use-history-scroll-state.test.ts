/**
 * use-history-scroll-state.test.ts — persists virtualizer scroll/pagination state
 * in window.history.state under a key, so back/forward restores it. Load-bearing:
 * setScrollState MERGES into the existing history entry (must not clobber sibling
 * keys / other virtualizers on the page), reads back the keyed slice, supports a
 * custom key for multiple virtualizers, and null clears the slice.
 *
 * Borrowable-lib unit test (libs/generic/sync) — tab-NEUTRAL, genuine coverage.
 * Run: cd libs/generic/sync && npx vitest run src/virtualizer/use-history-scroll-state.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useHistoryScrollState } from './use-history-scroll-state';

beforeEach(() => {
  window.history.replaceState(null, '', window.location.href);
});
afterEach(cleanup);

describe('useHistoryScrollState', () => {
  it('starts null when history has no scroll state', () => {
    const { result } = renderHook(() => useHistoryScrollState<unknown>());
    expect(result.current[0]).toBeNull();
  });

  it('persists and reads back the scroll slice under the default key', () => {
    const { result } = renderHook(() => useHistoryScrollState<unknown>());
    act(() => result.current[1]({ offset: 42 } as never));
    expect(result.current[0]).toEqual({ offset: 42 });
    expect((window.history.state as Record<string, unknown>).scrollState).toEqual({ offset: 42 });
  });

  it('scopes state under a custom key (multiple virtualizers per page)', () => {
    const { result } = renderHook(() => useHistoryScrollState<unknown>('gridA'));
    act(() => result.current[1]({ offset: 7 } as never));
    const hs = window.history.state as Record<string, unknown>;
    expect(hs.gridA).toEqual({ offset: 7 });
    expect(hs.scrollState).toBeUndefined();
  });

  it('merges into the existing history entry without clobbering sibling keys', () => {
    window.history.replaceState({ other: 'keep-me' }, '', window.location.href);
    const { result } = renderHook(() => useHistoryScrollState<unknown>());
    act(() => result.current[1]({ offset: 1 } as never));
    expect(window.history.state).toEqual({ other: 'keep-me', scrollState: { offset: 1 } });
  });

  it('null clears the scroll slice', () => {
    const { result } = renderHook(() => useHistoryScrollState<unknown>());
    act(() => result.current[1]({ offset: 9 } as never));
    expect(result.current[0]).toEqual({ offset: 9 });
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect((window.history.state as Record<string, unknown>).scrollState).toBeNull();
  });
});
