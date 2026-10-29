// @vitest-environment jsdom
//
// Settings > Backup > Where your mail is stored: a move the daemon refuses
// reads as a catalog sentence when it answers with a code (a conversion of
// the vault's storage format holds it back), and as before otherwise.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  vaultGetStatus: vi.fn(),
  vaultInspectFolder: vi.fn(),
  vaultMoveTo: vi.fn(),
  vaultMoveToDefault: vi.fn(),
  vaultAdopt: vi.fn(),
  vaultReset: vi.fn(),
  openPath: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
const pick = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const store = vi.hoisted(() => ({ state: null }));
vi.mock('../../../stores/settingsStore', () => ({ useSettingsStore: (select) => select(store.state) }));

import MailStorageLocation from '../MailStorageLocation';
import en from '../../../i18n/locales/en.json';

const CUSTOM = { status: 'ready', displayPath: '/Volumes/Mail', isCustom: true };
const BLOCKED = 'E_FORMAT_MOVE_BLOCKED: 3f1e0c1a-0000-4000-8000-00000000000a';

beforeEach(() => {
  store.state = { vaultStatus: CUSTOM, setVaultStatus: vi.fn() };
  Object.values(api).forEach((f) => f.mockReset());
  api.vaultGetStatus.mockResolvedValue(CUSTOM);
  api.vaultInspectFolder.mockResolvedValue({ kind: 'empty', writable: true, emailCount: 0 });
  pick.mockReset().mockResolvedValue('/Volumes/New');
});
afterEach(cleanup);

const moveButton = () => screen.getByRole('button', { name: en['settings.storage.moveMailAnotherFolder'] });

describe('MailStorageLocation', () => {
  it('a move a format conversion holds back reads as its catalog sentence', async () => {
    api.vaultMoveTo.mockRejectedValue(BLOCKED);
    render(<MailStorageLocation />);
    fireEvent.click(moveButton());
    await waitFor(() => expect(screen.getByText(en['errors.formatMoveBlocked'])).toBeTruthy());
    expect(api.vaultMoveTo).toHaveBeenCalledWith('/Volumes/New');
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it('so does moving the mail back to the default location', async () => {
    api.vaultMoveToDefault.mockRejectedValue(new Error(BLOCKED));
    render(<MailStorageLocation />);
    fireEvent.click(screen.getByRole('button', { name: en['common.resetToDefault'] }));
    fireEvent.click(screen.getByRole('button', { name: en['settings.mailLocation.moveMailBack'] }));
    await waitFor(() => expect(screen.getByText(en['errors.formatMoveBlocked'])).toBeTruthy());
  });

  it('a format that would not carry over has its sentence, and any other refusal reads as before', async () => {
    api.vaultMoveTo.mockRejectedValueOnce('E_FORMAT_MARKER: the vault marker /Volumes/Mail/.mailvault-vault.db will not read: busy');
    render(<MailStorageLocation />);
    fireEvent.click(moveButton());
    await waitFor(() => expect(screen.getByText(en['errors.formatMarker'])).toBeTruthy());

    api.vaultMoveTo.mockRejectedValueOnce('Choose a folder outside the current mail storage folder');
    fireEvent.click(moveButton());
    await waitFor(() => expect(screen.getByText('Choose a folder outside the current mail storage folder')).toBeTruthy());
  });

  it('a folder that is, holds or sits inside the backup folder reads as its catalog sentence', async () => {
    api.vaultMoveTo.mockRejectedValue('E_VAULT_OVERLAPS_BACKUP: /Volumes/Backup');
    render(<MailStorageLocation />);
    fireEvent.click(moveButton());
    await waitFor(() => expect(screen.getByText(en['errors.vaultOverlapsBackup'])).toBeTruthy());
    expect(screen.queryByText(/E_VAULT_OVERLAPS_BACKUP/)).toBeNull();
  });

  it('so does choosing it as the existing mail folder', async () => {
    api.vaultAdopt.mockRejectedValue('E_VAULT_OVERLAPS_BACKUP: /Volumes/Backup');
    render(<MailStorageLocation />);
    fireEvent.click(screen.getByRole('button', { name: en['settings.mailLocation.useExistingFolder'] }));
    await waitFor(() => expect(screen.getByText(en['errors.vaultOverlapsBackup'])).toBeTruthy());
  });

  it('the sentence names the rule: a different folder, not inside or around the backup', () => {
    expect(en['errors.vaultOverlapsBackup']).toBe('That is your backup folder (or it is inside or around it). Pick a different folder for your mail.');
  });
});
