// @vitest-environment jsdom
// WI-10006696: an SSE → POLLING fallback (and the recovery retry back to SSE)
// must not remount the children of SyncProvider. A remount reset the whole app
// and ended live Phone calls (the panel's unmount cleanup hangs up the call).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContext, useEffect, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SyncContext } from './SyncContext';
import { SyncProvider } from './SyncProvider';
import { useTransportFallback } from './fallback/useTransportFallback';
import { PollingAdapter } from './transports/polling/PollingAdapter';
import { SSEAdapter } from './transports/sse/SSEAdapter';
import type { SyncType } from './types';

const fallback = vi.hoisted(() => ({ active: 'SSE' as SyncType, listeners: new Set<() => void>() }));

vi.mock('./fallback/useTransportFallback', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useTransportFallback: () => {
      const activeTransport = useSyncExternalStore(
        (notify) => { fallback.listeners.add(notify); return () => fallback.listeners.delete(notify); },
        () => fallback.active,
      );
      return { activeTransport, onTransportError: () => undefined };
    },
  };
});

function switchTransport(next: SyncType) {
  act(() => {
    fallback.active = next;
    for (const notify of fallback.listeners) notify();
  });
}

const lifecycle = { mounts: 0, unmounts: 0 };

function Probe() {
  const ctx = useContext(SyncContext);
  useEffect(() => {
    lifecycle.mounts += 1;
    return () => { lifecycle.unmounts += 1; };
  }, []);
  return <span data-testid="transport">{ctx?.transport ?? 'none'}</span>;
}

afterEach(() => {
  cleanup();
  fallback.active = 'SSE';
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
});

describe('SyncProvider transport fallback keeps children mounted', () => {
  it('SSE → POLLING → SSE changes the exposed transport without remounting children', () => {
    render(
      <SyncProvider syncType="SSE">
        <Probe />
      </SyncProvider>,
    );
    expect(screen.getByTestId('transport').textContent).toBe('SSE');
    // The pending → mounted phase at startup may mount once more; that is the
    // baseline. No transport change may add to it.
    const baseline = { ...lifecycle };

    switchTransport('POLLING');
    expect(screen.getByTestId('transport').textContent).toBe('POLLING');
    expect(lifecycle).toEqual(baseline);

    switchTransport('SSE');
    expect(screen.getByTestId('transport').textContent).toBe('SSE');
    expect(lifecycle).toEqual(baseline);
  });

  it('control: the pre-fix shape (swapping adapters) IS detected as a remount', () => {
    // Calibrates the probe: if this stops failing the lifecycle check, the
    // test above could pass vacuously.
    function SwappingProvider({ children }: { children: ReactNode }) {
      const { activeTransport } = useTransportFallback({ preferred: 'SSE', fallbackDelayMs: 10_000 });
      return activeTransport === 'SSE'
        ? <SSEAdapter key="sse">{children}</SSEAdapter>
        : <PollingAdapter key="polling">{children}</PollingAdapter>;
    }
    render(<SwappingProvider><Probe /></SwappingProvider>);
    const baseline = { ...lifecycle };
    switchTransport('POLLING');
    expect(lifecycle.unmounts).toBe(baseline.unmounts + 1);
    expect(lifecycle.mounts).toBe(baseline.mounts + 1);
  });
});
