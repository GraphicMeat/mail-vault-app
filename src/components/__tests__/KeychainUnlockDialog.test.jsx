// @vitest-environment jsdom
//
// The dialog is the app's half of the keychain gate: it shows while the daemon
// says the keychain is blocked, "Later" puts it off, and a failed Unlock says
// why without closing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../services/daemonClient', () => ({
  // Never answers: the dialog's launch-time ask must not race the state a
  // test sets.
  daemonCall: vi.fn(() => new Promise(() => {})),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../../services/db', () => ({ getAccounts: vi.fn(), clearCredentialsCache: vi.fn() }));
vi.mock('../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: vi.fn() }));
vi.mock('../../stores/focusStore', () => ({ notify: vi.fn() }));

const { KeychainUnlockDialog } = await import('../KeychainUnlockDialog');
const { useKeychainGateStore, __resetKeychainGateForTests } = await import('../../stores/keychainGateStore');

const DIALOG = 'keychain-unlock-dialog';

const realUnlock = useKeychainGateStore.getState().unlock;

beforeEach(() => __resetKeychainGateForTests());
afterEach(() => {
  cleanup();
  useKeychainGateStore.setState({ unlock: realUnlock });
});

describe('KeychainUnlockDialog', () => {
  it('stays hidden while the keychain is readable', () => {
    render(<KeychainUnlockDialog />);
    expect(screen.queryByTestId(DIALOG)).toBeNull();
  });

  it('explains the keychain when it blocks, as an alert dialog', () => {
    render(<KeychainUnlockDialog />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    const dialog = screen.getByTestId(DIALOG);
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toMatch(/macOS Keychain/);
  });

  it('goes away on Later', () => {
    render(<KeychainUnlockDialog />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    fireEvent.click(screen.getByText('Later'));
    expect(screen.queryByTestId(DIALOG)).toBeNull();
  });

  it('runs the unlock from its primary button', () => {
    const unlock = vi.fn();
    render(<KeychainUnlockDialog />);
    act(() => useKeychainGateStore.setState({ blocked: true, unlock }));
    fireEvent.click(screen.getByTestId('keychain-unlock'));
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('says why a failed unlock failed, and stays open', () => {
    render(<KeychainUnlockDialog />);
    act(() => useKeychainGateStore.setState({ blocked: true, error: 'denied' }));
    expect(screen.getByTestId(DIALOG)).toBeTruthy();
    expect(screen.getByTestId('keychain-unlock-error').textContent).toMatch(/Access was refused/);
  });

  it('closes once the daemon reports the keychain readable again', () => {
    render(<KeychainUnlockDialog />);
    act(() => useKeychainGateStore.getState().apply({ blocked: true, reason: 'locked' }));
    act(() => useKeychainGateStore.getState().apply({ blocked: false }));
    expect(screen.queryByTestId(DIALOG)).toBeNull();
  });
});
