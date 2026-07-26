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
 * So the guard is defensive, and today it is unreachable-as-a-bug. Keep it —
 * it is what makes the fast path safe if pump ever stops being synchronous.
 *
 * WHAT THIS FILE IS AND IS NOT WORTH. It adds coverage the behavioural suite
 * lacks: FIFO admission under RANDOMISED arrival/completion schedules (that
 * suite checks one fixed 3-waiter ordering), and `setLimit` in the LOWERING
 * direction (it only covers raising). The invariant assertion documents the
 * property the fast path depends on.
 *
 * Its limit, measured rather than assumed: observation happens on macrotask
 * boundaries, so it CANNOT see a violation narrower than that. A pump deferred
 * by a single microtask was tried as a mutant and produced zero violations
 * here — this file would NOT catch that refactor. Do not treat a green run as
 * proof that pump is still synchronous; for that, read `run`'s `finally`.
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

  it('a LOWERED setLimit actually throttles subsequent admissions', async () => {
    // The behavioural suite covers RAISING (waiters admitted immediately). This
    // covers lowering, where the gate is transiently over-subscribed: the real
    // property is that once the surplus drains, the NEW ceiling is respected —
    // not merely that the invariant holds while over-subscribed (which is
    // vacuously true, since inFlight > limit there).
    const gate = createConcurrencyGate(4);
    const releases: Array<() => void> = [];
    let concurrent = 0;
    let peakAfterLowering = 0;
    let lowered = false;

    const runs = Array.from({ length: 14 }, () =>
      gate.run(async () => {
        concurrent += 1;
        if (lowered) peakAfterLowering = Math.max(peakAfterLowering, concurrent);
        await new Promise<void>((res) => releases.push(() => res()));
        concurrent -= 1;
      }),
    );
    await tick();
    expect(gate.inFlight).toBe(4);

    gate.setLimit(1);
    lowered = true;
    // Drain everything; every admission from here on must respect the new cap.
    while (releases.length > 0) {
      releases.shift()!();
      await tick();
      expect(gate.inFlight < gate.limit && gate.queued > 0).toBe(false);
    }
    await Promise.all(runs);

    expect(gate.limit).toBe(1);
    // The load-bearing assertion: every admission made AFTER the lowering
    // happened under the new cap of 1, so concurrency at those moments is 1 —
    // not the old 4. Bounding by 4 here would be vacuous (it was the original
    // limit and therefore cannot fail); bounding by 1 is what fails if
    // setLimit's new value never reaches `pump`.
    expect(peakAfterLowering).toBeLessThanOrEqual(1);
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });
});
