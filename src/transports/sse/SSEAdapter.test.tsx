/**
 * @vitest-environment jsdom
 *
 * EI-278 pin: the SSE transport's refetch interval is a DRIFT-REPAIR tick,
 * not a freshness source. When it shared the polling transport's 5-10s
 * cadence, every subscribed query REST-refetched on that cadence ON TOP of
 * SSE pushes — measured ~3.2 fetches/s sustained on the operator /adv page
 * (162k fetches over 14h), the dominant workload behind a 16GB WebKitGTK
 * webview OOM kill. Freshness under SSE comes from invalidate-driven
 * refetches; the interval only repairs pushes lost to an SSE blip or a
 * table missing its invalidation bridge entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { SSE_DRIFT_REPAIR_DEFAULT_MS, SSEAdapter } from './SSEAdapter';
import { getQueryClient } from '../polling/queryClient';

/**
 * Capture the options the adapter hands the cross-tab control stream. Only
 * `createCrossTabControlStream` is imported from @papercusp/sse here, and only
 * `.close()` is called on what it returns, so this is the whole surface.
 */
const controlStreamOpts: Array<Record<string, unknown>> = [];
/** URLs pushed via setUrl after open — the growth-driven re-declaration path. */
const setUrlCalls: string[] = [];
// `...actual` keeps the REAL defaultControlChannelKey, because the channel-key
// assertions below are about that function's actual behaviour — a stubbed one
// would let the regression they exist to catch sail straight through.
vi.mock('@papercusp/sse', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createCrossTabControlStream: (opts: Record<string, unknown>) => {
    controlStreamOpts.push(opts);
    return {
      close: () => {},
      setUrl: (next: string) => setUrlCalls.push(next),
      reconnect: () => {},
      // The adapter only reconnects from the tab holding the physical socket.
      isOwner: true,
    };
  },
}));

/**
 * Pins the invalidation-matching contract this transport depends on, because it is
 * counter-intuitive enough that WI-6796 got it backwards for a while and nearly
 * "fixed" a bug that does not exist.
 *
 * The subtlety: `useSyncQuery({ queryName })` with NO args does NOT key on
 * `undefined` — `createUsePollingQuery` defaults `args = {}` (usePollingQuery.ts),
 * so the key is `['sync', name, {}]`. That is exactly what a producer's
 * `notifySyncInvalidate(name, {})` targets, so the common no-args pairing matches
 * and there is nothing to repair. What genuinely does NOT match is a NON-EMPTY
 * args-scoped invalidate against a no-args subscription — the documented gotcha in
 * agent-insights/adding-a-sync-query.
 */
describe('invalidate key matching (the WI-6796 contract pin)', () => {
  it('an args-{} invalidate DOES reach a no-args subscription — they share the {} key', () => {
    const qc = new QueryClient();
    // How createUsePollingQuery keys `useSyncQuery({ queryName: 'accounts.pool' })`.
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.invalidateQueries({ queryKey: ['sync', 'accounts.pool', {}] });
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(true);
  });

  it('a NON-EMPTY args-scoped invalidate does NOT reach a no-args subscription (the real gotcha)', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.invalidateQueries({ queryKey: ['sync', 'accounts.pool', { workspaceId: 'w' }] });
    // Emit name-only (or the SAME args the consumer subscribes with) for these.
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(false);
  });

  it('the name-only predicate branch reaches every arg variant, including {}', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync', 'accounts.pool', {}], [{ id: 'a' }]);
    qc.setQueryData(['sync', 'accounts.pool', { workspaceId: 'w' }], [{ id: 'b' }]);
    qc.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'sync' && q.queryKey[1] === 'accounts.pool',
    });
    expect(qc.getQueryState(['sync', 'accounts.pool', {}])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['sync', 'accounts.pool', { workspaceId: 'w' }])?.isInvalidated).toBe(true);
  });
});

