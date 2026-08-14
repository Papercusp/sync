/** @vitest-environment jsdom */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncPrefetch, useSyncQuery } from './SyncContext';
import {
  DEMO_PRINCIPAL_HEADER,
  DEMO_PRINCIPAL_QUERY_PARAM,
  syncQueryKey,
} from './principal';
import { PollingAdapter } from './transports/polling/PollingAdapter';
import { clearPollingCache, getQueryClient } from './transports/polling/queryClient';
import { SSEAdapter } from './transports/sse/SSEAdapter';

type FakeListener = (event: { data: string; type: string; lastEventId?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<FakeListener>>();
  readyState = 0;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    const callback = typeof listener === 'function'
      ? listener as unknown as FakeListener
      : listener.handleEvent.bind(listener) as unknown as FakeListener;
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data = '') {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, type });
    }
  }

  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('Expected an EventSource instance');
    return source;
  }
}

let container: HTMLDivElement;
let root: Root | null;

async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Timed out waiting for sync assertion');
}

function QueryView() {
  const query = useSyncQuery<{ owner: string }>({
    queryName: 'identity.same-query',
    args: { page: 1 },
    pollIntervalMs: 60_000,
  });
  return <div>{query.data[0]?.owner ?? 'loading'}</div>;
}

function PrefetchOnMount() {
  const prefetch = useSyncPrefetch();
  useEffect(() => {
    prefetch({ queryName: 'identity.prefetch', args: { page: 2 } });
  }, [prefetch]);
  return null;
}

beforeEach(() => {
  clearPollingCache();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  clearPollingCache();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('demo-principal sync isolation', () => {
  it('partitions identical polling queries and never renders the previous principal as placeholder data', async () => {
    let resolveBob: (() => void) | undefined;
    const seenPrincipals: Array<string | null> = [];
    const seenBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const principal = new Headers(init?.headers).get(DEMO_PRINCIPAL_HEADER);
      seenPrincipals.push(principal);
      seenBodies.push(JSON.parse(String(init?.body)));
      if (principal === 'demo-bob') {
        await new Promise<void>((resolve) => { resolveBob = resolve; });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ rows: [{ owner: principal ?? 'public' }], version: '1' }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root?.render(
        <PollingAdapter userId="demo-alice" restEndpoint="http://sync.test/poll" pollIntervalMs={60_000}>
          <QueryView />
        </PollingAdapter>,
      );
    });
    await waitFor(() => expect(container.textContent).toBe('demo-alice'));

    await act(async () => {
      root?.render(
        <PollingAdapter userId="demo-bob" restEndpoint="http://sync.test/poll" pollIntervalMs={60_000}>
          <QueryView />
        </PollingAdapter>,
      );
    });
    await waitFor(() => expect(resolveBob).toBeTypeOf('function'));
    expect(container.textContent).toBe('loading');

    await act(async () => resolveBob?.());
    await waitFor(() => expect(container.textContent).toBe('demo-bob'));

    expect(seenPrincipals).toEqual(['demo-alice', 'demo-bob']);
    expect(seenBodies).toEqual([
      { queries: [{ name: 'identity.same-query', args: { page: 1 } }] },
      { queries: [{ name: 'identity.same-query', args: { page: 1 } }] },
    ]);
    expect(getQueryClient().getQueryData(syncQueryKey('demo-alice', 'identity.same-query', { page: 1 })))
      .toMatchObject({ rows: [{ owner: 'demo-alice' }] });
    expect(getQueryClient().getQueryData(syncQueryKey('demo-bob', 'identity.same-query', { page: 1 })))
      .toMatchObject({ rows: [{ owner: 'demo-bob' }] });
  });

  it('carries the principal through prefetch and keeps intentionally public queries compatible', async () => {
    const seenPrincipals: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenPrincipals.push(new Headers(init?.headers).get(DEMO_PRINCIPAL_HEADER));
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ rows: [], version: '1' }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root?.render(
        <PollingAdapter restEndpoint="http://sync.test/prefetch" pollIntervalMs={60_000}>
          <PrefetchOnMount />
        </PollingAdapter>,
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      root?.render(
        <PollingAdapter userId="demo-alice" restEndpoint="http://sync.test/prefetch" pollIntervalMs={60_000}>
          <PrefetchOnMount />
        </PollingAdapter>,
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(seenPrincipals).toEqual([null, 'demo-alice']);
  });

  it('reopens and reconnects SSE with the selected principal while targeting only its cache entries', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const queryClient = getQueryClient();
    const args = { scope: 'mine' };
    queryClient.setQueryData(syncQueryKey('demo-alice', 'orders.byBuyer', args), {
      rows: [{ owner: 'alice-original' }], version: '1',
    });
    queryClient.setQueryData(syncQueryKey('demo-bob', 'orders.byBuyer', args), {
      rows: [{ owner: 'bob-original' }], version: '1',
    });

    await act(async () => {
      root?.render(
        <SSEAdapter userId="demo-alice" restEndpoint="http://sync.test/sse-root" pollIntervalMs={60_000}>
          <span>ready</span>
        </SSEAdapter>,
      );
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const aliceSource = FakeEventSource.latest();
    expect(aliceSource.url).toBe(
      `http://sync.test/sse-root/sse?${DEMO_PRINCIPAL_QUERY_PARAM}=demo-alice`,
    );

    await act(async () => {
      root?.render(
        <SSEAdapter userId="demo-bob" restEndpoint="http://sync.test/sse-root" pollIntervalMs={60_000}>
          <span>ready</span>
        </SSEAdapter>,
      );
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(aliceSource.closed).toBe(true);
    const bobSource = FakeEventSource.latest();
    expect(bobSource.url).toBe(
      `http://sync.test/sse-root/sse?${DEMO_PRINCIPAL_QUERY_PARAM}=demo-bob`,
    );

    await act(async () => {
      bobSource.emit('update', JSON.stringify({
        name: 'orders.byBuyer',
        args,
        data: [{ owner: 'bob-updated' }],
      }));
    });
    expect(queryClient.getQueryData(syncQueryKey('demo-alice', 'orders.byBuyer', args)))
      .toMatchObject({ rows: [{ owner: 'alice-original' }] });
    expect(queryClient.getQueryData(syncQueryKey('demo-bob', 'orders.byBuyer', args)))
      .toMatchObject({ rows: [{ owner: 'bob-updated' }] });

    vi.useFakeTimers();
    bobSource.readyState = 2;
    await act(async () => {
      bobSource.emit('error');
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(FakeEventSource.latest().url).toBe(bobSource.url);
  });
});
