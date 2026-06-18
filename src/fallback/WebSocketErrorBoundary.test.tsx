// @vitest-environment jsdom
//
// WebSocketErrorBoundary — defense-in-depth resilience: a synchronous throw from
// the lazy WS adapter subtree must NOT blank the island; the boundary renders the
// polling fallback and reports the error so the host can switch transports. Pinned
// because the failure mode (blank grid on a throwing `new WebSocket()`) is exactly
// the kind of production white-screen this guards against. React logs caught errors
// to console (+ the boundary's own warn) — suppressed since the lib is fail-on-console.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WebSocketErrorBoundary } from './WebSocketErrorBoundary';

function Boom(): never {
  throw new Error('ws boom');
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('WebSocketErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    const onError = vi.fn();
    render(
      <WebSocketErrorBoundary onError={onError} fallback={<div>fallback</div>}>
        <div>healthy-child</div>
      </WebSocketErrorBoundary>,
    );
    expect(screen.getByText('healthy-child')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('renders the fallback and reports the error when a descendant throws', () => {
    const onError = vi.fn();
    render(
      <WebSocketErrorBoundary onError={onError} fallback={<div>polling-fallback</div>}>
        <Boom />
      </WebSocketErrorBoundary>,
    );
    expect(screen.getByText('polling-fallback')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0][0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('ws boom');
  });
});
