import { afterEach, describe, expect, it } from 'vitest';
import {
  OriginSchedulerError,
  _resetOriginSchedulersForTests,
  createOriginScheduler,
  getOriginScheduler,
} from './origin-scheduler';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  _resetOriginSchedulersForTests();
});

describe('createOriginScheduler', () => {
  it('prioritizes interactive work and keeps an exclusive interactive reservation', async () => {
    const scheduler = createOriginScheduler({ limit: 3, requestTimeoutMs: 1_000 });
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];

    const background = [0, 1].map((i) =>
      scheduler.run(
        async () => {
          started.push(`background-${i}`);
          await releases[i].promise;
        },
        { class: 'background-sync', timeoutMs: 1_000 },
      ),
    );
    await tick();
    expect(started).toEqual(['background-0', 'background-1']);
    expect(scheduler.snapshot().byClass['background-sync'].inFlight).toBe(2);

    const interactive = scheduler.run(
      async () => {
        started.push('interactive');
      },
      { class: 'interactive-control', timeoutMs: 1_000 },
    );
    const foreground = scheduler.run(
      async () => {
        started.push('foreground');
      },
      { class: 'foreground-read', timeoutMs: 1_000 },
    );
    await tick();
    // The reserved slot admits the direct interaction even while both shared
    // slots are occupied by background work.
    expect(started).toContain('interactive');
    releases[0].resolve();
    await tick();
    releases[1].resolve();
    await Promise.all([...background, interactive, foreground]);
    expect(started.indexOf('interactive')).toBeLessThan(started.indexOf('foreground'));
    expect(scheduler.inFlight).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it('preserves FIFO order within each class', async () => {
    const scheduler = createOriginScheduler({ limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const hold = deferred<void>();
    const order: string[] = [];
    const first = scheduler.run(async () => {
      order.push('a');
      await hold.promise;
    }, { class: 'foreground-read' });
    const second = scheduler.run(async () => { order.push('b'); }, { class: 'foreground-read' });
    const third = scheduler.run(async () => { order.push('c'); }, { class: 'foreground-read' });
    await tick();
    expect(order).toEqual(['a']);
    hold.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('cancels queued work, coalesces superseded background work, and sheds stale work', async () => {
    const scheduler = createOriginScheduler({ limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const hold = deferred<void>();
    const busy = scheduler.run(async () => hold.promise, { class: 'foreground-read' });
    const ac = new AbortController();
    const cancelled = scheduler.run(async () => 'never', { class: 'background-sync', signal: ac.signal });
    const old = scheduler.run(async () => 'old', { class: 'background-sync', coalesceKey: 'refresh' });
    const oldRejected = expect(old).rejects.toMatchObject({ code: 'superseded' });
    const replacement = scheduler.run(async () => 'new', { class: 'background-sync', coalesceKey: 'refresh' });
    await tick();
    ac.abort();
    await expect(cancelled).rejects.toBeDefined();
    await oldRejected;
    expect(scheduler.snapshot().byClass['background-sync'].shed).toBeGreaterThanOrEqual(1);
    hold.resolve();
    await busy;
    await expect(replacement).resolves.toBe('new');

    const staleHold = deferred<void>();
    const busyAgain = scheduler.run(async () => staleHold.promise, { class: 'foreground-read' });
    const stale = scheduler.run(async () => 'stale', { class: 'background-sync', staleAfterMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scheduler.shedStaleBackground(1)).toBe(1);
    await expect(stale).rejects.toMatchObject({ code: 'stale' });
    staleHold.resolve();
    await busyAgain;
  });

  it('enforces a total deadline even when a task ignores abort', async () => {
    const scheduler = createOriginScheduler({ limit: 1, reservedInteractive: 0, requestTimeoutMs: 20 });
    const never = scheduler.run(async () => new Promise<string>(() => {}), { class: 'foreground-read' });
    await expect(never).rejects.toMatchObject({ code: 'timeout' });
    expect(scheduler.snapshot().byClass['foreground-read'].timeouts).toBe(1);
    // The timed-out wrapper releases its slot, so a later request is not wedged.
    await expect(scheduler.run(async () => 'free', { class: 'foreground-read', timeoutMs: 100 })).resolves.toBe('free');
  });

  it('tracks streams and keeps bulk/media streams outside the control budget', () => {
    const scheduler = createOriginScheduler({ limit: 3, baselineStreams: 1 });
    const control = scheduler.registerStream({ name: 'control', kind: 'control' });
    expect(scheduler.limit).toBe(3);
    const extra = scheduler.registerStream({ name: 'flags', kind: 'standing' });
    expect(scheduler.limit).toBe(2);
    const media = scheduler.registerStream({ name: 'desktop', kind: 'media' });
    expect(scheduler.snapshot()).toMatchObject({ streams: 3, countedStreams: 2, limit: 2 });
    media.release();
    extra.release();
    control.release();
    expect(scheduler.limit).toBe(3);
  });

  it('exposes class-level wait/outcome/byte metrics', async () => {
    const scheduler = createOriginScheduler({ limit: 2, requestTimeoutMs: 100 });
    await scheduler.run(async (_signal, context) => {
      context.recordBytes(42);
      context.recordProtocol('h1');
      return 'ok';
    }, { class: 'interactive-control' });
    const snapshot = scheduler.metrics();
    expect(snapshot.protocol).toBe('h1');
    expect(snapshot.byClass['interactive-control']).toMatchObject({ completed: 1, bytes: 42 });
  });
});

describe('getOriginScheduler', () => {
  it('pins one scheduler to an origin, independent of endpoint path', () => {
    const first = getOriginScheduler('https://example.test/api/zero', { limit: 4 });
    const second = getOriginScheduler('https://example.test/api/other', { limit: 2 });
    expect(second).toBe(first);
    expect(first.limit).toBe(2);
  });

  it('normalizes relative endpoints to one browser origin', () => {
    expect(getOriginScheduler('/api/zero')).toBe(getOriginScheduler('/api/other'));
  });
});

it('uses typed scheduler errors for queue rejection', async () => {
  const scheduler = createOriginScheduler({ limit: 1, maxQueued: 1, reservedInteractive: 0 });
  const hold = deferred<void>();
  const first = scheduler.run(async () => hold.promise);
  const second = scheduler.run(async () => 'queued');
  const third = scheduler.run(async () => 'rejected');
  await expect(third).rejects.toBeInstanceOf(OriginSchedulerError);
  hold.resolve();
  await Promise.all([first, second]);
});
