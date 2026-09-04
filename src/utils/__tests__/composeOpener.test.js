import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerComposeOpener, openCompose } from '../composeOpener';

// App registers its compose state setter; surfaces with no compose prop
// (the list's row menus) hand a ComposeModal state through here.

// Module-level state: a spy registered by one case must not survive into the next.
afterEach(() => registerComposeOpener(null));

describe('composeOpener', () => {
  it('hands the state to whoever App registered, and says so', () => {
    const open = vi.fn();
    registerComposeOpener(open);
    const state = { mode: 'reply', replyTo: { uid: 7 } };
    expect(openCompose(state)).toBe(true);
    expect(open).toHaveBeenCalledWith(state);
  });

  it('answers false once the surface is gone, and opens nothing', () => {
    const open = vi.fn();
    registerComposeOpener(open);
    registerComposeOpener(null);
    expect(openCompose({ initialData: {} })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
