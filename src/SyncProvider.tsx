'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { lazyWithRetry as lazy } from './lazy-with-retry';
import { PollingAdapter } from './transports/polling/PollingAdapter';
import { useTransportFallback } from './fallback/useTransportFallback';
import { WebSocketErrorBoundary } from './fallback/WebSocketErrorBoundary';
import { SyncContext } from './SyncContext';
import type { SyncProviderProps, SyncQueryResult, SyncType } from './types';

/**
 * Lightweight SyncContext provider used in two cases where we can't (yet)
 * mount a real transport adapter:
 *
 *   1. Server-side rendering — no `window`, no WebSocket, no polling.
 *   2. The brief WS-probe window on the client before `wsHealthy` is known.
 *
 * Children still need a SyncContext so `useSyncQuery` calls don't throw.
 * This provider returns empty data and does not initiate any fetches, so
 * no REST polls bleed into the probe window. Once the probe resolves the
 * real adapter mounts and replaces this provider.
 */
function PendingSyncAdapter({
  children,
  transport,
}: {
  children: ReactNode;
  transport: SyncType;
}) {
  const value = useMemo(() => {
    const emptyResult: SyncQueryResult<unknown> = {
      data: [],
      loading: true,
      fetching: false,
      transport,
      invalidate: () => {},
      error: null,
    };
    return {
      transport,
      useDataImpl: <T,>(_opts: unknown) => emptyResult as SyncQueryResult<T>,
      prefetch: () => {},
    };
  }, [transport]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

// Lazy-load the WebSocket adapter — @rocicorp/zero only in this chunk
const LazyWebSocketAdapter = lazy(
  () => import('./transports/websocket/WebSocketAdapter'),
);

// Eager import — SSEAdapter is the primary path for desktop/operator and
// was repeatedly failing to chunk-load in dev (turbopack hash staleness on
// rapid SPA nav). Bundle cost is negligible vs the dev-mode flakiness it
// removes.
import { SSEAdapter as EagerSSEAdapter } from './transports/sse/SSEAdapter';
const LazySSEAdapter = EagerSSEAdapter;

/**
 * How long to wait for the up-front WebSocket handshake probe before falling
 * back to polling permanently. Must be short enough that blocked browsers see
 * data quickly, long enough that a real network round-trip succeeds.
 *
 * Localhost upgrades complete in <50ms; LAN in <100ms; WAN typically <500ms.
 * 1500ms is plenty of headroom while keeping the blank-fallback window short.
 */
const WS_PROBE_MS = 1_500;

const LOCALHOST_ZERO_FALLBACK = 'http://localhost:4848';

let warnedDefaultZeroServer = false;

function resolveDefaultZeroServer(): string {
  if (typeof window === 'undefined') return LOCALHOST_ZERO_FALLBACK;
  const injected = (window as unknown as { __ZERO_SERVER?: string }).__ZERO_SERVER;
  if (injected) return injected;
  if (
    !warnedDefaultZeroServer &&
    location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1'
  ) {
    warnedDefaultZeroServer = true;
    console.warn(
      `[Sync] No \`server\` prop and no \`window.__ZERO_SERVER\` set on ${location.hostname}; falling back to ${LOCALHOST_ZERO_FALLBACK}. ` +
      'WebSocket probe will fail and the provider will downgrade to POLLING. ' +
      'Pass `server="https://your-zero-host"` or set `window.__ZERO_SERVER` before mount to silence this.',
    );
  }
  return LOCALHOST_ZERO_FALLBACK;
}

type ProbeResult = 'unknown' | 'healthy' | 'blocked';

/**
 * Attempt a single WebSocket upgrade to determine whether WS transport is
 * usable in this environment. Resolves with:
 *
 * - 'healthy' when `open` fires (handshake completed)
 * - 'blocked' when the constructor throws, an `error` fires, `close` fires
 *   before `open`, or `WS_PROBE_MS` elapses with no `open`.
 *
 * We probe the zero server directly so we're testing the exact origin and
 * protocol Zero itself will use.
 */
function probeWebSocket(server: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const WSCtor = typeof window !== 'undefined' ? (window as unknown as { WebSocket?: typeof WebSocket }).WebSocket : undefined;
    if (!WSCtor) {
      resolve('blocked');
      return;
    }

    const wsUrl = server.replace(/^http/, 'ws');
    let settled = false;
    let ws: WebSocket | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish('blocked'), timeoutMs);

    try {
      ws = new WSCtor(wsUrl);
      ws.onopen = () => finish('healthy');
      ws.onerror = () => finish('blocked');
      ws.onclose = () => { if (!settled) finish('blocked'); };
    } catch {
      finish('blocked');
    }
  });
}

