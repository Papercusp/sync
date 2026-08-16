/**
 * concurrency-gate.test.ts — the semaphore behind the sync transport.
 *
 * These pin the two properties the transport actually depends on, stated as
 * properties rather than as timings so they survive any retuning of the cap:
 *
 *   (a) concurrency NEVER exceeds the configured limit — the reason the
 *       pre-handshake HTTP fallback and the :3055 dev browser can't be starved;
 *   (b) admission is FIFO and a queued waiter can be dropped on abort without
 *       ever consuming a slot.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConcurrencyGate } from './concurrency-gate';

/** A promise plus its resolver, so a test can hold a task "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createConcurrencyGate', () => {
  it('never runs more than `limit` tasks at once', async () => {
    const gate = createConcurrencyGate(3);
    let concurrent = 0;
    let peak = 0;
    const gates = Array.from({ length: 20 }, () => deferred());

    const runs = gates.map((d) =>
      gate.run(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await d.promise;
        concurrent -= 1;
      }),
    );

    // Let everything that can start, start; then drain one at a time so the
    // gate has to keep re-admitting.
    await tick();
    expect(peak).toBe(3);
    for (const d of gates) {
      d.resolve();
      await tick();
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it('releases the slot when a task REJECTS (a failing query must not leak a slot)', async () => {
    const gate = createConcurrencyGate(1);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('admits waiters in FIFO order', async () => {
    const gate = createConcurrencyGate(1);
    const order: string[] = [];
    const first = deferred();

    const a = gate.run(async () => {
      order.push('a');
      await first.promise;
    });
    const b = gate.run(async () => { order.push('b'); });
    const c = gate.run(async () => { order.push('c'); });

    await tick();
    expect(order).toEqual(['a']);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('drops a QUEUED task on abort without ever invoking it', async () => {
    const gate = createConcurrencyGate(1);
    const hold = deferred();
    const ran = vi.fn();

    const busy = gate.run(async () => { await hold.promise; });
    const ac = new AbortController();
    const queued = gate.run(async () => { ran(); }, ac.signal);

    await tick();
    expect(gate.queued).toBe(1);
    ac.abort();

    await expect(queued).rejects.toBeDefined();
    expect(ran).not.toHaveBeenCalled();
    expect(gate.queued).toBe(0);

    // The aborted waiter must not have consumed or leaked the slot.
    hold.resolve();
    await busy;
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(async () => 'free')).resolves.toBe('free');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const gate = createConcurrencyGate(4);
    const ran = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(gate.run(async () => { ran(); }, ac.signal)).rejects.toBeDefined();
    expect(ran).not.toHaveBeenCalled();
    expect(gate.inFlight).toBe(0);
  });

  it('setLimit admits waiters immediately when the cap is raised', async () => {
    const gate = createConcurrencyGate(1);
    const hold = deferred();
    let started = 0;

    const runs = [
      gate.run(async () => { started += 1; await hold.promise; }),
      gate.run(async () => { started += 1; await hold.promise; }),
      gate.run(async () => { started += 1; await hold.promise; }),
    ];

    await tick();
    expect(started).toBe(1);
    gate.setLimit(3);
    await tick();
    expect(started).toBe(3);

    hold.resolve();
    await Promise.all(runs);
  });

  it('clamps a nonsense limit to at least 1 rather than deadlocking', async () => {
    expect(createConcurrencyGate(0).limit).toBe(1);
    expect(createConcurrencyGate(-5).limit).toBe(1);
    expect(createConcurrencyGate(Number.NaN).limit).toBe(1);
    await expect(createConcurrencyGate(0).run(async () => 'ran')).resolves.toBe('ran');
  });
});
