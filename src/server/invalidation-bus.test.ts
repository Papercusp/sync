import { describe, it, expect } from 'vitest';
import {
  createInvalidationBus,
  type ListenSource,
  type NotifySink,
  type SyncEvent,
} from './invalidation-bus';

/**
 * Single-process loopback: notify() publishes JSON; the same JSON is
 * delivered back through the ListenSource (as PG NOTIFY → LISTEN does in
 * one process). `deliver` lets a test inject a raw event directly (to
 * bypass the notify-side dedupe, e.g. for bridge tests).
 */
function makeLoopback() {
  let onMsg: ((raw: string) => void) | null = null;
  const delivered: string[] = [];
  const listen: ListenSource = {
    start(cb) {
      onMsg = cb;
    },
  };
  const notify: NotifySink = {
    async notify(json) {
      delivered.push(json);
      onMsg?.(json);
    },
  };
  return { listen, notify, delivered, deliver: (raw: string) => onMsg?.(raw) };
}

describe('invalidation-bus', () => {
  it('subscribe starts the listen source and receives notified events', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({ listen: lb.listen, notify: lb.notify, now: () => clock.t });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    await bus.notifyInvalidate('plans.items', { harnessSlug: 'x' });
    expect(lb.delivered).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 1, name: 'plans.items', args: { harnessSlug: 'x' } });
    expect(events[0].data).toBeUndefined();
  });

  it('dedupes identical notifies inside the window, lets them through after', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 1000,
    });
    await bus.subscribe(() => {});

    await bus.notifyInvalidate('plans.items', { harnessSlug: 'x' });
    await bus.notifyInvalidate('plans.items', { harnessSlug: 'x' }); // dup, suppressed
    expect(lb.delivered).toHaveLength(1);

    clock.t += 1001; // past the window
    await bus.notifyInvalidate('plans.items', { harnessSlug: 'x' });
    expect(lb.delivered).toHaveLength(2);
  });

  it('different args are not deduped against each other', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({ listen: lb.listen, notify: lb.notify, now: () => clock.t });
    await bus.subscribe(() => {});
    await bus.notifyInvalidate('plans.items', { harnessSlug: 'a' });
    await bus.notifyInvalidate('plans.items', { harnessSlug: 'b' });
    expect(lb.delivered).toHaveLength(2);
  });

  it('drops oversized data payloads (client refetches)', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      payloadSizeLimit: 50,
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    await bus.notifyInvalidate('big.query', { k: 'v' }, [{ blob: 'x'.repeat(200) }]);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBeUndefined(); // stripped
    expect(events[0].args).toEqual({ k: 'v' });
  });

  it('keeps small data payloads (update event)', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({ listen: lb.listen, notify: lb.notify, now: () => clock.t });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));
    await bus.notifyInvalidate('small.query', undefined, [{ a: 1 }]);
    expect(events[0].data).toEqual([{ a: 1 }]);
  });

  it('bridge synthesizes extra events from a raw delivered event', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      bridge: (name) =>
        name === 'harness_shared.harness_status.changed' ? ['harnessStatus.byHarness'] : [],
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_status.changed' }));
    expect(events.map((e) => e.name)).toEqual([
      'harness_shared.harness_status.changed',
      'harnessStatus.byHarness',
    ]);
  });

  it('ignores malformed / nameless raw events', async () => {
    const lb = makeLoopback();
    const bus = createInvalidationBus({ listen: lb.listen, notify: lb.notify });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));
    lb.deliver('not json');
    lb.deliver(JSON.stringify({ noName: true }));
    expect(events).toHaveLength(0);
  });

  it('backfillSince returns events after the id and prunes by window', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      historyWindowMs: 5000,
    });
    await bus.subscribe(() => {});
    await bus.notifyInvalidate('q', { i: 1 });
    await bus.notifyInvalidate('q', { i: 2 });
    expect(bus.backfillSince(1).map((e) => e.id)).toEqual([2]);
    expect(bus.backfillSince(0)).toHaveLength(2);

    clock.t += 6000; // both fall out of the retention window
    expect(bus.backfillSince(0)).toHaveLength(0);
    expect(bus.historySize()).toBe(0);
  });
});