/**
 * WI-2141694. The control stream holds a STANDING per-origin socket. Several
 * same-origin documents (the portal's steering + chat panes, plus the HUD and
 * launched-sessions iframes) each hold their own, and at the browser's ~6
 * connection cap those standing streams starve the short REST fetches a
 * newly-framed document needs to boot — the readyState=interactive hang.
 *
 * stream-registry ships the yield mechanism for exactly this, but until this
 * opt-in it reached ZERO of the contended streams: `yieldOnContention: true`
 * appeared only in apps/operator (FeaturesAdmin, use-state-snapshots), never
 * on the path the panes actually use. Deleting the option from SSEAdapter
 * silently restores that gap, so it is pinned here.
 */
describe('control stream yields under per-origin contention (WI-2141694)', () => {
  const RealEventSource = (globalThis as Record<string, unknown>).EventSource;

  beforeEach(() => {
    controlStreamOpts.length = 0;
    // jsdom ships no EventSource, and the adapter's effect early-returns on
    // `typeof EventSource === 'undefined'` — without this stub the effect
    // never runs and every assertion below would pass vacuously.
    (globalThis as Record<string, unknown>).EventSource = class {};
  });

  afterEach(() => {
    cleanup();
    if (RealEventSource === undefined) delete (globalThis as Record<string, unknown>).EventSource;
    else (globalThis as Record<string, unknown>).EventSource = RealEventSource;
  });

  it('opts in, so the registry can reclaim its socket for a starved document', () => {
    render(<SSEAdapter>{null}</SSEAdapter>);

    // CONTROL: proves the effect ran and the capture works. Without it, a
    // silently-skipped effect (the EventSource guard above) leaves
    // controlStreamOpts empty and the real assertion cannot fail honestly.
    expect(controlStreamOpts.length).toBeGreaterThan(0);
    const opts = controlStreamOpts[0]!;
    // CALIBRATION: an option we did not add, pinned in the same capture, so a
    // mock that returned a bare {} could not masquerade as a pass.
    expect(opts.zombieTimeoutMs).toBe(30_000);

    expect(opts.yieldOnContention).toBe(true);
  });

  it('leaves priority at the default so the OLDEST stream yields first', () => {
    render(<SSEAdapter>{null}</SSEAdapter>);

    expect(controlStreamOpts.length).toBeGreaterThan(0);
    // The always-present panes are the oldest same-origin streams, so the
    // registry's oldest-first tie-break makes them the ones that step aside
    // for a just-opened iframe. Setting a priority here would defeat that.
    expect(controlStreamOpts[0]!.streamPriority).toBeUndefined();
  });
});

/**
 * Per-client invalidation filtering, adapter half. The server drops any event
 * whose query name is not in this declaration, so what the adapter puts on the
 * URL at connect decides what this browser can ever receive. The two failure
 * directions are NOT symmetric: declaring too much only wastes bandwidth,
 * while declaring too little silently starves a view — so the empty-cache case
 * must emit NO declaration rather than an empty one.
 */
