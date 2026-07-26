/**
 * concurrency-gate — a tiny async semaphore, FIFO, with abort-aware queueing.
 *
 * WHY THE SYNC TRANSPORT NEEDS ONE (drop-sync-batcher-2026-07-25 P-002).
 * The polling transport issues ONE request per query. A hydration wave is ~95
 * of them at once, and two environments still cap parallel connections:
 *
 *   - the desktop's pre-handshake window (up to ~30s from webview mount until
 *     the sidecar signals `PAPERCUSP_IPC_READY`), where `ipcFetch` falls back
 *     to plain HTTP and the webview's own per-host connection pool applies;
 *   - the `:3055` dev browser, where `tauri dev` skips the sidecar entirely.
 *
 * Unbounded there means the surplus queues in the connection pool and starves
 * every other request on the page. Bounded, it does not — and bounding is
 * *also* faster, which is the part that surprised: measured against :3070,
 * 95 queries at concurrency 6 finished the whole wave in 1126ms (p50 9.4ms)
 * against 2676ms for the single bundle this replaced, because firing all 95
 * resolvers at once saturates the PG pool and the event loop and slows every
 * one of them down. See D-001 of the plan.
 *
 * The gate is deliberately NOT a batcher: each caller keeps its own request,
 * its own AbortSignal, and its own arrival time. A slow query occupies one
 * slot; it cannot hold anyone else's result hostage, which is the head-of-line
 * property the bundle could not offer at any window size.
 */

/** Fallback for environments/signals without `AbortSignal.reason`. */
function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

export interface ConcurrencyGate {
  /**
   * Run `fn` as soon as a slot frees up, FIFO. Releases the slot when `fn`
   * settles (resolve OR reject).
   *
   * When `signal` is supplied, an abort that lands while this call is still
   * QUEUED drops it from the queue and rejects without ever invoking `fn` —
   * a request for an unmounted panel never reaches the network. Once `fn` has
   * started, cancellation is `fn`'s own business (for the sync fetcher, the
   * same signal is passed to `fetch`).
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Retune the cap at runtime; frees waiters immediately when raised. */
  setLimit(next: number): void;
  /** Max concurrent `fn` executions. */
  readonly limit: number;
  /** Currently executing. */
  readonly inFlight: number;
  /** Waiting for a slot. */
  readonly queued: number;
}

interface Waiter {
  admit: () => void;
  drop: (reason: unknown) => void;
}

function normalizeLimit(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  let max = normalizeLimit(limit);
  let active = 0;
  const waiters: Waiter[] = [];

  const pump = (): void => {
    while (active < max && waiters.length > 0) {
      const next = waiters.shift()!;
      active += 1;
      next.admit();
    }
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    // Fast path only when nobody is already waiting — otherwise a late caller
    // could jump a queue it should be joining (FIFO is what keeps an early
    // hydration query from being starved by a steady drip of poll ticks).
    if (active < max && waiters.length === 0) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: Waiter = {
        admit: () => {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          resolve();
        },
        drop: reject,
      };
      waiters.push(waiter);
      if (signal) {
        onAbort = () => {
          const i = waiters.indexOf(waiter);
          // Already admitted → the slot is held and `run`'s finally releases it.
          if (i === -1) return;
          waiters.splice(i, 1);
          waiter.drop(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw abortReason(signal);
      await acquire(signal);
      try {
        return await fn();
      } finally {
        active -= 1;
        pump();
      }
    },
    setLimit(next: number): void {
      max = normalizeLimit(next);
      pump();
    },
    get limit() {
      return max;
    },
    get inFlight() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
  };
}
