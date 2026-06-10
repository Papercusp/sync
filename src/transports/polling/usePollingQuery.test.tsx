/**
 * Audit P-066 regression: non-memoized args objects must NOT cause refetch
 * storms. TanStack Query v5 hashes query keys structurally (sorted keys), so
 * a content-equal args object minted fresh on every render maps to the same
 * query. The audit-proposed change (a JSON.stringify'd argsKey in the
 * queryKey) would REGRESS exact-match invalidation: SSEAdapter's
 * setQueryData / invalidateQueries build keys from server-emitted args
 * objects, which match the stored object keys structurally but would not
 * match a client-side stringify (key-order-sensitive). These tests pin the
 * object-key behavior both ways.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createUsePollingQuery } from './usePollingQuery';

// The batchers Map is module-level — isolate tests via unique endpoints.
let epCounter = 0;
const ep = () => `http://p066-test-${++epCounter}`;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function makeOkFetch(results: Array<{ rows?: unknown[]; version?: string }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ results }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePollingQuery — queryKey stability (P-066)', () => {
  it('a fresh content-equal args object per render does not refetch', async () => {
    const mockFetch = makeOkFetch([{ rows: [1], version: 'v1' }]);
    global.fetch = mockFetch as unknown as typeof fetch;

    const usePollingQuery = createUsePollingQuery({
      restEndpoint: ep(),
      defaultPollIntervalMs: 60_000,
    });

    const { result, rerender } = renderHook(
      // Fresh object literal EVERY render — the non-memoized-caller case.
      () => usePollingQuery({ queryName: 'q.test', args: { b: 2, a: 1 } }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    rerender();
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('key-order-permuted args map to the same query (structural hash)', async () => {
    const mockFetch = makeOkFetch([{ rows: ['x'], version: 'v1' }]);
    global.fetch = mockFetch as unknown as typeof fetch;

    const usePollingQuery = createUsePollingQuery({
      restEndpoint: ep(),
      defaultPollIntervalMs: 60_000,
    });
    const wrapper = makeWrapper();

    const a = renderHook(
      () => usePollingQuery({ queryName: 'q.perm', args: { a: 1, b: 2 } }),
      { wrapper },
    );
    const b = renderHook(
      () => usePollingQuery({ queryName: 'q.perm', args: { b: 2, a: 1 } }),
      { wrapper },
    );

    await waitFor(() => {
      expect(a.result.current.loading).toBe(false);
      expect(b.result.current.loading).toBe(false);
    });

    // Same structural hash → ONE query → the batch body carries ONE entry
    // (a reference- or order-sensitive key would produce two).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as { body: string }).body,
    ) as { queries: unknown[] };
    expect(body.queries).toHaveLength(1);
  });
});
