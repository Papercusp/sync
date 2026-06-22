/**
 * Invalidation bus — the server-push core of @papercusp/sync.
 *
 * Generic extraction of the operator's `sync-sse.ts`. One process-local
 * bus fans a stream of invalidation/update events out to every connected
 * SSE subscriber, with:
 *   - a monotonic event id + an in-memory ring buffer for `Last-Event-ID`
 *     reconnect replay (`backfillSince`),
 *   - source-side dedupe so a periodic reconcile sweep that re-emits the
 *     same `(name, args)` doesn't fan out a flicker storm,
 *   - a 32KB payload cap (oversized → drop `data`, client refetches),
 *   - an optional `bridge` that synthesizes extra events (e.g. a raw
 *     PG-trigger `<schema>.<table>.changed` → the camelCase query names
 *     that read that table).
 *
 * Transport is INJECTED, so the lib stays dependency-free:
 *   - `ListenSource.start(onMessage)` feeds raw JSON event strings in
 *     (the host wires this to PG `LISTEN`, a Redis sub, an in-process
 *     emitter — anything).
 *   - `NotifySink.notify(json)` sends an event out to all processes (the
 *     host wires this to `pg_notify`, a Redis pub, etc). In a single
 *     process the notify loops back through the ListenSource.
 *
 * The host's `notifyInvalidate(...)` call publishes via the sink; the sink
 * delivery comes back through the listen source and is what actually fans
 * out to subscribers — so multi-process deployments all see every event.
 */

export interface SyncEvent {
  id: number;
  ts: number;
  name: string;
  args?: Record<string, unknown>;
  /** Optional full payload. Absent when oversized (>limit) or unknown —
   *  client falls back to invalidate-then-refetch. */
  data?: unknown[];
}

/** Inbound transport: deliver raw JSON event strings to `onMessage`. */
export interface ListenSource {
  start(onMessage: (raw: string) => void): Promise<void> | void;
  stop?(): void | Promise<void>;
}

/**
 * A bridged target the `bridge` may synthesize from a raw event. Either:
 *   - a bare query NAME (string) → full-bust (the bridged event carries NO
 *     `args`, so the client invalidates EVERY cache entry under that name); or
 *   - `{ name, args }` → SCOPED invalidate (the bridged event carries those
 *     `args`, so the client invalidates only the matching cache key — e.g.
 *     a single row's entry, built from the source event's row PK).
 *
 * A string and `{ name }` (no args) are equivalent — both full-bust.
 */
export type BridgeTarget =
  | string
  | { name: string; args?: Record<string, unknown> };

/** Outbound transport: publish a JSON payload to all processes. */
export interface NotifySink {
  notify(payloadJson: string): Promise<void>;
}

export interface SubscribeHandle {
  send: (e: SyncEvent) => void;
  close: () => void;
}

export interface CreateInvalidationBusOptions {
  listen: ListenSource;
  notify: NotifySink;
  /** Ring-buffer retention for reconnect replay. Default 60_000. */
  historyWindowMs?: number;
  /** Suppress identical notifies within this window. Default 90_000. */
  dedupeWindowMs?: number;
  /** Serialized-payload byte cap; over → drop `data`. Default 32768. */
  payloadSizeLimit?: number;
  /**
   * Synthesize extra invalidation targets from a raw event (e.g. a PG-trigger
   * `<schema>.<table>.changed`). Receives BOTH the event name and its `args`
   * (the trigger payload — `{ workspace_id, op, id }` for the operator) so a
   * target can be SCOPED to the changed row's PK (`args.id`). Returns
   * {@link BridgeTarget}s: a bare string full-busts (back-compat); a
   * `{ name, args }` object scopes the invalidation to those args.
   */
  bridge?: (
    eventName: string,
    eventArgs?: Record<string, unknown>,
  ) => readonly BridgeTarget[];
  /** Injectable clock (testing). Default Date.now. */
  now?: () => number;
  onError?: (where: string, err: unknown) => void;
  log?: (msg: string) => void;
}

export interface InvalidationBus {
  /** Register an SSE subscriber. Lazily starts the ListenSource. */
  subscribe(send: (e: SyncEvent) => void): Promise<SubscribeHandle>;
  /** Events with id > lastEventId still inside the retention window. */
  backfillSince(lastEventId: number): SyncEvent[];
  /** Publish an invalidation (or data-bearing update) to all processes. */
  notifyInvalidate(
    name: string,
    args?: Record<string, unknown>,
    data?: unknown[],
  ): Promise<void>;
  /** Eagerly start the ListenSource (otherwise lazy on first subscribe). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Inspection / tests. */
  historySize(): number;
}

const DEFAULT_HISTORY_WINDOW_MS = 60_000;
const DEFAULT_DEDUPE_WINDOW_MS = 90_000;
const DEFAULT_PAYLOAD_SIZE_LIMIT = 32 * 1024;

