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
  onTransportError: (error: Error) => void;
}

export function useTransportFallback(
  opts: UseTransportFallbackOptions,
): UseTransportFallbackResult {
  const { preferred, fallbackDelayMs } = opts;
  const [activeTransport, setActiveTransport] = useState<SyncType>(preferred);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when preferred changes
  useEffect(() => {
    setActiveTransport(preferred);
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
  }, [preferred]);

  const onTransportError = useCallback(
    (error: Error) => {
      // Debounce: don't fall back immediately — wait for sustained failure
      if (fallbackTimer.current) return; // Already waiting

      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        setActiveTransport((current) => {
          const currentIndex = FALLBACK_ORDER.indexOf(current);
          const nextIndex = currentIndex + 1;

          if (nextIndex >= FALLBACK_ORDER.length) {
            // Already at terminal fallback (POLLING) — nothing to do
            console.warn('[Sync] Already at terminal transport (POLLING)');
            return current;
          }

          const next = FALLBACK_ORDER[nextIndex];
          console.warn(
            `[Sync] Transport ${current} failed — falling back to ${next}`,
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
