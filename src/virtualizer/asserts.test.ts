/**
 * asserts.test.ts — the virtualizer's invariant guards. Tiny but load-bearing: a broken
 * `assert` (e.g. an inverted condition) would silently disable every invariant check that
 * uses it. Pins: assert passes on truthy / throws on falsy, the default + string + LAZY
 * (function) message forms (and that the lazy message is only evaluated on failure), and
 * that unreachable always throws.
 *
 * Borrowable-lib unit test (sync, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/sync && npx vitest run src/virtualizer/asserts.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { assert, unreachable } from './asserts';

describe('assert', () => {
  it('passes for a truthy value (no throw)', () => {
    expect(() => assert(1)).not.toThrow();
    expect(() => assert('x')).not.toThrow();
  });

  it('throws the default message for a falsy value', () => {
    expect(() => assert(0)).toThrow('Assertion failed');
    expect(() => assert(false)).toThrow('Assertion failed');
  });

  it('throws a provided string message', () => {
    expect(() => assert(null, 'boom')).toThrow('boom');
  });

  it('evaluates a lazy message ONLY on failure', () => {
    const msg = vi.fn(() => 'lazy boom');
    // success path: the thunk must NOT be called
    assert(true, msg);
    expect(msg).not.toHaveBeenCalled();
    // failure path: the thunk is evaluated for the message
    expect(() => assert(false, msg)).toThrow('lazy boom');
    expect(msg).toHaveBeenCalledTimes(1);
  });
});

describe('unreachable', () => {
  it('always throws', () => {
    expect(() => unreachable(undefined as never)).toThrow('Unreachable');
  });
});