/** Tiny non-crypto hash (FNV-1a, 32-bit) for the dedupe key's data leg.
 *  The key needs *equality* on the payload, not the payload bytes: storing
 *  full serialized payloads as Map keys retained them in memory for the
 *  whole dedupe window and made every key comparison O(payload size). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function createInvalidationBus(
  opts: CreateInvalidationBusOptions,
): InvalidationBus {
  const historyWindowMs = opts.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
  const dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const payloadSizeLimit = opts.payloadSizeLimit ?? DEFAULT_PAYLOAD_SIZE_LIMIT;
  const bridge = opts.bridge ?? (() => [] as const);
  const now = opts.now ?? (() => Date.now());
  const onError = opts.onError ?? (() => {});
  const log = opts.log ?? (() => {});

  let nextId = 1;
  const history: SyncEvent[] = [];
  const subscribers = new Set<{ send: (e: SyncEvent) => void }>();
  const recentNotifies = new Map<string, number>();
  const inflightNotifies = new Set<Promise<unknown>>();

  let startPromise: Promise<void> | null = null;

  function pruneHistory(): void {
    const cutoff = now() - historyWindowMs;
    while (history.length > 0 && history[0].ts < cutoff) history.shift();
  }

  function fanout(ev: SyncEvent): void {
    history.push(ev);
    pruneHistory();
    for (const s of subscribers) {
      try {
        s.send(ev);
      } catch {
        /* best-effort — one bad subscriber must not break the fan-out */
      }
    }
  }

  function onMessage(raw: string): void {
    let parsed: { name?: unknown; args?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed.name !== 'string') return;
    const ev: SyncEvent = {
      id: nextId++,
      ts: now(),
      name: parsed.name,
      args:
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : undefined,
      data: Array.isArray(parsed.data) ? parsed.data : undefined,
    };
    fanout(ev);

    // Bridge: synthesize additional events from the raw (name, args). A bare
    // string target full-busts (no `args` → client invalidates every cache
    // entry under that name); a `{ name, args }` target SCOPES the invalidate
    // to those args (e.g. just the changed row's key, derived from args.id).
    for (const target of bridge(parsed.name, ev.args)) {
      if (typeof target === 'string') {
        fanout({ id: nextId++, ts: now(), name: target });
      } else {
        const bridged: SyncEvent = { id: nextId++, ts: now(), name: target.name };
        if (target.args !== undefined) bridged.args = target.args;
        fanout(bridged);
      }
    }
  }

  function start(): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        await opts.listen.start(onMessage);
        log('[sync] invalidation bus listening');
      })().catch((e) => {
        // Reset so a later subscribe retries (matches the original behavior).
        startPromise = null;
        onError('listen.start', e);
        throw e;
      });
    }
    return startPromise;
  }

  async function subscribe(send: (e: SyncEvent) => void): Promise<SubscribeHandle> {
    await start();
    const sub = { send };
    subscribers.add(sub);
    return { send, close: () => void subscribers.delete(sub) };
  }

  function backfillSince(lastEventId: number): SyncEvent[] {
    pruneHistory();
    return history.filter((e) => e.id > lastEventId);
  }

  function pruneNotifyCache(ts: number): void {
    if (recentNotifies.size < 200) return;
    for (const [k, t] of recentNotifies) {
      if (ts - t > dedupeWindowMs) recentNotifies.delete(k);
    }
  }

  async function notifyInvalidate(
    name: string,
    args?: Record<string, unknown>,
    data?: unknown[],
  ): Promise<void> {
    let payload: Record<string, unknown> = { name };
    if (args !== undefined) payload.args = args;
    if (data !== undefined) {
      payload.data = data;
      if (JSON.stringify(payload).length > payloadSizeLimit) {
        payload = { name };
        if (args !== undefined) payload.args = args;
      }
    }

    // Source-side dedupe. Data-bearing notifies hash the data into the key
    // so a NEW row set still gets through; pure invalidates collapse. Only
    // a short hash goes into the key — never the payload itself.
    const dataKey = data === undefined ? '' : fnv1a(JSON.stringify(data));
    const key = `${name}|${args ? JSON.stringify(args) : ''}|${dataKey}`;
    const ts = now();
    const last = recentNotifies.get(key);
    if (last !== undefined && ts - last < dedupeWindowMs) return;
    recentNotifies.set(key, ts);
    pruneNotifyCache(ts);

    const publish = Promise.resolve(opts.notify.notify(JSON.stringify(payload)));
    inflightNotifies.add(publish);
    try {
      await publish;
    } catch (e) {
      onError('notify', e);
    } finally {
      inflightNotifies.delete(publish);
    }
  }

  /**
   * Stop the bus:
   *   1. Drops all subscribers immediately — no further fan-out.
   *   2. DRAINS in-flight `notifyInvalidate` sink publishes (a stop during
   *      a write burst doesn't silently discard outbound notifies; their
   *      failures still route to `onError`, never to the stop caller).
   *   3. Stops the ListenSource and resets the lazy-start latch.
   * A `notifyInvalidate` made AFTER stop() still attempts to publish
   * (best-effort against a stopped sink); a later subscribe()/start()
   * restarts the listen source.
   */
  async function stop(): Promise<void> {
    subscribers.clear();
    if (inflightNotifies.size > 0) {
      await Promise.allSettled([...inflightNotifies]);
    }
    if (opts.listen.stop) await opts.listen.stop();
    startPromise = null;
  }

  return {
    subscribe,
    backfillSince,
    notifyInvalidate,
    start,
    stop,
    historySize: () => history.length,
  };
}
