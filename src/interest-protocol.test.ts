/**
 * The interest-declaration wire contract.
 *
 * The load-bearing property is the ROUND TRIP: whatever the client writes with
 * `withInterestParam`, the server must read back with `parseInterestParam` as
 * the same set. The two halves live in different packages and are exercised by
 * different suites, so nothing else in the tree fails if they drift — and the
 * drift is silent (the server sees no declaration and fans out everything,
 * which looks like the feature being off rather than broken).
 */
import { describe, expect, it } from 'vitest';
import {
  INTEREST_PARAM,
  MAX_DECLARED_QUERY_NAMES,
  parseInterestParam,
  withInterestParam,
} from './interest-protocol';

/** Read a built URL back the way the server route does. */
function readBack(url: string): Set<string> | undefined {
  return parseInterestParam(new URL(url).searchParams.get(INTEREST_PARAM));
}

describe('withInterestParam -> parseInterestParam round trip', () => {
  it('carries the declared set across the wire unchanged', () => {
    const declared = ['work.items', 'plans.items', 'accounts.pool'];
    const url = withInterestParam('http://x/sse', declared);
    expect(readBack(url)).toEqual(new Set(declared));
  });

  it('survives names needing URL encoding', () => {
    // Not hypothetical: args-free query names are dotted today, but the param
    // must not quietly corrupt a name that ever contains a reserved char.
    const declared = ['a+b', 'c&d', 'e f'];
    const url = withInterestParam('http://x/sse', declared);
    expect(readBack(url)).toEqual(new Set(declared));
  });

  it('appends with & when the URL already carries a query', () => {
    const url = withInterestParam('http://x/sse?token=abc', ['work.items']);
    expect(url).toContain('?token=abc&');
    expect(new URL(url).searchParams.get('token')).toBe('abc');
    expect(readBack(url)).toEqual(new Set(['work.items']));
  });

  it('emits a byte-identical URL for the same set in a different order', () => {
    // The reconnect path is driven by URL inequality, so a re-enumerated set
    // must not look like a change or the connection would thrash.
    const a = withInterestParam('http://x/sse', ['b', 'a', 'c']);
    const b = withInterestParam('http://x/sse', ['c', 'b', 'a']);
    expect(a).toBe(b);
  });

  it('de-duplicates rather than declaring a name twice', () => {
    const url = withInterestParam('http://x/sse', ['a', 'a', 'b']);
    expect(readBack(url)).toEqual(new Set(['a', 'b']));
  });
});

describe('fail-open (D-002): every ambiguous input means NO filtering', () => {
  it('an EMPTY set leaves the URL undeclared rather than declaring nothing', () => {
    // The dangerous misreading: an empty allow-list read as "send nothing"
    // starves the client completely, and the symptom looks like a dead
    // connection rather than a filter bug.
    const url = withInterestParam('http://x/sse', []);
    expect(url).toBe('http://x/sse');
    expect(readBack(url)).toBeUndefined();
  });

  it('a set of only blank names is treated as empty, not as a filter', () => {
    expect(withInterestParam('http://x/sse', ['', '   '])).toBe('http://x/sse');
  });

  it('parses an absent param as undefined', () => {
    expect(parseInterestParam(null)).toBeUndefined();
    expect(parseInterestParam(undefined)).toBeUndefined();
  });

  it('parses an empty or blank param as undefined, NOT as an empty allow-list', () => {
    expect(parseInterestParam('')).toBeUndefined();
    expect(parseInterestParam('   ')).toBeUndefined();
    expect(parseInterestParam(',,,')).toBeUndefined();
  });

  it('trims whitespace around names', () => {
    expect(parseInterestParam(' a , b ')).toEqual(new Set(['a', 'b']));
  });

  it('refuses an over-cap declaration on BOTH sides rather than truncating it', () => {
    // Truncating would silently starve whichever names fell off the end.
    const tooMany = Array.from({ length: MAX_DECLARED_QUERY_NAMES + 1 }, (_, i) => `q${i}`);
    expect(withInterestParam('http://x/sse', tooMany)).toBe('http://x/sse');
    expect(parseInterestParam(tooMany.join(','))).toBeUndefined();
  });

  it('accepts a declaration exactly AT the cap', () => {
    const atCap = Array.from({ length: MAX_DECLARED_QUERY_NAMES }, (_, i) => `q${i}`);
    const url = withInterestParam('http://x/sse', atCap);
    expect(readBack(url)).toEqual(new Set(atCap));
  });
});
