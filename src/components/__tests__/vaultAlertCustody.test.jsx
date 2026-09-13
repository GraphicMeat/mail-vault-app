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
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { VaultAlertBanner } from '../VaultAlertBanner';

describe('VaultAlertBanner: custody store', () => {
  beforeEach(() => {
    api.vaultGetStatus.mockResolvedValue({ status: 'ready', displayPath: '/v', isCustom: true });
  });

  // No auto-cleanup without vitest globals, and a leftover banner would make
  // the next findByText ambiguous.
  afterEach(cleanup);

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

  it('shows both banners when the vault is missing and the store is closed', async () => {
    api.vaultGetStatus.mockResolvedValue({ status: 'missing', displayPath: '/gone', isCustom: true });
    api.custodyStatus.mockResolvedValue({ available: false, error: 'no vault root', path: null });
    render(<VaultAlertBanner />);
    expect(await screen.findByText('Vault records could not be opened')).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy(); // the missing-vault banner's Choose folder
  });
});
