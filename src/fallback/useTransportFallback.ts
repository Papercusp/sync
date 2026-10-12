'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { SyncType, SyncFallbackObserver } from '../types';

const FALLBACK_ORDER: SyncType[] = ['WEBSOCKETS', 'SSE', 'POLLING'];

interface UseTransportFallbackOptions {
  preferred: SyncType;
  fallbackDelayMs: number;
  /**
   * After falling back, wait this long before retrying the preferred
   * transport. Each retry that fails again doubles the next wait (capped at
   * `recoveryMaxDelayMs`); a retry that stays healthy for one base delay
   * resets the backoff. Set to 0 to disable recovery entirely (the transport
   * then only moves down the fallback chain until remount/preferred change).
   * Default 30_000. Must be > `fallbackDelayMs`, otherwise a failed retry
   * would be miscounted as stable and the backoff never grows.
   */
  recoveryDelayMs?: number;
  /** Cap for the doubling recovery delay. Default 300_000 (5 min). */
  recoveryMaxDelayMs?: number;
  observeFallback?: SyncFallbackObserver;
}

interface UseTransportFallbackResult {
  activeTransport: SyncType;
  onTransportError: (error: Error) => void;
  onTransportHealthChange: (healthy: boolean) => void;
}

export function useTransportFallback(
  opts: UseTransportFallbackOptions,
): UseTransportFallbackResult {
  const {
    preferred,
    fallbackDelayMs,
    recoveryDelayMs = 30_000,
    recoveryMaxDelayMs = 300_000,
    observeFallback,
  } = opts;
  const [activeTransport, setActiveTransport] = useState<SyncType>(preferred);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(preferred);
  const healthyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current recovery wait — doubles per failed recovery, resets once a
  // recovery sticks (see the recovery effect below).
  const recoveryWaitRef = useRef(recoveryDelayMs);

  // Reset when preferred changes
  useEffect(() => {
    setActiveTransport(preferred);
    activeRef.current = preferred;
    recoveryWaitRef.current = recoveryDelayMs;
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    // recoveryDelayMs is deliberately not a dep: a delay change alone should
    // not reset the active transport, only seed future resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred]);

  // A pending fallback timer was armed with the OLD delay — cancel it when
  // the delay changes; the next transport error re-arms with the new value.
  useEffect(() => {
    return () => {
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };
  }, [fallbackDelayMs]);

  // A retry is not recovery evidence. Only the adapter's successful open,
  // sustained without errors or a visibility/lease pause, can record applied=1.
  const onTransportHealthChange = useCallback((healthy: boolean) => {
    if (healthyTimer.current) clearTimeout(healthyTimer.current);
    healthyTimer.current = null;
    if (!healthy || preferred === 'POLLING' || activeRef.current !== preferred) return;
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = null;
    healthyTimer.current = setTimeout(() => {
      healthyTimer.current = null;
      if (activeRef.current !== preferred) return;
      try {
        observeFallback?.('browser-sync-transport', { eligible: 1, applied: 1, reason: 'applied', scope: preferred });
      } catch { /* diagnostics cannot change transport behavior */ }
    }, recoveryDelayMs > 0 ? recoveryDelayMs : fallbackDelayMs);
  }, [preferred, recoveryDelayMs, fallbackDelayMs, observeFallback]);

  const onTransportError = useCallback(
    (error: Error) => {
      if (healthyTimer.current) clearTimeout(healthyTimer.current);
      healthyTimer.current = null;
      // Debounce: don't fall back immediately — wait for sustained failure
      if (fallbackTimer.current) return; // Already waiting

      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        const current = activeRef.current;
          const currentIndex = FALLBACK_ORDER.indexOf(current);
          const nextIndex = currentIndex + 1;

          if (nextIndex >= FALLBACK_ORDER.length) {
            // Already at terminal fallback (POLLING) — nothing to do
            console.warn('[Sync] Already at terminal transport (POLLING)');
            return;
          }

          const next = FALLBACK_ORDER[nextIndex] ?? current;
          // Outside React's state updater: StrictMode may evaluate that updater
          // twice, but this is one measured fallback decision.
          if (preferred !== 'POLLING') {
            try {
              observeFallback?.('browser-sync-transport', { eligible: 1, applied: 0, reason: 'preferred-unavailable', scope: preferred });
            } catch { /* diagnostics cannot change transport behavior */ }
          }
          console.warn(
            `[Sync] Transport ${current} failed — falling back to ${next}`,
            error.message,
          );
          activeRef.current = next;
          setActiveTransport(next);
      }, fallbackDelayMs);
    },
    [fallbackDelayMs, preferred, observeFallback],
  );

  // Recovery: while on a fallback transport, periodically retry the
  // preferred one instead of staying pinned down the chain forever (a single
  // SSE blip used to pin desktop to polling until remount). A retry that
  // fails falls back again via onTransportError, which re-enters this effect
  // with a doubled wait; a retry that holds for one base delay is considered
  // recovered and resets the backoff.
  useEffect(() => {
    if (recoveryDelayMs <= 0) return;

    if (activeTransport === preferred) {
      const stabilityTimer = setTimeout(() => {
        recoveryWaitRef.current = recoveryDelayMs;
      }, recoveryDelayMs);
      return () => clearTimeout(stabilityTimer);
    }

    const wait = recoveryWaitRef.current;
    const recoveryTimer = setTimeout(() => {
      // Double up-front; the stability timer above resets it if this attempt
      // sticks.
      recoveryWaitRef.current = Math.min(
        recoveryWaitRef.current * 2,
        recoveryMaxDelayMs,
      );
      console.info(
        `[Sync] Retrying preferred transport ${preferred} after ${wait}ms on ${activeTransport}`,
      );
      activeRef.current = preferred;
      setActiveTransport(preferred);
    }, wait);
    return () => clearTimeout(recoveryTimer);
  }, [activeTransport, preferred, recoveryDelayMs, recoveryMaxDelayMs]);

  useEffect(() => () => {
    if (healthyTimer.current) clearTimeout(healthyTimer.current);
    healthyTimer.current = null;
  }, [preferred, fallbackDelayMs, recoveryDelayMs, observeFallback]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, []);

  return { activeTransport, onTransportError, onTransportHealthChange };
}
