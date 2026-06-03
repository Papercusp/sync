import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  createRestQueryHandler,
  createRestBatchHandler,
  createSseHandler,
  type SsePrimitives,
} from './http-routes';
import { NAME_NOT_FOUND, type NamedQueryResolver } from './query-registry';
import type { SyncEvent } from './invalidation-bus';

const resolver: NamedQueryResolver = async (name, args) => {
  if (name === 'boom') throw new Error('kaboom');
  if (name === 'missing') return NAME_NOT_FOUND;
  if (name === 'big') return [{ blob: 'x'.repeat(4000) }];
  return [{ name, args }];
};

describe('createRestQueryHandler', () => {
  const handler = createRestQueryHandler(resolver);

  it('400 on missing name', async () => {
    const res = await handler(new Request('http://t/rest-query'));
    expect(res.status).toBe(400);
  });

  it('400 on invalid args JSON', async () => {
    const res = await handler(new Request('http://t/rest-query?name=q&args=%7Bbad'));
    expect(res.status).toBe(400);
  });

  it('400 on unknown query name', async () => {
    const res = await handler(new Request('http://t/rest-query?name=missing'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ name: 'missing' });
  });

  it('200 with { rows, version } on success', async () => {
    const res = await handler(
      new Request('http://t/rest-query?name=q&args=' + encodeURIComponent('{"a":1}')),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; version: string };
    expect(body.rows).toEqual([{ name: 'q', args: { a: 1 } }]);
    expect(typeof body.version).toBe('string');
  });

  it('500 when the resolver throws', async () => {
    const res = await handler(new Request('http://t/rest-query?name=boom'));
    expect(res.status).toBe(500);
  });

  it('gzips a large body when accept-encoding allows', async () => {
    const res = await handler(
      new Request('http://t/rest-query?name=big', { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const buf = Buffer.from(await res.arrayBuffer());
    const json = JSON.parse(gunzipSync(buf).toString()) as { rows: unknown[] };
    expect(json.rows).toHaveLength(1);
  });

  it('499 on an already-aborted request', async () => {
    const res = await handler(new Request('http://t/rest-query?name=q', { signal: AbortSignal.abort() }));
    expect(res.status).toBe(499);
  });
});

describe('createRestBatchHandler', () => {
  const handler = createRestBatchHandler(resolver);

  it('400 on non-array body', async () => {
    const res = await handler(
      new Request('http://t/batch', { method: 'POST', body: JSON.stringify({ queries: {} }) }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when batch exceeds the cap', async () => {
    const h = createRestBatchHandler(resolver, { maxBatch: 1 });
    const res = await h(
      new Request('http://t/batch', {
        method: 'POST',
        body: JSON.stringify({ queries: [{ name: 'a' }, { name: 'b' }] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns positional results with per-slot errors', async () => {
    const res = await handler(
      new Request('http://t/batch', {
        method: 'POST',
        body: JSON.stringify({ queries: [{ name: 'q', args: { i: 1 } }, { name: 'missing' }, { name: 'boom' }] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ rows?: unknown[]; error?: string }> };
    expect(body.results[0].rows).toEqual([{ name: 'q', args: { i: 1 } }]);
    expect(body.results[1].error).toMatch(/unknown queryName/);
    expect(body.results[2].error).toMatch(/kaboom/);
  });
});

describe('createSseHandler', () => {
  it('maps backfill + live events to update/invalidate via injected sse', async () => {
    // Model a reconnect: client sends Last-Event-ID = 1, so events 2 & 3 replay.
    const events: SyncEvent[] = [
      { id: 2, ts: 0, name: 'plans.items', args: { h: 'x' } },
      { id: 3, ts: 0, name: 'plans.get', data: [{ slug: 'a' }] },
    ];
    const bus = {
      subscribe: async (_send: (e: SyncEvent) => void) => ({ close: () => {} }),
      backfillSince: (id: number) => events.filter((e) => e.id > id),
    };
    let replayed: Array<{ name: string; data: unknown; id: number }> = [];
    const sse: SsePrimitives = {
      parseLastEventId: () => 1,
      sseResponse: (opts) => {
        replayed = opts.replay ? opts.replay() : [];
        return new Response('ok');
      },
    };
    const handler = createSseHandler(bus, sse);
    const res = await handler(new Request('http://t/sse'));
    expect(res.status).toBe(200);
    expect(replayed).toEqual([
      { name: 'invalidate', data: { name: 'plans.items', args: { h: 'x' } }, id: 2 },
      { name: 'update', data: { name: 'plans.get', data: [{ slug: 'a' }] }, id: 3 },
    ]);
  });
});
