import { describe, it, expect } from 'vitest';
import {
  createRestQueryHandler,
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

  it('carries resolver timing with an explicit millisecond unit', async () => {
    const res = await handler(new Request('http://t/rest-query?name=q'));
    const body = (await res.json()) as {
      timing?: {
        unit: string;
        resolverStartedAtMs: number;
        resolverCompletedAtMs: number;
        resolverMs: number;
      };
    };
    expect(body.timing?.unit).toBe('ms');
    expect(body.timing?.resolverCompletedAtMs).toBeGreaterThanOrEqual(body.timing?.resolverStartedAtMs ?? 0);
    expect(body.timing?.resolverMs).toBe(
      body.timing!.resolverCompletedAtMs - body.timing!.resolverStartedAtMs,
    );
  });

  it('500 when the resolver throws', async () => {
    const res = await handler(new Request('http://t/rest-query?name=boom'));
    expect(res.status).toBe(500);
  });

  // NO WIRE COMPRESSION (2026-07-26). These are INVERSE guards: re-adding
  // gzip to this transport must red here, not be discovered in a profile.
  // Rationale: the shipping deployment is a loopback desktop sidecar, so
  // compression only trades real CPU on both ends for bytes that never
  // leave the machine.
  it('does NOT compress a large body even when accept-encoding allows gzip', async () => {
    const res = await handler(
      new Request('http://t/rest-query?name=big', { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    // Body is readable as plain JSON — no decompression step.
    const json = (await res.json()) as { rows: unknown[] };
    expect(json.rows).toHaveLength(1);
  });

  it('does NOT compress a small body when accept-encoding allows gzip', async () => {
    const res = await handler(
      new Request('http://t/rest-query?name=q', { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('499 on an already-aborted request', async () => {
    const res = await handler(new Request('http://t/rest-query?name=q', { signal: AbortSignal.abort() }));
    expect(res.status).toBe(499);
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
      { name: 'invalidate', data: { name: 'plans.items', args: { h: 'x' }, tsMs: 0 }, id: 2 },
      { name: 'update', data: { name: 'plans.get', data: [{ slug: 'a' }], tsMs: 0 }, id: 3 },
    ]);
  });
});
