// @vitest-environment jsdom

import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';

vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(),
  getSavedEmailIds: async () => new Set(),
  getArchivedEmailIds: async () => new Set(),
  readLocalEmailIndex: async () => [],
}));

const accounts = [
  { id: 'studio', name: 'Old studio name', email: 'studio@example.com', authType: 'password' },
  { id: 'personal', name: 'Personal', email: 'personal@example.com', authType: 'oauth2' },
];

beforeEach(() => {
  useSettingsStore.setState({
    sidebarCollapsed: false, sidebarStyle: 'list', displayNames: { studio: 'Design studio' },
    hiddenAccounts: {}, accountOrder: [], accountColors: {}, unreadPerAccount: { personal: 3 },
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null,
  });
  useMailStore.setState({
    accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [{ name: 'INBOX', path: 'INBOX' }, { name: 'Archive', path: 'Archive', specialUse: '\\Archive' }],
    emails: [{ uid: 1, subject: 'Sample', date: '2026-09-08' }], localEmails: [],
    connectionStatus: 'connected', connectionError: null, connectionErrorType: null,
    suspectEmptyServerData: null, loading: false, loadingMore: false, totalEmails: 1,
    viewMode: 'all', folderStatus: {},
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Sidebar navigation', () => {
  it.each(['list', 'tagcloud'])('uses the saved account name and address in %s navigation', style => {
    useSettingsStore.setState({ sidebarStyle: style });
    render(<Sidebar />);
    const row = screen.getByRole('button', { name: 'Design studio, studio@example.com' });
    expect(within(row).getByText('Design studio')).toBeTruthy();
    expect(within(row).getByText('studio@example.com')).toBeTruthy();
    expect(screen.queryByText('Old studio name')).toBeNull();
  });

  it('keeps Settings beside Refresh outside the scrolling navigation', () => {
    const onOpenSettings = vi.fn();
    render(<Sidebar onOpenSettings={onOpenSettings} />);
    const header = screen.getByTestId('sidebar-header');
    expect(within(header).getByTitle('Refresh emails')).toBeTruthy();
    fireEvent.click(within(header).getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getAllByTestId('open-settings')).toHaveLength(1);
  });

  it('updates a renamed account immediately and keeps its name in the collapsed rail', () => {
    render(<Sidebar />);
    act(() => useSettingsStore.setState({ displayNames: { studio: 'Client work' } }));
    expect(screen.getByRole('button', { name: 'Client work, studio@example.com' })).toBeTruthy();
    act(() => useSettingsStore.setState({ sidebarCollapsed: true }));
    expect(screen.getByRole('button', { name: 'Client work, studio@example.com' })).toBeTruthy();
  });

  it.each([false, true])('exposes backup separately from account activation when collapsed is %s', collapsed => {
    useSettingsStore.setState({
      sidebarCollapsed: collapsed,
      billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
      backupSchedules: { studio: { enabled: true, interval: 'daily' } },
      backupState: { studio: { lastStatus: 'success', lastBackupTime: Date.now() } },
    });
    const onOpenBackup = vi.fn();
    render(<Sidebar onOpenBackup={onOpenBackup} />);
    const account = screen.getByRole('button', { name: 'Design studio, studio@example.com' });
    const backup = screen.getByRole('button', { name: 'Backup up to date' });
    expect(account.tagName).toBe('BUTTON');
    expect(account.contains(backup)).toBe(false);
    expect(backup.closest('[role="button"]')).toBeNull();
    fireEvent.click(backup);
    expect(onOpenBackup).toHaveBeenCalledWith('studio');
  });

  it('keeps all mail locations directly accessible and changes the actual filter', async () => {
    render(<Sidebar />);
    expect(screen.queryByText('Show mail from')).toBeNull();
    const sources = screen.getByRole('group', { name: t('sidebar.mailSource') });
    fireEvent.click(within(sources).getByRole('button', { name: 'Server' }));
    expect(useMailStore.getState().viewMode).toBe('server');
    await act(async () => fireEvent.click(within(sources).getByRole('button', { name: 'Vault' })));
    expect(useMailStore.getState().viewMode).toBe('local');
    await act(async () => fireEvent.click(within(sources).getByRole('button', { name: t('sidebar.allMail') })));
    expect(useMailStore.getState().viewMode).toBe('all');
  });

  it('puts repair and server-change details in the account dialog without displaying technical text in navigation', () => {
    vi.useFakeTimers();
    useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'serverError', connectionError: 'IMAP greeting failed: test detail' });
    render(<Sidebar />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText('IMAP greeting failed: test detail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change server' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.details') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('IMAP greeting failed: test detail')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Change server' })).toBeTruthy();
    expect(within(dialog).getByText('studio@example.com')).toBeTruthy();
  });

  it('waits for a persistent error on each account before offering its repair', () => {
    vi.useFakeTimers();
    useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'serverError', connectionError: 'Connection failed' });
    render(<Sidebar />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('button', { name: t('sidebar.details') })).toBeTruthy();
    act(() => useMailStore.setState({ activeAccountId: 'personal', connectionErrorType: 'oauthExpired' }));
    expect(screen.queryByRole('button', { name: t('sidebar.reconnect') })).toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('button', { name: t('sidebar.reconnect') })).toBeTruthy();
  });
});
