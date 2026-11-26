// @vitest-environment jsdom
// Edge back pops the top layer the way System Back does (backStack.js).
import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { pushLayer, popTopLayer } from '../backStack.js';

describe('popTopLayer', () => {
  it('does nothing with no layer open', () => {
    expect(popTopLayer()).toBe(false);
  });
  it('closes only the top layer, like Back', async () => {
    const lower = vi.fn();
    const top = vi.fn();
    const releaseLower = pushLayer(lower);
    pushLayer(top);
    expect(popTopLayer()).toBe(true);
    await waitFor(() => expect(top).toHaveBeenCalledTimes(1));
    expect(lower).not.toHaveBeenCalled();
    releaseLower();
  });
});
