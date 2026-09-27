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

  it('keeps backup and download mode but hides the mail folder chooser on the App Store build', () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    render(<StorageStep onContinue={() => {}} />);
    expect(screen.queryByTestId('storage-row-mail')).toBeNull();
    expect(screen.queryByText(t('settings.storage.moveMailAnotherFolder'))).toBeNull();
    expect(screen.getByTestId('storage-row-backup')).toBeTruthy();
    expect(screen.getByTestId('storage-row-mode')).toBeTruthy();
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
