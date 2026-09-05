/**
 * Client-side interest derivation and the cross-tab union.
 *
 * The union is the part worth testing hardest. It is a CORRECTNESS
 * requirement, not an optimisation (plan D-003c): tabs share ONE socket via
 * createCrossTabControlStream, each tab has its own queryClient, so a
 * declaration built from the owner tab's cache alone starves every follower.
 * That bug is invisible in the single-webview desktop case — where this would
 * most likely be tested by hand — so it has to be pinned here instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  createInterestTracker,
  observedQueryNames,
  type InterestBroadcastChannel,
} from './query-interest';

/** Channels sharing a name deliver to each other, like BroadcastChannel.
 * Delivery is synchronous here so assertions stay deterministic. */
const buses = new Map<string, Set<FakeChannel>>();

class FakeChannel implements InterestBroadcastChannel {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public readonly name: string) {
    let peers = buses.get(name);
    if (!peers) {
      peers = new Set();
      buses.set(name, peers);
    }
    peers.add(this);
  }
  postMessage(data: unknown): void {
    for (const peer of buses.get(this.name) ?? []) {
      if (peer === this) continue;
      peer.onmessage?.({ data: JSON.parse(JSON.stringify(data)) });
    }
  }
  close(): void {
    buses.get(this.name)?.delete(this);
  }
}

/** Manual timer control, so the debounce is asserted rather than waited on. */
function makeScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    scheduler: {
      setTimeout: (fn: () => void) => {
        const id = next++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    flush: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    pending: () => timers.size,
  };
}

function clientWith(...names: string[]): QueryClient {
  const qc = new QueryClient();
  for (const n of names) qc.setQueryData(['sync', n, {}], []);
  return qc;
}

beforeEach(() => buses.clear());

describe('observedQueryNames', () => {
  it('reads sync query names straight off the cache', () => {
    expect(observedQueryNames(clientWith('work.items', 'plans.items'))).toEqual(
      new Set(['work.items', 'plans.items']),
    );
  });

  it('collapses the same name subscribed under different args', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'work.items', {}], []);
    qc.setQueryData(['sync', 'work.items', { state: 'open' }], []);
    expect(observedQueryNames(qc)).toEqual(new Set(['work.items']));
  });

  it('ignores cache entries belonging to other consumers', () => {
    const qc = clientWith('work.items');
    qc.setQueryData(['something-else', 'nope'], []);
    qc.setQueryData(['sync'], []);
    expect(observedQueryNames(qc)).toEqual(new Set(['work.items']));
  });

  it('skips a non-string name rather than coercing it into a declared name', () => {
    // A coerced "[object Object]" would become a declared name that filters
    // real events away — a silent-staleness source, so it must be dropped.
    const qc = clientWith('work.items');
    qc.setQueryData(['sync', { bad: true }, {}], []);
    qc.setQueryData(['sync', 42, {}], []);
    expect(observedQueryNames(qc)).toEqual(new Set(['work.items']));
  });
});

