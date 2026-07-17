/**
 * @vitest-environment jsdom
 *
 * Fallback + recovery behavior of useTransportFallback.
 *
 * Audit P-065 (papercusp-full-app-audit-2026-06-09): the hook used to be a
 * one-way ratchet — a single SSE blip pinned desktop to POLLING until
 * remount — and a pending fallback timer survived a fallbackDelayMs change
 * with the stale delay. These tests pin the recovery path (retry preferred,
 * doubling backoff, stability reset) and the timer-cancel behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransportFallback } from './useTransportFallback';
import type { SyncType } from '../types';

const FALLBACK_MS = 1_000;
const RECOVERY_MS = 5_000;

type HookProps = {
  preferred: SyncType;
  fallbackDelayMs: number;
  recoveryDelayMs?: number;
  recoveryMaxDelayMs?: number;
};

function setup(opts?: Partial<HookProps>) {
  // Annotate initialProps so renderHook infers Props = HookProps (optional
  // keys stay optional); the bare literal made rerender demand every key.
  const initialProps: HookProps = {
    preferred: opts?.preferred ?? 'SSE',
    fallbackDelayMs: opts?.fallbackDelayMs ?? FALLBACK_MS,
    recoveryDelayMs: opts?.recoveryDelayMs ?? RECOVERY_MS,
    recoveryMaxDelayMs: opts?.recoveryMaxDelayMs,
  };
  return renderHook((props: HookProps) => useTransportFallback(props), { initialProps });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTransportFallback — fallback', () => {
  it('falls back one step after fallbackDelayMs of sustained failure', () => {
    const { result } = setup();
    expect(result.current.activeTransport).toBe('SSE');

    act(() => result.current.onTransportError(new Error('blip')));
    expect(result.current.activeTransport).toBe('SSE'); // debounced

    act(() => void vi.advanceTimersByTime(FALLBACK_MS));
    expect(result.current.activeTransport).toBe('POLLING');
  });

  it('cancels a pending fallback timer when fallbackDelayMs changes', () => {
    const { result, rerender } = setup();
    act(() => result.current.onTransportError(new Error('blip')));

    // Change the delay while the old timer is pending — it must be cancelled.
    rerender({
      preferred: 'SSE',
      fallbackDelayMs: FALLBACK_MS * 10,
      recoveryDelayMs: RECOVERY_MS,
    });
    act(() => void vi.advanceTimersByTime(FALLBACK_MS));
    expect(result.current.activeTransport).toBe('SSE'); // old timer dead

    // A fresh error arms a timer with the NEW delay.
    act(() => result.current.onTransportError(new Error('still down')));
    act(() => void vi.advanceTimersByTime(FALLBACK_MS * 10));
    expect(result.current.activeTransport).toBe('POLLING');
  });

  it('resets to preferred when the preferred prop changes', () => {
    const { result, rerender } = setup();
    act(() => result.current.onTransportError(new Error('down')));
    act(() => void vi.advanceTimersByTime(FALLBACK_MS));
    expect(result.current.activeTransport).toBe('POLLING');

    rerender({
      preferred: 'WEBSOCKETS',
      fallbackDelayMs: FALLBACK_MS,
      recoveryDelayMs: RECOVERY_MS,
    });
    expect(result.current.activeTransport).toBe('WEBSOCKETS');
  });
});

describe('useTransportFallback — recovery', () => {
  function fallTo(result: { current: ReturnType<typeof useTransportFallback> }) {
    act(() => result.current.onTransportError(new Error('down')));
    act(() => void vi.advanceTimersByTime(FALLBACK_MS));
  }

  it('retries the preferred transport after recoveryDelayMs', () => {
    const { result } = setup();
    fallTo(result);
    expect(result.current.activeTransport).toBe('POLLING');

    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    expect(result.current.activeTransport).toBe('SSE');
  });

  it('doubles the recovery wait per failed retry and caps it', () => {
    const { result } = setup({ recoveryMaxDelayMs: RECOVERY_MS * 4 });
    fallTo(result);

    // Retry 1 fires after base delay, fails again.
    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    expect(result.current.activeTransport).toBe('SSE');
    fallTo(result);

    // Retry 2 must wait 2× base: not yet at 1× …
    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    expect(result.current.activeTransport).toBe('POLLING');
    // … fires at 2×.
    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    expect(result.current.activeTransport).toBe('SSE');
    fallTo(result);

    // Retry 3 waits 4× (the cap, recoveryMaxDelayMs).
    act(() => void vi.advanceTimersByTime(RECOVERY_MS * 4 - 1));
    expect(result.current.activeTransport).toBe('POLLING');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.activeTransport).toBe('SSE');
  });

  it('resets the backoff once a retry stays healthy for one base delay', () => {
    const { result } = setup();
    fallTo(result);

    // First retry fails → wait doubles to 2×.
    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    fallTo(result);

    // Second retry (after 2×) STICKS for one base delay → backoff resets.
    act(() => void vi.advanceTimersByTime(RECOVERY_MS * 2));
    expect(result.current.activeTransport).toBe('SSE');
    act(() => void vi.advanceTimersByTime(RECOVERY_MS)); // stability window

    // Next failure: the following retry is back at the BASE delay.
    fallTo(result);
    act(() => void vi.advanceTimersByTime(RECOVERY_MS));
    expect(result.current.activeTransport).toBe('SSE');
  });

  it('recoveryDelayMs: 0 disables recovery (legacy one-way ratchet)', () => {
    const { result } = setup({ recoveryDelayMs: 0 });
    fallTo(result);
    expect(result.current.activeTransport).toBe('POLLING');

    act(() => void vi.advanceTimersByTime(60 * 60 * 1000));
    expect(result.current.activeTransport).toBe('POLLING');
  });
});
