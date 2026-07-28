/**
 * query-fetcher — ONE `GET /rest-query` per sync query, through a bounded gate.
 *
 * Replaced the micro-batcher on 2026-07-26 (drop-sync-batcher-2026-07-25). The
 * batcher coalesced a refetch wave into one `POST /rest-query-batch`; the
 * server resolved that bundle with `Promise.all` and answered only when its
 * SLOWEST member did, so every panel in the wave waited on the worst query in
 * it. That head-of-line coupling is structural — a bundle is indivisible, so no
 * window size could have fixed it — and it is the reason this module exists.
 *
 * The SIZE of the win is transport-dependent, so quote the right number. On the
 * DESKTOP path (webview→sidecar IPC, the one that ships) a 106-query wave costs
 * about the same either way — 2922ms individual at the default gate vs 3000ms
 * bundled — but individual requests paint continuously (p50 395ms) instead of
 * showing nothing until the wall, a ~7.6x better time-to-first-paint at equal
 * total cost. Planning's loopback-HTTP numbers against :3070 (bundle 2676ms vs
 * 1126ms individual) showed a far larger wall win; those do NOT transfer to IPC
 * and must not be used to retune anything — see plan D-003 and the note on
 * `DEFAULT_MAX_IN_FLIGHT` below.
 *
 * What this module keeps from the batcher, deliberately:
 *   - the rows-delta codec round-trip, now per REQUEST rather than per batch
 *     slot (`delta=<cursor>`, `delta=` to opt in cold, refetch-full on a
 *     checksum mismatch — correctness still rides the codec's checksum guard);
 *   - `reportSyncReachable` / `reportSyncUnreachable` connectivity signalling;
 *   - the `{ rows, version }` result shape its callers destructure.
 *
 * What it adds back: per-query `AbortSignal` cancellation, which a bundle
 * structurally could not offer (it is indivisible). An unmounted panel now
 * cancels its in-flight request instead of leaving the server to resolve a
 * query nobody will read — worth having when a wave is ~6MB.
 *
 * NOTE ON `GET`: args ride the query string. Every live sync query's args are
 * small ids/limits, well inside header limits; a resolver that ever needs a
 * large argument object should take a name + a server-side id, not a fatter URL.
 */
import { reportSyncReachable, reportSyncStaleOperator, reportSyncUnreachable } from '../../connectivity';
import { getSyncDeltaCodec, type SyncDeltaMeta } from '../../delta-codec';
import { createConcurrencyGate, type ConcurrencyGate } from './concurrency-gate';

export interface QueryResult {
  rows: unknown[];
  version: string;
  changes?: unknown[];
  delta?: SyncDeltaMeta;
}

export interface QueryFetchOptions {
  /** react-query's per-query signal. Aborts on unmount/cancel. */
  signal?: AbortSignal;
}

export type QueryFetch = (name: string, args: unknown, opts?: QueryFetchOptions) => Promise<QueryResult>;

/**
 * Max sync requests in flight per endpoint.
 *
 * 24, and the number came from the DESKTOP transport rather than from loopback
 * HTTP — that distinction is the whole reason it is not 12. Planning measured
 * this against `:3070` over plain loopback HTTP and found wall time FLAT from
 * concurrency 6 to 24 (1126ms vs 1106ms), which said "pick the low end, it is
 * free, and per-query latency is better there". Re-measured inside a running
 * Tauri shell over the real webview→sidecar IPC path — 106 live sync queries,
 * warmed, 5 interleaved rounds — wall is NOT flat (median ms):
 *
 *     conc=12   4981      p50 212      <- SLOWER than the bundle it replaces
 *     conc=16   3732      p50 307
 *     conc=24   2922      p50 395      <- chosen
 *     one bundle 3000     nothing paints before the wall
 *
 * At 24 the wave finishes as fast as the bundle (2922 vs 3000) AND half the
 * panels have painted by ~395ms instead of every panel waiting ~3000ms — a
 * ~7.6x better time-to-first-paint at equal total cost. At 12 the wall
 * REGRESSES past the bundle, which is the one outcome that would have made
 * dropping the batcher a net loss.
 *
 * The trade is real and deliberate: raising the cap raises per-query p50
 * (212 → 395ms) because parallel resolvers contend for the same PG pool and
 * event loop. It is worth it because the bundle's effective p50 IS its wall.
 *
 * Do not "restore" a lower default from the planning numbers without
 * re-measuring over IPC; loopback-HTTP results do not transfer (plan D-003).
 * The floor still matters for a different reason: on the two paths with a real
 * per-host connection cap (the desktop's pre-`PAPERCUSP_IPC_READY` HTTP
 * fallback and the `:3055` dev browser) the browser grants ~6, and a wave of
 * 106 measured 10.7-11.7s there versus 2-3s over IPC — the gate is what keeps
 * that from starving every other request on the page.
 */
