// @vitest-environment jsdom

import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBackupStore } from '../../stores/backupStore';
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
    sidebarCollapsed: false, sidebarStyle: 'list', sidebarLayout: 'stacked', sidebarBackupStatusLocation: 'avatar',
    backupGlobalEnabled: false, backupSchedules: {}, backupState: {}, displayNames: { studio: 'Design studio' },
    hiddenAccounts: {}, accountOrder: [], accountColors: {}, unreadPerAccount: { personal: 3 },
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null,
  });
  useBackupStore.setState({ activeBackup: null });
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

  describe.each(['avatar', 'row'])('backup health with %s placement', placement => {
    it.each([
      ['success', 1, 'sidebar.backupUpDate'],
      ['success', 72, 'sidebar.backupUpDate'],
      ['failed', 1, 'sidebar.backupFailedClickView'],
      ['degraded', 1, 'sidebar.backupIncompleteClickView'],
      [null, null, 'sidebar.neverBackedUpClickConfigure'],
      [null, 72, 'sidebar.backupOverdueClickView'],
    ])('preserves the meaning of %s after %s hours', (lastStatus, hoursAgo, labelKey) => {
      useSettingsStore.setState({
        sidebarBackupStatusLocation: placement,
        billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
        backupSchedules: { studio: { enabled: true, interval: 'daily' } },
        backupState: { studio: { lastStatus, lastBackupTime: hoursAgo === null ? 0 : Date.now() - hoursAgo * 3600_000 } },
      });
      render(<Sidebar />);
      expect(screen.getByRole('button', { name: t(labelKey) }).title).toBe(t(labelKey));
      expect(document.querySelectorAll('.sidebar-backup-status')).toHaveLength(1);
    });

    it('only exposes schedule health when automatic backups can run', () => {
      useSettingsStore.setState({ sidebarBackupStatusLocation: placement, backupGlobalEnabled: true });
      render(<Sidebar />);
      expect(document.querySelector('.sidebar-backup-status')).toBeNull();
      act(() => useSettingsStore.setState({ billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' } }));
      expect(screen.getAllByRole('button', { name: t('sidebar.neverBackedUpClickConfigure') })).toHaveLength(2);
      act(() => useSettingsStore.setState({ backupGlobalEnabled: false }));
      expect(document.querySelector('.sidebar-backup-status')).toBeNull();
    });
  });

  it('shows the latest failure when a hidden indicator is restored on a memoized account row', () => {
    useSettingsStore.setState({
      sidebarBackupStatusLocation: 'hidden',
      billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
      backupSchedules: { studio: { enabled: true, interval: 'daily' } },
      backupState: { studio: { lastStatus: 'success', lastBackupTime: Date.now() } },
    });
    render(<Sidebar />);
    act(() => useSettingsStore.getState().updateBackupState('studio', { lastStatus: 'failed' }));
    expect(screen.queryByRole('button', { name: t('sidebar.backupFailedClickView') })).toBeNull();
    act(() => useSettingsStore.getState().setSidebarBackupStatusLocation('row'));
    expect(screen.getByRole('button', { name: t('sidebar.backupFailedClickView') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('sidebar.backupUpDate') })).toBeNull();
  });

  it.each([false, true])('keeps live backup progress available with hidden account icons (collapsed: %s)', collapsed => {
    useSettingsStore.setState({ sidebarCollapsed: collapsed, sidebarBackupStatusLocation: 'hidden' });
    useBackupStore.setState({ activeBackup: {
      active: true, done: false, accountId: 'studio', accountEmail: 'studio@example.com',
      totalFolders: 4, completedFolders: 2, queueLength: 0,
    } });
    const onOpenBackup = vi.fn();
    render(<Sidebar onOpenBackup={onOpenBackup} />);
    expect(document.querySelector('.sidebar-backup-status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Backing up studio@example.com/ }));
    expect(onOpenBackup).toHaveBeenCalledOnce();
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

  it('scopes the cached-data notice to its own account', () => {
    // The notice group is keyed by account so switching accounts SWAPS it
    // rather than collapsing the outgoing card. Without the key the exiting
    // card lingers for the length of its animation, over the incoming
    // account's row.
    render(<Sidebar />);
    act(() => useMailStore.setState({
      suspectEmptyServerData: { accountId: 'studio', type: 'emails', message: 'Cached copy shown.', timestamp: 1 },
    }));
    expect(screen.getByTestId('cached-data-banner')).toBeTruthy();
    act(() => useMailStore.setState({ activeAccountId: 'personal' }));
    expect(screen.queryByTestId('cached-data-banner')).toBeNull();
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

describe('Insights workspace entry', () => {
  it.each(['account','current folder','all inboxes','mail source'])('leaves Insights before navigating to %s',async target=>{
    const onOpenMail=vi.fn();render(<Sidebar onOpenMail={onOpenMail} insightsOpen />);
    const control = target==='account' ? screen.getByRole('button',{name:'Design studio, studio@example.com'})
      : target==='current folder' ? screen.getByTestId('sidebar-folder-list').querySelector('[title="INBOX"]')
      : target==='all inboxes' ? screen.getByTestId('all-inboxes-btn')
      : within(screen.getByRole('group',{name:t('sidebar.mailSource')})).getByRole('button',{name:'Server'});
    expect(control).toBeTruthy();await act(async()=>fireEvent.click(control));
    expect(onOpenMail).toHaveBeenCalledOnce();
  });
  it.each([
    ['list','stacked',false],['tagcloud','stacked',false],['list','split',false],['list','switcher',false],['list','stacked',true],
  ])('is independently reachable in %s / %s / collapsed %s', (style,layout,collapsed) => {
    useSettingsStore.setState({sidebarStyle:style,sidebarLayout:layout,sidebarCollapsed:collapsed});
    const open=vi.fn();render(<Sidebar onOpenInsights={open} insightsOpen />);
    const button=screen.getByRole('button',{name:t('insights.title')});
    expect(button.getAttribute('aria-current')).toBe('page');
    fireEvent.click(button);expect(open).toHaveBeenCalledOnce();
    expect(useMailStore.getState().activeMailbox).toBe('INBOX');
  });
});
