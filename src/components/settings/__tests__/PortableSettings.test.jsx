// @vitest-environment jsdom
//
// Settings > Portable: the Premium wizard that copies MailVault to a drive,
// and the page a copy running from that drive shows instead. Assertions read
// test ids and daemon calls, never copy: the copy lives in nine catalogs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

const replies = {};
const daemonCall = vi.fn((method) => {
  const reply = replies[method];
  return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
});
vi.mock('../../../services/daemonClient', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));
const openDialog = vi.fn(() => Promise.resolve('/Volumes/USB'));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a) => openDialog(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: vi.fn(() => Promise.resolve(true)) }));

const { PortableSettings } = await import('../PortableSettings');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { __resetPortableForTests } = await import('../../../stores/portableStore');
const { t } = await import('../../../i18n/index.js');

const PREMIUM = { hasSubscription: true, status: 'active' };
const GIB = 1024 ** 3;

beforeEach(() => {
  __resetPortableForTests();
  daemonCall.mockClear();
  openDialog.mockClear();
  for (const k of Object.keys(replies)) delete replies[k];
  replies['portable.status'] = { portable: false };
  replies['portable.estimate'] = { freeBytes: 64 * GIB, neededBytes: 2 * GIB };
  replies['portable.create'] = { root: '/Volumes/USB/MailVault Data', removedFromHost: false, quarantineCleared: true };
  useSettingsStore.setState({ billingProfile: PREMIUM });
});
afterEach(cleanup);

const createCalls = () => daemonCall.mock.calls.filter(([m]) => m === 'portable.create');

async function fillWizard({ passphrase = 'correct horse battery', confirm = passphrase } = {}) {
  render(<PortableSettings />);
  fireEvent.click(await screen.findByTestId('portable-choose-drive'));
  await screen.findByTestId('portable-space');
  fireEvent.change(screen.getByTestId('portable-passphrase'), { target: { value: passphrase } });
  fireEvent.change(screen.getByTestId('portable-passphrase-confirm'), { target: { value: confirm } });
}

describe('PortableSettings', () => {
  it('shows a free user the upsell instead of the wizard', async () => {
    useSettingsStore.setState({ billingProfile: null });
    render(<PortableSettings onUpgrade={() => {}} />);
    expect(await screen.findByTestId('portable-upsell')).toBeTruthy();
    expect(screen.queryByTestId('portable-create')).toBeNull();
  });

  it('shows a Premium user the wizard', async () => {
    render(<PortableSettings />);
    expect(await screen.findByTestId('portable-create')).toBeTruthy();
    expect(screen.queryByTestId('portable-upsell')).toBeNull();
  });

  it('shows the free space against what the copy needs once a drive is picked', async () => {
    await fillWizard();
    expect(daemonCall).toHaveBeenCalledWith('portable.estimate', { dest: '/Volumes/USB' });
    expect(screen.getByTestId('portable-space').dataset.enough).toBe('true');
  });

  it('blocks the copy while the two passphrases differ', async () => {
    await fillWizard({ confirm: 'correct horse batterx' });
    expect(screen.getByTestId('portable-passphrase-mismatch')).toBeTruthy();
    expect(screen.getByTestId('portable-create').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('portable-create'));
    expect(createCalls()).toEqual([]);
  });

  it('blocks a passphrase shorter than twelve characters', async () => {
    await fillWizard({ passphrase: 'too short' });
    expect(screen.getByTestId('portable-create').disabled).toBe(true);
  });

  it('asks the daemon to make the copy with the chosen options', async () => {
    await fillWizard();
    fireEvent.click(screen.getByTestId('portable-copy-mail'));
    fireEvent.click(screen.getByTestId('portable-create'));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0][1]).toEqual({
      dest: '/Volumes/USB',
      passphrase: 'correct horse battery',
      copyMail: false,
      copyConfig: true,
      removeFromHost: false,
    });
    expect(await screen.findByTestId('portable-done')).toBeTruthy();
  });

  it('removes from this computer only after the user confirms', async () => {
    await fillWizard();
    fireEvent.click(screen.getByTestId('portable-remove-from-host'));
    fireEvent.click(screen.getByTestId('portable-create'));
    const confirm = await screen.findByRole('alertdialog');
    expect(createCalls()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: t('portable.removeConfirm.confirm') }));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0][1].removeFromHost).toBe(true);
  });

  it('offers removal only when both mail and accounts go to the drive', async () => {
    await fillWizard();
    const remove = screen.getByTestId('portable-remove-from-host');
    expect(remove.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('portable-copy-config'));
    expect(remove.disabled).toBe(true);
  });

  it('shows the running copy its drive instead of the wizard', async () => {
    replies['portable.status'] = { portable: true, locked: false, drive: '/Volumes/USB', freeBytes: GIB };
    render(<PortableSettings />);
    const running = await screen.findByTestId('portable-running');
    expect(running.textContent).toContain('/Volumes/USB');
    expect(screen.queryByTestId('portable-create')).toBeNull();
  });
});

describe('PortableSettings in the App Store build', () => {
  it('shows only that portable mode is not available there', async () => {
    vi.resetModules();
    vi.doMock('../../../utils/buildFlags', () => ({ IS_APPSTORE_BUILD: true, IAP_PRODUCT_BACKUPS: 'x' }));
    const { PortableSettings: MasPortable } = await import('../PortableSettings');
    render(<MasPortable />);
    expect(screen.getByTestId('portable-appstore')).toBeTruthy();
    expect(screen.queryByTestId('portable-create')).toBeNull();
    expect(screen.queryByTestId('portable-upsell')).toBeNull();
    vi.doUnmock('../../../utils/buildFlags');
  });
});
