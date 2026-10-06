// @vitest-environment jsdom
// WI-10006698: an EMPTY `queryNameAllowlist` makes SyncProvider inert. The
// hosted portal passes `[]` while the signed-in principal has no selected
// workspace; the hosted boundary refuses that principal's stream with
// 403 `workspace_not_selected`, and three refusals tripped the POLLING
// fallback on every freshly signed-up tab. With nothing dispatchable there is
// nothing for an invalidation stream to refresh, so none may open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { SyncProvider } from './SyncProvider';
import { useSyncQuery } from './index';

const opened = vi.hoisted(() => ({ streams: 0 }));

vi.mock('@papercusp/sse', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createCrossTabControlStream: () => {
    opened.streams += 1;
    return { close: () => {}, setUrl: () => {}, reconnect: () => {}, isOwner: true };
  },
}));

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows: [] }), { status: 200 }));

function Reader() {
  useSyncQuery({ queryName: 'workspaceHosts.control' });
  return null;
}

// The adapter bails before opening anything when the runtime has no
// EventSource, which jsdom lacks; give it one so a stream COULD open.
class FakeEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  opened.streams = 0;
  fetchMock.mockClear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Stable references, as the type's doc requires of a host.
const NOTHING: readonly string[] = [];
const HOSTED: readonly string[] = ['workspaceHosts.control'];

async function mount(allowlist: readonly string[] | undefined) {
  await act(async () => {
    render(
      <SyncProvider syncType="SSE" restEndpoint="/api/hosted/browser" queryNameAllowlist={allowlist}>
        <Reader />
      </SyncProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('SyncProvider with an empty queryNameAllowlist is inert (WI-10006698)', () => {
  it('opens no invalidation stream and dispatches no query', async () => {
    await mount(NOTHING);
    expect(opened.streams).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: a non-empty allowlist DOES open the stream and dispatch the allowed query', async () => {
    // Calibrates the probe: if this stops opening a stream, the test above
    // passes vacuously.
    await mount(HOSTED);
    expect(opened.streams).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalled();
  });
});