export const DEFAULT_MAX_IN_FLIGHT = 24;

/**
 * Per-request deadline. THIS IS A LIVENESS BOUND ON A GATE SLOT, NOT A GUESS AT
 * USER PATIENCE — do not retune it as if it were the latter.
 *
 * `gate.run` releases its slot in a `finally`, so a slot is held for exactly as
 * long as the request function stays pending. Without a deadline, a transport
 * that never settles owns a slot FOREVER; once `DEFAULT_MAX_IN_FLIGHT` of them
 * are stuck, `acquire()` queues every later caller behind waiters that can never
 * drain, the request function is never invoked, and the caller's promise neither
 * resolves nor rejects — silently, with nothing in the console. That is WI-6559,
 * observed as: click Grade, wait 30s, get an error, while other queries that
 * resolved earlier in the same instance look fine.
 *
 * 20s is chosen to sit UNDER the callers' own ceilings (fetchSyncQuery's
 * PARAMS_TIMEOUT_MS is 30s) so a stuck request surfaces as a real rejection with
 * a real message, instead of the caller timing out against a promise that is
 * still pending. It is far above the measured working range — a 106-query
 * desktop wave completes in ~2.9s at p50 395ms — so it cannot fire on a merely
 * slow query, which is the property that makes it safe.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Max sync requests in flight for a REAL per-host-connection-capped path —
 * i.e. one where `fetch()` opens an actual browser HTTP connection instead of
 * riding the Tauri IPC bridge (which has no such cap; see `DEFAULT_MAX_IN_FLIGHT`
 * above). Two paths are provably always in this bucket: a plain (non-Tauri)
 * browser tab pointed at the dev server, and the desktop's pre-IPC-ready
 * startup window (`installDesktopIpcPolyfills`'s `window.fetch` patch falls
 * back to native HTTP until the sidecar handshake / dev socket connects).
 *
 * WEBKITGTK GRANTS ~6 CONNECTIONS PER HOST. A 24-wide gate on a connection-
 * capped path admits 24 fetches against at most 6 sockets — a wave of 106
 * measured 10.7-11.7s there vs 2-3s over IPC (see `DEFAULT_MAX_IN_FLIGHT`'s
 * doc), and it starves every OTHER request on the page (long-lived SSE
 * streams included) that's competing for the same 6 slots.
 *
 * THIS VALUE IS A SAFE FLOOR, NOT A MEASURED-OPTIMAL NUMBER — do not treat it
 * as tuned. It is deliberately conservative: of the ~6 sockets WebKitGTK
 * grants, this leaves real headroom for the page's own standing streams
 * (sync SSE + the flags stream + — until EI-18758340172989350 /
 * EI-18827862438924553's consolidation lands — a duplicated leader-bridge
 * stream can eat 3-4 of the 6 on its own). Per the `DEFAULT_MAX_IN_FLIGHT`
 * lesson (plan drop-sync-batcher-2026-07-25 D-003), do NOT retune this from
 * loopback-HTTP numbers or by guessing — re-measure inside a real Tauri shell
 * (or a real browser tab) AFTER the standing-stream consolidation lands, and
 * raise it only on a real measurement over the transport that actually ships
 * that path. Follow-up: WI-6460.
 */
export const CONNECTION_CAPPED_MAX_IN_FLIGHT = 2;

interface Fetcher {
  fetchQuery: QueryFetch;
  gate: ConcurrencyGate;
}

const fetchers = new Map<string, Fetcher>();

const keyFor = (restEndpoint: string, tokenQueryParam?: string): string =>
  `${restEndpoint}\u0000${tokenQueryParam ?? ''}`;

/** True when `err` is this request's own cancellation rather than a transport failure. */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/** The exact prefix `GET /rest-query` uses for a resolver the SERVER doesn't
 *  know — see rest-query.ts. Matched verbatim, not fuzzily, so this can never
 *  misfire on an unrelated 400 (a malformed-args error, an auth failure, …). */
const UNKNOWN_QUERY_NAME_PREFIX = 'unknown queryName: ';

