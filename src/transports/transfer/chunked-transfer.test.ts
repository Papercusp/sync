import { afterEach, describe, expect, it } from 'vitest';

import { _resetOriginSchedulersForTests } from '../polling/origin-scheduler';
import { parseTransportCapability } from './transport-capability';
import { resolveTransferPlane } from './transfer-origin';
import {
  ChunkedTransferError,
  planChunks,
  runChunkedTransfer,
  type TransferChunk,
} from './chunked-transfer';

const CONTROL_ORIGIN = 'https://portal.papercusp.test';
const CHUNK = 64 * 1024;

function plane(overrides: Record<string, unknown> = {}) {
  return resolveTransferPlane(
    parseTransportCapability({
      mode: 'reverse-connector',
      transferOrigin: 'https://bulk.papercusp.test',
      resumable: true,
      chunkBytes: CHUNK,
      maxConcurrentChunks: 4,
      ticketTtlSec: 120,
      ...overrides,
    }),
    CONTROL_ORIGIN,
  );
}

afterEach(() => {
  _resetOriginSchedulersForTests();
});

describe('planChunks', () => {
  it('covers the whole range with no gaps or overlaps', () => {
    const chunks = planChunks(10_000, 4_000);
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 4_000 },
      { index: 1, start: 4_000, end: 8_000 },
      { index: 2, start: 8_000, end: 10_000 },
    ]);
    const covered = chunks.reduce((sum, c) => sum + (c.end - c.start), 0);
    expect(covered).toBe(10_000);
  });

  it('yields ONE empty chunk for a zero-length transfer, not zero chunks', () => {
    // Zero chunks would make an empty file "succeed" without ever contacting
    // the host, which is a silent no-op rather than a transfer.
    expect(planChunks(0, CHUNK)).toEqual([{ index: 0, start: 0, end: 0 }]);
  });

  it('rejects a negative size or a non-positive chunk size', () => {
    expect(() => planChunks(-1, CHUNK)).toThrow(ChunkedTransferError);
    expect(() => planChunks(100, 0)).toThrow(ChunkedTransferError);
  });
});

describe('runChunkedTransfer', () => {
  it('transfers every chunk exactly once and reports progress', async () => {
    const p = plane();
    const seen: number[] = [];
    const progress: number[] = [];

    const result = await runChunkedTransfer({
      plane: p,
      totalBytes: CHUNK * 3 + 17,
      sendChunk: async (chunk) => {
        seen.push(chunk.index);
      },
      onProgress: (snapshot) => progress.push(snapshot.completedChunks),
    });

    expect(result.totalChunks).toBe(4);
    expect(result.transferredChunks).toBe(4);
    expect(result.skippedChunks).toBe(0);
    expect(result.bytesTransferred).toBe(CHUNK * 3 + 17);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(progress.at(-1)).toBe(4);
  });

  it('RESUMES from the completed set instead of re-sending accepted chunks', async () => {
    const p = plane();
    const seen: number[] = [];

    const result = await runChunkedTransfer({
      plane: p,
      totalBytes: CHUNK * 4,
      completed: [0, 1],
      sendChunk: async (chunk) => {
        seen.push(chunk.index);
      },
    });

    expect(seen.sort((a, b) => a - b)).toEqual([2, 3]);
    expect(result.skippedChunks).toBe(2);
    expect(result.transferredChunks).toBe(2);
    expect(result.completed).toEqual([0, 1, 2, 3]);
    // Bytes already accepted still count toward the total.
    expect(result.bytesTransferred).toBe(CHUNK * 4);
  });

  it('preserves a resume cursor on failure so a retry need not restart', async () => {
    const p = plane({ maxConcurrentChunks: 1 });
    let attempt = 0;

    const failure = await runChunkedTransfer({
      plane: p,
      totalBytes: CHUNK * 4,
      sendChunk: async (chunk: TransferChunk) => {
        attempt += 1;
        if (chunk.index === 2) throw new Error('connector reset');
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChunkedTransferError);
    const err = failure as ChunkedTransferError & { completed?: number[] };
    expect(err.code).toBe('chunk_failed');
    expect(err.chunkIndex).toBe(2);
    expect(err.completed).toBeDefined();
    // The cursor must actually carry the accepted work forward.
    expect(err.completed).toContain(0);
    expect(err.completed).not.toContain(2);
    expect(attempt).toBeGreaterThan(0);
  });

  it('REFUSES to resume against a host that declared resumable:false', async () => {
    const p = plane({ resumable: false });

    await expect(
      runChunkedTransfer({
        plane: p,
        totalBytes: CHUNK * 3,
        completed: [0],
        sendChunk: async () => {},
      }),
    ).rejects.toThrow(/resumable:false/);

    // A fresh transfer against the same host is still fine — only CONTINUING
    // one is refused.
    const fresh = await runChunkedTransfer({
      plane: p,
      totalBytes: CHUNK * 2,
      sendChunk: async () => {},
    });
    expect(fresh.transferredChunks).toBe(2);
  });

  it('issues every chunk on the TRANSFER scheduler, never the control one', async () => {
    const p = plane({ maxConcurrentChunks: 2 });
    let maxObservedInFlight = 0;

    await runChunkedTransfer({
      plane: p,
      totalBytes: CHUNK * 8,
      sendChunk: async () => {
        const snapshot = p.scheduler.snapshot();
        maxObservedInFlight = Math.max(maxObservedInFlight, snapshot.inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });

    // Concurrency came from the plane's own limiter, and stayed within the
    // host's declared chunk concurrency.
    expect(maxObservedInFlight).toBeGreaterThan(0);
    expect(maxObservedInFlight).toBeLessThanOrEqual(2);
    expect(p.scheduler.snapshot().byClass.bulk.completed).toBe(8);
  });
});
