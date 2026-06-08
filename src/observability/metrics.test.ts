/**
 * @vitest-environment jsdom
 *
 * Tests for the in-memory sync metrics counters + the window global installer.
 * Run with: npx vitest run libs/generic/sync/src/observability/metrics.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { syncMetrics, installSyncMetricsGlobal } from './metrics';

beforeEach(() => syncMetrics.__resetForTests());

describe('syncMetrics counters', () => {
  it('counts SSE events and bytes', () => {
    syncMetrics.sseEventReceived(100);
    syncMetrics.sseEventReceived(50);
    const s = syncMetrics.snapshot();
    expect(s.sse.eventsReceived).toBe(2);
    expect(s.sse.bytesReceived).toBe(150);
  });

  it('tracks reconnect attempts', () => {
    syncMetrics.sseReconnectAttempt();
    syncMetrics.sseReconnectAttempt();
    expect(syncMetrics.snapshot().sse.reconnectCount).toBe(2);
  });

  it('reports connectedSinceMs as null while disconnected and ≥0 once connected', () => {
    expect(syncMetrics.snapshot().sse.connectedSinceMs).toBeNull();
    syncMetrics.sseConnected();
    expect(syncMetrics.snapshot().sse.connectedSinceMs).toBeGreaterThanOrEqual(0);
    syncMetrics.sseDisconnected();
    expect(syncMetrics.snapshot().sse.connectedSinceMs).toBeNull();
  });

  it('computes a clamped (≥0) event latency from a server timestamp', () => {
    syncMetrics.sseEventReceived(10, Date.now() - 50);
    expect(syncMetrics.snapshot().sse.lastEventLatencyMs).toBeGreaterThanOrEqual(0);
    syncMetrics.sseEventReceived(10, Date.now() + 10_000); // future ts → clamp to 0
    expect(syncMetrics.snapshot().sse.lastEventLatencyMs).toBe(0);
  });

  it('counts cache hits/misses and invalidation sources', () => {
    syncMetrics.cacheHit();
    syncMetrics.cacheMiss();
    syncMetrics.cacheMiss();
    syncMetrics.invalidateFromSse();
    syncMetrics.invalidateFromTimer();
    syncMetrics.invalidateFromManual();
    const s = syncMetrics.snapshot();
    expect(s.cache).toEqual({ hits: 1, misses: 2 });
    expect(s.invalidations).toEqual({ fromSse: 1, fromTimer: 1, fromManual: 1 });
  });

  it('__resetForTests wipes every counter', () => {
    syncMetrics.sseEventReceived(99);
    syncMetrics.cacheHit();
    syncMetrics.__resetForTests();
    const s = syncMetrics.snapshot();
    expect(s.sse.eventsReceived).toBe(0);
    expect(s.sse.bytesReceived).toBe(0);
    expect(s.cache.hits).toBe(0);
  });
});

describe('installSyncMetricsGlobal', () => {
  it('installs window.__sync_metrics__ idempotently with a working snapshot', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__sync_metrics__;
    installSyncMetricsGlobal();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (window as any).__sync_metrics__;
    expect(first).toBeDefined();
    installSyncMetricsGlobal();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__sync_metrics__).toBe(first); // not re-installed
    expect(first.snapshot()).toHaveProperty('sse');
  });
});
