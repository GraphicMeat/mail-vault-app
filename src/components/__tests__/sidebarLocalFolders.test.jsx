// @vitest-environment jsdom
//
// The sidebar end of MBOX import mode 3: the account's vault-only folders
// (`list_local_folders`) show under "On this computer", and "Delete folder"
// asks first, then hands the folder to the daemon by its display name
// (`delete_local_folder`), which moves its mail into the deleted bin.

import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const sent = vi.hoisted(() => ({ calls: [], answer: {} }));
vi.mock('../../services/transport', async importOriginal => ({
  ...await importOriginal(),
  send: (cmd, args) => {
    sent.calls.push([cmd, args]);
    const answer = sent.answer[cmd];
    return typeof answer === 'function' ? answer(args) : Promise.resolve(answer ?? null);
  },
}));
vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(),
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  readLocalEmailIndex: async () => [],
}));

const { Sidebar } = await import('../Sidebar');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useViewStore } = await import('../../stores/viewStore');

const NAME = 'MBOX import 2026-09-29';
const FOLDER = { name: NAME, dir: 'MBOX_import_2026-09-29', kind: 'import', created: 1, source: 'takeout.mbox' };
const accounts = [{ id: 'studio', name: 'Studio', email: 'studio@example.com', authType: 'password' }];
const activateAccount = vi.fn(async () => {});
const realLoadEmails = useMailStore.getState().loadEmails;

beforeEach(() => {
  sent.calls = [];
  sent.answer = { delete_local_folder: { dir: FOLDER.dir, deleted: 2 }, list_local_folders: [] };
  activateAccount.mockClear();
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  useSettingsStore.setState({
    sidebarCollapsed: false, sidebarStyle: 'list', sidebarLayout: 'stacked', hiddenAccounts: {}, accountOrder: [],
    accountColors: {}, displayNames: {}, unreadPerAccount: {}, expandedFolders: {}, transferHoverEnabled: false,
    backupGlobalEnabled: false, backupSchedules: {}, backupState: {}, billingProfile: null,
  });
  useViewStore.setState({ activeViewId: null });
  useMailStore.setState({
    accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [{ name: 'INBOX', path: 'INBOX' }, { name: 'Archive', path: 'Archive', specialUse: '\\Archive' }],
    localFolders: { studio: [FOLDER] },
    emails: [], localEmails: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null,
    loading: false, loadingMore: false, totalEmails: 0, viewMode: 'all', folderStatus: {},
    exportProgress: null, error: null, activateAccount, loadEmails: realLoadEmails,
  });
});

afterEach(() => { cleanup(); delete window.__TAURI__; });

const localRow = () => screen.getByRole('group', { name: 'On this computer' }).querySelector(`[data-path="${NAME}"]`);
const openMenu = () => fireEvent.contextMenu(localRow(), { clientX: 30, clientY: 40 });
const deleteItem = () => within(screen.getByTestId('folder-context-menu')).getByText('Delete folder…').closest('button');
const confirmDialog = () => screen.getByRole('alertdialog');
const rpc = (cmd) => sent.calls.filter(([c]) => c === cmd).map(([, args]) => args);

