/** @vitest-environment jsdom */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncQueryResult } from './types';

/**
 * These tests are about ONE question: does a call site that names a query the
 * Zero registry deliberately has NO leaf for still read successfully when the
 * provider has settled on WEBSOCKETS?
 *
 * That is the whole defect behind WI-39763 / WI-39772. `useSyncQuery` hands the
 * name to the Zero client, which resolves it against the registry and throws
 * `Query '<name>' is not a function`. The polling and SSE adapters forward the
 * name straight to REST without consulting the registry, so eight call sites
 * looked healthy on those rungs and detonated the moment a client reached
 * WebSockets. `useRestSyncQuery` is the fix: always the REST/batch path, on
 * every transport.
 *
 * Two invariants are locked here, and they fail in DIFFERENT ways:
 *
 *  1. The name never reaches the Zero REGISTRY. On the WebSocket rung that
 *     means not calling `ctx.useDataImpl` at all — it is
 *     `createUseWebSocketQuery`, which resolves the name in a `useMemo` that
 *     runs BEFORE it consults `enabled`, so even a disabled call throws. On
 *     every other rung `useDataImpl` IS the REST path (both PollingAdapter and
 *     SSEAdapter build it with `createUsePollingQuery`), so the hook goes
 *     THROUGH it there — that is the seam consumers stub, and bypassing it
 *     silently disabled those stubs (36 web tests, WI-39869).
 *  2. It does not throw `No QueryClient set`. `useRestQuery` calls
 *     `useQuery` UNCONDITIONALLY (transports/polling/usePollingQuery.ts), so it
 *     needs a `QueryClientProvider` above it. The polling/SSE adapters always
 *     mounted one; the WebSocket adapter did NOT until WI-39772 added it. Drop
 *     that provider and every test below dies at render, which is exactly the
 *     signal wanted — the crash is otherwise a mystifying react-query error far
 *     from its cause.
 */

// ── Fake Zero ───────────────────────────────────────────────────────────────
// The adapter constructs a Zero client on mount. Nothing here drives connection
// states (WebSocketAdapter.test.tsx owns that); this only has to be inert and
// subscribable so the adapter mounts and publishes its context.
const H = vi.hoisted(() => {
  class FakeZero {
    static instances: FakeZero[] = [];
    mutate = {};
    connection = {
      state: {
        current: { name: 'connecting' as const },
        subscribe: () => () => {},
      },
      connect: async () => {},
    };
    constructor(public opts: unknown) {
      FakeZero.instances.push(this);
    }
  }

  /**
   * One spy for every (endpoint, token, principal) key the fetcher is asked
   * for, plus a flat log of the reads that actually went out. `getBatchFetcher`
   * is memoized in the real module and called on every render, so the test
   * asserts on the RECORDED READS rather than on call counts.
   */
  const batchReads: Array<{ endpoint: string; queryName: string; args: unknown }> = [];
  const getBatchFetcher = vi.fn(
    (endpoint: string, _token: string | undefined, _principal: string | null) =>
      async (queryName: string, args: unknown) => {
        batchReads.push({ endpoint, queryName, args });
        return { rows: [{ id: `${queryName}-row` }], version: '1' };
      },
  );

  return { FakeZero, getBatchFetcher, batchReads };
});

const FakeZero = H.FakeZero;

vi.mock('@rocicorp/zero', () => ({ Zero: H.FakeZero }));

vi.mock('@rocicorp/zero/react', async () => {
  const { createElement: h } = await import('react');
  return {
    ZeroProvider: ({ children }: { children: ReactNode }) => h('div', null, children),
  };
});

// Replace ONLY the network edge. Everything above it — useRestQuery, the
// react-query cache, the adapter's QueryClientProvider — stays real, because
// the wiring between them is precisely what is under test.
vi.mock('./transports/polling/batch-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transports/polling/batch-fetcher')>()),
  getBatchFetcher: H.getBatchFetcher,
}));

// Stub only clearPollingCache (a mount side effect nothing here asserts on);
// spread the real module so `getQueryClient` — the adapter's QueryClientProvider
// client, the thing invariant 2 is about — stays real.
vi.mock('./transports/polling/queryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transports/polling/queryClient')>()),
  clearPollingCache: () => {},
}));

import { SyncContext } from './SyncContext';
import WebSocketAdapter from './transports/websocket/WebSocketAdapter';
import { useRestSyncQuery } from './useRestSyncQuery';

// React 19 only honours `act()` when the environment opts in explicitly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** Last result the consumer rendered — asserted after the fetch settles. */
let seen: SyncQueryResult<{ id: string }> | null = null;

