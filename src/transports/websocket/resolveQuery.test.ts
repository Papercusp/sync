/**
 * Tests for resolveQuery — dot-path resolution of a query name against a
 * caller-supplied registry. Run with:
 *   npx vitest run libs/generic/sync/src/transports/websocket/resolveQuery.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveQuery } from './resolveQuery';

describe('resolveQuery', () => {
  it('returns undefined for the disabled sentinels ("" and "noop")', () => {
    expect(resolveQuery('', {}, {})).toBeUndefined();
    expect(resolveQuery('noop', {}, {})).toBeUndefined();
  });

  it('resolves a single-level query and invokes it with args', () => {
    const products = vi.fn((a: unknown) => ({ q: a }));
    const out = resolveQuery('products', { limit: 5 }, { products });
    expect(products).toHaveBeenCalledWith({ limit: 5 });
    expect(out).toEqual({ q: { limit: 5 } });
  });

  it('resolves a nested dotted query', () => {
    const page = vi.fn(() => 'PAGE');
    const out = resolveQuery('products.page', { cursor: 'c' }, { products: { page } });
    expect(page).toHaveBeenCalledWith({ cursor: 'c' });
    expect(out).toBe('PAGE');
  });

  it('throws "is not a function" when a single-level name is missing', () => {
    expect(() => resolveQuery('missing', {}, {})).toThrow(
      /Query 'missing' is not a function — got undefined/,
    );
  });

  it('throws "Unknown query (failed at ...)" when an intermediate segment is missing', () => {
    expect(() => resolveQuery('a.b', {}, {})).toThrow(/Unknown query: 'a\.b' \(failed at 'b'\)/);
  });

  it('throws when the resolved leaf is not a function', () => {
    expect(() => resolveQuery('x', {}, { x: 42 })).toThrow(/'x' is not a function — got number/);
  });

  it('throws when traversal hits a non-object midway', () => {
    expect(() => resolveQuery('x.y.z', {}, { x: { y: 7 } })).toThrow(/failed at 'z'/);
  });
});
