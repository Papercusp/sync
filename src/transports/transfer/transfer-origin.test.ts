import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetOriginSchedulersForTests,
  getOriginScheduler,
} from '../polling/origin-scheduler';
import { parseTransportCapability, TransportCapabilityError } from './transport-capability';
import {
  assertDistinctTransferOrigin,
  resolveTransferPlane,
  TransferOriginError,
} from './transfer-origin';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CONTROL_ORIGIN = 'https://portal.papercusp.test';

/**
 * The D-002 conservative browser baseline: a six-connection HTTP/1.1 origin
 * with one consolidated control SSE standing, leaving three finite slots, one
 * of which is held back exclusively for interactive control work.
 */
function controlScheduler() {
  return getOriginScheduler(CONTROL_ORIGIN, {
    limit: 3,
    reservedInteractive: 1,
    requestTimeoutMs: 1_000,
    profile: 'http',
    protocol: 'http/1.1',
  });
}

function capability(overrides: Record<string, unknown> = {}) {
  return parseTransportCapability({
    mode: 'reverse-connector',
    transferOrigin: 'https://bulk.papercusp.test',
    resumable: true,
    chunkBytes: 4 * 1024 * 1024,
    maxConcurrentChunks: 6,
    ticketTtlSec: 120,
    ...overrides,
  });
}

afterEach(() => {
  _resetOriginSchedulersForTests();
});

describe('transfer-origin separation (P-021 acceptance)', () => {
  it('gives the transfer plane a scheduler that is not the control scheduler', () => {
    const control = controlScheduler();
    const plane = resolveTransferPlane(capability(), CONTROL_ORIGIN);

    expect(plane.scheduler).not.toBe(control);
    expect(plane.transferOrigin).not.toBe(plane.controlOrigin);
    expect(plane.scheduler.snapshot().origin).toBe('https://bulk.papercusp.test');
    expect(control.snapshot().origin).toBe(CONTROL_ORIGIN);
  });

  it('saturating the transfer plane consumes NO control-origin capacity', async () => {
    const control = controlScheduler();
    const plane = resolveTransferPlane(capability(), CONTROL_ORIGIN);

    // Flood the transfer plane far past its own ceiling: 18 chunk transfers
    // against a 6-slot plane, none of which will settle.
    const held = deferred();
    const bulk = Array.from({ length: 18 }, () =>
      plane.scheduler.run(async () => {
        await held.promise;
      }, { class: 'bulk', timeoutMs: 60_000 }),
    );
    await tick();

    const transferSnapshot = plane.scheduler.snapshot();
    expect(transferSnapshot.inFlight).toBe(6);
    expect(transferSnapshot.queued).toBe(12);

    // THE ASSERTION THAT MATTERS: the control origin never saw any of it.
    const controlSnapshot = control.snapshot();
    expect(controlSnapshot.inFlight).toBe(0);
    expect(controlSnapshot.queued).toBe(0);
    expect(controlSnapshot.byClass.bulk.admitted).toBe(0);
    expect(controlSnapshot.limit).toBe(3);

    held.resolve();
    await Promise.all(bulk);
  });

  it('admits interactive control work immediately while bulk transfer is saturated', async () => {
    const control = controlScheduler();
    const plane = resolveTransferPlane(capability(), CONTROL_ORIGIN);
    const order: string[] = [];

    const heldBulk = deferred();
    const bulk = Array.from({ length: 18 }, (_, i) =>
      plane.scheduler.run(async () => {
        order.push(`bulk-${i}`);
        await heldBulk.promise;
      }, { class: 'bulk', timeoutMs: 60_000 }),
    );

    // Occupy every non-reserved control slot with background work, so the ONLY
    // way interactive runs is via the reservation.
    const heldBackground = deferred();
    const background = [0, 1].map((i) =>
      control.run(async () => {
        order.push(`background-${i}`);
        await heldBackground.promise;
      }, { class: 'background-sync', timeoutMs: 60_000 }),
    );
    await tick();

    expect(control.snapshot().byClass['background-sync'].inFlight).toBe(2);

    // Interactive must run NOW: not behind 18 bulk transfers, not behind the
    // background pair. This is the reserved auth/mutation/control capacity.
    const interactive = control.run(async () => {
      order.push('interactive');
    }, { class: 'interactive-control', timeoutMs: 1_000 });

    await interactive;
    expect(order).toContain('interactive');
    expect(order.indexOf('interactive')).toBeGreaterThan(-1);

    heldBulk.resolve();
    heldBackground.resolve();
    await Promise.all([...bulk, ...background]);
  });

  it('REFUSES a capability whose transfer origin collapses onto the control origin', () => {
    expect(() => resolveTransferPlane(capability({ transferOrigin: CONTROL_ORIGIN }), CONTROL_ORIGIN)).toThrow(
      TransferOriginError,
    );

    // The near-miss a hand-written config actually produces: same origin, path
    // suffix. A naive string compare would wave this through and silently void
    // the entire reservation.
    expect(() => assertDistinctTransferOrigin(CONTROL_ORIGIN, `${CONTROL_ORIGIN}/bulk/`)).toThrow(
      /is the control origin/,
    );

    try {
      assertDistinctTransferOrigin(CONTROL_ORIGIN, CONTROL_ORIGIN);
      throw new Error('expected a TransferOriginError');
    } catch (error) {
      expect(error).toBeInstanceOf(TransferOriginError);
      expect((error as TransferOriginError).code).toBe('not_distinct');
    }
  });

  it('refuses a capability that omits an explicit transfer origin', () => {
    expect(() => parseTransportCapability({
      mode: 'direct',
      resumable: false,
      chunkBytes: 1024 * 1024,
      maxConcurrentChunks: 2,
      ticketTtlSec: 60,
    })).toThrow(TransportCapabilityError);
  });

  /**
   * CALIBRATION CONTROL — permanent, deliberately-wrong implementation.
   *
   * Without this, "control saw 0 in-flight" could be true because the
   * separation works OR because the assertion measures nothing. This models
   * the pre-P-021 world (bulk issued on the control origin) and proves the
   * same measurement DOES report contention when contention exists. If this
   * case ever starts reporting 0, the assertion above has gone vacuous and the
   * suite is no longer evidence of anything.
   */
  it('CONTROL: bulk issued on the control origin DOES consume control capacity', async () => {
    const control = controlScheduler();

    const held = deferred();
    const collapsed = Array.from({ length: 18 }, () =>
      control.run(async () => {
        await held.promise;
      }, { class: 'bulk', timeoutMs: 60_000 }),
    );
    await tick();

    const snapshot = control.snapshot();
    expect(snapshot.inFlight).toBeGreaterThan(0);
    expect(snapshot.byClass.bulk.admitted).toBeGreaterThan(0);

    held.resolve();
    await Promise.all(collapsed);
  });

  it('sizes the transfer plane from the host, never from the control profile', () => {
    const control = controlScheduler();
    const plane = resolveTransferPlane(capability({ maxConcurrentChunks: 12 }), CONTROL_ORIGIN);

    expect(plane.scheduler.snapshot().limit).toBe(12);
    // A generous host must not widen the control budget.
    expect(control.snapshot().limit).toBe(3);
    expect(plane.scheduler.snapshot().reservedInteractive).toBe(0);
  });
});
