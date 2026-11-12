// @vitest-environment jsdom
//
// The sidebar end of Move folder: right-click a custom folder, Move folder…,
// and the dialog opens on that folder of the account on screen.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '../../services/workflows/bindStoreActions';

const sent = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../services/transport', async importOriginal => ({
  ...await importOriginal(),
  send: (cmd, args) => {
    sent.calls.push([cmd, args]);
    if (cmd === 'folder_move.plan') return Promise.resolve({ items: [], fastRename: null, refusal: null, cached: false });
    return Promise.resolve(cmd === 'list_local_folders' ? [] : null);
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
const en = (await import('../../i18n/locales/en.json')).default;

const accounts = [{ id: 'studio', name: 'Studio', email: 'studio@example.com', authType: 'password' }];

beforeEach(() => {
  sent.calls = [];
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  useSettingsStore.setState({
    sidebarCollapsed: false, sidebarStyle: 'list', sidebarLayout: 'stacked', hiddenAccounts: {}, accountOrder: [],
    accountColors: {}, displayNames: {}, unreadPerAccount: {}, expandedFolders: {}, transferHoverEnabled: false,
    backupGlobalEnabled: false, backupSchedules: {}, backupState: {}, billingProfile: null,
  });
  useViewStore.setState({ activeViewId: null });
  useMailStore.setState({
    accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [{ name: 'INBOX', path: 'INBOX', delimiter: '/' }, { name: 'Projects', path: 'Projects', delimiter: '/' }],
    localFolders: {}, emails: [], localEmails: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null,
    loading: false, loadingMore: false, totalEmails: 0, viewMode: 'all', folderStatus: {}, exportProgress: null, error: null,
  });
});
afterEach(() => { cleanup(); delete window.__TAURI__; });

const folderRow = (path) => screen.getByTestId('sidebar-folder-list').querySelector(`[data-testid="folder-row"][data-path="${path}"]`);

describe('Sidebar Move folder', () => {
  it('right-click, Move folder… opens the dialog on that folder of the account on screen', async () => {
    render(<Sidebar />);
    fireEvent.contextMenu(folderRow('Projects'), { clientX: 30, clientY: 40 });
    fireEvent.click(within(screen.getByTestId('folder-context-menu')).getByText(en['sidebar.moveFolder']).closest('button'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(en['folderMove.title'].replace('{{name}}', 'Projects'));
    expect(within(dialog).getByLabelText(en['folderMove.account']).value).toBe('studio');
    expect(screen.queryByTestId('folder-context-menu')).toBeNull();

    fireEvent.click(dialog.querySelector('[data-testid="move-folder-target"][data-path="INBOX"]'));
    await waitFor(() => expect(sent.calls.filter(([c]) => c === 'folder_move.plan').map(([, a]) => a))
      .toEqual([{ sourceAccountId: 'studio', sourcePath: 'Projects', destAccountId: 'studio', destPath: 'INBOX' }]));

    fireEvent.click(within(dialog).getByRole('button', { name: en['common.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('INBOX offers no Move folder', () => {
    render(<Sidebar />);
    fireEvent.contextMenu(folderRow('INBOX'), { clientX: 30, clientY: 40 });
    expect(within(screen.getByTestId('folder-context-menu')).queryByText(en['sidebar.moveFolder'])).toBeNull();
  });
});
