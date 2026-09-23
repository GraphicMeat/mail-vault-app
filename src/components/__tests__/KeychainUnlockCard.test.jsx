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

  it('shakes when the user clicks anywhere else, and not for clicks on itself', () => {
    render(<div><button data-testid="elsewhere">x</button><KeychainUnlockCard /></div>);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    const nudge = () => screen.getByTestId(CARD).querySelector('[data-nudge]');
    expect(nudge().getAttribute('data-nudge')).toBe('0');
    expect(nudge().className).not.toMatch(/animate-nudge/);

    fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    expect(nudge().getAttribute('data-nudge')).toBe('1');
    expect(nudge().className).toMatch(/animate-nudge/);

    fireEvent.pointerDown(screen.getByTestId('keychain-unlock'));
    expect(nudge().getAttribute('data-nudge')).toBe('1');

    // Readable again: the card is gone and clicks no longer count.
    act(() => useKeychainGateStore.getState().apply({ blocked: false }));
    fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    expect(screen.queryByTestId(CARD)).toBeNull();
  });

  it('starts the unlock on every third click past it, never while one runs', () => {
    const unlock = vi.fn();
    render(<div><button data-testid="elsewhere">x</button><KeychainUnlockCard /></div>);
    act(() => useKeychainGateStore.setState({ blocked: true, unlock }));
    const clickPast = (n) => { for (let i = 0; i < n; i++) fireEvent.pointerDown(screen.getByTestId('elsewhere')); };

    clickPast(2);
    expect(unlock).not.toHaveBeenCalled();
    // Clicks on the card itself do not count toward the third.
    fireEvent.pointerDown(screen.getByTestId(CARD).querySelector('[data-nudge]'));
    expect(unlock).not.toHaveBeenCalled();
    clickPast(1);
    expect(unlock).toHaveBeenCalledTimes(1);
    clickPast(3);
    expect(unlock).toHaveBeenCalledTimes(2);

    // An unlock already running is not started again; the count still resets.
    act(() => useKeychainGateStore.setState({ unlocking: true }));
    clickPast(3);
    expect(unlock).toHaveBeenCalledTimes(2);
    act(() => useKeychainGateStore.setState({ unlocking: false }));
    clickPast(2);
    expect(unlock).toHaveBeenCalledTimes(2);
    clickPast(1);
    expect(unlock).toHaveBeenCalledTimes(3);
  });

  it('forgets a partial count when the gate clears, and counts nothing after', () => {
    const unlock = vi.fn();
    render(<div><button data-testid="elsewhere">x</button><KeychainUnlockCard /></div>);
    act(() => useKeychainGateStore.setState({ blocked: true, unlock }));
    fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    fireEvent.pointerDown(screen.getByTestId('elsewhere'));

    act(() => useKeychainGateStore.setState({ blocked: false }));
    for (let i = 0; i < 6; i++) fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    expect(unlock).not.toHaveBeenCalled();

    act(() => useKeychainGateStore.setState({ blocked: true }));
    fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    expect(unlock).not.toHaveBeenCalled();
  });

  it('shows no error line for an unanswered prompt: the card is the message', () => {
    render(<KeychainUnlockCard />);
    act(() => useKeychainGateStore.setState({ blocked: true, error: 'timeout' }));
    expect(screen.getByTestId(CARD)).toBeTruthy();
    expect(screen.queryByTestId('keychain-unlock-error')).toBeNull();
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
