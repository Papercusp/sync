import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Same helper as apps/operator/lib/lazy-with-retry.ts. Duplicated here so
// libs/sync stays standalone and doesn't depend on the consumer app.
export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  opts: { retries?: number; intervalMs?: number; reloadOnFail?: boolean } = {},
): LazyExoticComponent<T> {
  const retries = opts.retries ?? 3;
  const intervalMs = opts.intervalMs ?? 400;
  const reloadOnFail = opts.reloadOnFail ?? process.env.NODE_ENV !== 'production';
  return lazy(() =>
    new Promise<{ default: T }>((resolve, reject) => {
      const attempt = (n: number) => {
        loader().then(resolve).catch((err: unknown) => {
          const msg = (err as { message?: string } | null)?.message ?? '';
          const isChunkErr =
            (err as { name?: string } | null)?.name === 'ChunkLoadError' ||
            /Failed to (load|fetch) chunk|Loading chunk \d+ failed/i.test(msg);
          if (!isChunkErr || n <= 0) {
            if (isChunkErr && reloadOnFail && typeof window !== 'undefined') {
              const k = '__chunkReloadOnce__';
              if (!sessionStorage.getItem(k)) {
                sessionStorage.setItem(k, '1');
                window.location.reload();
                return;
              }
            }
            reject(err);
            return;
          }
          setTimeout(() => attempt(n - 1), intervalMs);
        });
      };
      attempt(retries);
    }),
  );
}
