import { describe, expect, it, vi } from 'vitest';
import { emitSyncBusEvent, onSyncBusEvent } from './bus-tap';

describe('sync bus tap', () => {
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
