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

// A module-local Set is not a page-wide bus. The packaged desktop can evaluate
// this module twice when the sync transport reaches it by a relative import
// while an app bridge reaches it through the package export. In that shape the
// SSE adapter emits into one Set and DesktopConsoleLaunchBridge subscribes to a
// different Set: the stream stays healthy, but the bridge sees zero events.
//
// Share the registry through globalThis, matching the already-hardened
// leader-bridge singleton. Symbol.for keeps independently evaluated copies on
// one collision-resistant key, while unsubscribe still removes the exact
// listener from the shared Set during React/HMR cleanup.
const LISTENERS_KEY = Symbol.for('papercusp.sync.bus-tap.listeners');

function listeners(): Set<SyncBusListener> {
  const host = globalThis as Record<PropertyKey, unknown>;
  let current = host[LISTENERS_KEY] as Set<SyncBusListener> | undefined;
  if (!current) {
    current = new Set<SyncBusListener>();
    host[LISTENERS_KEY] = current;
  }
  return current;
}

/** Subscribe to every sync push event. Returns an unsubscribe function. */
export function onSyncBusEvent(fn: SyncBusListener): () => void {
  const registry = listeners();
  registry.add(fn);
  return () => {
    registry.delete(fn);
  };
}

/** Transport-side: fan a push event out to all listeners (error-isolated). */
export function emitSyncBusEvent(ev: SyncBusEvent): void {
  for (const fn of listeners()) {
    try {
      fn(ev);
    } catch {
      /* listener errors never block the bus or the cache wiring */
    }
  }
}
