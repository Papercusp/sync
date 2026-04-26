'use client';

import { useMemo, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SyncContext } from '../../SyncContext';
import { getQueryClient } from './queryClient';
import { createUsePollingQuery, createPrefetchSync } from './usePollingQuery';
import type { SyncType } from '../../types';

interface PollingAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  pollIntervalMs?: number;
  onTransportError?: (error: Error) => void;
}

const DEFAULT_REST_ENDPOINT = 'http://localhost:3100/zero';

export function PollingAdapter({
  children,
  restEndpoint,
  server,
  pollIntervalMs = 10_000,
}: PollingAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () => createUsePollingQuery({ restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs }),
    [endpoint, pollIntervalMs],
  );

  const prefetch = useMemo(
    () => createPrefetchSync({ restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs }, queryClient),
    [endpoint, pollIntervalMs, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'POLLING' as SyncType, useDataImpl, prefetch }),
    [useDataImpl, prefetch],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SyncContext.Provider value={ctxValue}>
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
