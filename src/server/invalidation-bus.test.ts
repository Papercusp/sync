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

/** Deterministic timer seam for bridge trailing-edge tests. */
function makeTimerHarness() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer(fn: () => void, _ms: number): number {
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    },
    clearTimer(handle: unknown): void {
      callbacks.delete(handle as number);
    },
    fireAll(): void {
      // Snapshot current timers so a callback that re-arms itself is left for
      // the next explicit tick, just like a real elapsed-time advancement.
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const fn of pending) fn();
    },
    get pending(): number {
      return callbacks.size;
    },
  };
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

  it('per-call dedupeWindowMs override lets a self-debounced producer through the default window', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 90_000, // the real default — would suppress a 10s-cadence reconcile
    });
    await bus.subscribe(() => {});

    // A self-debounced detector firing every ~10s with a SHORT per-call window.
    await bus.notifyInvalidate('harness_shared.user_actions.changed', undefined, undefined, { dedupeWindowMs: 5_000 });
    expect(lb.delivered).toHaveLength(1);

    clock.t += 4_000; // < override window → still suppressed (collapses a same-tick burst)
    await bus.notifyInvalidate('harness_shared.user_actions.changed', undefined, undefined, { dedupeWindowMs: 5_000 });
    expect(lb.delivered).toHaveLength(1);

    clock.t += 2_000; // now 6s since the first — past the 5s override (but FAR inside the 90s default)
    await bus.notifyInvalidate('harness_shared.user_actions.changed', undefined, undefined, { dedupeWindowMs: 5_000 });
    expect(lb.delivered).toHaveLength(2); // override won — the 90s default would have suppressed this
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

  it('passes the raw event args to the bridge and SCOPES a { name, args } target', async () => {
    // caching-layer-tag-eca P-006: a per-row query opts into scoping; the
    // bridged event carries the changed row's key so the client invalidates
    // just that key (exact-match), not the whole query cache.
    const lb = makeLoopback();
    const seenArgs: unknown[] = [];
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      bridge: (name, args) => {
        seenArgs.push(args);
        if (name !== 'harness_shared.widget.changed') return [];
        const id = (args as { id?: unknown } | undefined)?.id;
        return typeof id === 'string'
          ? [{ name: 'widget.byId', args: { id } }] // scoped
          : ['widget.byId']; // full-bust fallback
      },
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    lb.deliver(
      JSON.stringify({
        name: 'harness_shared.widget.changed',
        args: { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' },
      }),
    );
    // The bridge saw the trigger args (with the row id).
    expect(seenArgs).toEqual([{ workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' }]);
    // Original event + one SCOPED bridged event carrying just { id }.
    const bridged = events.find((e) => e.name === 'widget.byId');
    expect(bridged?.args).toEqual({ id: 'widget-42' });
  });

  it('a bare-string bridge target full-busts (no args), even with id-bearing event args', async () => {
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      bridge: () => ['list.byHarness'], // unconditional full-bust
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));
    lb.deliver(JSON.stringify({ name: 'harness_shared.t.changed', args: { id: 'x', workspace_id: 'w' } }));
    const bridged = events.find((e) => e.name === 'list.byHarness');
    expect(bridged).toBeDefined();
    expect(bridged?.args).toBeUndefined();
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

  // ── Audit P-066/P-067: dedupe key hashes data; stop() drains ──────────────

  it('data-bearing notifies dedupe by content; a new row set passes (hashed key)', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 1000,
    });
    await bus.subscribe(() => {});

    await bus.notifyInvalidate('q.rows', { k: 1 }, [{ a: 1 }]);
    await bus.notifyInvalidate('q.rows', { k: 1 }, [{ a: 1 }]); // same data → suppressed
    expect(lb.delivered).toHaveLength(1);

    await bus.notifyInvalidate('q.rows', { k: 1 }, [{ a: 2 }]); // NEW data → through
    expect(lb.delivered).toHaveLength(2);

    // data-bearing and pure-invalidate forms are distinct keys
    await bus.notifyInvalidate('q.rows', { k: 1 });
    expect(lb.delivered).toHaveLength(3);
  });

  // ── WI-840: bridge()-synthesized targets go through the SAME source-side
  // dedupe as explicit notifyInvalidate() calls, instead of fanning out
  // unthrottled on every single row-level trigger event. ─────────────────

  it('bridged full-bust targets dedupe within the window, like an explicit notifyInvalidate', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      // Mirrors a hot table (e.g. harness_plans) bridged to a full-bust list query.
      bridge: (name) => (name === 'harness_shared.harness_plans.changed' ? ['plans.list'] : []),
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed', args: { id: 'p1' } }));
    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed', args: { id: 'p2' } })); // different row, same bridge target
    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed', args: { id: 'p3' } }));
    // Every raw row-changed event still delivers (unthrottled)...
    expect(events.filter((e) => e.name === 'harness_shared.harness_plans.changed')).toHaveLength(3);
    // ...but the bridged full-bust target only fanned out ONCE inside the window.
    expect(events.filter((e) => e.name === 'plans.list')).toHaveLength(1);

    clock.t += 1001; // past the window
    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed', args: { id: 'p4' } }));
    expect(events.filter((e) => e.name === 'plans.list')).toHaveLength(2);
  });

  it('a hot table bridged to several query names throttles each target independently, not cross-suppressed', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name) =>
        name === 'harness_shared.harness_plans.changed'
          ? ['plans.list', 'plans.attention', 'plans.items']
          : [],
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed' }));
    lb.deliver(JSON.stringify({ name: 'harness_shared.harness_plans.changed' }));
    // All three distinct bridged names get through once each — the dedupe key
    // includes the target name, so one target's throttling never suppresses
    // a sibling target derived from the same raw event.
    expect(events.filter((e) => e.name === 'plans.list')).toHaveLength(1);
    expect(events.filter((e) => e.name === 'plans.attention')).toHaveLength(1);
    expect(events.filter((e) => e.name === 'plans.items')).toHaveLength(1);
  });

  // ── WI-37446: the mirror of the test above. That one proves one SOURCE's
  // several TARGETS don't cross-suppress; this proves several SOURCES sharing
  // ONE target don't either. Without the source in the key, the chattiest
  // source holds the shared window and silently swallows every other source's
  // events — measured live as the mode pill rendering a stale contract for 90s
  // because coord_presence (~1999 writes/10min) monopolised advRoster.list's
  // window against agent_modes' rare, meaningful writes. ────────────────────

  it('several source tables bridged to the SAME target are not cross-suppressed', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 90_000, // the real production default
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name) =>
        name === 'harness_shared.coord_presence.changed' ||
        name === 'harness_shared.agent_modes.changed'
          ? ['advRoster.list']
          : [],
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    // A chatty source holds the window open: 50 presence writes, ONE fanout.
    for (let i = 0; i < 50; i++) {
      clock.t += 10;
      lb.deliver(
        JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: `p${i}` } }),
      );
    }
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(1);

    // The rare, meaningful write from a DIFFERENT source gets through at once,
    // deep inside the window presence is still holding. This is the assertion
    // that fails without the source in the dedupe key.
    lb.deliver(
      JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'agent-1' } }),
    );
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(2);

    // ...and that source is itself still throttled: a second mode write inside
    // the window does NOT fan out again, so WI-840's cap holds PER SOURCE and
    // the per-name bound stays (distinct sources), never (write rate).
    clock.t += 10;
    lb.deliver(
      JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'agent-2' } }),
    );
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(2);
  });

  it('shortens one source/query bridge window without weakening a hot source guard', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 90_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name) =>
        name === 'harness_shared.coord_presence.changed' ||
        name === 'harness_shared.agent_modes.changed'
          ? ['advRoster.list']
          : [],
      // The target is shared by a hot heartbeat source and a low-volume
      // control-plane source. The callback's source argument lets the latter
      // use a short window without turning the former into a fan-out storm.
      bridgedDedupeWindowMs: (queryName, sourceName) =>
        queryName === 'advRoster.list' && sourceName === 'harness_shared.agent_modes.changed'
          ? 1_000
          : undefined,
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    // Hot coord_presence remains on the production 90s guard.
    lb.deliver(JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: 'p1' } }));
    clock.t += 10;
    lb.deliver(JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: 'p2' } }));
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(1);

    // Low-volume mode writes get through once their short window expires,
    // while an immediate repeat is still coalesced.
    lb.deliver(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm1' } }));
    clock.t += 500;
    lb.deliver(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm2' } }));
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(2);

    clock.t += 501;
    lb.deliver(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm3' } }));
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(3);

    // The hot source is still throttled even though the low-volume source has
    // its own override for the same query name.
    clock.t += 1;
    lb.deliver(JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: 'p3' } }));
    expect(events.filter((e) => e.name === 'advRoster.list')).toHaveLength(3);
  });

  it('emits the latest bridged scoped target on a bounded trailing edge and replays it by id', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 90_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name, args) =>
        name === 'harness_shared.widget.changed'
          ? [{ name: 'widget.byId', args: { id: String(args?.id ?? '') } }]
          : [],
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    // The first write is leading-edge immediate.
    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed', args: { id: 'row', version: 1 } }));
    expect(events.filter((e) => e.name === 'widget.byId').map((e) => e.args)).toEqual([{ id: 'row' }]);

    // A newer write inside the historical 90s floor replaces the pending
    // payload; it does not create a second immediate fan-out.
    clock.t = 1100;
    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed', args: { id: 'row', version: 2 } }));
    expect(events.filter((e) => e.name === 'widget.byId')).toHaveLength(1);
    expect(timers.pending).toBe(1);

    // The timer is anchored at the first suppressed write (1100), so the
    // latest state is delivered at 3100, well within the two-second bound.
    clock.t = 3099;
    timers.fireAll();
    expect(events.filter((e) => e.name === 'widget.byId')).toHaveLength(1);
    clock.t = 3100;
    timers.fireAll();
    const trailing = events.filter((e) => e.name === 'widget.byId')[1];
    expect(trailing).toMatchObject({ args: { id: 'row' }, ts: 1100 });
    expect(trailing.id).toBeGreaterThan(events[0].id);
    expect(bus.backfillSince(trailing.id - 1)).toContainEqual(trailing);
    expect(timers.pending).toBe(0);

    await bus.stop();
  });

  it('keeps source-aware trailing windows independent during a sustained burst', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 90_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name) =>
        name === 'harness_shared.hot.changed' || name === 'harness_shared.rare.changed'
          ? ['shared.list']
          : [],
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    // Hot source: leading event, then a sustained stream. The latest hot
    // source write must be the one emitted by the trailing flush.
    lb.deliver(JSON.stringify({ name: 'harness_shared.hot.changed', args: { n: 0 } }));
    clock.t = 1100;
    lb.deliver(JSON.stringify({ name: 'harness_shared.hot.changed', args: { n: 1 } }));
    clock.t = 1600;
    lb.deliver(JSON.stringify({ name: 'harness_shared.hot.changed', args: { n: 2 } }));
    clock.t = 2100;
    lb.deliver(JSON.stringify({ name: 'harness_shared.hot.changed', args: { n: 3 } }));

    // Rare source has its own source-keyed leading edge, despite the hot
    // source still holding its floor.
    clock.t = 2200;
    lb.deliver(JSON.stringify({ name: 'harness_shared.rare.changed', args: { n: 9 } }));
    expect(events.filter((e) => e.name === 'shared.list')).toHaveLength(2);

    // Hot trailing timer was due at 3100 (first suppressed event at 1100).
    clock.t = 3100;
    timers.fireAll();
    const lists = events.filter((e) => e.name === 'shared.list');
    expect(lists).toHaveLength(3);
    expect(lists[2]).toMatchObject({ ts: 2100 });
    expect(timers.pending).toBe(0);

    await bus.stop();
  });

  it('prunes a delayed trailing event even when newer raw events already occupy the ring', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      historyWindowMs: 1_000,
      dedupeWindowMs: 90_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name) => (name === 'harness_shared.widget.changed' ? ['widget.list'] : []),
    });
    await bus.subscribe(() => {});

    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed' })); // leading bridge at 1000
    clock.t = 1100;
    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed' })); // pending bridge
    clock.t = 2201;
    lb.deliver(JSON.stringify({ name: 'unrelated.changed' })); // newer ring entry
    clock.t = 3100;
    timers.fireAll(); // delayed bridge has source ts=1100, now outside retention

    expect(bus.backfillSince(0).map((event) => event.name)).toEqual(['unrelated.changed']);
    await bus.stop();
  });

  it('bridged SCOPED targets with different args are not cross-suppressed', async () => {
    const clock = { t: 1000 };
    const lb = makeLoopback();
    const timers = makeTimerHarness();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      bridge: (name, args) => {
        const id = (args as { id?: unknown } | undefined)?.id;
        return typeof id === 'string' && name === 'harness_shared.widget.changed'
          ? [{ name: 'widget.byId', args: { id } }]
          : [];
      },
    });
    const events: SyncEvent[] = [];
    await bus.subscribe((e) => events.push(e));

    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed', args: { id: 'a' } }));
    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed', args: { id: 'b' } }));
    lb.deliver(JSON.stringify({ name: 'harness_shared.widget.changed', args: { id: 'a' } })); // repeat of 'a' — suppressed
    const scoped = events.filter((e) => e.name === 'widget.byId');
    expect(scoped.map((e) => e.args)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('stop() drains in-flight notifies before stopping the listen source', async () => {
    let releaseNotify!: () => void;
    const gate = new Promise<void>((r) => (releaseNotify = r));
    const sent: string[] = [];
    let listenStopped = false;
    const listen: ListenSource = {
      start() {},
      stop() {
        listenStopped = true;
      },
    };
    const notify: NotifySink = {
      async notify(json) {
        await gate; // hold the publish in flight
        sent.push(json);
      },
    };
    const bus = createInvalidationBus({ listen, notify });
    await bus.start();

    const pending = bus.notifyInvalidate('q.slow', { k: 1 }); // not awaited
    let stopped = false;
    const stopping = bus.stop().then(() => {
      stopped = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false); // still draining
    expect(listenStopped).toBe(false);

    releaseNotify();
    await Promise.all([pending, stopping]);
    expect(stopped).toBe(true);
    expect(listenStopped).toBe(true);
    expect(sent).toHaveLength(1); // the in-flight publish completed, not discarded
  });
});
