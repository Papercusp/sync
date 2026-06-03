/**
 * Postgres LISTEN/NOTIFY adapters for the invalidation bus.
 *
 * Thin glue that turns a postgres-js-style client into the bus's
 * `ListenSource` / `NotifySink` seams. Dependency-free: the host passes
 * in its own postgres client(s) (structurally `PgSqlLike`), so this lib
 * never imports `postgres` and never opens its own connection policy.
 *
 * Typical host wiring (operator):
 *
 *   import postgres from 'postgres';
 *   import { getOrgPg } from '@papercusp/db-org';
 *   const listen = createPgListenSource({
 *     open: () => postgres(adminUrl, { max: 1, idle_timeout: 0 }),
 *     channel: 'sync_invalidate',
 *   });
 *   const notify = createPgNotifySink({
 *     getSql: () => getOrgPg().sql,           // reuse the shared pool
 *     channel: 'sync_invalidate',
 *   });
 */

import type { ListenSource, NotifySink } from './invalidation-bus';

/**
 * Minimal structural shape of a postgres-js client — only what the
 * adapters use. A real `postgres()` Sql satisfies this.
 */
export interface PgSqlLike {
  /** Tagged-template query, e.g. sql`SELECT pg_notify(${ch}, ${payload})`. */
  (strings: TemplateStringsArray, ...args: unknown[]): Promise<unknown>;
  /** Subscribe to a NOTIFY channel; resolves once the LISTEN is ready. */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<unknown>;
  /** Close the connection (optional in the structural type). */
  end?(opts?: unknown): Promise<void>;
}

const DEFAULT_CHANNEL = 'sync_invalidate';

/**
 * A `ListenSource` backed by a dedicated postgres `LISTEN` connection.
 * `open()` is called once on `start()` to create the (long-lived,
 * single-connection) client — the host decides the pool policy.
 */
export function createPgListenSource(opts: {
  open: () => PgSqlLike;
  channel?: string;
}): ListenSource {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  let sql: PgSqlLike | null = null;
  return {
    async start(onMessage) {
      sql = opts.open();
      await sql.listen(channel, (raw) => onMessage(raw));
    },
    async stop() {
      if (sql?.end) await sql.end({ timeout: 5 });
      sql = null;
    },
  };
}

/**
 * A `NotifySink` that fires `pg_notify(channel, payload)` on the host's
 * (shared) pool. `getSql` is read per-call so it always uses the live
 * pool — opening a fresh connection per notify would exhaust the budget.
 */
export function createPgNotifySink(opts: {
  getSql: () => PgSqlLike;
  channel?: string;
}): NotifySink {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  return {
    async notify(payloadJson) {
      const sql = opts.getSql();
      await sql`SELECT pg_notify(${channel}, ${payloadJson})`;
    },
  };
}
