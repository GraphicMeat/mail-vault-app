// @vitest-environment jsdom
//
// The custody store (the record of what each stored message is) can fail to
// open: corrupt, written by a newer build, or held by another copy of the app.
// Nothing in the app deletes or rebuilds it, so this banner is the only way
// the user hears about it. It names the file and offers no button, because the
// repair is theirs to make.
//
// The startup emit of `custody-status` happens in `setup`, before the webview
// exists, so a listener registered on mount never sees it: the banner has to
// ask with the command and listen only for the later (vault switch) emits.
import React from 'react';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `vi.hoisted`: the mock factory runs while the imports below are still being
// resolved, which is before a plain module-level `const` has been initialised.
const api = vi.hoisted(() => ({
  vaultGetStatus: vi.fn(),
  custodyStatus: vi.fn(),
  vaultInspectFolder: vi.fn(),
  vaultAdopt: vi.fn(),
}));
vi.mock('../../services/api', () => api);

// One listener registry per test, so a spec can fire the event the app would.
const listeners = vi.hoisted(() => new Map());
const listen = vi.hoisted(() => vi.fn(async (name, cb) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
}));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { VaultAlertBanner } from '../VaultAlertBanner';

describe('VaultAlertBanner: custody store', () => {
  beforeEach(() => {
    api.vaultGetStatus.mockResolvedValue({ status: 'ready', displayPath: '/v', isCustom: true });
  });

  // No auto-cleanup without vitest globals, and a leftover banner would make
  // the next findByText ambiguous.
  afterEach(() => { cleanup(); listeners.clear(); listen.mockClear(); });

  it('names the file when the store could not be opened, and offers no delete', async () => {
    api.custodyStatus.mockResolvedValue({ available: false, error: 'custody store unreadable: file is not a database', path: '/v/custody/custody.db' });
    render(<VaultAlertBanner />);
    expect(await screen.findByText('Vault records could not be opened')).toBeTruthy();
    expect(screen.getByText(/\/v\/custody\/custody\.db/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing while the store is open and the vault is present', async () => {
    api.custodyStatus.mockResolvedValue({ available: true, error: null, path: '/v/custody/custody.db' });
    const { container } = render(<VaultAlertBanner />);
    await waitFor(() => expect(api.custodyStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('shows both banners when the vault is missing and the store could not be opened', async () => {
    api.vaultGetStatus.mockResolvedValue({ status: 'missing', displayPath: '/gone', isCustom: true });
    api.custodyStatus.mockResolvedValue({ available: false, error: 'no vault root', path: null });
    const { container } = render(<VaultAlertBanner />);
    expect(await screen.findByText('Vault records could not be opened')).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy(); // the missing-vault banner's Choose folder
    // With no root there is no file to name, so the sentence that names one is
    // dropped whole rather than interpolated with nothing.
    expect(container.textContent).toMatch(/no vault root/);
    expect(container.textContent).not.toMatch(/cannot read \./);
  });

  it('renders nothing for a store that is merely closed', async () => {
    // `close()` during a vault switch leaves available:false with no error and
    // emits nothing. That is not a failure the user can act on.
    api.custodyStatus.mockResolvedValue({ available: false, error: null, path: null });
    const { container } = render(<VaultAlertBanner />);
    await waitFor(() => expect(api.custodyStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});

/**
 * Spec deviation 9 / Task 2.9b Step 5. Custody opens in the DAEMON now, and
 * the daemon emits `custody-status` as it starts — before the app's event
 * channel has reconnected, and the bus drops an event with no subscriber. So
 * after a vault switch (which restarts the daemon) the banner's `listen` never
 * fires, and a store that failed to open on the new root would go unreported
 * until the next launch. The banner re-asks on `daemon-reconnected`.
 */
describe('VaultAlertBanner: the daemon owns custody', () => {
  beforeEach(() => {
    // The call COUNT is the assertion here, and these mocks are module-level.
    api.custodyStatus.mockClear();
    api.vaultGetStatus.mockResolvedValue({ status: 'ready', displayPath: '/v', isCustom: true });
  });
  afterEach(() => { cleanup(); listeners.clear(); listen.mockClear(); });

  it('re-queries custody_status when the daemon channel reconnects', async () => {
    api.custodyStatus.mockResolvedValue({ available: true, error: null, path: '/v/custody/custody.db' });
    render(<VaultAlertBanner />);
    await waitFor(() => expect(listeners.has('daemon-reconnected')).toBe(true));
    expect(api.custodyStatus).toHaveBeenCalledTimes(1);

    // The respawned daemon could not open the store on the new root. Its
    // startup emit was dropped; only the re-query can find this out.
    api.custodyStatus.mockResolvedValue({ available: false, error: 'file is not a database', path: '/w/custody/custody.db' });
    await act(async () => { await listeners.get('daemon-reconnected')({ payload: {} }); });

    expect(api.custodyStatus).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Vault records could not be opened')).toBeTruthy();
    expect(screen.getByText(/\/w\/custody\/custody\.db/)).toBeTruthy();
  });

  it('unlistens daemon-reconnected on unmount', async () => {
    api.custodyStatus.mockResolvedValue({ available: true, error: null, path: '/v/custody/custody.db' });
    const { unmount } = render(<VaultAlertBanner />);
    await waitFor(() => expect(listeners.has('daemon-reconnected')).toBe(true));
    unmount();
    await waitFor(() => expect(listeners.has('daemon-reconnected')).toBe(false));
  });
});
