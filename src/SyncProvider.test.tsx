/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { useContext } from 'react';
import { render, screen } from '@testing-library/react';
import { SyncContext } from './SyncContext';
import { normalizeSyncType, SyncProvider } from './SyncProvider';

function TransportProbe() {
  const context = useContext(SyncContext);
  return <output data-testid="transport">{context?.transport ?? 'missing'}</output>;
}

describe('SyncProvider transport compatibility', () => {
  it('normalizes the removed WebSocket preference to SSE', () => {
    expect(normalizeSyncType('WEBSOCKETS')).toBe('SSE');
    expect(normalizeSyncType('SSE')).toBe('SSE');
    expect(normalizeSyncType('POLLING')).toBe('POLLING');
  });

  it('exposes SSE even during the pending and mounted phases for legacy input', () => {
    render(
      <SyncProvider syncType="WEBSOCKETS">
        <TransportProbe />
      </SyncProvider>,
    );

    expect(screen.getByTestId('transport').textContent).toBe('SSE');
  });
});
