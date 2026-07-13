/**
 * @vitest-environment jsdom
 *
 * use-history-state.test.ts — the window.history.state React hook.
 * Load-bearing properties: getSnapshot is MEMOIZED by JSON string (returns the
 * same ref when state is structurally unchanged — otherwise useSyncExternalStore
 * render-loops); setState writes via replaceState + dispatches the synthetic
 * `historystatechange` event (replaceState does NOT fire popstate); and an
 * external popstate re-reads.
 *
 * Borrowable-lib unit test (libs/generic/sync) — tab-NEUTRAL, genuine coverage.
 * Run: cd libs/generic/sync && npx vitest run src/virtualizer/use-history-state.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useHistoryState } from './use-history-state';

beforeEach(() => {
  // jsdom persists history.state across tests in a file — reset to a clean entry.
  window.history.replaceState(null, '', window.location.href);
});
afterEach(cleanup);

describe('useHistoryState', () => {
  it('reads the current history.state (null on a clean entry)', () => {
    const { result } = renderHook(() => useHistoryState());
    expect(result.current[0]).toBeNull();
  });

  it('setState writes history.state and re-renders via the synthetic event', () => {
    const { result } = renderHook(() => useHistoryState());
    act(() => result.current[1]({ scrollY: 120 }));
    expect(window.history.state).toEqual({ scrollY: 120 });
    expect(result.current[0]).toEqual({ scrollY: 120 });
  });

  it('re-reads on an external popstate (cross-tab / native navigation)', () => {
    const { result } = renderHook(() => useHistoryState());
    act(() => {
      window.history.replaceState({ ext: 1 }, '', window.location.href);
      window.dispatchEvent(new Event('popstate'));
    });
    expect(result.current[0]).toEqual({ ext: 1 });
  });

  it('returns a stable snapshot ref when state is structurally unchanged', () => {
    const { result } = renderHook(() => useHistoryState());
    act(() => result.current[1]({ a: 1 }));
    const ref1 = result.current[0];
    // a notify with no actual state change must NOT produce a new snapshot object
    act(() => window.dispatchEvent(new Event('historystatechange')));
    expect(result.current[0]).toBe(ref1);
  });
});
