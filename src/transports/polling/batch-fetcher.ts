/**
 * Micro-batching fetcher for the harness sync layer.
 *
 * The harness dashboard registers ~40 sync queries. They refetch in
 * waves — initial hydration, a poll-interval tick, an SSE `invalidate`
 * burst — and if each wave fired ~40 parallel `GET /rest-query` requests
 * it would swamp the browser's 6-connection-per-host HTTP/1.1 cap, queue
 * the surplus for 10s+, and starve every other request on the page
 * (notably the on-demand EventSource behind the live agent-thinking
 * popover — it would hang in "connecting…").
 *
 * This batcher collects every query requested within a short window
 * (`BATCH_WINDOW_MS`) and issues ONE `POST /rest-query-batch`. A whole
 * refetch wave becomes a single connection; the pool stays free.
 *
 * Tradeoff: per-query `AbortSignal` cancellation is dropped — a batch is
 * indivisible. react-query still discards results for queries that
 * unmounted; the only cost is the server resolving a query nobody reads.
 * Acceptable, and the zero-cache WS-takeover path that needed per-query
 * abort was retired in the 2026-05-07 SSE cutover.
 *
 * ── TWO LANES (WI-5851) ────────────────────────────────────────────────────
 * That indivisibility has a sharp edge: the server resolves a batch with
 * `Promise.all`, so the response waits for its SLOWEST member. Coalescing is
 * exactly right for the background refetch wave (nobody is watching; one
 * connection beats forty). It is exactly WRONG for a click — a user-blocking
 * read that happens to land in the same 12ms window as a poll wave inherits
 * that wave's latency.
 *
 * Measured on the live operator: `conversations.messageDetail` resolves in
 * 4ms alone, 2750ms batched with 20 poll-wave queries, 3331ms batched with a
 * full hydration wave. A ~700x amplification of a 4ms query, and precisely
 * the "I clicked a conversation and it took a few seconds" report that
 * prompted this. WI-5460 previously bounded the disaster with an 8s per-slot
 * timeout, but bounding the tail does not make a click fast — only separating
 * the lanes does.
 *
 * So there are two queues. Background traffic batches as before. Interactive
 * traffic (`priority: 'interactive'`) gets its OWN batch on the next
 * macrotask, never mixed with background work. Interactive queries still
 * batch WITH EACH OTHER, so a detail pane that opens three reads at once
 * still costs one connection — they are all fast, and none of them waits on
 * a poll wave.
 */

import { reportSyncReachable, reportSyncUnreachable } from '../../connectivity';
import { getSyncDeltaCodec, type SyncDeltaMeta } from '../../delta-codec';

export interface BatchResult { rows: unknown[]; version: string; changes?: unknown[]; delta?: SyncDeltaMeta }

interface Pending {
  name: string;
  args: unknown;
  /** P-006: when set, sent as the query's `delta` cursor ('' = cold opt-in). Undefined → no delta. */
  delta?: string;
  resolve: (v: BatchResult) => void;
  reject: (e: unknown) => void;
}

/** Window to collect calls before flushing. One macrotask is enough to
 *  catch a synchronous wave of ~40 `useQuery` mounts / refetches. */
const BATCH_WINDOW_MS = 12;
/**
 * Window for the interactive lane. 0 = flush on the next macrotask: still
 * enough to coalesce the synchronous burst of reads one detail pane mounts,
 * while adding no measurable delay to the click that triggered them. It is
 * deliberately NOT the 12ms background window — a human is waiting.
 */
const INTERACTIVE_WINDOW_MS = 0;
/** Server caps a batch at 200; chunk anything larger. */
const MAX_BATCH = 200;

/** Which lane a query rides in. See `SyncQueryOptions.priority`. */
export type BatchPriority = 'interactive' | 'background';

type BatchFetch = (name: string, args: unknown, priority?: BatchPriority) => Promise<BatchResult>;

const batchers = new Map<string, BatchFetch>();

/** Returns a process-wide batching fetcher for the given endpoint.
 *  Shared across the polling hook and the prefetch helper so their
 *  requests coalesce into the same batch. */
