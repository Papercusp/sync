/**
 * Framework-neutral HTTP handler factories for the sync server half.
 *
 * Each factory returns a `(req: Request) => Promise<Response>` using only
 * Web-standard Request/Response (+ node:zlib for gzip). The host mounts
 * them under whatever router it uses (the operator wraps each in a
 * `defineTool({ method, path, auth, handler })`). The named-query resolver
 * and the SSE primitives are INJECTED, so this module pulls in no domain
 * or transport dependency.
 *
 * Wire contract (matches the client transport):
 *   GET  rest-query?name=&args=<json>      → { rows, version } | { error }
 *   POST rest-query-batch { queries[] }    → { results: ({rows,version}|{error})[] }
 *   GET  sse                               → text/event-stream (invalidate|update|heartbeat)
 */

import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { NAME_NOT_FOUND, type NamedQueryResolver } from './query-registry';
import type { SyncEvent } from './invalidation-bus';

// Async gzip — the sync-batch read path combines up to ~200 query results, and
// `gzipSync` ran fully synchronously on the one HTTP/MCP event loop, blocking
// every heartbeat + concurrent request for the duration of the compression
// (operator-scalability-event-loop-2026-06-16 P1-2). `zlib.gzip` runs on
// libuv's threadpool, so the loop stays free while it compresses.
const gzip = promisify(gzipCb);

const GZIP_MIN_BYTES = 1024;

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Gzip the body when the client accepts it and it's worth it. */
async function bodyResponse(req: Request, body: string): Promise<Response> {
  const acceptsGzip = (req.headers.get('accept-encoding') ?? '')
    .toLowerCase()
    .includes('gzip');
  if (acceptsGzip && body.length >= GZIP_MIN_BYTES) {
    return new Response(await gzip(body), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        vary: 'accept-encoding',
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** GET rest-query?name=&args=<json> — single named query. */
export function createRestQueryHandler(
  resolve: NamedQueryResolver,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const name = u.searchParams.get('name');
    if (!name) return jsonResponse({ error: 'missing name' }, 400);
    let args: unknown;
    try {
      args = JSON.parse(u.searchParams.get('args') ?? '{}');
    } catch {
      return jsonResponse({ error: 'invalid args (not JSON)' }, 400);
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    try {
      const rows = await resolve(name, args);
      if (rows === NAME_NOT_FOUND) {
        return jsonResponse({ error: `unknown queryName: ${name}`, name }, 400);
      }
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return await bodyResponse(req, JSON.stringify({ rows, version: String(Date.now()) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: msg, name }, 500);
    }
  };
}

interface BatchQuery {
  name: string;
  args?: unknown;
}

/** POST rest-query-batch { queries[] } — positional results, per-slot errors. */
export function createRestBatchHandler(
  resolve: NamedQueryResolver,
  opts?: { maxBatch?: number },
): (req: Request) => Promise<Response> {
  const maxBatch = opts?.maxBatch ?? 200;
  return async (req: Request): Promise<Response> => {
    let body: { queries?: BatchQuery[] };
    try {
      body = (await req.json()) as { queries?: BatchQuery[] };
    } catch {
      return jsonResponse({ error: 'invalid body (not JSON)' }, 400);
    }
    const list = body?.queries;
    if (!Array.isArray(list) || list.length === 0) {
      return jsonResponse({ error: 'body.queries must be a non-empty array' }, 400);
    }
    if (list.length > maxBatch) {
      return jsonResponse({ error: `batch too large (max ${maxBatch})` }, 400);
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });

    const version = String(Date.now());
    const results = await Promise.all(
      list.map(async (q) => {
        if (!q || typeof q.name !== 'string') return { error: 'missing query name' };
        try {
          const rows = await resolve(q.name, q.args ?? {});
          if (rows === NAME_NOT_FOUND) return { error: `unknown queryName: ${q.name}` };
          return { rows, version };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return await bodyResponse(req, JSON.stringify({ results }));
  };
}

/**
 * SSE primitives injected from the host's `@papercusp/sse` (kept out of
 * this module so the lib's own tests don't need it linked).
 */
export interface SsePrimitives {
  parseLastEventId: (req: Request) => number | null;
  sseResponse: (opts: {
    signal: AbortSignal;
    lastEventId: number | null;
    heartbeatMs?: number;
    initialHeartbeat?: boolean;
    replay?: () => Array<{ name: string; data: unknown; id: number }>;
    setup: (sink: {
      closed: boolean;
      event: (name: string, data: unknown, meta?: { id?: number }) => void;
      onClose: (fn: () => void) => void;
    }) => void | Promise<void>;
  }) => Response;
}

function payloadFor(ev: SyncEvent): { name: string; args?: unknown; data?: unknown[] } {
  const out: { name: string; args?: unknown; data?: unknown[] } = { name: ev.name };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

/** GET sse — text/event-stream of invalidate|update events + heartbeat. */
export function createSseHandler(
  bus: {
    subscribe(send: (e: SyncEvent) => void): Promise<{ close: () => void }>;
    backfillSince(lastEventId: number): SyncEvent[];
  },
  sse: SsePrimitives,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const lastEventId = sse.parseLastEventId(req);
    return sse.sseResponse({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return bus.backfillSince(lastEventId).map((ev) => ({
          name: ev.data !== undefined ? 'update' : 'invalidate',
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await bus.subscribe((ev) => {
          if (sink.closed) return;
          sink.event(ev.data !== undefined ? 'update' : 'invalidate', payloadFor(ev), {
            id: ev.id,
          });
        });
        sink.onClose(handle.close);
      },
    });
  };
}
