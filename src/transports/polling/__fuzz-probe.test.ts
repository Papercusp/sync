/**
 * TEMPORARY scratch probe — deleted before end of session. Determines whether
 * the fast-path's `waiters.length === 0` guard is load-bearing or defensive.
 */
import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from './concurrency-gate';

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('concurrency-gate FIFO fuzz', () => {
  it('preserves global FIFO admission order under random arrivals/completions', async () => {
    for (let seed = 0; seed < 60; seed++) {
      const rnd = mulberry32(seed);
      const limit = 1 + Math.floor(rnd() * 4);
      const gate = createConcurrencyGate(limit);
      const admitted: number[] = [];
      const releases: Array<() => void> = [];
      const runs: Array<Promise<unknown>> = [];
      const N = 24;

      for (let i = 0; i < N; i++) {
        runs.push(
          gate.run(async () => {
            admitted.push(i);
            await new Promise<void>((res) => releases.push(res));
          }),
        );
        if (rnd() < 0.5) await Promise.resolve();
        if (rnd() < 0.4 && releases.length > 0) {
          releases.shift()!();
          await Promise.resolve();
        }
      }
      while (releases.length > 0) {
        releases.shift()!();
        await Promise.resolve();
      }
      await Promise.all(runs);

      expect({ seed, admitted }).toEqual({
        seed,
        admitted: Array.from({ length: N }, (_, i) => i),
      });
    }
  });
});