describe('interest declaration on the SSE URL', () => {
  const RealEventSource = (globalThis as Record<string, unknown>).EventSource;

  beforeEach(() => {
    controlStreamOpts.length = 0;
    setUrlCalls.length = 0;
    // Same reason as the block above: without an EventSource the adapter's
    // effect early-returns and every assertion here would pass vacuously.
    (globalThis as Record<string, unknown>).EventSource = class {};
    getQueryClient().clear();
  });

  afterEach(() => {
    cleanup();
    getQueryClient().clear();
    if (RealEventSource === undefined) delete (globalThis as Record<string, unknown>).EventSource;
    else (globalThis as Record<string, unknown>).EventSource = RealEventSource;
  });

  it('declares the query names already in the cache at connect', () => {
    getQueryClient().setQueryData(['sync', 'work.items', {}], []);
    getQueryClient().setQueryData(['sync', 'plans.items', {}], []);

    render(<SSEAdapter>{null}</SSEAdapter>);

    // CONTROL: proves the effect ran and the capture works.
    expect(controlStreamOpts.length).toBeGreaterThan(0);
    const url = String(controlStreamOpts[0]!.url);
    // CALIBRATION: an option we did not add, so a bare-{} mock cannot pass.
    expect(controlStreamOpts[0]!.zombieTimeoutMs).toBe(30_000);

    const declared = new URL(url, 'http://localhost').searchParams.get('queries');
    expect(declared).not.toBeNull();
    expect(new Set(declared!.split(','))).toEqual(new Set(['work.items', 'plans.items']));
  });

  it('emits NO declaration when nothing is observed yet, rather than an empty one', () => {
    // An empty declaration read as an empty allow-list would starve the client
    // completely, and the symptom (a UI that never updates) looks like a dead
    // connection rather than a filter bug. No param = today's full fan-out.
    render(<SSEAdapter>{null}</SSEAdapter>);

    expect(controlStreamOpts.length).toBeGreaterThan(0);
    const url = String(controlStreamOpts[0]!.url);
    expect(new URL(url, 'http://localhost').searchParams.get('queries')).toBeNull();
  });

  it('keys the cross-tab channel WITHOUT the declaration, so tabs still share ONE socket', () => {
    // The regression this catches is silent and expensive.
    // defaultControlChannelKey folds every non-bearer query param into the
    // channel name, and `queries` is not bearer-like — so left to the default,
    // two tabs observing different queries would elect themselves SEPARATE
    // owners and each open a standing socket, multiplying exactly the
    // per-origin sockets WI-2141694 conserves. Nothing else in the suite
    // notices: every assertion still passes, there are just more connections.
    getQueryClient().setQueryData(['sync', 'a.query', {}], []);
    render(<SSEAdapter>{null}</SSEAdapter>);
    const first = controlStreamOpts.at(-1)!;
    const firstUrl = String(first.url);

    // CONTROL: the declaration really is on the wire, so nothing below passes
    // merely because the feature failed to engage.
    expect(firstUrl).toContain('queries=');

    // The key must POSITIVELY equal the one the undeclared URL produces.
    // Asserting only "does not contain queries" would be satisfied by the key
    // being absent altogether — a mutation probe caught exactly that: dropping
    // `channelKey` left it undefined, and every negative assertion passed.
    const undeclared = firstUrl.replace(/[?&]queries=[^&]*/, '');
    expect(typeof first.channelKey).toBe('string');
    expect(first.channelKey).toBe(defaultControlChannelKey(undeclared));

    // CALIBRATION: the default keying genuinely DIFFERS here, so the equality
    // above is a real constraint rather than a tautology.
    expect(defaultControlChannelKey(firstUrl)).not.toBe(first.channelKey);

    cleanup();
    getQueryClient().clear();
    getQueryClient().setQueryData(['sync', 'b.query', {}], []);
    render(<SSEAdapter>{null}</SSEAdapter>);
    const second = controlStreamOpts.at(-1)!;

    // CONTROL: the two mounts genuinely declared DIFFERENT sets...
    expect(String(second.url)).not.toBe(firstUrl);
    // ...yet land on the same channel, so they still share one owner.
    expect(typeof second.channelKey).toBe('string');
    expect(second.channelKey).toBe(first.channelKey);
  });

  it('keeps the token param alongside the declaration', () => {
    // Regression shape: appending the declaration with the wrong separator
    // would swallow the token and 401 the stream.
    getQueryClient().setQueryData(['sync', 'work.items', {}], []);

    render(<SSEAdapter tokenQueryParam="tok-123">{null}</SSEAdapter>);

    expect(controlStreamOpts.length).toBeGreaterThan(0);
    const parsed = new URL(String(controlStreamOpts[0]!.url), 'http://localhost');
    expect(parsed.searchParams.get('token')).toBe('tok-123');
    expect(parsed.searchParams.get('queries')).toBe('work.items');
  });
});

describe('SSE drift-repair interval (EI-278)', () => {
  it('defaults to minutes, never a seconds-scale poll cadence', () => {
    // ≥60s = the floor below which the "drift repair" tick degenerates back
    // into a poll storm across ~30+ live subscriptions. If you are lowering
    // this to "make a panel update faster", the correct fix is an
    // invalidation producer for its table (notifySyncInvalidate at the write
    // site, or a bridge entry in table-to-query-names.ts) — not a faster
    // global tick.
    expect(SSE_DRIFT_REPAIR_DEFAULT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('stays bounded so an unbridged table is never stale for more than a few minutes', () => {
    expect(SSE_DRIFT_REPAIR_DEFAULT_MS).toBeLessThanOrEqual(300_000);
  });
});
