// @vitest-environment jsdom
//
// The card is the app's half of the keychain gate: it shows for as long as
// the daemon says the keychain is blocked, cannot be dismissed, and a failed
// Unlock says why without going away.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Exit animations would keep a card that already left in the DOM (same
// stand-in as BulkSaveProgress.test.jsx).
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../../services/daemonClient', () => ({
  // Never answers: the card's launch-time ask must not race the state a
  // test sets.
  daemonCall: vi.fn(() => new Promise(() => {})),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../../services/db', () => ({ getAccounts: vi.fn(), clearCredentialsCache: vi.fn() }));
vi.mock('../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../../stores/focusStore', () => ({ notify: vi.fn() }));

const { KeychainUnlockCard } = await import('../KeychainUnlockCard');
const { useKeychainGateStore, __resetKeychainGateForTests } = await import('../../stores/keychainGateStore');

const CARD = 'keychain-unlock-card';

const realUnlock = useKeychainGateStore.getState().unlock;

beforeEach(() => __resetKeychainGateForTests());
afterEach(() => {
  cleanup();
  useKeychainGateStore.setState({ unlock: realUnlock });
});

describe('KeychainUnlockCard', () => {
  it('stays hidden while the keychain is readable', () => {
    render(<KeychainUnlockCard />);
    expect(screen.queryByTestId(CARD)).toBeNull();
  });

  it('explains the keychain when it blocks, as a labelled alert in the corner', () => {
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    const card = screen.getByTestId(CARD);
    expect(card.getAttribute('role')).toBe('alert');
    expect(document.getElementById(card.getAttribute('aria-labelledby')).textContent).toBe('Unlock your keychain');
    expect(card.textContent).toMatch(/macOS Keychain/);
    expect(card.className).toMatch(/fixed/);
  });

  it('offers no way to dismiss it', () => {
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    const buttons = screen.getByTestId(CARD).querySelectorAll('button');
    expect([...buttons].map(b => b.dataset.testid)).toEqual(['keychain-unlock']);
  });

  it('runs the unlock from its primary button', () => {
    const unlock = vi.fn();
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.setState({ blocked: true, unlock }));
    fireEvent.click(screen.getByTestId('keychain-unlock'));
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('says why a failed unlock failed, and stays open', () => {
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.setState({ blocked: true, error: 'denied' }));
    expect(screen.getByTestId(CARD)).toBeTruthy();
    expect(screen.getByTestId('keychain-unlock-error').textContent).toMatch(/Access was refused/);
  });

  it('goes away only once the daemon reports the keychain readable again', () => {
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    act(() => useKeychainGateStore.getState().apply({ blocked: false }));
    expect(screen.queryByTestId(CARD)).toBeNull();
  });
});
