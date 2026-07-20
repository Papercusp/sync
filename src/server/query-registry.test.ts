import { describe, it, expect, vi } from 'vitest';
import {
  createResolver,
  knownQueryNames,
  isRegistered,
  NAME_NOT_FOUND,
  QueryResolveTimeoutError,
  type QueryRegistry,
} from './query-registry';

describe('query-registry', () => {
  const registry: QueryRegistry = {
    'plans.items': {
      resolve: async (args) => [{ got: args }],
    },
    'plans.get': {
      argsSchema: {
        parse: (input) => {
          const o = input as { slug?: unknown };
          if (typeof o?.slug !== 'string') throw new Error('slug required');
          return { slug: o.slug };
        },
      },
      resolve: async (args: { slug: string }) => [{ slug: args.slug }],
    },
  };

  it('resolves a known query with raw args when no schema', async () => {
    const resolve = createResolver(registry);
    const rows = await resolve('plans.items', { harnessSlug: 'x' });
    expect(rows).toEqual([{ got: { harnessSlug: 'x' } }]);
  });

  it('returns NAME_NOT_FOUND for an unregistered name', async () => {
    const resolve = createResolver(registry);
    expect(await resolve('nope.missing', {})).toBe(NAME_NOT_FOUND);
  });

  it('validates args through argsSchema before resolving', async () => {
    const resolve = createResolver(registry);
    const rows = await resolve('plans.get', { slug: 'alpha' });
    expect(rows).toEqual([{ slug: 'alpha' }]);
  });

  it('propagates a schema validation error (route maps to HTTP)', async () => {
    const resolve = createResolver(registry);
    await expect(resolve('plans.get', { slug: 123 })).rejects.toThrow('slug required');
  });

  it('knownQueryNames is sorted; isRegistered reflects membership', () => {
    expect(knownQueryNames(registry)).toEqual(['plans.get', 'plans.items']);
    expect(isRegistered(registry, 'plans.items')).toBe(true);
    expect(isRegistered(registry, 'plans.nope')).toBe(false);
  });

  describe('timeoutMs (EI-18106470827657366 — bound an indefinitely-hung resolver)', () => {
    it('with no timeoutMs, a slow resolver is unaffected (default off, byte-identical)', async () => {
      vi.useFakeTimers();
      try {
        const resolve = createResolver(registry); // no opts — same as before this change
        const p = resolve('plans.items', {});
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(p).resolves.toEqual([{ got: {} }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a resolver that never settles rejects with QueryResolveTimeoutError once timeoutMs elapses', async () => {
      vi.useFakeTimers();
      try {
        const hangingRegistry: QueryRegistry = {
          'wedged.query': {
            // Simulates a stuck downstream await (e.g. a starved PG-pool
            // acquire) — a promise that never resolves or rejects on its own.
            resolve: () => new Promise(() => {}),
          },
        };
        const resolve = createResolver(hangingRegistry, { timeoutMs: 10_000 });
        const p = resolve('wedged.query', {});
        // Attach a rejection handler immediately so vitest/node never sees this
        // as an unhandled rejection while fake timers advance below.
        const assertion = expect(p).rejects.toThrow(QueryResolveTimeoutError);
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('a resolver that settles before timeoutMs is unaffected', async () => {
      const resolve = createResolver(registry, { timeoutMs: 10_000 });
      await expect(resolve('plans.items', { a: 1 })).resolves.toEqual([{ got: { a: 1 } }]);
    });

    it('a resolver that rejects before timeoutMs propagates its real error, not a timeout', async () => {
      const failingRegistry: QueryRegistry = {
        'broken.query': {
          resolve: async () => {
            throw new Error('downstream boom');
          },
        },
      };
      const resolve = createResolver(failingRegistry, { timeoutMs: 10_000 });
      await expect(resolve('broken.query', {})).rejects.toThrow('downstream boom');
    });

    it('NAME_NOT_FOUND still short-circuits before any timeout machinery', async () => {
      const resolve = createResolver(registry, { timeoutMs: 10_000 });
      expect(await resolve('nope.missing', {})).toBe(NAME_NOT_FOUND);
    });
  });
});
