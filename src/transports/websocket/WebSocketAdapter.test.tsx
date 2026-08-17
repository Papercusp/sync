/** @vitest-environment jsdom */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests are about ONE question: which Zero connection states does the
 * adapter treat as "this rung is dead, step down the ladder"?
 *
 * The filing that prompted them (EI-20706847951836003) reported the seller UI
 * rendering an authoritative-looking "My events 0" — no error surface, no REST
 * requests — against a zero-cache that ACCEPTED the WebSocket upgrade and then
 * rejected the session. The up-front probe in SyncProvider only asks whether
 * the socket upgrades, so a reachable-but-unauthorized server sails past it and
 * the runtime watcher in this file is the only thing left that can demote.
 *
 * @rocicorp/zero 1.8.0's ConnectionState is a six-member union
 * (zero-client/src/client/connection.d.ts): disconnected | connecting |
 * connected | needs-auth | error | closed. Two of those are terminal —
 * `needs-auth` ("No connection retries will be made until the host application
 * calls connect()") and `closed` — and an auth rejection lands in `needs-auth`,
 * NOT in `error`.
 */

// ── Fake Zero ───────────────────────────────────────────────────────────────
// Only the surface WebSocketAdapter actually touches: a subscribable
// connection state, and `mutate` (read into the context value).

type FakeState =
  | { name: 'disconnected'; reason: string }
  | { name: 'connecting'; reason?: string }
  | { name: 'connected' }
  | { name: 'needs-auth'; reason: unknown }
  | { name: 'error'; reason: string }
  | { name: 'closed'; reason: string };

// `vi.mock` factories are hoisted above every module-level binding, so the
// fake has to be created inside `vi.hoisted` to exist by the time the factory
// runs (same reason SyncProvider.test.tsx hoists its captured handles).
const H = vi.hoisted(() => {
  class FakeZero {
    static instances: FakeZero[] = [];

    mutate = {};
    listeners = new Set<(s: FakeState) => void>();
    connection: {
      state: {
        current: FakeState;
        subscribe: (l: (s: FakeState) => void) => () => void;
      };
      connect: () => Promise<void>;
    };

    constructor(public opts: unknown) {
      FakeZero.instances.push(this);
      this.connection = {
        state: {
          current: { name: 'connecting' },
          subscribe: (listener: (s: FakeState) => void) => {
            this.listeners.add(listener);
            return () => {
              this.listeners.delete(listener);
            };
          },
        },
        connect: async () => {},
      };
    }

    /** Drive a state transition the way the real client would. */
    emit(next: FakeState) {
      this.connection.state.current = next;
      for (const l of this.listeners) l(next);
    }
  }
  return { FakeZero };
});

const FakeZero = H.FakeZero;
type FakeZeroInstance = InstanceType<typeof FakeZero>;

vi.mock('@rocicorp/zero', () => ({ Zero: H.FakeZero }));

vi.mock('@rocicorp/zero/react', async () => {
  const { createElement: h } = await import('react');
  return {
    ZeroProvider: ({ children }: { children: ReactNode }) => h('div', null, children),
  };
});

// The polling cache pulls in TanStack Query; the adapter only calls it for its
// side effect on mount and nothing here asserts on it.
vi.mock('../polling/queryClient', () => ({ clearPollingCache: () => {} }));

import WebSocketAdapter from './WebSocketAdapter';

const PROBE_TIMEOUT_MS = 10_000;

// React 19 only honours `act()` when the environment opts in explicitly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mountAdapter(
  onTransportError: (e: Error) => void,
  userId: string,
): FakeZeroInstance {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(WebSocketAdapter, {
        userId,
        server: 'http://zero.test',
        onTransportError,
        schema: {},
        queries: {},
        kvStore: 'mem' as const,
        children: createElement('div', { 'data-testid': 'child' }, 'child'),
      }),
    );
  });
  // The instance the adapter actually constructed//cached for this mount.
  return FakeZero.instances[FakeZero.instances.length - 1];
}

describe('WebSocketAdapter connection-state fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeZero.instances = [];
    // The adapter caches Zero instances on `window` keyed by
    // (userId|server|kvStore) and deliberately never evicts, so every test
    // gets a distinct userId AND a cleared cache.
    delete (window as unknown as { __zero_instance_cache__?: unknown }).__zero_instance_cache__;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('demotes on a fatal `error` state', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-error');

    act(() => {
      zero.emit({ name: 'error', reason: 'boom' });
    });

    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError.mock.calls[0][0].message).toContain('boom');
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * An auth rejection ("Connection userID does not match validated server
   * userID" → Unauthorized) puts the client in `needs-auth`, which by Zero's
   * own contract will NEVER retry on its own. Leaving the app on this rung
   * means every named query resolves empty forever while the UI renders a
   * confident "0".
   *
   * It must demote IMMEDIATELY, not after the generic PROBE_TIMEOUT_MS
   * backstop: the state is already a definitive verdict on the WS rung, the
   * same reasoning SyncProvider applies to a failed probe.
   */
  it('demotes IMMEDIATELY on `needs-auth` (rejected after a successful upgrade)', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-needs-auth');

    act(() => {
      zero.emit({
        name: 'needs-auth',
        reason: { type: 'zero-cache', reason: 'Unauthorized' },
      });
    });

    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError.mock.calls[0][0].message).toMatch(/needs-auth|auth/i);
  });

  /** `closed` is terminal too — a new Zero instance is required to reconnect. */
  it('demotes IMMEDIATELY on `closed`', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-closed');

    act(() => {
      zero.emit({ name: 'closed', reason: 'shut down' });
    });

    expect(onTransportError).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the contract: transient states must NOT demote on
   * arrival, or a slow-but-healthy connection loses the WS rung on every
   * hydration. `connecting`/`disconnected` are Zero's normal retry states —
   * the PROBE_TIMEOUT_MS backstop is what eventually catches a stuck one.
   */
  it('does not demote while merely `connecting` or `disconnected`', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-connecting');

    act(() => {
      zero.emit({ name: 'connecting' });
      zero.emit({ name: 'disconnected', reason: 'retrying' });
    });

    expect(onTransportError).not.toHaveBeenCalled();
  });

  it('still demotes via the timeout backstop when a connection never settles', () => {
    const onTransportError = vi.fn();
    mountAdapter(onTransportError, 'user-stuck');

    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS + 1);
    });

    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError.mock.calls[0][0].message).toContain('not connected');
  });

  it('cancels the timeout backstop once connected', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-connected');

    act(() => {
      zero.emit({ name: 'connected' });
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS + 1);
    });

    expect(onTransportError).not.toHaveBeenCalled();
  });

  /** One demotion per mount — the ladder debounces, it must not be spammed. */
  it('reports at most one failure per mount', () => {
    const onTransportError = vi.fn();
    const zero = mountAdapter(onTransportError, 'user-once');

    act(() => {
      zero.emit({ name: 'error', reason: 'first' });
      zero.emit({ name: 'needs-auth', reason: { type: 'zero-cache', reason: 'second' } });
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS + 1);
    });

    expect(onTransportError).toHaveBeenCalledTimes(1);
  });
});
