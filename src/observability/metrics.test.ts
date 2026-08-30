/**
 * @vitest-environment jsdom
 *
 * Tests for the in-memory sync metrics counters + the window global installer.
 * Run with: npx vitest run libs/generic/sync/src/observability/metrics.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  syncMetrics,
  installSyncMetricsGlobal,
  SYNC_QUERY_RING_SIZE,
  SYNC_STAGE_NAMES,
  createSyncTraceId,
} from './metrics';

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
    expect(s.invalidations).toEqual({ fromSse: 1, fromTimer: 1, fromManual: 1, bySseName: {} });
  });

  it('EI-19406583179082751: invalidateFromSse(name) attributes the count per query name', () => {
    syncMetrics.invalidateFromSse('plans.list');
    syncMetrics.invalidateFromSse('plans.list');
    syncMetrics.invalidateFromSse('work_items.list');
    syncMetrics.invalidateFromSse(); // no name — still counts toward the aggregate, not bySseName
    const s = syncMetrics.snapshot();
    expect(s.invalidations.fromSse).toBe(4);
    expect(s.invalidations.bySseName).toEqual({ 'plans.list': 2, 'work_items.list': 1 });
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

describe('transport metrics (P-003b — the gate depth nothing outside tests read)', () => {
  const ev = (over: Partial<Parameters<typeof syncMetrics.queryCompleted>[0]> = {}) => ({
    name: 'plans.list',
    startedAtMs: 0,
    waitMs: 0,
    requestMs: 10,
    bytes: 1000,
    outcome: 'ok' as const,
    ...over,
  });

  it('reports the gate depth LIVE through a registered probe', () => {
    let depth = { inFlight: 3, queued: 7, limit: 24 };
    syncMetrics.registerGateProbe(() => depth);
    expect(syncMetrics.snapshot().transport).toMatchObject({ inFlight: 3, queued: 7, limit: 24 });
    depth = { inFlight: 0, queued: 0, limit: 24 };
    // The point of a probe over a copied counter: the SECOND read must see the
    // gate as it is now, not as it was when the probe was registered.
    expect(syncMetrics.snapshot().transport).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('reports nulls — not zeros — when no gate is registered', () => {
    const t = syncMetrics.snapshot().transport;
    // "no gate" and "an idle gate" are different facts; zero would assert the latter.
    expect(t.inFlight).toBeNull();
    expect(t.queued).toBeNull();
    expect(t.limit).toBeNull();
  });

  it('survives a probe that throws rather than breaking the snapshot', () => {
    syncMetrics.registerGateProbe(() => {
      throw new Error('gate exploded');
    });
    expect(syncMetrics.snapshot().transport.inFlight).toBeNull();
  });

  it('accumulates queue-wait tail counters, which is where a waiting user shows up', () => {
    syncMetrics.queryCompleted(ev({ waitMs: 10 }));
    syncMetrics.queryCompleted(ev({ waitMs: 300 }));
    syncMetrics.queryCompleted(ev({ waitMs: 4000 }));
    const t = syncMetrics.snapshot().transport;
    expect(t.requests).toBe(3);
    expect(t.queueWaitMsTotal).toBe(4310);
    expect(t.queueWaitMsMax).toBe(4000);
    expect(t.queueWaitOver250).toBe(2);
    expect(t.queueWaitOver1000).toBe(1);
  });

  it('counts a timeout as both a failure and a timeout, and ignores unknown byte counts', () => {
    syncMetrics.queryCompleted(ev({ outcome: 'timeout', bytes: -1 }));
    syncMetrics.queryCompleted(ev({ outcome: 'error', bytes: -1 }));
    const t = syncMetrics.snapshot().transport;
    expect(t.failures).toBe(2);
    expect(t.timeouts).toBe(1);
    expect(t.bytesReceived).toBe(0); // -1 means "not observed", never subtracted
  });

  it('rolls up per queryName so payload weight is attributable', () => {
    syncMetrics.queryCompleted(ev({ name: 'plans.list', bytes: 800_000, requestMs: 40 }));
    syncMetrics.queryCompleted(ev({ name: 'plans.list', bytes: 800_000, requestMs: 90 }));
    syncMetrics.queryCompleted(ev({ name: 'toastLog.recent', bytes: 2_000, requestMs: 5 }));
    const { byQuery } = syncMetrics.snapshot();
    expect(byQuery['plans.list']).toMatchObject({ requests: 2, bytes: 1_600_000, requestMsMax: 90 });
    expect(byQuery['toastLog.recent']).toMatchObject({ requests: 1, bytes: 2_000 });
  });

  it('keeps a bounded ring of recent queries — the hydration wave, without an external recorder', () => {
    for (let i = 0; i < SYNC_QUERY_RING_SIZE + 25; i++) {
      syncMetrics.queryCompleted(ev({ name: `q${i}` }));
    }
    const recent = syncMetrics.recentQueries();
    expect(recent).toHaveLength(SYNC_QUERY_RING_SIZE);
    // Oldest dropped first, so the ring holds the MOST RECENT window.
    expect(recent[0].name).toBe('q25');
    expect(recent[recent.length - 1].name).toBe(`q${SYNC_QUERY_RING_SIZE + 24}`);
    // A copy: sorting the caller's view must not reorder the ring itself.
    recent.reverse();
    expect(syncMetrics.recentQueries()[0].name).toBe('q25');
  });

  it('__resetForTests clears transport state and unregisters the probe', () => {
    syncMetrics.registerGateProbe(() => ({ inFlight: 1, queued: 2, limit: 3 }));
    syncMetrics.queryCompleted(ev({ waitMs: 500 }));
    syncMetrics.__resetForTests();
    const s = syncMetrics.snapshot();
    expect(s.transport.requests).toBe(0);
    expect(s.transport.queueWaitOver250).toBe(0);
    expect(s.transport.inFlight).toBeNull();
    expect(s.byQuery).toEqual({});
    expect(syncMetrics.recentQueries()).toEqual([]);
  });
});

describe('freshness stage telemetry (P-022)', () => {
  it('publishes a closed, explicitly millisecond stage contract', () => {
    expect(SYNC_STAGE_NAMES).toEqual([
      'commit',
      'eventReceipt',
      'schedulerWait',
      'resolver',
      'transfer',
      'parseCache',
      'reactCommit',
      'updateToScreen',
    ]);
    const stages = syncMetrics.snapshot().stages!;
    expect(stages.unit).toBe('ms');
    for (const stage of SYNC_STAGE_NAMES) {
      expect(stages.byStage[stage]).toMatchObject({
        unit: 'ms',
        count: 0,
        durationMsTotal: 0,
        durationMsMax: 0,
        lastDurationMs: null,
      });
    }
  });

  it('records stage samples and rejects non-finite/negative writer values', () => {
    const traceId = createSyncTraceId('test');
    syncMetrics.recordStage('resolver', 12, {
      queryName: 'plans.list',
      traceId,
      measuredAtMs: 500,
    });
    syncMetrics.recordStage('resolver', 4, { queryName: 'plans.list', traceId, measuredAtMs: 501 });
    syncMetrics.recordStage('transfer', -1);
    syncMetrics.recordStage('parseCache', Number.NaN);
    const stages = syncMetrics.snapshot().stages!;
    expect(stages.byStage.resolver).toMatchObject({
      unit: 'ms',
      count: 2,
      durationMsTotal: 16,
      durationMsMax: 12,
      lastDurationMs: 4,
    });
    expect(stages.byStage.transfer.count).toBe(0);
    expect(stages.invalidSamples).toBe(2);
    expect(syncMetrics.recentStages()).toEqual([
      { stage: 'resolver', unit: 'ms', durationMs: 12, measuredAtMs: 500, queryName: 'plans.list', traceId },
      { stage: 'resolver', unit: 'ms', durationMs: 4, measuredAtMs: 501, queryName: 'plans.list', traceId },
    ]);
  });

  it('keeps commit and event-receipt stages on the server/client epoch timestamps', () => {
    syncMetrics.sseEventReceived(10, 1_000, {
      queryName: 'plans.list',
      traceId: 'sse-test',
      receivedAtMs: 1_125,
    });
    const stages = syncMetrics.snapshot().stages!;
    expect(stages.byStage.commit).toMatchObject({ unit: 'ms', count: 1, lastDurationMs: 0 });
    expect(stages.byStage.eventReceipt).toMatchObject({ unit: 'ms', count: 1, lastDurationMs: 125 });
    expect(stages.recent.slice(-2)).toEqual([
      { stage: 'commit', unit: 'ms', durationMs: 0, measuredAtMs: 1_000, queryName: 'plans.list', traceId: 'sse-test' },
      { stage: 'eventReceipt', unit: 'ms', durationMs: 125, measuredAtMs: 1_125, queryName: 'plans.list', traceId: 'sse-test' },
    ]);
  });

  it('queryCompleted wires the scheduler, resolver, transfer, and parse/cache writers', () => {
    syncMetrics.queryCompleted({
      name: 'plans.list',
      startedAtMs: 10,
      waitMs: 7,
      requestMs: 20,
      bytes: 100,
      outcome: 'ok',
      traceId: 'query-test',
      stages: { schedulerWaitMs: 7, resolverMs: 5, transferMs: 8, parseCacheMs: 2 },
    });
    const byStage = syncMetrics.snapshot().stages!.byStage;
    expect(byStage.schedulerWait.lastDurationMs).toBe(7);
    expect(byStage.resolver.lastDurationMs).toBe(5);
    expect(byStage.transfer.lastDurationMs).toBe(8);
    expect(byStage.parseCache.lastDurationMs).toBe(2);
    expect(syncMetrics.recentQueries()[0]).toMatchObject({ traceId: 'query-test' });
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
