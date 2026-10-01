/**
 * @vitest-environment jsdom
 *
 * Tests for the in-memory sync metrics counters + the window global installer.
 * Run with: npx vitest run libs/generic/sync/src/observability/metrics.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncMetrics,
  installSyncMetricsGlobal,
  SYNC_QUERY_RING_SIZE,
  SYNC_STAGE_NAMES,
  createSyncTraceId,
} from './metrics';
import { createOriginScheduler } from '../transports/polling/origin-scheduler';

beforeEach(() => syncMetrics.__resetForTests());

describe('syncMetrics counters', () => {
  it('retains pending IPC assertion time separately from its completed client result', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const finish = syncMetrics.beginIpcAssertion();
      const pending = syncMetrics.snapshot().ipcAssertion!;
      expect(pending).toEqual([{ startedAtMs: 100, importReadyAtMs: null, invokeStartedAtMs: null,
        invokeCompletedAtMs: null, completedAtMs: null, client: null }]);
      clock.mockReturnValue(1_100);
      finish.mark('importReady');
      clock.mockReturnValue(1_200);
      finish.mark('invokeStarted');
      const invoking = syncMetrics.snapshot().ipcAssertion![0];
      expect(invoking.importReadyAtMs! - invoking.startedAtMs).toBe(1_000);
      expect(invoking.invokeCompletedAtMs).toBeNull();
      clock.mockReturnValue(6_000);
      finish.mark('invokeCompleted');
      clock.mockReturnValue(6_100);
      finish('connected');
      expect(syncMetrics.snapshot().ipcAssertion).toEqual([
        { startedAtMs: 100, importReadyAtMs: 1_100, invokeStartedAtMs: 1_200,
          invokeCompletedAtMs: 6_000, completedAtMs: 6_100, client: 'connected' },
      ]);
      expect(invoking.invokeCompletedAtMs).toBeNull();
      expect(pending[0].completedAtMs).toBeNull();
      clock.mockReturnValue(7_100);
      finish.mark('importReady'); // Neither duplicate phases nor late marks rewrite the attempt.
      finish.mark('invokeCompleted');
      finish('dead'); // A duplicate completion cannot rewrite the observation.
      expect(syncMetrics.snapshot().ipcAssertion![0].client).toBe('connected');
      expect(syncMetrics.snapshot().ipcAssertion![0].importReadyAtMs).toBe(1_100);
      expect(syncMetrics.snapshot().ipcAssertion![0].invokeCompletedAtMs).toBe(6_000);
      for (let i = 0; i < 70; i++) syncMetrics.beginIpcAssertion()(null);
      expect(syncMetrics.snapshot().ipcAssertion).toHaveLength(64);
      syncMetrics.__resetForTests();
      expect(syncMetrics.snapshot().ipcAssertion).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps invoke phases absent when an assertion fails during module import', () => {
    const finish = syncMetrics.beginIpcAssertion();
    finish(null);
    const sample = syncMetrics.snapshot().ipcAssertion![0];
    expect(sample.importReadyAtMs).toBeNull();
    expect(sample.invokeStartedAtMs).toBeNull();
    expect(sample.invokeCompletedAtMs).toBeNull();
    expect(sample.completedAtMs).not.toBeNull();
    expect(sample.client).toBeNull();
  });

  it('bounds IPC rejection reasons and preserves the first completed observation', () => {
    const finish = syncMetrics.beginIpcAssertion();
    finish(null, 'x'.repeat(700));
    const saved = syncMetrics.snapshot().ipcAssertion![0];
    expect(saved.error).toBe('x'.repeat(500));
    saved.error = 'changed snapshot';
    finish('connected', 'later completion');
    expect(syncMetrics.snapshot().ipcAssertion![0]).toMatchObject({
      client: null, error: 'x'.repeat(500),
    });
  });

  it('retains native execution separately from a delayed invoke reply', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const finish = syncMetrics.beginIpcAssertion();
      finish.mark('invokeStarted');
      clock.mockReturnValue(10_000);
      finish.mark('invokeCompleted');
      finish.recordNative(120, 0.5);
      finish('connected');
      const saved = syncMetrics.snapshot().ipcAssertion![0];
      expect(saved.nativeStartedAtMs).toBe(120);
      expect(saved.nativeDurationMs).toBe(0.5);
      expect(saved.invokeCompletedAtMs! - saved.invokeStartedAtMs!).toBe(9_900);
      saved.nativeDurationMs = 9_900;
      finish.recordNative(200, 5);
      expect(syncMetrics.snapshot().ipcAssertion![0].nativeDurationMs).toBe(0.5);
    } finally {
      clock.mockRestore();
    }
  });

  it('distinguishes responsive renderer timers from the final unobserved reply interval', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const finish = syncMetrics.beginIpcAssertion();
      finish.startRenderer(50);
      for (const at of [150, 200, 250]) {
        clock.mockReturnValue(at);
        finish.observeRenderer('timer');
      }
      const pending = syncMetrics.snapshot().ipcAssertion![0].renderer!;
      expect(pending).toMatchObject({ timerTicks: 3, maxGapMs: 50, stoppedAtMs: null, gaps: [] });
      // Promise continuations can run before the delayed timer. The completion
      // boundary must capture this gap without fabricating another timer tick.
      clock.mockReturnValue(4_600);
      finish.observeRenderer('reply');
      finish('connected');
      const saved = syncMetrics.snapshot().ipcAssertion![0].renderer!;
      expect(saved).toMatchObject({ timerTicks: 3, maxGapMs: 4_350,
        stoppedAtMs: 4_600, stopReason: 'reply', unit: 'ms', clock: 'performance.now' });
      expect(saved.gaps).toEqual([{ startedAtMs: 250, completedAtMs: 4_600, durationMs: 4_350 }]);
      expect(pending.gaps).toEqual([]);
      saved.gaps[0].durationMs = 0;
      saved.gaps.push({ startedAtMs: 0, completedAtMs: 0, durationMs: 0 });
      finish.observeRenderer('timer');
      expect(syncMetrics.snapshot().ipcAssertion![0].renderer!.gaps).toEqual([
        { startedAtMs: 250, completedAtMs: 4_600, durationMs: 4_350 },
      ]);
    } finally { clock.mockRestore(); }
  });

  it('bounds renderer gaps and keeps deadline termination distinct from receipt', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const finish = syncMetrics.beginIpcAssertion();
      for (const interval of [NaN, Infinity, 0, -1]) finish.startRenderer(interval);
      expect(syncMetrics.snapshot().ipcAssertion![0].renderer).toBeUndefined();
      finish.startRenderer(50);
      for (let i = 1; i <= 20; i++) {
        clock.mockReturnValue(100 + i * 200);
        finish.observeRenderer('timer');
      }
      clock.mockReturnValue(4_150);
      finish.observeRenderer('deadline');
      const expired = syncMetrics.snapshot().ipcAssertion![0].renderer!;
      expect(expired.gaps).toHaveLength(8);
      expect(expired.timerTicks).toBe(20);
      expect(expired.stopReason).toBe('deadline');
      clock.mockReturnValue(10_000);
      finish.observeRenderer('reply');
      finish('connected');
      expect(syncMetrics.snapshot().ipcAssertion![0].renderer).toEqual(expired);
    } finally { clock.mockRestore(); }
  });

  it.each([[NaN, 1], [100, Infinity], [-1, 1], [100, -1]])(
    'omits invalid native timing (%s, %s) instead of reporting zero work', (start, duration) => {
      const finish = syncMetrics.beginIpcAssertion();
      finish.recordNative(start, duration);
      finish('connected');
      expect(syncMetrics.snapshot().ipcAssertion![0].nativeStartedAtMs).toBeUndefined();
      expect(syncMetrics.snapshot().ipcAssertion![0].nativeDurationMs).toBeUndefined();
    },
  );

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

  it('publishes the live origin scheduler snapshot beside legacy transport depth', () => {
    const scheduler = createOriginScheduler({ limit: 3, origin: 'https://metrics.example' });
    syncMetrics.registerSchedulerProbe(() => scheduler.snapshot());
    const lease = scheduler.registerStream({ name: 'control', kind: 'control' });
    const snapshot = syncMetrics.snapshot();
    expect(snapshot.scheduler).toMatchObject({
      origin: 'https://metrics.example',
      streams: 1,
      byClass: expect.objectContaining({
        'interactive-control': expect.objectContaining({ queued: 0, inFlight: 0 }),
      }),
    });
    lease.release();
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
