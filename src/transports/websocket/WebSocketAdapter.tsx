'use client';

import { useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import { Zero } from '@rocicorp/zero';
import { ZeroProvider } from '@rocicorp/zero/react';
import { schema } from '@restart/zero';
import { SyncContext } from '../../SyncContext';
import { useWebSocketQuery } from './useWebSocketQuery';
import { clearPollingCache } from '../polling/queryClient';
import type { SyncType } from '../../types';

interface WebSocketAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  pollIntervalMs?: number;
  onTransportError?: (error: Error) => void;
}

const DEFAULT_ZERO_SERVER =
  typeof window !== 'undefined'
    ? (window as any).__ZERO_SERVER ?? 'http://localhost:4848'
    : 'http://localhost:4848';

const PROBE_TIMEOUT_MS = 10_000;

// Module-level cache of Zero instances keyed by (userId|server). Survives
// component remounts caused by Suspense, lazy-chunk-loading, transport-fallback
// toggling, or astro ClientRouter page transitions.
//
// Without this, WebSocketAdapter creates a NEW Zero instance on each remount
// — 6+ simultaneous instances observed in practice. Each instance opens its
// own WS, subscribes independently, and receives duplicate pokes, multiplying
// client-side processing latency.
type CachedZero = { zero: Zero<typeof schema>; refcount: number };
const ZERO_CACHE: Map<string, CachedZero> = (() => {
  if (typeof window === 'undefined') return new Map();
  const w = window as unknown as { __RESTART_ZERO_CACHE__?: Map<string, CachedZero> };
  if (!w.__RESTART_ZERO_CACHE__) w.__RESTART_ZERO_CACHE__ = new Map();
  return w.__RESTART_ZERO_CACHE__;
})();

function WebSocketAdapter({
  children,
  userId = 'anonymous',
  server,
  onTransportError,
}: WebSocketAdapterProps) {
  const zeroServer = server ?? DEFAULT_ZERO_SERVER;
  const cacheKey = `${userId}|${zeroServer}`;
  const zeroRef = useRef<Zero<typeof schema> | null>(null);

  // Look up or create the Zero instance for this (userId, server) pair from
  // the module-level cache. This survives component remounts and prevents
  // duplicate WS connections (observed 6+ simultaneous instances pre-fix).
  let cached = ZERO_CACHE.get(cacheKey);
  if (!cached) {
    const zero = new Zero({
      userID: userId,
      server: zeroServer,
      schema,
      // Default behavior is to call location.reload() on schema-version
      // mismatch or missing client-state, which produces a continuous
      // refresh loop in dev when the postgres publication doesn't match
      // the client's declared schema. Log instead — the page stays
      // mounted and the live-overlay subscriptions degrade gracefully
      // (queries return empty rather than triggering a reload).
      onUpdateNeeded: (reason) => {
        // eslint-disable-next-line no-console
        console.warn('[zero] update needed but auto-reload suppressed', reason);
      },
      onClientStateNotFound: () => {
        // eslint-disable-next-line no-console
        console.warn('[zero] client state not found but auto-reload suppressed');
      },
    });
    cached = { zero, refcount: 0 };
    ZERO_CACHE.set(cacheKey, cached);
  }
  zeroRef.current = cached.zero;

  // Refcount per mount; close + evict when the last consumer unmounts.
  useEffect(() => {
    const entry = ZERO_CACHE.get(cacheKey);
    if (!entry) return;
    entry.refcount += 1;
    return () => {
      entry.refcount -= 1;
      if (entry.refcount <= 0) {
        try { entry.zero.close?.(); } catch { /* ignore */ }
        ZERO_CACHE.delete(cacheKey);
      }
    };
  }, [cacheKey]);

  // Clear any TanStack Query subscriptions that were created while the
  // PollingAdapter was mounted during the WS-probe window. This stops
  // background REST refetches the moment WebSocketAdapter takes over.
  // Running it once on mount (empty deps) is correct: if the adapter
  // re-mounts (transport toggled back to polling and then WS again), we
  // want to clear stale polling data on each WS takeover.
  useEffect(() => {
    clearPollingCache();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  // NOTE: previous versions polled `zero.connection.state` every 3s to detect
  // sustained disconnection and fall back to POLLING. That property is not a
  // stable public API, so the probe produced false positives — the fallback
  // would flip WS → POLLING on a healthy connection, making data appear to
  // "refresh" every ~20s. Zero already handles reconnection internally; we
  // trust it and only fall back if the lazy chunk itself fails to load.

  // Monitor Zero connection state and trigger fallback if WS is blocked.
  // Path 1: subscribe to 'error' state (JS-level WS override that throws).
  // Path 2: timeout probe for network-level blocks (declarativeNetRequest).
  useEffect(() => {
    const z = zeroRef.current;
    if (!z || !onTransportError) return;

    let fired = false;
    const trigger = (msg: string) => {
      if (fired) return;
      fired = true;
      onTransportError(new Error(msg));
    };
    // Declare timer as let before the subscribe callback so the closure
    // doesn't hit the temporal dead zone if Zero is already connected and
    // the callback fires synchronously during subscribe().
    let timer: ReturnType<typeof setTimeout>;

    // Path 1: subscribe to 'error' state (JS-level WS override that throws).
    // Also cancel the Path 2 timer once we see 'connected' so a slow initial
    // hydration doesn't trigger a false fallback.
    const unsub = z.connection.state.subscribe((s) => {
      if (s.name === 'error') {
        trigger(`Zero connection error: ${(s as { reason?: string }).reason ?? 'unknown'}`);
      } else if (s.name === 'connected') {
        // WS is genuinely up — cancel the timeout probe.
        clearTimeout(timer);
      }
    });

    // Path 2: if still not connected after PROBE_TIMEOUT_MS, assume WS is
    // network-blocked. The timer is cleared above if 'connected' fires first.
    timer = setTimeout(() => {
      if (z.connection.state.current.name !== 'connected') {
        trigger(
          `WebSocket not connected after ${PROBE_TIMEOUT_MS}ms ` +
          `(state: ${z.connection.state.current.name})`,
        );
      }
    }, PROBE_TIMEOUT_MS);

    return () => {
      unsub();
      clearTimeout(timer);
    };
  // zeroRef is a ref — intentionally omitted from deps (stable ref object)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTransportError]);

  const noop = useCallback(() => {}, []);
  const ctxValue = useMemo(
    () => ({ transport: 'WEBSOCKETS' as SyncType, useDataImpl: useWebSocketQuery, prefetch: noop }),
    [],
  );

  return (
    <ZeroProvider zero={zeroRef.current!}>
      <SyncContext.Provider value={ctxValue}>
        {children}
      </SyncContext.Provider>
    </ZeroProvider>
  );
}

// Default export for React.lazy
export default WebSocketAdapter;
