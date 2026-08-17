import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTransportFallback } from './useTransportFallback';

/**
 * The ladder is WEBSOCKETS → SSE → POLLING, debounced by `fallbackDelayMs` so
 * a transient blip does not demote a healthy transport.
 *
 * The subtle case these tests exist for: a WEBSOCKETS-preferred SyncProvider
 * renders the SSE rung the instant the WS probe fails, ~`fallbackDelayMs`
 * BEFORE `activeTransport` catches up. During that window SSE is the transport
 * actually serving the app, so an SSE failure must be attributed to SSE — not
 * swallowed as a duplicate of the WS failure that opened the window.
 */
describe('useTransportFallback', () => {
  const DELAY = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const setup = (preferred: 'WEBSOCKETS' | 'SSE' | 'POLLING' = 'WEBSOCKETS') =>
    renderHook(() => useTransportFallback({ preferred, fallbackDelayMs: DELAY }));

  it('starts on the preferred transport and does not step down without an error', () => {
    const { result } = setup();
    expect(result.current.activeTransport).toBe('WEBSOCKETS');
    act(() => { vi.advanceTimersByTime(DELAY * 3); });
    expect(result.current.activeTransport).toBe('WEBSOCKETS');
  });

  it('debounces: steps down only after fallbackDelayMs elapses', () => {
    const { result } = setup();
    act(() => { result.current.onTransportError(new Error('ws down'), 'WEBSOCKETS'); });

    act(() => { vi.advanceTimersByTime(DELAY - 1); });
    expect(result.current.activeTransport).toBe('WEBSOCKETS');

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.activeTransport).toBe('SSE');
  });

  it('collapses repeat errors from the SAME rung into one step-down', () => {
    const { result } = setup();
    act(() => {
      result.current.onTransportError(new Error('ws 1'), 'WEBSOCKETS');
      result.current.onTransportError(new Error('ws 2'), 'WEBSOCKETS');
      result.current.onTransportError(new Error('ws 3'), 'WEBSOCKETS');
    });
    act(() => { vi.advanceTimersByTime(DELAY); });
    // One rung, not three.
    expect(result.current.activeTransport).toBe('SSE');
  });

  // ── The regression this fix exists for ────────────────────────────────────
  it('does NOT swallow an SSE failure that lands inside the WS debounce window', () => {
    const { result } = setup('WEBSOCKETS');

    // WS probe fails. SyncProvider now renders SSE immediately, while the
    // ladder is still debouncing its WEBSOCKETS → SSE step.
    act(() => { result.current.onTransportError(new Error('ws probe blocked'), 'WEBSOCKETS'); });
    expect(result.current.activeTransport).toBe('WEBSOCKETS');

    // Halfway through that window, the SSE rung — the one actually serving —
    // fails too. Under the old `if (fallbackTimer.current) return` debounce
    // this was dropped entirely, and the ladder settled on SSE: a transport
    // already known to be broken.
    act(() => { vi.advanceTimersByTime(DELAY / 2); });
    act(() => { result.current.onTransportError(new Error('sse dead'), 'SSE'); });

    act(() => { vi.advanceTimersByTime(DELAY); });
    expect(result.current.activeTransport).toBe('POLLING');
  });

  it('never walks back UP the ladder when an earlier rung reports late', () => {
    const { result } = setup('WEBSOCKETS');

    act(() => { result.current.onTransportError(new Error('sse dead'), 'SSE'); });
    act(() => { vi.advanceTimersByTime(DELAY); });
    expect(result.current.activeTransport).toBe('POLLING');

    // A straggling WEBSOCKETS error arriving after we are already on POLLING
    // must not promote us back to SSE.
    act(() => { result.current.onTransportError(new Error('late ws'), 'WEBSOCKETS'); });
    act(() => { vi.advanceTimersByTime(DELAY * 2); });
    expect(result.current.activeTransport).toBe('POLLING');
  });

  it('stays on POLLING once terminal', () => {
    const { result } = setup('POLLING');
    act(() => { result.current.onTransportError(new Error('polling failed'), 'POLLING'); });
    act(() => { vi.advanceTimersByTime(DELAY * 2); });
    expect(result.current.activeTransport).toBe('POLLING');
  });

  it('falls back to its own view of the active rung when `from` is omitted', () => {
    const { result } = setup('WEBSOCKETS');
    // Legacy call shape — adapters that predate the `from` argument.
    act(() => { result.current.onTransportError(new Error('unattributed')); });
    act(() => { vi.advanceTimersByTime(DELAY); });
    expect(result.current.activeTransport).toBe('SSE');
  });

  it('resets to the new preferred transport when `preferred` changes', () => {
    const { result, rerender } = renderHook(
      ({ preferred }) => useTransportFallback({ preferred, fallbackDelayMs: DELAY }),
      { initialProps: { preferred: 'WEBSOCKETS' as const } },
    );

    act(() => { result.current.onTransportError(new Error('ws down'), 'WEBSOCKETS'); });
    act(() => { vi.advanceTimersByTime(DELAY); });
    expect(result.current.activeTransport).toBe('SSE');

    rerender({ preferred: 'POLLING' as unknown as 'WEBSOCKETS' });
    expect(result.current.activeTransport).toBe('POLLING');
  });
});
