'use client';

import { type ReactNode } from 'react';
import { PollingAdapter } from '../polling/PollingAdapter';

/**
 * SSE Transport — STUB
 *
 * TODO: Implement Server-Sent Events transport.
 * When implemented, this adapter will:
 * 1. Open an EventSource to a /zero/sse endpoint
 * 2. Receive push notifications when data changes
 * 3. Use TanStack Query for initial data load + SSE for invalidation
 *
 * For now, falls through to PollingAdapter identically.
 */

interface SSEAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  pollIntervalMs?: number;
  onTransportError?: (error: Error) => void;
}

export function SSEAdapter(props: SSEAdapterProps) {
  // SSE stub — behaves exactly like polling
  // TODO: Replace with EventSource-based implementation
  console.debug('[Sync] SSE transport not yet implemented — falling back to polling');
  return <PollingAdapter {...props} />;
}
