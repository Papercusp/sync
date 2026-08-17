'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { SyncType } from '../types';

const FALLBACK_ORDER: SyncType[] = ['WEBSOCKETS', 'SSE', 'POLLING'];

interface UseTransportFallbackOptions {
  preferred: SyncType;
  fallbackDelayMs: number;
}

interface UseTransportFallbackResult {
  activeTransport: SyncType;
  /**
   * Report a transport failure. `from` names the rung that actually failed —
   * pass it whenever the caller renders a rung ahead of `activeTransport`
   * (see SyncProvider's `effectiveTransport`), or the failure is attributed to
   * the wrong rung and swallowed by the debounce.
   */
  onTransportError: (error: Error, from?: SyncType) => void;
}

export function useTransportFallback(
  opts: UseTransportFallbackOptions,
): UseTransportFallbackResult {
  const { preferred, fallbackDelayMs } = opts;
  const [activeTransport, setActiveTransport] = useState<SyncType>(preferred);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which rung the pending step-down is FOR. Needed because the debounce
  // below must distinguish "the same transport is still failing" (keep
  // debouncing) from "a LATER rung has now failed too" (supersede).
  const pendingFrom = useRef<SyncType | null>(null);
  // Mirror of `activeTransport` read inside `onTransportError`. A ref, not a
  // dependency: `SyncProvider` lists `onTransportError` in a useEffect dep
  // array, so letting its identity change per transport would re-run the WS
  // probe effect on every rung change.
  const activeTransportRef = useRef<SyncType>(preferred);
  useEffect(() => {
    activeTransportRef.current = activeTransport;
  }, [activeTransport]);

  // Reset when preferred changes
  useEffect(() => {
    setActiveTransport(preferred);
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    pendingFrom.current = null;
  }, [preferred]);

  const onTransportError = useCallback(
    (error: Error, from?: SyncType) => {
      // Which rung actually failed. Callers that know (SyncProvider stamps its
      // `effectiveTransport`) pass it explicitly; the rest fall back to the
      // hook's own view.
      const failing = from ?? activeTransportRef.current;
      const failingIndex = FALLBACK_ORDER.indexOf(failing);
      if (failingIndex < 0) return;

      // Debounce: don't fall back immediately — wait for sustained failure.
      // But only swallow a repeat of the rung we are ALREADY stepping down
      // from. A WEBSOCKETS-preferred provider renders the SSE rung as soon as
      // the WS probe fails, ~10s before `activeTransport` catches up; without
      // this check SSE's own failures land inside the WS debounce window and
      // are dropped, leaving the ladder one rung behind reality (it advances
      // WEBSOCKETS → SSE at the very moment SSE is known to be broken).
      if (fallbackTimer.current) {
        const pendingIndex = pendingFrom.current
          ? FALLBACK_ORDER.indexOf(pendingFrom.current)
          : -1;
        if (failingIndex <= pendingIndex) return; // same or earlier rung — keep debouncing
        clearTimeout(fallbackTimer.current); // a later rung failed — supersede
      }

      pendingFrom.current = failing;
      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        pendingFrom.current = null;
        setActiveTransport((current) => {
          const nextIndex = failingIndex + 1;

          if (nextIndex >= FALLBACK_ORDER.length) {
            // Already at terminal fallback (POLLING) — nothing to do
            console.warn('[Sync] Already at terminal transport (POLLING)');
            return current;
          }

          // Never walk BACK up the ladder: if something already advanced us
          // past the failing rung, keep the further-along transport.
          const next = FALLBACK_ORDER[Math.max(nextIndex, FALLBACK_ORDER.indexOf(current))];
          if (next === current) return current;
          console.warn(
            `[Sync] Transport ${failing} failed — falling back to ${next}`,
            error.message,
          );
          return next;
        });
      }, fallbackDelayMs);
    },
    [fallbackDelayMs],
  );

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, []);

  return { activeTransport, onTransportError };
}
