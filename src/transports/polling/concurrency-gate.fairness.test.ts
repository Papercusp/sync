/**
 * concurrency-gate — FAIRNESS / fast-path invariant.
 *
 * `acquire`'s fast path is guarded by `active < max && waiters.length === 0`,
 * and the comment there says the `waiters.length === 0` half is what stops a
 * late caller jumping a queue it should join. Mutation testing (2026-07-26)
 * found that REMOVING that half breaks none of the behavioural tests. That was
 * chased down rather than left ambiguous, and the verdict is: it is an
 * EQUIVALENT MUTANT, not a hole in the suite. Running an identical randomised
 * schedule against the real gate and against a copy with the guard removed
 * produced zero divergence (0 violations / 0 queue-jumps on both, 40 seeds).
 *
 * The reason is structural: `pump()` runs SYNCHRONOUSLY inside `run`'s
 * `finally` (and inside `setLimit`), so no JS can ever observe the in-between
 * state the guard defends against:
 *
 *     at every observable point:  inFlight < limit  ⟹  queued === 0
 *
 * So the guard is defensive, and today it is unreachable-as-a-bug. KEEP BOTH
 * the guard and this test anyway: the invariant above is what actually makes
 * the fast path safe, and it is one refactor away from being false. If anyone
 * makes pump asynchronous — a microtask hop, a scheduler yield, an await
 * between the decrement and the pump — the guard starts carrying real weight
 * and this file fails LOUDLY, instead of FIFO fairness degrading silently in
 * production under exactly the wave this gate exists to order.
 */
import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from './concurrency-gate';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Deterministic PRNG so a failure is reproducible from its seed. */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('concurrency-gate fairness invariant', () => {
  it('never leaves a slot free while a waiter is queued, and admits in FIFO order', async () => {
    for (let seed = 0; seed < 40; seed++) {
      const rnd = mulberry32(seed);
      const limit = 1 + Math.floor(rnd() * 4);
      const gate = createConcurrencyGate(limit);

      const admittedOrder: number[] = [];
      const violations: Array<{ seed: number; inFlight: number; queued: number }> = [];
      const inFlight = new Map<number, () => void>();
      const runs: Array<Promise<unknown>> = [];
      const N = 20;

      const observe = () => {
        if (gate.inFlight < gate.limit && gate.queued > 0) {
          violations.push({ seed, inFlight: gate.inFlight, queued: gate.queued });
        }
      };
      const finishOne = async () => {
        const key = inFlight.keys().next().value;
        if (key === undefined) return;
        inFlight.get(key)!();
        inFlight.delete(key);
        await tick();
        observe();
      };

      for (let i = 0; i < N; i++) {
        runs.push(
          gate.run(async () => {
            admittedOrder.push(i);
            await new Promise<void>((res) => inFlight.set(i, res));
          }),
        );
        await tick();
        observe();
        // Randomly retire an in-flight task: this is what frees a slot while
        // others are still queued — the only window the guard could matter in.
        if (rnd() < 0.45) await finishOne();
      }

      while (inFlight.size > 0) await finishOne();
      await Promise.all(runs);

      expect(violations).toEqual([]);
      // Admission order must equal arrival order — no queue jumping.
      expect({ seed, admittedOrder }).toEqual({
        seed,
        admittedOrder: Array.from({ length: N }, (_, i) => i),
      });
    }
  });

  it('holds the invariant across setLimit in both directions', async () => {
    const gate = createConcurrencyGate(2);
    const inFlight: Array<() => void> = [];
    const runs = Array.from({ length: 8 }, () =>
      gate.run(async () => {
        await new Promise<void>((res) => inFlight.push(res));
      }),
    );
    await tick();
    expect(gate.inFlight).toBe(2);

    gate.setLimit(5); // raise: pump must immediately absorb the slack
    await tick();
    expect(gate.inFlight < gate.limit && gate.queued > 0).toBe(false);
    expect(gate.inFlight).toBe(5);

    gate.setLimit(1); // lower: over-subscribed, but still no free-slot-with-waiter
    await tick();
    expect(gate.inFlight < gate.limit && gate.queued > 0).toBe(false);

    while (inFlight.length > 0) {
      inFlight.shift()!();
      await tick();
      expect(gate.inFlight < gate.limit && gate.queued > 0).toBe(false);
    }
    await Promise.all(runs);
  });
});