/**
 * Renders a sync-transport provider. When `syncType === 'WEBSOCKETS'` we
 * first run a short health probe to check whether WebSocket upgrades work
 * in this browser. Only if the probe succeeds do we mount the Zero-powered
 * WebSocketAdapter. Otherwise we render the polling adapter immediately so
 * the page never shows a blank data region when WS is disabled or blocked.
 *
 * Runtime WS failures after a successful probe are still handled by
 * `useTransportFallback` inside the WebSocketAdapter path.
 */
export function SyncProvider({
  syncType = 'WEBSOCKETS',
  children,
  userId,
  server,
  restEndpoint,
  pollIntervalMs = 10_000,
  fallbackDelayMs = 10_000,
  recoveryDelayMs,
  recoveryMaxDelayMs,
  schema,
  queries,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
  mutators,
}: SyncProviderProps) {
  const { activeTransport, onTransportError } = useTransportFallback({
    preferred: syncType,
    fallbackDelayMs,
    recoveryDelayMs,
    recoveryMaxDelayMs,
  });

  // null = probe in progress; true/false = decision made.
  // For non-WS preferred transports, no probe is needed — start ready.
  const [wsHealthy, setWsHealthy] = useState<boolean | null>(
    syncType === 'WEBSOCKETS' ? null : false,
  );

  // SSR/CSR parity: lazy adapters resolve differently on server (suspend →
  // fallback) vs client (chunk loads → real subtree), causing a hydration
  // mismatch. Defer mounting any lazy adapter until after first client
  // commit by gating on `mounted`. Server and first client render both see
  // `mounted === false` and render the same PendingSyncAdapter; the lazy
  // chunk only mounts on the second client render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (syncType !== 'WEBSOCKETS') return;
    // Gate on activeTransport so a transport recovery (useTransportFallback
    // retrying the preferred transport after a fallback) re-runs the probe:
    // wsHealthy only flips back to true through a fresh successful probe.
    if (activeTransport !== 'WEBSOCKETS') return;
    if (typeof window === 'undefined') return;
    let cancelled = false;

    const resolvedServer = server ?? resolveDefaultZeroServer();
    const startedAt = performance.now();
    // eslint-disable-next-line no-console
    console.info(`[Sync] WebSocket probe starting → ${resolvedServer} (${WS_PROBE_MS}ms timeout)`);
    (window as unknown as { __SYNC_PROBE__?: unknown }).__SYNC_PROBE__ = { status: 'probing', server: resolvedServer, startedAt };

    probeWebSocket(resolvedServer, WS_PROBE_MS).then((result) => {
      if (cancelled) return;
      const durationMs = Math.round(performance.now() - startedAt);
      const healthy = result === 'healthy';
      setWsHealthy(healthy);
      (window as unknown as { __SYNC_PROBE__?: unknown }).__SYNC_PROBE__ = { status: result, server: resolvedServer, durationMs };
      // eslint-disable-next-line no-console
      console.info(`[Sync] WebSocket probe ${result} in ${durationMs}ms → using ${healthy ? 'WEBSOCKETS' : 'POLLING (REST fallback)'}`);
      if (!healthy) {
        // Move the fallback chain WEBSOCKETS → SSE → POLLING so metadata matches.
        onTransportError(new Error(`WebSocket probe to ${resolvedServer} did not open (${result})`));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [syncType, server, onTransportError]);

  // schema/queries are only used by the WebSocket transport; PollingAdapter
  // ignores them safely. Threading both through commonProps keeps the call
  // sites parallel.
  const commonProps = {
    userId, server, restEndpoint, pollIntervalMs, onTransportError, schema, queries, mutators,
    // SSE-only knobs — WS / polling adapters ignore them.
    tokenQueryParam, endpointOverride, visibilityPause,
  };

  // ── Transport selection ────────────────────────────────────────────────
  //
  // wsHealthy has three states:
  //   null  = probe in progress (WS not yet tested)
  //   true  = probe succeeded, use WebSocketAdapter
  //   false = probe failed or WS errored, use PollingAdapter
  //
  // When WS is preferred and the probe is still running we render children
  // under `PendingSyncAdapter` — an empty-data passthrough context — rather
  // than mounting PollingAdapter. This prevents TanStack Query from starting
  // REST-poll subscriptions that would bleed through even after WS takes
  // over, while still rendering the React tree so SSR produces HTML and
  // client hydration paints instantly from any SSR-seeded props. The pending
  // window is at most WS_PROBE_MS (1500 ms) on the client, and the entire
  // request on the server (server also takes this branch because useEffect
  // never fires, keeping wsHealthy === null).
  // If we are NOT in WS mode (POLLING / SSE preferred, or fallback triggered)
  // we never probe and wsHealthy stays false, so this branch is never taken.
  if (syncType === 'WEBSOCKETS' && activeTransport === 'WEBSOCKETS' && wsHealthy === null) {
    return <PendingSyncAdapter transport="WEBSOCKETS">{children}</PendingSyncAdapter>;
  }

  // SSR pass and first client render: render the empty passthrough so the
  // server-side HTML matches what the client paints before useEffect fires.
  // Avoids hydration mismatches from lazy() suspending differently on the
  // server vs the client.
  if (!mounted) {
    return <PendingSyncAdapter transport={syncType}>{children}</PendingSyncAdapter>;
  }

  // SSE primary path — used by desktop/operator deployments. The SSEAdapter
  // wraps the polling fetcher (initial load + post-invalidate refetch) and
  // adds an EventSource subscriber that pushes invalidate/update events.
  // Falls back to polling on repeated SSE failures via useTransportFallback.
  if (syncType === 'SSE' && activeTransport === 'SSE') {
    return (
      <Suspense fallback={
        <PendingSyncAdapter transport="SSE">{children}</PendingSyncAdapter>
      }>
        <LazySSEAdapter key="sse" {...commonProps}>
          {children}
        </LazySSEAdapter>
      </Suspense>
    );
  }

  const shouldUseWebSocket =
    syncType === 'WEBSOCKETS' && activeTransport === 'WEBSOCKETS' && wsHealthy === true;

  if (!shouldUseWebSocket) {
    // Stable key across the whole polling lifecycle so React preserves the
    // children's state (grid scroll, filter inputs, etc.) when fallback
    // progresses WEBSOCKETS → SSE → POLLING.
    return (
      <PollingAdapter key="polling" {...commonProps}>
        {children}
      </PollingAdapter>
    );
  }

  const pollingFallback = (key: string) => (
    <PollingAdapter key={key} {...commonProps}>
      {children}
    </PollingAdapter>
  );

  return (
    <WebSocketErrorBoundary
      fallback={pollingFallback('polling-ws-errored')}
      onError={() => {
        // Force the fallback chain to record the failure so we stay on polling
        onTransportError(new Error('WebSocket subtree threw during render'));
        setWsHealthy(false);
      }}
    >
      <Suspense fallback={pollingFallback('polling-ws-fallback')}>
        <LazyWebSocketAdapter key="websocket" {...commonProps}>
          {children}
        </LazyWebSocketAdapter>
      </Suspense>
    </WebSocketErrorBoundary>
  );
}
