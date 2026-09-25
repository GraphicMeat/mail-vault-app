// @vitest-environment jsdom
//
// A portable copy starts locked on every computer: the card asks for the
// passphrase, says so when it is wrong, and leaves once the daemon unlocks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
const daemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
const retryKeychainAccess = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: (...a) => retryKeychainAccess(...a) }));

const { PortableUnlockCard } = await import('../PortableUnlockCard');
const { usePortableStore, __resetPortableForTests } = await import('../../stores/portableStore');

const CARD = 'portable-unlock-card';
const LOCKED = { portable: true, locked: true, drive: '/Volumes/USB' };

beforeEach(() => {
  __resetPortableForTests();
  retryKeychainAccess.mockClear();
  daemonCall.mockReset();
  // The launch-time ask never answers, so it cannot race the state a test sets.
  daemonCall.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

function type(value) {
  fireEvent.change(screen.getByTestId('portable-unlock-input'), { target: { value } });
  fireEvent.click(screen.getByTestId('portable-unlock'));
}

describe('PortableUnlockCard', () => {
  it('stays hidden in an installed copy and in an unlocked portable one', () => {
    render(<PortableUnlockCard />);
    expect(screen.queryByTestId(CARD)).toBeNull();
    act(() => usePortableStore.getState().apply({ portable: true, locked: false }));
    expect(screen.queryByTestId(CARD)).toBeNull();
  });

  it('asks for the passphrase while the drive is locked', () => {
    render(<PortableUnlockCard />);
    act(() => usePortableStore.getState().apply(LOCKED));
    expect(screen.getByTestId(CARD)).toBeTruthy();
  });

  it('says a wrong passphrase was wrong and stays', async () => {
    render(<PortableUnlockCard />);
    act(() => usePortableStore.getState().apply(LOCKED));
    daemonCall.mockImplementation((method) => method === 'portable.unlock'
      ? Promise.reject(new Error('E_PORTABLE_PASSPHRASE'))
      : new Promise(() => {}));

    type('not the passphrase');

    const error = await screen.findByTestId('portable-unlock-error');
    expect(error.dataset.error).toBe('wrong');
    expect(screen.getByTestId(CARD)).toBeTruthy();
    expect(retryKeychainAccess).not.toHaveBeenCalled();
  });

  it('unlocks with the right one, leaves, and reloads the accounts', async () => {
    render(<PortableUnlockCard />);
    act(() => usePortableStore.getState().apply(LOCKED));
    daemonCall.mockImplementation((method) => method === 'portable.unlock'
      ? Promise.resolve({ ok: true })
      : new Promise(() => {}));

    type('correct horse battery');

    await waitFor(() => expect(screen.queryByTestId(CARD)).toBeNull());
    expect(daemonCall).toHaveBeenCalledWith('portable.unlock', { passphrase: 'correct horse battery' });
    expect(retryKeychainAccess).toHaveBeenCalledTimes(1);
  });
});