function Consumer({ queryName }: { queryName: string }) {
  seen = useRestSyncQuery<{ id: string }>({ queryName, args: { a: 1 } });
  return createElement('div', { 'data-testid': 'consumer' }, String(seen.data?.length ?? 0));
}

function mount(children: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(children);
  });
}

/** Mount a consumer INSIDE a WebSocket provider — the transport that breaks. */
function mountUnderWebSockets(queryName: string, userId: string) {
  mount(
    createElement(WebSocketAdapter, {
      userId,
      server: 'http://zero.test',
      schema: {},
      queries: {},
      kvStore: 'mem' as const,
      onTransportError: () => {},
      children: createElement(Consumer, { queryName }),
    }),
  );
}

/**
 * Let react-query's queryFn microtasks and the resulting re-render flush.
 * Several turns: the fetch settles in one, the observer notification and the
 * consumer's re-render land in later ones.
 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('useRestSyncQuery', () => {
  beforeEach(() => {
    seen = null;
    FakeZero.instances = [];
    H.batchReads.length = 0;
    H.getBatchFetcher.mockClear();
    // The adapter caches Zero instances on `window` keyed by
    // (userId|server|kvStore) and deliberately never evicts, so every test
    // gets a distinct userId AND a cleared cache.
    delete (window as unknown as { __zero_instance_cache__?: unknown }).__zero_instance_cache__;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. On WEBSOCKETS this name has no
   * registry leaf; `useSyncQuery` would throw `Query 'event.stats' is not a
   * function`. `useRestSyncQuery` must resolve it over REST instead.
   */
  it('reads over REST while the provider is on WEBSOCKETS', async () => {
    mountUnderWebSockets('event.stats', 'user-ws-rest');
    await settle();

    expect(H.batchReads).toEqual([
      { endpoint: 'http://zero.test/zero', queryName: 'event.stats', args: { a: 1 } },
    ]);
    expect(seen?.data).toEqual([{ id: 'event.stats-row' }]);
    expect(seen?.error).toBeNull();
  });

  /**
   * Reaching the REST path at all proves the QueryClientProvider the WebSocket
   * adapter gained in WI-39772 is still there: `useRestQuery` calls `useQuery`
   * unconditionally, so without it the mount above throws `No QueryClient set`.
   * Asserted explicitly so a future removal reads as THIS, not as an unrelated
   * react-query failure.
   */
  it('does not throw "No QueryClient set" under the WebSocket adapter', async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
    window.addEventListener('error', onError);
    try {
      mountUnderWebSockets('build.history', 'user-ws-provider');
      await settle();
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(errors.map(String).join('\n')).not.toMatch(/No QueryClient set/);
    expect(container.querySelector('[data-testid="consumer"]')?.textContent).toBe('1');
  });

  /**
   * `transport` describes how the DATA was resolved, not which provider is
   * mounted. A `useRestSyncQuery` read is the REST/batch path on every rung, so
   * it reports POLLING even under a WebSocket provider — call sites branching
   * on `transport` need that to stay honest.
   */
  it('reports POLLING as the resolving transport even on the WS provider', async () => {
    mountUnderWebSockets('event.pricingHistory', 'user-ws-transport');
    await settle();

    expect(seen?.transport).toBe('POLLING');
  });

  /**
   * No provider at all. Matching `useSyncQuery`, that must be an inert result
   * rather than a throw — and it must NOT fire a fetch at the placeholder URL.
   */
  it('is inert with no provider instead of throwing or fetching', async () => {
    mount(createElement(Consumer, { queryName: 'orders.byBuyer' }));
    await settle();

    expect(H.batchReads).toEqual([]);
    expect(seen?.data).toEqual([]);
    expect(seen?.error).toBeNull();
  });

  /**
   * THE PRODUCTION SHAPE OF THE SAME HAZARD, and the reason the QueryClient is
   * passed explicitly rather than taken from context.
   *
   * `PendingSyncAdapter` (SyncProvider.tsx) covers SSR and the WS-probe window
   * that precedes EVERY first page load. It publishes a SyncContext — so
   * `useSyncQuery` resolves to its inert `useDataImpl` — but mounts NO
   * `QueryClientProvider`, and it has no `restEndpoint`. A `useRestSyncQuery`
   * call site that read its client from context would therefore throw
   * `No QueryClient set` and take down the subtree during that window: strictly
   * worse than the WI-39772 defect it replaced, and invisible to every test
   * that mounts a real adapter.
   */
  it('degrades to an empty read in the probe window (SyncContext, no QueryClientProvider)', async () => {
    const pendingValue = {
      transport: 'POLLING' as const,
      principal: null,
      // Shape-matched to PendingSyncAdapter, FIELD FOR FIELD (SyncProvider.tsx
      // `emptyResult`). The abbreviated `{ data: [], loading: true }` this used
      // to carry was not that shape — it omits `error`, so it modelled a
      // provider that cannot exist and would have hidden a real `undefined`
      // leaking into `error` here.
      useDataImpl: () => ({
        data: [],
        loading: true,
        fetching: false,
        transport: 'POLLING' as const,
        invalidate: () => {},
        error: null,
      }) as never,
      prefetch: () => {},
    };
    mount(
      createElement(
        SyncContext.Provider,
        { value: pendingValue },
        createElement(Consumer, { queryName: 'event.stats' }),
      ),
    );
    await settle();

    expect(H.batchReads).toEqual([]);
    expect(seen?.data).toEqual([]);
    expect(seen?.error).toBeNull();
  });

  /**
   * THE SEAM. On SSE and polling the provider's `useDataImpl` IS this REST
   * path — both adapters build it with `createUsePollingQuery` — so reading
   * through it is the same request, and it is what every consumer stubs.
   *
   * Bypassing it is not a cosmetic difference: 12 call sites moved onto this
   * hook when D-025 demoted their queries, and because the hook went straight
   * to `useRestQuery` their tests' stubbed providers were silently ignored and
   * 36 assertions across 9 files began rendering the loading branch (WI-39869).
   * A stubbed provider that has no effect is the worst kind of failure — the
   * test still runs, it just stops testing anything the stub describes.
   */
  it('reads THROUGH the provider hook on SSE, so a stubbed provider is honoured', async () => {
    const useDataImpl = vi.fn(() => ({
      data: [{ id: 'from-the-provider' }],
      loading: false,
      fetching: false,
      transport: 'SSE' as const,
      invalidate: () => {},
      error: null,
    }));
    mount(
      createElement(
        SyncContext.Provider,
        {
          value: {
            transport: 'SSE' as const,
            principal: null,
            useDataImpl,
            prefetch: () => {},
            restEndpoint: 'http://zero.test/zero',
          } as never,
        },
        createElement(Consumer, { queryName: 'event.config' }),
      ),
    );
    await settle();

    expect(useDataImpl).toHaveBeenCalledWith(
      expect.objectContaining({ queryName: 'event.config', args: { a: 1 } }),
    );
    expect(seen?.data).toEqual([{ id: 'from-the-provider' }]);
    // The provider served it, so the hook must not ALSO fetch — a double read
    // would double every poll for these call sites.
    expect(H.batchReads).toEqual([]);
  });

  /**
   * THE EXCEPTION, and the one that must never be "simplified" away.
   *
   * On WEBSOCKETS `useDataImpl` is `createUseWebSocketQuery`, which resolves
   * the name against the Zero registry inside a `useMemo` evaluated BEFORE it
   * reads `enabled` (useWebSocketQuery.ts). So for a name the registry has no
   * leaf for, even a DISABLED call throws `Query '<name>' is not a function` —
   * which is WI-39763/WI-39772 exactly. Passing `enabled: false` does not save
   * it; only not calling it does.
   *
   * The assertion is deliberately on the CALL, not on the absence of a throw:
   * the fake registry here would not throw, so "it didn't crash" would pass
   * vacuously.
   */
  it('does NOT call the provider hook on WEBSOCKETS, where it would hit the registry', async () => {
    const useDataImpl = vi.fn(() => ({
      data: [{ id: 'registry-resolved' }],
      loading: false,
      fetching: false,
      transport: 'WEBSOCKETS' as const,
      invalidate: () => {},
      error: null,
    }));
    mount(
      createElement(
        SyncContext.Provider,
        {
          value: {
            transport: 'WEBSOCKETS' as const,
            principal: null,
            useDataImpl,
            prefetch: () => {},
            restEndpoint: 'http://zero.test/zero',
          } as never,
        },
        createElement(Consumer, { queryName: 'event.stats' }),
      ),
    );
    await settle();

    expect(useDataImpl).not.toHaveBeenCalled();
    // Positive control: the read really did happen, over REST. Without this an
    // assertion that the provider hook went uncalled would also pass if the
    // hook had simply stopped reading anything at all.
    expect(H.batchReads).toEqual([
      { endpoint: 'http://zero.test/zero', queryName: 'event.stats', args: { a: 1 } },
    ]);
    expect(seen?.data).toEqual([{ id: 'event.stats-row' }]);
  });
});
