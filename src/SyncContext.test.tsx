import { useCallback } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSyncMutate } from './SyncContext';

describe('useSyncMutate', () => {
  it('uses the current REST fallback after route inputs change', async () => {
    const { result, rerender } = renderHook(
      ({ eventId }) => {
        const fallback = useCallback(async () => eventId, [eventId]);
        return useSyncMutate<Record<string, never>, string>('chat.sendMessage', fallback);
      },
      { initialProps: { eventId: 'sunday-drop' } },
    );

    await expect(result.current({})).resolves.toBe('sunday-drop');

    act(() => rerender({ eventId: 'selected-room' }));

    await expect(result.current({})).resolves.toBe('selected-room');
  });
});
