// @vitest-environment jsdom
//
// Choosing the backup folder: the app refuses a folder that is, holds or sits
// inside the folder the mail is stored in, and says so in the catalog's words.
// The check is native; the picker only shows the refusal and saves nothing.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const pick = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('../../../services/api', () => ({
  vaultGetStatus: vi.fn().mockResolvedValue({ displayPath: '/Volumes/Mail' }),
  backupGetExternalLocation: vi.fn().mockResolvedValue({ status: 'not_configured' }),
  openPath: vi.fn(),
}));
const store = vi.hoisted(() => ({ state: null }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((select) => select(store.state), { getState: () => store.state }),
}));

import BackupLocationPicker from '../BackupLocationPicker';
import en from '../../../i18n/locales/en.json';

const invoke = vi.fn();
beforeEach(() => {
  store.state = { setBackupCustomPath: vi.fn(), externalBackupLocation: null, setExternalBackupLocation: vi.fn() };
  window.__TAURI__ = { core: { invoke } };
  invoke.mockReset().mockRejectedValue('E_BACKUP_OVERLAPS_VAULT: /Volumes/Mail');
  pick.mockReset().mockResolvedValue('/Volumes/Mail/backup');
});
afterEach(() => { cleanup(); delete window.__TAURI__; });

describe('BackupLocationPicker', () => {
  it('a folder that overlaps the mail folder reads as the catalog sentence, not the code', async () => {
    render(<BackupLocationPicker />);
    fireEvent.click(screen.getByRole('button', { name: en['settings.backup.config.chooseFolder'] }));
    await waitFor(() => expect(screen.getByText(en['errors.backupOverlapsVault'])).toBeTruthy());
    expect(screen.queryByText(/E_BACKUP_OVERLAPS_VAULT/)).toBeNull();
    expect(invoke).toHaveBeenCalledWith('backup_save_external_location', { path: '/Volumes/Mail/backup' });
    expect(store.state.setExternalBackupLocation).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('the sentence names the rule: a different folder, not inside or around the mail', () => {
    const sentence = en['errors.backupOverlapsVault'];
    expect(sentence).toBe('That is where your mail is stored (or it is inside or around that folder). Pick a different folder for your backup.');
  });
});