describe('growth reporting', () => {
  it('reports the initial set once the debounce elapses', () => {
    const { scheduler, flush } = makeScheduler();
    const onGrow = vi.fn();
    createInterestTracker({
      queryClient: clientWith('a'),
      scope: 's',
      onGrow,
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    expect(onGrow).not.toHaveBeenCalled();
    flush();
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(onGrow.mock.calls[0]?.[0]).toEqual(new Set(['a']));
  });

  it('coalesces a burst of mounts into ONE reconnect', () => {
    // A navigation mounting a dozen queries must not thrash the connection.
    const { scheduler, flush } = makeScheduler();
    const onGrow = vi.fn();
    const qc = clientWith('a');
    const tracker = createInterestTracker({
      queryClient: qc,
      scope: 's',
      onGrow,
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    for (const n of ['b', 'c', 'd', 'e']) {
      qc.setQueryData(['sync', n, {}], []);
      tracker.refresh();
    }
    flush();
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(onGrow.mock.calls[0]?.[0]).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('does NOT report when the set only shrinks — the declaration is grow-only', () => {
    // D-003b: a name that has ever been observed keeps receiving events after
    // its component unmounts. That buys immunity to unmount/remount races.
    const { scheduler, flush } = makeScheduler();
    const onGrow = vi.fn();
    const qc = clientWith('a', 'b');
    const tracker = createInterestTracker({
      queryClient: qc,
      scope: 's',
      onGrow,
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();
    expect(onGrow).toHaveBeenCalledTimes(1);

    qc.removeQueries({ queryKey: ['sync', 'b', {}] });
    tracker.refresh();
    flush();
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(tracker.current()).toEqual(new Set(['a', 'b']));
  });

  it('does not fire a pending report after close()', () => {
    const { scheduler, flush, pending } = makeScheduler();
    const onGrow = vi.fn();
    const tracker = createInterestTracker({
      queryClient: clientWith('a'),
      scope: 's',
      onGrow,
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    expect(pending()).toBe(1);
    tracker.close();
    flush();
    expect(onGrow).not.toHaveBeenCalled();
  });
});

describe('cross-tab union (D-003c — the follower-starvation guard)', () => {
  it("includes a peer tab's names, so a filter built from this union cannot starve it", () => {
    const { scheduler, flush } = makeScheduler();
    const ownerGrow = vi.fn();

    const owner = createInterestTracker({
      queryClient: clientWith('owner.query'),
      scope: 'shared',
      onGrow: ownerGrow,
      tabId: 'owner',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    createInterestTracker({
      queryClient: clientWith('follower.query'),
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'follower',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });

    flush();
    // The whole point: the owner declares BOTH, not just its own cache.
    expect(owner.current()).toEqual(new Set(['owner.query', 'follower.query']));
    expect(ownerGrow).toHaveBeenCalled();
    expect(ownerGrow.mock.calls.at(-1)?.[0]).toContain('follower.query');
  });

  it('a LATE-joining tab learns the names already mounted in its peers', () => {
    // Without the join ask, a tab opened second would hold a union missing
    // every already-mounted query until a peer happened to change.
    const { scheduler, flush } = makeScheduler();
    createInterestTracker({
      queryClient: clientWith('early.query'),
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'early',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();

    const late = createInterestTracker({
      queryClient: clientWith('late.query'),
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'late',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();
    expect(late.current()).toEqual(new Set(['early.query', 'late.query']));
  });

  it("a peer's later growth reaches the owner", () => {
    const { scheduler, flush } = makeScheduler();
    const ownerGrow = vi.fn();
    const owner = createInterestTracker({
      queryClient: clientWith('owner.query'),
      scope: 'shared',
      onGrow: ownerGrow,
      tabId: 'owner',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    const followerQc = clientWith('follower.query');
    const follower = createInterestTracker({
      queryClient: followerQc,
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'follower',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();

    followerQc.setQueryData(['sync', 'follower.late', {}], []);
    follower.refresh();
    flush();
    expect(owner.current()).toContain('follower.late');
  });

  it('does not mix tabs on a DIFFERENT scope', () => {
    const { scheduler, flush } = makeScheduler();
    const a = createInterestTracker({
      queryClient: clientWith('a.query'),
      scope: 'scope-a',
      onGrow: vi.fn(),
      tabId: 'a',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    createInterestTracker({
      queryClient: clientWith('b.query'),
      scope: 'scope-b',
      onGrow: vi.fn(),
      tabId: 'b',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();
    expect(a.current()).toEqual(new Set(['a.query']));
  });

  it('keeps a departed tab\'s names rather than risking starving a live view', () => {
    const { scheduler, flush } = makeScheduler();
    const owner = createInterestTracker({
      queryClient: clientWith('owner.query'),
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'owner',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    const follower = createInterestTracker({
      queryClient: clientWith('follower.query'),
      scope: 'shared',
      onGrow: vi.fn(),
      tabId: 'follower',
      scheduler,
      broadcastChannelCtor: FakeChannel,
    });
    flush();
    follower.close();
    flush();
    // A superset only ever costs traffic; dropping the names could starve a
    // view still open in a tab we merely stopped hearing from.
    expect(owner.current()).toContain('follower.query');
  });
});

describe('no coordination surface', () => {
  it('falls back to a self-only declaration, which is correct for a standalone tab', () => {
    // With no BroadcastChannel the control stream is standalone too: this tab
    // owns its OWN socket, so its own cache is the whole truth.
    //
    // The global is stubbed away rather than left to the runtime: Node ships a
    // real BroadcastChannel, so without this the test would quietly exercise
    // the coordinated path while claiming to cover the uncoordinated one.
    vi.stubGlobal('BroadcastChannel', undefined);
    try {
      const { scheduler, flush } = makeScheduler();
      const onGrow = vi.fn();
      const tracker = createInterestTracker({
        queryClient: clientWith('mine'),
        scope: 's',
        onGrow,
        scheduler,
      });
      flush();
      expect(tracker.current()).toEqual(new Set(['mine']));
      expect(onGrow).toHaveBeenCalledTimes(1);
      tracker.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps tracking locally when the channel constructor throws', () => {
    const { scheduler, flush } = makeScheduler();
    const onGrow = vi.fn();
    const Boom = function Boom() {
      throw new Error('no channel here');
    } as unknown as new (name: string) => InterestBroadcastChannel;
    const tracker = createInterestTracker({
      queryClient: clientWith('mine'),
      scope: 's',
      onGrow,
      scheduler,
      broadcastChannelCtor: Boom,
    });
    flush();
    expect(tracker.current()).toEqual(new Set(['mine']));
  });
});