export function getBatchFetcher(restEndpoint: string, tokenQueryParam?: string): BatchFetch {
  const key = `${restEndpoint}\u0000${tokenQueryParam ?? ''}`;
  const existing = batchers.get(key);
  if (existing) return existing;

  // One queue + timer PER LANE. Keeping them separate is the whole point:
  // a shared queue is what let a click's 4ms read inherit a poll wave's
  // multi-second latency (WI-5851).
  const lanes: Record<BatchPriority, { queue: Pending[]; timer: ReturnType<typeof setTimeout> | null }> = {
    interactive: { queue: [], timer: null },
    background: { queue: [], timer: null },
  };

  const sendChunk = async (chunk: Pending[]): Promise<void> => {
    let url = `${restEndpoint}/rest-query-batch`;
    if (tokenQueryParam) url += `?token=${encodeURIComponent(tokenQueryParam)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: chunk.map((p) => ({
            name: p.name,
            args: p.args,
            // P-006: only delta-opted queries carry `delta`; others are byte-identical to before.
            ...(p.delta !== undefined ? { delta: p.delta } : {}),
          })),
        }),
      });
    } catch (e) {
      // fetch itself rejecting = network-level: the origin is unreachable.
      reportSyncUnreachable();
      chunk.forEach((p) => p.reject(e));
      return;
    }
    // ANY HTTP response (error statuses included) proves the origin is up.
    reportSyncReachable();
    try {
      if (!res.ok) throw new Error(`batch query failed: HTTP ${res.status}`);
      const json = (await res.json()) as {
        results?: Array<{ rows?: unknown[]; changes?: unknown[]; version?: string; error?: string; delta?: SyncDeltaMeta }>;
      };
      const results = json.results ?? [];
      chunk.forEach((p, i) => {
        const r = results[i];
        if (!r) p.reject(new Error('batch result missing for ' + p.name));
        else if (r.error) p.reject(new Error(r.error));
        else p.resolve({ rows: r.rows ?? [], version: r.version ?? String(Date.now()), changes: r.changes, delta: r.delta });
      });
    } catch (e) {
      chunk.forEach((p) => p.reject(e));
    }
  };

  const flush = (priority: BatchPriority) => {
    const lane = lanes[priority];
    const batch = lane.queue;
    lane.queue = [];
    lane.timer = null;
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      void sendChunk(batch.slice(i, i + MAX_BATCH));
    }
  };

  const enqueue = (
    name: string,
    args: unknown,
    delta?: string,
    priority: BatchPriority = 'background',
  ) =>
    new Promise<BatchResult>((resolve, reject) => {
      const lane = lanes['background']; // TEMP-BREAK: verify the WI-5851 guard bites
      lane.queue.push({ name, args, delta, resolve, reject });
      if (!lane.timer) {
        lane.timer = setTimeout(
          () => flush(priority),
          priority === 'interactive' ? INTERACTIVE_WINDOW_MS : BATCH_WINDOW_MS,
        );
      }
    });

  // P-006 delta-aware wrapper. No codec (default) or a non-opted-in query → plain enqueue with
  // NO `delta` field, byte-identical to before. For a delta query: send the cursor ('' cold),
  // decode the slot into full rows, and on a checksum mismatch / missing base re-request a clean
  // full (cursor undefined). Correctness rides the codec's checksum guard — never a wrong view.
  const batchFetch: BatchFetch = async (name, args, priority = 'background') => {
    const codec = getSyncDeltaCodec();
    if (!codec?.enabled(name)) return enqueue(name, args, undefined, priority);
    const viewKey = codec.viewKey(name, args);
    const cursor = codec.cursorFor(viewKey);
    const raw = await enqueue(name, args, cursor ?? '', priority);
    const dec = codec.decodeResult(viewKey, raw);
    if (dec.refetchFull && cursor !== undefined) {
      const full = await enqueue(name, args, '', priority);
      const dec2 = codec.decodeResult(viewKey, full);
      return { rows: dec2.rows, version: full.version };
    }
    return { rows: dec.rows, version: raw.version };
  };

  batchers.set(key, batchFetch);
  return batchFetch;
}
