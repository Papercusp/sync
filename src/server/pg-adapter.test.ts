/**
 * createPgListenSource — the cold-bust `onListen` hook (caching-layer-tag-eca P-017).
 *
 * postgres-js calls a listener's `onlisten` callback every time the LISTEN is
 * (re)established: once on the initial subscribe, and again after the dedicated
 * connection drops and postgres-js transparently reconnects + re-issues the
 * `LISTEN` (its `onclose` → re-`listen` path). This test drives a fake postgres-js
 * client through that lifecycle and asserts the source forwards every (re)connect
 * to the host's `onListen` — the seam the operator wires to `cache.clearL1()`.
 */
import { describe, it, expect } from 'vitest';
import { createPgListenSource } from './pg-adapter';
import type { PgSqlLike } from './pg-adapter';

/**
 * A fake postgres-js client. `reconnect()` re-fires the stored `onListen`
 * (postgres-js re-invokes the listener's `onlisten` on reconnect) and lets a
 * test push a NOTIFY through `emit()`.
 */
function makeFakeSql(): {
  sql: PgSqlLike;
  reconnect: () => void;
  emit: (raw: string) => void;
  ended: boolean;
} {
  let onNotify: ((p: string) => void) | undefined;
  let onListen: (() => void) | undefined;
  const state = { ended: false };
  const sql = {
    listen(_channel: string, notify: (p: string) => void, listen?: () => void) {
      onNotify = notify;
      onListen = listen;
      // postgres-js resolves the LISTEN, then fires onlisten on the initial connect.
      listen?.();
      return Promise.resolve(undefined);
    },
    async end() {
      state.ended = true;
    },
  } as unknown as PgSqlLike;
  return {
    sql,
    reconnect: () => onListen?.(),
    emit: (raw: string) => onNotify?.(raw),
    get ended() {
      return state.ended;
    },
  } as ReturnType<typeof makeFakeSql>;
}

describe('createPgListenSource — onListen cold-bust hook', () => {
  it('fires onListen on the initial connect AND on every reconnect', async () => {
    const fake = makeFakeSql();
    let connects = 0;
    const src = createPgListenSource({
      open: () => fake.sql,
      channel: 'sync_invalidate',
      onListen: () => {
        connects++;
      },
    });

    await src.start(() => {});
    expect(connects).toBe(1); // initial connect

    // Simulate the dedicated LISTEN connection dropping + postgres-js reconnecting.
    fake.reconnect();
    fake.reconnect();
    expect(connects).toBe(3); // every (re)connect cold-busts
  });

  it('still delivers NOTIFY payloads to onMessage (the hook does not disturb the stream)', async () => {
    const fake = makeFakeSql();
    const messages: string[] = [];
    const src = createPgListenSource({
      open: () => fake.sql,
      onListen: () => {},
    });
    await src.start((raw) => messages.push(raw));
    fake.emit('{"name":"plans.items"}');
    expect(messages).toEqual(['{"name":"plans.items"}']);
  });

  it('omitting onListen is a no-op (back-compat — the param is simply not forwarded)', async () => {
    const fake = makeFakeSql();
    const src = createPgListenSource({ open: () => fake.sql });
    // Just must not throw when postgres-js would have nothing to call back.
    await expect(src.start(() => {})).resolves.toBeUndefined();
    fake.reconnect(); // no onListen registered ⇒ nothing happens
  });

  it('stop() ends the connection', async () => {
    const fake = makeFakeSql();
    const src = createPgListenSource({ open: () => fake.sql });
    await src.start(() => {});
    await src.stop?.();
    expect(fake.ended).toBe(true);
  });
});
