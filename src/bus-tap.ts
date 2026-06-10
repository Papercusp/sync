/**
 * Sync-bus tap — a domain-free listener registry for the raw push events the
 * sync transport receives (`invalidate` / `update`, payload `{ name, args,
 * data? }`).
 *
 * Why this exists: app-level consumers (e.g. an attention notifier) used to
 * open their OWN EventSource against the same SSE route the sync transport
 * already holds. In the browser (HTTP/1.1) every standing stream costs one of
 * Chromium's ~6 per-host sockets, and the duplicate pushed the app to the
 * limit — starving ordinary fetches (route loaders queued forever). One
 * transport connection, many listeners.
 *
 * The transport adapters call `emitSyncBusEvent` for every well-formed push
 * event; consumers subscribe with `onSyncBusEvent` and filter by `name`.
 * Listeners are isolated — one throwing listener never blocks the others or
 * the cache wiring.
 */

export interface SyncBusEvent {
  name: string;
  args?: unknown;
  data?: unknown[];
}

type SyncBusListener = (ev: SyncBusEvent) => void;

const listeners = new Set<SyncBusListener>();

/** Subscribe to every sync push event. Returns an unsubscribe function. */
export function onSyncBusEvent(fn: SyncBusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Transport-side: fan a push event out to all listeners (error-isolated). */
export function emitSyncBusEvent(ev: SyncBusEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* listener errors never block the bus or the cache wiring */
    }
  }
}
