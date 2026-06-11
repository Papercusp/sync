'use client';

/**
 * Sync connectivity store — "can this page reach its data origin right now?"
 *
 * The transport adapters already see every outcome that matters: an SSE
 * stream opening, a reconnect attempt failing, a REST batch fetch throwing.
 * This module folds those reports into one boolean an app shell can render
 * as an offline banner (the gap behind EI-239: the operator died and the UI
 * looked healthy-but-empty with every action silently failing).
 *
 * Semantics:
 * - Only NETWORK-LEVEL failures count toward offline (fetch/stream could not
 *   connect). An HTTP error response proves the origin is reachable — a 500
 *   is a server bug, not connectivity loss — so adapters report it as
 *   reachable.
 * - Offline flips on after `OFFLINE_AFTER_CONSECUTIVE` consecutive
 *   unreachable reports (a single blip that recovers on the next attempt
 *   never shows the banner) and clears on the first reachable report.
 *
 * Same module-scope listener-registry idiom as `bus-tap.ts`: one store, many
 * subscribers, render-only state.
 */

import { useSyncExternalStore } from 'react';

export interface SyncConnectivity {
  offline: boolean;
  /** Epoch ms when the current offline stretch started; 0 while online. */
  offlineSinceMs: number;
}

const OFFLINE_AFTER_CONSECUTIVE = 2;

const ONLINE: SyncConnectivity = { offline: false, offlineSinceMs: 0 };

let consecutiveFailures = 0;
let state: SyncConnectivity = ONLINE;
const listeners = new Set<() => void>();

function setState(next: SyncConnectivity): void {
  state = next;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a throwing subscriber never blocks the store */
    }
  }
}

/**
 * Transport-side: a network-level failure — fetch threw, or the stream's
 * reconnect attempts are failing. HTTP error responses do NOT belong here.
 */
export function reportSyncUnreachable(): void {
  consecutiveFailures += 1;
  if (!state.offline && consecutiveFailures >= OFFLINE_AFTER_CONSECUTIVE) {
    setState({ offline: true, offlineSinceMs: Date.now() });
  }
}

/**
 * Transport-side: any proof the origin answered — a stream opened, or a
 * fetch resolved to ANY HTTP response (including error statuses).
 */
export function reportSyncReachable(): void {
  consecutiveFailures = 0;
  if (state.offline) setState(ONLINE);
}

export function getSyncConnectivity(): SyncConnectivity {
  return state;
}

/** Subscribe to connectivity flips. Returns an unsubscribe function. */
export function onSyncConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook — re-renders on offline/online flips. SSR snapshot is online. */
export function useSyncConnectivity(): SyncConnectivity {
  return useSyncExternalStore(onSyncConnectivity, getSyncConnectivity, () => ONLINE);
}

/** Test seam — clears failures, listeners stay registered. */
export function _resetSyncConnectivityForTests(): void {
  consecutiveFailures = 0;
  state = ONLINE;
}