describe('Sidebar local folders', () => {
  it('shows the account\'s local folders under "On this computer" after its server folders', () => {
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-folder-list');
    const drawn = [...list.querySelectorAll('[data-testid="folder-row"]')].map(r => r.getAttribute('data-path'));
    expect(drawn).toEqual(['INBOX', 'Archive', NAME]);
    expect(localRow()).toBeTruthy();
  });

  it('shows no other account\'s local folders', () => {
    useMailStore.setState({ localFolders: { other: [FOLDER] } });
    render(<Sidebar />);
    expect(screen.queryByRole('group', { name: 'On this computer' })).toBeNull();
  });

  it('asks before deleting, then deletes the folder by its display name and lists the folders again', async () => {
    render(<Sidebar />);
    openMenu();
    fireEvent.click(deleteItem());
    // Nothing reaches the daemon before the yes.
    expect(rpc('delete_local_folder')).toEqual([]);
    const dialog = confirmDialog();
    expect(dialog.textContent).toContain(NAME);
    expect(dialog.textContent).toContain('Deleted emails');

    fireEvent.click(within(dialog).getByTestId('confirm-delete-folder'));
    await waitFor(() => expect(rpc('delete_local_folder')).toEqual([{ accountId: 'studio', name: NAME }]));
    await waitFor(() => expect(rpc('list_local_folders')).toEqual([{ accountId: 'studio' }]));
    // The daemon's fresh list replaces the old one, and the group goes with it.
    await waitFor(() => expect(screen.queryByRole('group', { name: 'On this computer' })).toBeNull());
    // Not the open folder: the view stays where it is.
    expect(activateAccount).not.toHaveBeenCalled();
    expect(useMailStore.getState().error).toBeNull();
  });

  it('leaves the folder alone when the delete is cancelled', () => {
    render(<Sidebar />);
    openMenu();
    fireEvent.click(deleteItem());
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }));
    expect(rpc('delete_local_folder')).toEqual([]);
    expect(localRow()).toBeTruthy();
  });

  it('opens INBOX once the open folder is deleted', async () => {
    useMailStore.setState({ activeMailbox: NAME });
    render(<Sidebar />);
    openMenu();
    fireEvent.click(deleteItem());
    fireEvent.click(within(confirmDialog()).getByTestId('confirm-delete-folder'));
    await waitFor(() => expect(activateAccount).toHaveBeenCalledWith('studio', 'INBOX'));
  });

  it.each([
    ['gone after all', [], 'INBOX'],
    ['still there', [FOLDER], 'rescan'],
  ])('after a refused delete of the open folder, goes by the fresh listing: %s', async (_label, listed, expected) => {
    const loadEmails = vi.fn(async () => {});
    useMailStore.setState({ activeMailbox: NAME, loadEmails });
    sent.answer.delete_local_folder = () => Promise.reject(new Error('E_LOCAL_FOLDER_NOT_EMPTY: 1 moved to the deleted bin, some mail is left in MBOX_import_2026-09-29'));
    sent.answer.list_local_folders = listed;
    render(<Sidebar />);
    openMenu();
    fireEvent.click(deleteItem());
    fireEvent.click(within(confirmDialog()).getByTestId('confirm-delete-folder'));
    await waitFor(() => expect(useMailStore.getState().error).toBeTruthy());

    if (expected === 'INBOX') {
      // A reload of a folder no longer local would have gone to a server.
      expect(activateAccount).toHaveBeenCalledWith('studio', 'INBOX');
      expect(loadEmails).not.toHaveBeenCalled();
    } else {
      expect(loadEmails).toHaveBeenCalled();
      expect(activateAccount).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['E_LOCAL_FOLDER_NOT_EMPTY: 1 moved to the deleted bin, some mail is left in MBOX_import_2026-09-29', 'Some emails in this folder could not be moved to Deleted emails'],
    ['E_NOT_LOCAL_FOLDER: MBOX_import_2026-09-29 has no import marker', 'is not a folder kept on this computer'],
    ['E_BIN_CAPTURE: write deleted copy: No space left on device', 'Could not keep a copy of this email before deleting it'],
    ['custody store unavailable: closed', 'Could not delete this folder'],
  ])('tells the user in catalog words when the daemon refuses (%s)', async (daemonText, catalogText) => {
    sent.answer.delete_local_folder = () => Promise.reject(new Error(daemonText));
    sent.answer.list_local_folders = [FOLDER];
    render(<Sidebar />);
    openMenu();
    fireEvent.click(deleteItem());
    fireEvent.click(within(confirmDialog()).getByTestId('confirm-delete-folder'));
    await waitFor(() => expect(useMailStore.getState().error).toContain(catalogText));
    const shown = useMailStore.getState().error;
    expect(shown).not.toMatch(/E_[A-Z_]+|MBOX_import|custody|No space/);
    // Listed again anyway: a partial delete took mail out of it.
    expect(rpc('list_local_folders')).toEqual([{ accountId: 'studio' }]);
  });

  it('does not offer the delete while an import is running', () => {
    useMailStore.setState({ exportProgress: { active: true, mode: 'import', total: 0, completed: 0 } });
    render(<Sidebar />);
    openMenu();
    expect(deleteItem().disabled).toBe(true);
  });
});
