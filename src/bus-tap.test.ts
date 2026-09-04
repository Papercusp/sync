import { describe, expect, it, vi } from 'vitest';
import { moduleEvaluationCount } from '@papercusp/module-singleton';
import { emitSyncBusEvent, onSyncBusEvent } from './bus-tap';

const STATE_KEY = 'papercusp.sync.bus-tap.listeners';

describe('sync bus tap', () => {
  it('shares subscribers across duplicate module evaluations', async () => {
    const evaluationsBefore = moduleEvaluationCount(STATE_KEY);
    vi.resetModules();
    const subscriberCopy = await import('./bus-tap');
    vi.resetModules();
    const emitterCopy = await import('./bus-tap');
    const seen: string[] = [];
    const off = subscriberCopy.onSyncBusEvent((ev) => seen.push(ev.name));

    emitterCopy.emitSyncBusEvent({ name: 'console.launch-request' });

    expect(seen).toEqual(['console.launch-request']);
    expect(moduleEvaluationCount(STATE_KEY)).toBe(evaluationsBefore + 2);
    off();
  });

  it('delivers events to subscribers and stops after unsubscribe', () => {
    const seen: string[] = [];
    const off = onSyncBusEvent((ev) => seen.push(ev.name));

    emitSyncBusEvent({ name: 'a.changed' });
    emitSyncBusEvent({ name: 'b.changed', args: { id: 1 } });
    expect(seen).toEqual(['a.changed', 'b.changed']);

    off();
    emitSyncBusEvent({ name: 'c.changed' });
    expect(seen).toEqual(['a.changed', 'b.changed']);
  });

  it('isolates a throwing listener from the others', () => {
    const ok = vi.fn();
    const offBad = onSyncBusEvent(() => {
      throw new Error('boom');
    });
    const offOk = onSyncBusEvent(ok);

    expect(() => emitSyncBusEvent({ name: 'x' })).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);

    offBad();
    offOk();
  });
});
