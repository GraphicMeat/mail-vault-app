// @vitest-environment jsdom
// Track H6: where mail lives, where its backup goes and how much stays on this
// computer, asked before the first account so nothing lands in the default
// location first. Every row is the control Settings uses, not a tour copy.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Swappable per case: the Mac App Store build cannot relocate the vault.
const buildFlags = { IS_APPSTORE_BUILD: false };
vi.mock('../../../utils/buildFlags', async (importOriginal) => ({
  ...(await importOriginal()),
  get IS_APPSTORE_BUILD() { return buildFlags.IS_APPSTORE_BUILD; },
}));

vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn(async () => ({ ok: true })) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const open = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a) => open(...a) }));

const api = vi.hoisted(() => ({
  vaultGetStatus: vi.fn(),
  vaultInspectFolder: vi.fn(),
  vaultMoveTo: vi.fn(),
  vaultAdopt: vi.fn(),
  vaultMoveToDefault: vi.fn(),
  vaultReset: vi.fn(),
  backupGetExternalLocation: vi.fn(),
  openPath: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

import { StorageStep } from '../StorageStep';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

// The backup picker talks to the shell the way Settings > Backup always has.
const invoke = vi.fn();
const WRITES = ['backup_save_external_location', 'backup_clear_external_location'];
const wrote = () => invoke.mock.calls.filter(([cmd]) => WRITES.includes(cmd));

beforeEach(() => {
  vi.clearAllMocks();
  buildFlags.IS_APPSTORE_BUILD = false;
  window.__TAURI__ = { core: { invoke } };
  invoke.mockResolvedValue(undefined);
  api.vaultGetStatus.mockResolvedValue({ displayPath: '/Users/me/Library/MailVault', isCustom: false, status: 'ok' });
  api.backupGetExternalLocation.mockResolvedValue({ status: 'not_configured' });
  useSettingsStore.setState({
    billingProfile: null, shareGrant: null,
    fetchMode: 'keepRecent', fetchModes: {}, localCacheDurationMonths: 3,
    externalBackupLocation: null, backupCustomPath: null, vaultStatus: null,
  });
});
afterEach(() => { cleanup(); delete window.__TAURI__; });

describe('onboarding storage step', () => {
  it('shows the mail folder, backup folder and download mode, each with its one-line explanation', async () => {
    render(<StorageStep onContinue={() => {}} />);
    for (const [row, hint] of [
      ['storage-row-mail', 'onboarding.storageMailHint'],
      ['storage-row-backup', 'onboarding.storageBackupHint'],
      ['storage-row-mode', 'onboarding.storageModeHint'],
    ]) {
      const el = screen.getByTestId(row);
      expect(el.textContent).toContain(t(hint));
    }
    // The mail row is Settings' own card: it names the default folder.
    expect((await screen.findByText('/Users/me/Library/MailVault')).getAttribute('data-testid')).toBe('vault-path');
    expect(screen.getByText(t('settings.storage.moveMailAnotherFolder'))).toBeTruthy();
  });

  it('keeps backup and download mode but hides the mail folder chooser on the App Store build', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    invoke.mockImplementation(async (cmd) => (cmd === 'iap_is_entitled' ? true : undefined));
    render(<StorageStep onContinue={() => {}} />);
    expect(screen.queryByTestId('storage-row-mail')).toBeNull();
    expect(screen.queryByText(t('settings.storage.moveMailAnotherFolder'))).toBeNull();
    expect(screen.getByTestId('storage-row-mode')).toBeTruthy();
    // With the backups purchase, the backup row is the real picker.
    expect(await screen.findByText(t('settings.backup.config.chooseFolder'))).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('iap_is_entitled', { productId: 'com.mailvault.app.backups' });
    expect(screen.queryByTestId('storage-backup-locked')).toBeNull();
  });

  // The shell refuses an external folder without the purchase, in English:
  // the tour says where to unlock it instead of offering a Choose that fails.
  it('offers no backup folder on the App Store build without the backups purchase', async () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    invoke.mockImplementation(async (cmd) => (cmd === 'iap_is_entitled' ? false : undefined));
    render(<StorageStep onContinue={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('iap_is_entitled', { productId: 'com.mailvault.app.backups' }));
    const row = screen.getByTestId('storage-row-backup');
    expect(row.textContent).toContain(t('onboarding.storageBackupLocked'));
    expect(screen.queryByText(t('settings.backup.config.chooseFolder'))).toBeNull();
    expect(wrote()).toEqual([]);
  });

  it('does not let Continue leave while the mail folder is being moved', async () => {
    let finishMove;
    open.mockResolvedValue('/Volumes/Mail');
    api.vaultInspectFolder.mockResolvedValue({ writable: true, kind: 'empty' });
    api.vaultMoveTo.mockImplementation(() => new Promise(resolve => { finishMove = resolve; }));
    const onContinue = vi.fn();
    render(<StorageStep onContinue={onContinue} />);

    fireEvent.click(screen.getByText(t('settings.storage.moveMailAnotherFolder')));
    await waitFor(() => expect(screen.getByTestId('onboarding-continue').disabled).toBe(true));
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).not.toHaveBeenCalled();

    finishMove({ sourceRemoved: true, filesCopied: 0 });
    await waitFor(() => expect(screen.getByTestId('onboarding-continue').disabled).toBe(false));
  });

  it('saves a chosen backup folder the way Settings does, then checks it can really write there', async () => {
    open.mockResolvedValue('/Volumes/Backup');
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'backup_save_external_location') return { status: 'ready', displayPath: '/Volumes/Backup' };
      if (cmd === 'backup_validate_external_location') {
        return { status: 'invalid', displayPath: '/Volumes/Backup', lastError: 'Write test failed: Read-only file system' };
      }
      return undefined;
    });
    render(<StorageStep onContinue={() => {}} />);

    fireEvent.click(screen.getByText(t('settings.backup.config.chooseFolder')));

    expect(await screen.findByText('Write test failed: Read-only file system')).toBeTruthy();
    const cmds = invoke.mock.calls.map(([cmd]) => cmd);
    expect(invoke).toHaveBeenCalledWith('backup_save_external_location', { path: '/Volumes/Backup' });
    expect(cmds.lastIndexOf('backup_validate_external_location')).toBeGreaterThan(cmds.indexOf('backup_save_external_location'));
    expect(useSettingsStore.getState().externalBackupLocation.status).toBe('invalid');
  });

  // A write test that errors must not leave save's optimistic "ready" badge
  // beside the error.
  it('marks the folder unusable when the write check itself fails', async () => {
    open.mockResolvedValue('/Volumes/Backup');
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'backup_save_external_location') return { status: 'ready', displayPath: '/Volumes/Backup' };
      if (cmd === 'backup_validate_external_location') throw 'Bookmark resolution failed';
      return undefined;
    });
    render(<StorageStep onContinue={() => {}} />);

    fireEvent.click(screen.getByText(t('settings.backup.config.chooseFolder')));

    expect(await screen.findByText('Bookmark resolution failed')).toBeTruthy();
    expect(useSettingsStore.getState().externalBackupLocation).toMatchObject({ status: 'invalid', lastError: 'Bookmark resolution failed' });
    expect(screen.queryByText(t('settings.backup.config.ready'))).toBeNull();
    expect(screen.getByText(t('settings.backup.config.accessDenied'))).toBeTruthy();
  });

  it('shows why a backup folder was refused', async () => {
    open.mockResolvedValue('/Volumes/Backup');
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'backup_save_external_location') throw 'Cloud Backups requires a one-time in-app purchase.';
      return undefined;
    });
    render(<StorageStep onContinue={() => {}} />);

    fireEvent.click(screen.getByText(t('settings.backup.config.chooseFolder')));

    expect(await screen.findByText('Cloud Backups requires a one-time in-app purchase.')).toBeTruthy();
    expect(useSettingsStore.getState().externalBackupLocation).toBe(null);
  });

  it('uses the Settings download mode control and writes the same setting', () => {
    render(<StorageStep onContinue={() => {}} />);
    const row = screen.getByTestId('storage-row-mode');
    expect(row.querySelector('[data-testid="download-mode"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: t('settings.storage.modeIndexOnly') }));
    expect(useSettingsStore.getState().fetchMode).toBe('indexOnly');
    fireEvent.click(screen.getByRole('radio', { name: t('settings.storage.year1') }));
    expect(useSettingsStore.getState().localCacheDurationMonths).toBe(12);
  });

  it('keeps every default when Continue is pressed without a change', async () => {
    const onContinue = vi.fn();
    render(<StorageStep onContinue={onContinue} />);
    await screen.findByTestId('vault-path');

    fireEvent.click(screen.getByTestId('onboarding-continue'));

    expect(onContinue).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.backupGetExternalLocation).toHaveBeenCalled());
    expect(wrote()).toEqual([]);
    expect(api.vaultMoveTo).not.toHaveBeenCalled();
    expect(api.vaultAdopt).not.toHaveBeenCalled();
    const s = useSettingsStore.getState();
    expect(s.fetchMode).toBe('keepRecent');
    expect(s.localCacheDurationMonths).toBe(3);
    expect(s.externalBackupLocation).toBe(null);
  });
});
