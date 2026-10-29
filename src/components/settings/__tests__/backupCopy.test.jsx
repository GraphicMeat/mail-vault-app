// @vitest-environment jsdom
//
// The words on the backup pages, as agreed with Rokas. Import and export are
// one-time moves and say so; a backup is a second copy and its folder must
// not be where the mail is stored.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../services/transport', () => ({ send: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../MailStorageLocation', () => ({ default: () => <div data-testid="mail-location" /> }));
vi.mock('../BackupLocationPicker', () => ({ default: () => <div data-testid="backup-picker" /> }));

const { default: BackupRestore } = await import('../BackupRestore');
const { default: BackupConfig } = await import('../BackupConfig');
const { default: en } = await import('../../../i18n/locales/en.json');

afterEach(cleanup);

describe('Import & Export page', () => {
  it('opens by saying import and export are one-time and nothing stays linked', () => {
    render(<BackupRestore />);
    const intro = en['settings.backup.importExport.intro'];
    expect(intro).toBe('Import and export are one-time moves. They copy your mail once, right now, to or from a file. Nothing stays linked: mail that arrives later is not added to the file, and changes to the file do not reach MailVault. For ongoing protection, use Backup Settings and Backup Schedule.');
    expect(screen.getByText(intro)).toBeTruthy();
  });

  it('the ZIP section is a one-time snapshot, not a live backup', () => {
    render(<BackupRestore />);
    expect(screen.getByRole('heading', { name: en['settings.backup.importExport.zipHeading'] })).toBeTruthy();
    expect(en['settings.backup.importExport.zipHeading']).toBe('Vault archive (ZIP)');
    const zip = en['settings.backup.restore.writeEverythingVaultSingleZip'];
    expect(zip).toBe('Export writes everything in your vault to one .zip, once. Copy it anywhere. Import reads such a .zip back in, once. It is a snapshot, not a live backup.');
    expect(screen.getByText(zip)).toBeTruthy();
  });

  it('the MBOX section is one-time and not kept in sync', () => {
    render(<BackupRestore />);
    const mbox = en['settings.backup.restore.writeVaultStandardMboxFile'];
    expect(mbox).toBe('Export writes your vault to one standard MBOX file, once, for Thunderbird, Apple Mail and others. Import reads an MBOX from another client into your vault, once. Nothing is kept in sync.');
    expect(screen.getByText(mbox)).toBeTruthy();
  });
});

describe('Backup Settings page', () => {
  it('says what a backup is, what scope and storage each pick, and that the backup folder must differ from the mail folder', () => {
    render(<BackupConfig />);
    expect(en['settings.backup.config.scopeIntro']).toBe('A backup is a second, independent copy of your mail, kept apart from the working copy above. Scope picks which mail is copied. Storage picks where the copy goes.');
    expect(screen.getByText(en['settings.backup.config.scopeIntro'])).toBeTruthy();
    expect(en['settings.backup.config.scopeLabel']).toBe('Scope: what to back up');
    expect(screen.getByText(en['settings.backup.config.scopeLabel'])).toBeTruthy();
    expect(en['settings.backup.config.storageLabel']).toBe('Storage: where the backup goes');
    expect(screen.getByText(en['settings.backup.config.storageLabel'])).toBeTruthy();
    expect(en['settings.backup.config.storageHint']).toBe('Pick a folder that is not where your mail is stored, not inside it, and not around it. A backup in the same place is not a second copy: lose that folder and you lose both.');
    expect(screen.getByText(en['settings.backup.config.storageHint'])).toBeTruthy();
  });

  it('the archived scope names what it leaves out', () => {
    expect(en['settings.backup.config.onlyWhatAlreadyVaultGets']).toBe('Only mail already in your vault is copied. Mail that is still only on the server is not.');
  });

  it('the mail folder card says it is the original, so the backup must live elsewhere', () => {
    expect(en['settings.mailLocation.thisIsTheWorkingCopy']).toBe("This is your working copy: the mail MailVault reads, searches and syncs. By default it lives in the app's own storage. Move it to any folder or drive and everything follows: messages, headers and attachments. It is the original, so your backup must live in a different folder.");
  });
});
