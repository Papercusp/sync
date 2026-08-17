/** @vitest-environment jsdom */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncProvider } from './SyncProvider';

// Each rung of the ladder is replaced by a marker element. These tests are
// about WHICH rung SyncProvider selects for a WEBSOCKETS-preferred consumer —
// not about what the adapter then does with the connection (the adapters have
// their own tests). Stubbing all three keeps the assertion unambiguous: the
// rendered `data-rung` IS the provider's decision. It also keeps the suite
// runnable without @rocicorp/zero, which the real WebSocketAdapter pulls in
// through an optional peer dependency.
//
// The factories are async + `createElement` on purpose: `vi.mock` is hoisted
// above the import block, so a JSX literal here would compile to a jsx-runtime
// call that is not in scope yet.
const captured = vi.hoisted(() => ({
  sseTransportError: null as ((error: Error) => void) | null,
}));

vi.mock('./transports/websocket/WebSocketAdapter', async () => {
  const { createElement: h } = await import('react');
  return {
    default: ({ children }: { children: ReactNode }) =>
      h('div', { 'data-rung': 'WEBSOCKETS' }, children),
  };
});

vi.mock('./transports/sse/SSEAdapter', async () => {
  const { createElement: h } = await import('react');
  return {
    SSEAdapter: ({
      children,
      onTransportError,
    }: {
      children: ReactNode;
      onTransportError?: (error: Error) => void;
    }) => {
      captured.sseTransportError = onTransportError ?? null;
      return h('div', { 'data-rung': 'SSE' }, children);
    },
  };
});

vi.mock('./transports/polling/PollingAdapter', async () => {
  const { createElement: h } = await import('react');
  return {
    PollingAdapter: ({ children }: { children: ReactNode }) =>
      h('div', { 'data-rung': 'POLLING' }, children),
  };
});

const ZERO_SERVER = 'http://zero.test';

/**
 * Stand-in for the browser WebSocket the probe constructs. `mode` decides how
 * the handshake resolves; the events fire on a microtask because
 * `probeWebSocket` assigns `onopen`/`onerror` AFTER the constructor returns.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static mode: 'healthy' | 'blocked' = 'healthy';

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    const mode = FakeWebSocket.mode;
    queueMicrotask(() => {
      if (mode === 'healthy') this.onopen?.();
      else this.onerror?.();
    });
  }

  close() {
    this.closed = true;
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
  throw lastError ?? new Error('Timed out waiting for a transport rung');
}

function rung(): string | null {
  return container.querySelector('[data-rung]')?.getAttribute('data-rung') ?? null;
}

function renderProvider(fallbackDelayMs: number) {
  return act(async () => {
    root?.render(
      createElement(
        SyncProvider,
        {
          syncType: 'WEBSOCKETS',
          userId: 'demo-alice',
          server: ZERO_SERVER,
          restEndpoint: 'http://sync.test/sync',
          endpointOverride: 'http://sync.test/sync/sse',
          pollIntervalMs: 60_000,
          fallbackDelayMs,
        },
        createElement('span', null, 'child'),
      ),
    );
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.mode = 'healthy';
  captured.sseTransportError = null;
  // The probe verdict is cached on `window` for the whole session, so a stale
  // entry from a previous test would short-circuit the next one's probe.
  delete (window as unknown as { __sync_ws_probe_cache__?: unknown }).__sync_ws_probe_cache__;
  delete (window as unknown as { __SYNC_PROBE__?: unknown }).__SYNC_PROBE__;
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('SyncProvider WEBSOCKETS → SSE → POLLING ladder', () => {
  it('mounts the WebSocket adapter when the upgrade probe completes', async () => {
    await renderProvider(10_000);
    await waitFor(() => expect(rung()).toBe('WEBSOCKETS'));

    // The probe targets the zero server itself, with the scheme swapped —
    // that is the exact origin and protocol Zero will use.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://zero.test');
    expect(container.textContent).toBe('child');
  });

  it('steps down to the SSE rung when the probe is blocked, without waiting out the fallback debounce', async () => {
    FakeWebSocket.mode = 'blocked';

    // A long debounce proves the step-down comes from the probe verdict itself
    // and not from `useTransportFallback` advancing `activeTransport`: this
    // branch used to be gated on `syncType === 'SSE'`, so a WEBSOCKETS-preferred
    // provider skipped the SSE rung entirely and collapsed to POLLING —
    // the one consumer that most needs SSE could never reach it.
    await renderProvider(60_000);
    await waitFor(() => expect(rung()).toBe('SSE'));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(container.textContent).toBe('child');
  });

  it('continues to the polling rung when the SSE transport then fails', async () => {
    FakeWebSocket.mode = 'blocked';

    await renderProvider(50);
    await waitFor(() => expect(rung()).toBe('SSE'));
    await waitFor(() => expect(captured.sseTransportError).toBeTypeOf('function'));

    // The step-down to SSE is immediate on the probe verdict, so the SSE rung
    // is already mounted while the debounce opened by the probe's OWN error
    // report is still in flight — and `useTransportFallback` drops any report
    // arriving during that window. A persistently failing stream keeps
    // reporting, so report until one lands outside it and the ladder advances.
    for (let attempt = 0; attempt < 25 && rung() !== 'POLLING'; attempt += 1) {
      await act(async () => {
        captured.sseTransportError?.(new Error('SSE stream failed'));
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    }
    expect(rung()).toBe('POLLING');

    expect(container.textContent).toBe('child');
  });

  it('probes a given server once per session and reuses the verdict across remounts', async () => {
    FakeWebSocket.mode = 'blocked';

    await renderProvider(60_000);
    await waitFor(() => expect(rung()).toBe('SSE'));
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Remounting the provider (an island swap, a route change) must not open a
    // second socket: against a dead zero server each probe is a 1.5s failing
    // connection, and island × navigation churn of those is what freezes Firefox.
    await act(async () => root?.unmount());
    root = createRoot(container);
    await renderProvider(60_000);
    await waitFor(() => expect(rung()).toBe('SSE'));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
