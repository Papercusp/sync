'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered when a descendant throws during render, commit, or in an effect. */
  onError: (error: Error) => void;
  fallback: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Defense-in-depth: catches any synchronous throw from inside the lazy-loaded
 * WebSocket adapter (Zero construction, ZeroProvider, useQuery hooks) and
 * renders the polling adapter instead. Without this, a throwing
 * `new WebSocket()` — as produced by the WebSocket Toggle extension — can
 * unmount the entire island subtree and leave the grid blank.
 */
export class WebSocketErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.warn('[Sync] WebSocket subtree threw — falling back to polling:', error.message);
    this.props.onError(error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
