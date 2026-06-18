// @vitest-environment jsdom
//
// PollingAdapter — the polling-transport provider. Genuine logic worth pinning:
// the REST endpoint derivation (restEndpoint ?? `${server}/zero` ?? default — a
// wrong derivation sends every poll to the wrong URL), forwarding of
// pollIntervalMs/tokenQueryParam to the query factory, and providing a
// SyncContext with transport 'POLLING'. The query factory is mocked to capture
// the derived config; QueryClientProvider/SyncContext render for real.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  createUsePollingQuery: vi.fn((_cfg: unknown) => () => ({})),
  createPrefetchSync: vi.fn((_cfg: unknown, _qc: unknown) => () => {}),
}));
vi.mock('./usePollingQuery', () => ({
  createUsePollingQuery: (cfg: unknown) => h.createUsePollingQuery(cfg),
  createPrefetchSync: (cfg: unknown, qc: unknown) => h.createPrefetchSync(cfg, qc),
}));

import { PollingAdapter } from './PollingAdapter';
import { SyncContext } from '../../SyncContext';

function Probe() {
  const ctx = useContext(SyncContext) as { transport?: string } | null;
  return <div>transport:{ctx?.transport}</div>;
}

afterEach(() => {
  cleanup();
  h.createUsePollingQuery.mockClear();
  h.createPrefetchSync.mockClear();
});

const cfgOf = () => h.createUsePollingQuery.mock.calls[0][0] as { restEndpoint: string; defaultPollIntervalMs: number; tokenQueryParam?: string };

describe('PollingAdapter endpoint derivation', () => {
  it('uses an explicit restEndpoint verbatim', () => {
    render(<PollingAdapter restEndpoint="/api/zero"><span /></PollingAdapter>);
    expect(cfgOf().restEndpoint).toBe('/api/zero');
  });

  it('derives `${server}/zero` when only server is given', () => {
    render(<PollingAdapter server="https://sync.example.com"><span /></PollingAdapter>);
    expect(cfgOf().restEndpoint).toBe('https://sync.example.com/zero');
  });

  it('falls back to the default endpoint when neither is given', () => {
    render(<PollingAdapter><span /></PollingAdapter>);
    expect(cfgOf().restEndpoint).toBe('http://localhost:3100/zero');
  });

  it('restEndpoint wins over server when both are present', () => {
    render(<PollingAdapter restEndpoint="/rel" server="https://x.com"><span /></PollingAdapter>);
    expect(cfgOf().restEndpoint).toBe('/rel');
  });
});

describe('PollingAdapter config + context', () => {
  it('forwards the default poll interval and the token query param', () => {
    render(<PollingAdapter restEndpoint="/z" tokenQueryParam="t0k"><span /></PollingAdapter>);
    expect(cfgOf().defaultPollIntervalMs).toBe(10_000);
    expect(cfgOf().tokenQueryParam).toBe('t0k');
  });

  it('honors a custom pollIntervalMs', () => {
    render(<PollingAdapter restEndpoint="/z" pollIntervalMs={2_500}><span /></PollingAdapter>);
    expect(cfgOf().defaultPollIntervalMs).toBe(2_500);
  });

  it('renders children inside a SyncContext with transport POLLING', () => {
    render(<PollingAdapter restEndpoint="/z"><Probe /></PollingAdapter>);
    expect(screen.getByText('transport:POLLING')).toBeTruthy();
  });
});
