import { describe, it, expect } from 'vitest';
import {
  createResolver,
  knownQueryNames,
  isRegistered,
  NAME_NOT_FOUND,
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
});