async function describeHttpError(
  res: Response,
  name: string,
): Promise<{ message: string; unknownQueryName: boolean }> {
  let detail = '';
  let unknownQueryName = false;
  try {
    const body = (await res.json()) as { error?: string } | null;
    if (body?.error) {
      detail = ` — ${body.error}`;
      unknownQueryName = res.status === 400 && body.error.startsWith(UNKNOWN_QUERY_NAME_PREFIX);
    }
  } catch {
    // Non-JSON error body: the status alone is the diagnosis.
  }
  return { message: `sync query "${name}" failed: HTTP ${res.status}${detail}`, unknownQueryName };
}

/**
 * Process-wide single-query fetcher for one endpoint, sharing ONE concurrency
 * gate across the polling hook, the prefetch helper and `fetchSyncQuery` — a
 * per-caller gate would multiply the cap by the number of callers and defeat it.
 *
 * `maxInFlight` on a later call retunes the existing gate in place rather than
 * minting a second fetcher, so the endpoint keeps exactly one cap.
 */
export function getQueryFetcher(
  restEndpoint: string,
  tokenQueryParam?: string,
  maxInFlight: number = DEFAULT_MAX_IN_FLIGHT,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): QueryFetch {
  const key = keyFor(restEndpoint, tokenQueryParam);
  const existing = fetchers.get(key);
  if (existing) {
    if (existing.gate.limit !== maxInFlight) existing.gate.setLimit(maxInFlight);
    return existing.fetchQuery;
  }

  const gate = createConcurrencyGate(maxInFlight);

  const sendOne = async (
    name: string,
    args: unknown,
    delta: string | undefined,
    signal?: AbortSignal,
  ): Promise<QueryResult> => {
    const params = new URLSearchParams({ name, args: JSON.stringify(args ?? {}) });
    // Only a delta-opted query carries `delta`; absent → the server's full path,
    // byte-identical to a pre-delta request.
    if (delta !== undefined) params.set('delta', delta);
    if (tokenQueryParam) params.set('token', tokenQueryParam);

    // The deadline aborts THIS request if the transport stops answering, so the
    // gate slot it holds is always released. See DEFAULT_REQUEST_TIMEOUT_MS: a
    // slot held forever is what starves every later caller (WI-6559). The
    // caller's own signal is chained in, so an unmount still cancels normally.
    const deadline = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // RACED, not merely aborted. Aborting assumes the transport HONOURS
    // `init.signal` — and the transport that actually hangs here is the desktop's
    // IPC-polyfilled `window.fetch`, which is exactly the one we cannot assume
    // that of. If it ignores the abort, an abort-only deadline leaves the promise
    // pending and the gate slot held, i.e. it would not fix the bug at all. The
    // race guarantees this function settles no matter how the transport behaves,
    // which is the property the gate needs. The abort is still fired, so a
    // well-behaved transport also releases its socket.
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        deadline.abort();
        reject(new Error(`sync query "${name}" timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
    });
    const onCallerAbort = (): void => deadline.abort();
    if (signal) {
      if (signal.aborted) deadline.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      let res: Response;
      try {
        const inFlight = fetch(`${restEndpoint}/rest-query?${params.toString()}`, { signal: deadline.signal });
        // If the race is won by the deadline, the loser can still reject later;
        // swallow that so it is not an unhandled rejection.
        inFlight.catch(() => {});
        res = await Promise.race([inFlight, expiry]);
      } catch (e) {
        // OUR deadline fired: this request is never coming back. Reject loudly
        // rather than leaving the caller to time out against a pending promise —
        // the silent-hang shape is the actual defect being fixed here. Checked
        // BEFORE isAbortError, which would otherwise classify our own abort as
        // the caller's cancellation and swallow it.
        if (timedOut) {
          reportSyncUnreachable();
          throw new Error(`sync query "${name}" timed out after ${requestTimeoutMs}ms`);
        }
        // A request WE cancelled says nothing about whether the origin is up —
        // reporting it as unreachable would flip the whole app offline every time
        // a panel unmounts mid-fetch.
        if (isAbortError(e, signal)) throw e;
        reportSyncUnreachable();
        throw e;
      }
      // ANY HTTP response (error statuses included) proves the origin is up.
      reportSyncReachable();
      if (!res.ok) {
        const { message, unknownQueryName } = await describeHttpError(res, name);
        // WI-5956: this specific shape means the origin is reachable but running
        // OLDER code than this (freshly-rebuilt) client — a version-skew bug, not
        // a per-query fluke. Surface it app-wide (StaleOperatorIndicator) instead
        // of letting it read as one silently-broken panel.
        if (unknownQueryName) reportSyncStaleOperator(name);
        throw new Error(message);
      }
      const json = (await res.json()) as {
        rows?: unknown[];
        changes?: unknown[];
        version?: string;
        delta?: SyncDeltaMeta;
      };
      return {
        rows: json.rows ?? [],
        version: json.version ?? String(Date.now()),
        changes: json.changes,
        delta: json.delta,
      };
    } finally {
      // Covers the BODY read too — a hung `res.json()` holds the slot exactly as
      // effectively as a hung `fetch`, so the timer must outlive the response.
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  };

  /**
   * One gated request under a TOTAL deadline — one that starts when the caller
   * asks, so it covers the QUEUE WAIT as well as the request itself.
   *
   * WI-6559, second half. `gate.run(fn)` is `await acquire()` and THEN `fn()`,
   * and `sendOne` arms its deadline INSIDE `fn` — so that deadline bounds only
   * the request, never the wait to be ALLOWED to make one. A caller queued
   * behind a saturated gate was therefore unbounded: no timeout, no rejection,
   * no console output. That is precisely the silent-hang shape the deadline was
   * written to prevent, surviving in the QUEUED position.
   *
   * Measured live (2026-07-28, Tauri webview): a COLD page's Grade click never
   * produced a card at all — 30s, no error — while the SAME click on a warm
   * page answered in 250ms, because warm hit react-query's cache and never
   * touched the gate. The cold page's startup query wave saturates the gate,
   * `rubrics.list` queues, and nothing ever bounds the wait; the caller's own
   * 30s ceiling then fires, which is the owner's verbatim "click Grade, wait
   * 30s, get an error".
   *
   * Aborting `queueDeadline` drops a QUEUED waiter from the queue and rejects
   * it WITHOUT ever invoking `fn` (see concurrency-gate), so an expiry here
   * cannot leak a waiter that later wakes and fires a request nobody awaits.
   * The signal is chained from the caller's, so an unmount still cancels
   * normally at either stage.
   *
   * Deliberately NOT reported as `reportSyncUnreachable`: exhausting our OWN
   * in-process slots says nothing about whether the origin is up, and flipping
   * the whole app offline for local back-pressure would be a false alarm.
   */
  const runGated = async (
    name: string,
    args: unknown,
    delta: string | undefined,
    signal?: AbortSignal,
  ): Promise<QueryResult> => {
    const queueDeadline = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCallerAbort = (): void => queueDeadline.abort();
    if (signal) {
      if (signal.aborted) queueDeadline.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    // RACED for the same reason sendOne races: a rejection we control is the
    // only way to guarantee this settles regardless of how the gate or the
    // transport behaves.
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        queueDeadline.abort();
        reject(
          new Error(
            `sync query "${name}" timed out after ${requestTimeoutMs}ms waiting for a request slot`,
          ),
        );
      }, requestTimeoutMs);
    });
    try {
      const running = gate.run(() => sendOne(name, args, delta, queueDeadline.signal), queueDeadline.signal);
      // The loser of the race can still reject later; swallow it so it is not
      // an unhandled rejection.
      running.catch(() => {});
      return await Promise.race([running, expiry]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  };

  // Delta-aware wrapper. No codec (the default) or a non-opted-in query → a
  // plain request with NO `delta` param. For a delta query: send the cursor
  // ('' cold), decode into full rows, and on a checksum mismatch / missing base
  // re-request a clean full. A wrong or stale key can only cost a refetch,
  // never a wrong view.
  const fetchQuery: QueryFetch = async (name, args, opts) => {
    const signal = opts?.signal;
    const codec = getSyncDeltaCodec();
    if (!codec?.enabled(name)) return runGated(name, args, undefined, signal);

    const viewKey = codec.viewKey(name, args);
    const cursor = codec.cursorFor(viewKey);
    const raw = await runGated(name, args, cursor ?? '', signal);
    const dec = codec.decodeResult(viewKey, raw);
    if (dec.refetchFull && cursor !== undefined) {
      const full = await runGated(name, args, '', signal);
      const dec2 = codec.decodeResult(viewKey, full);
      return { rows: dec2.rows, version: full.version };
    }
    return { rows: dec.rows, version: raw.version };
  };

  fetchers.set(key, { fetchQuery, gate });
  return fetchQuery;
}

/** The gate backing an endpoint's fetcher — observability and tests. */
export function getFetchGate(restEndpoint: string, tokenQueryParam?: string): ConcurrencyGate | undefined {
  return fetchers.get(keyFor(restEndpoint, tokenQueryParam))?.gate;
}

/** Drop every cached fetcher. Test-only; the map is process-wide by design. */
export function _resetQueryFetchersForTests(): void {
  fetchers.clear();
}
