/**
 * queryClient.test.ts — the polling-transport TanStack QueryClient singleton.
 * Pinned because its defaultOptions are load-bearing per the source comments:
 * notifyOnChangeProps MUST list every prop usePollingQuery reads (else a
 * background refetch fans out render storms or drops updates), and
 * clearPollingCache must actually empty the cache (WebSocketAdapter calls it on
 * mount to stop probe-window polls the moment WS takes over).
 *
 * Borrowable-lib unit test (libs/generic/sync) — tab-NEUTRAL, genuine coverage.
 * Run: cd libs/generic/sync && npx vitest run src/transports/polling/queryClient.test.ts
 */
import { describe, expect, it } from 'vitest';
import { getQueryClient, clearPollingCache } from './queryClient';

describe('getQueryClient', () => {
  it('returns a stable singleton', () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });

  it('configures the load-bearing query defaults', () => {
    const q = getQueryClient().getDefaultOptions().queries!;
    expect(q.staleTime).toBe(5_000);
    expect(q.gcTime).toBe(60 * 60 * 1000);
    expect(q.refetchOnWindowFocus).toBe(false);
    expect(q.structuralSharing).toBe(true);
    // The reactivity contract: must include every prop usePollingQuery reads.
    expect(q.notifyOnChangeProps).toEqual(['data', 'error', 'isLoading', 'isFetching', 'isPlaceholderData']);
  });
});

describe('clearPollingCache', () => {
  it('removes cached query data (probe-window polls stop when WS takes over)', () => {
    const qc = getQueryClient();
    qc.setQueryData(['probe'], { v: 1 });
    expect(qc.getQueryData(['probe'])).toEqual({ v: 1 });
    clearPollingCache();
    expect(qc.getQueryData(['probe'])).toBeUndefined();
  });
});
