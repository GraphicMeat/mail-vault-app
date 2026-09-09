// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { openFolder } from '../../services/workflows/loadSubtree';
import { t } from '../../i18n';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

vi.mock('../../services/workflows/loadSubtree', () => ({ openFolder: vi.fn() }));
vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(), getSavedEmailIds: async () => new Set(),
  getArchivedEmailIds: async () => new Set(), readLocalEmailIndex: async () => [],
}));
const accounts = [
  { id: 'studio', name: 'Studio', email: 'studio@example.com', authType: 'password' },
  { id: 'personal', name: 'Personal', email: 'personal@example.com', authType: 'oauth2' },
  { id: 'hidden', name: 'Hidden', email: 'hidden@example.com' },
];
const mailboxes = Array.from({ length: 12 }, (_, i) => ({ name: i ? `Project ${i}` : 'INBOX', path: i ? `Project ${i}` : 'INBOX' }));
const activateAccount = vi.fn();
const setUnifiedInbox = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    sidebarLayout: 'stacked', sidebarCollapsed: false, sidebarStyle: 'list', sidebarBackupStatusLocation: 'avatar',
    displayNames: { studio: 'Design studio' }, hiddenAccounts: { hidden: true },
    accountOrder: [], accountColors: {}, unreadPerAccount: { personal: 3 },
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null,
    lastMailboxPerAccount: { personal: 'Archive' },
  });
  useMailStore.setState({
    accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes, emails: [], localEmails: [], connectionStatus: 'connected',
    connectionError: null, connectionErrorType: null, suspectEmptyServerData: null,
    loading: false, loadingMore: false, totalEmails: 0, viewMode: 'all', folderStatus: {},
    activateAccount, setUnifiedInbox,
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const switcher = () => screen.getByRole('button', { name: new RegExp(t('sidebar.switchAccount')) });
const openChooser = () => { switcher().focus(); fireEvent.click(switcher()); return screen.getByRole('dialog', { name: t('workspace.accounts') }); };

describe('Sidebar layouts', () => {
  it('keeps split section controls outside their independent lists', () => {
    useSettingsStore.setState({ sidebarLayout: 'split' });
    render(<Sidebar />);
    const accountList = screen.getByTestId('sidebar-account-list');
    const folderList = screen.getByTestId('sidebar-folder-list');
    expect(accountList.closest('[data-sidebar-layout="split"]')).toBeTruthy();
    expect(folderList.closest('[data-sidebar-layout="split"]')).toBeTruthy();
    expect(within(accountList).queryByRole('heading')).toBeNull();
    expect(within(folderList).queryByRole('group', { name: t('sidebar.mailSource') })).toBeNull();
    expect(within(folderList).queryByRole('searchbox')).toBeNull();
    expect(within(folderList).getByText('Project 11')).toBeTruthy();
    expect(within(accountList).getByText('personal@example.com')).toBeTruthy();
  });

  it('offers searchable accounts, preserves last folder, and restores trigger focus', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    render(<Sidebar />);
    expect(screen.queryByText('personal@example.com')).toBeNull();
    const chooser = openChooser();
    const search = within(chooser).getByRole('searchbox', { name: t('sidebar.findAccount') });
    expect(document.activeElement).toBe(search);
    expect(within(chooser).queryByText('hidden@example.com')).toBeNull();
    fireEvent.change(search, { target: { value: 'personal@' } });
    expect(within(chooser).queryByRole('button', { name: 'Design studio, studio@example.com' })).toBeNull();
    const personal = within(chooser).getByRole('button', { name: 'Personal, personal@example.com' });
    expect(within(personal).getByText('3')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(personal);
    fireEvent.click(personal);
    expect(openFolder).toHaveBeenCalledWith('personal', 'Archive');
    expect(screen.queryByRole('dialog', { name: t('workspace.accounts') })).toBeNull();
    expect(document.activeElement).toBe(switcher());
  });

  it('keeps All Inboxes and Add account accessible, including when search has no results', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    const onAddAccount = vi.fn();
    render(<Sidebar onAddAccount={onAddAccount} />);
    let chooser = openChooser();
    fireEvent.click(within(chooser).getByRole('button', { name: t('sidebar.allInboxes') }));
    expect(setUnifiedInbox).toHaveBeenCalledWith(true);
    chooser = openChooser();
    fireEvent.change(within(chooser).getByRole('searchbox'), { target: { value: 'unmatched' } });
    expect(within(chooser).getByText(t('sidebar.noAccountsFound'))).toBeTruthy();
    fireEvent.click(within(chooser).getByRole('button', { name: t('sidebar.addAccount') }));
    expect(onAddAccount).toHaveBeenCalledOnce();
  });

  it('closes the account chooser with Escape and uses arrows between results', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    render(<Sidebar />);
    const chooser = openChooser();
    fireEvent.keyDown(within(chooser).getByRole('searchbox'), { key: 'ArrowDown' });
    const all = within(chooser).getByRole('button', { name: t('sidebar.allInboxes') });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(chooser).getByRole('button', { name: 'Design studio, studio@example.com' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: t('workspace.accounts') })).toBeNull();
    expect(document.activeElement).toBe(switcher());
  });


  it('isolates account chooser keys from real global mail actions', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher', keyboardShortcutsEnabled: true,
      keyboardShortcuts: { deleteEmail: '#', reply: 'r', nextEmail: 'j', previousEmail: 'k' },
    });
    const handlers = { deleteEmail: vi.fn(), reply: vi.fn(), nextEmail: vi.fn(), previousEmail: vi.fn() };
    renderHook(() => useKeyboardShortcuts(handlers));
    render(<Sidebar />);
    const chooser = openChooser();
    const account = within(chooser).getByRole('button', { name: 'Design studio, studio@example.com' });
    account.focus();
    for (const key of ['#', 'r', 'j', 'k']) fireEvent.keyDown(account, { key });
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(account, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: '#' });
    expect(handlers.deleteEmail).toHaveBeenCalledOnce();
  });

  it.each([1, 2])('shows empty account search only without a unified result (%s visible accounts)', count => {
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    useMailStore.setState({ accounts: accounts.slice(0, count) });
    render(<Sidebar />);
    const chooser = openChooser();
    fireEvent.change(within(chooser).getByRole('searchbox'), { target: { value: t('sidebar.allInboxes') } });
    expect(within(chooser).queryByRole('button', { name: t('sidebar.allInboxes') }) !== null).toBe(count > 1);
    expect(within(chooser).queryByText(t('sidebar.noAccountsFound')) !== null).toBe(count < 2);
  });

  it('shows active connection repair outside the closed chooser, without duplicating it inside', () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    useMailStore.setState({ connectionStatus: 'error', connectionErrorType: 'passwordMissing' });
    const onOpenAccounts = vi.fn();
    render(<Sidebar onOpenAccounts={onOpenAccounts} />);
    act(() => vi.advanceTimersByTime(3000));
    const repair = screen.getByRole('button', { name: t('sidebar.enterPassword') });
    fireEvent.click(repair);
    expect(onOpenAccounts).toHaveBeenCalledWith('studio', 'connection');
    const chooser = openChooser();
    expect(within(chooser).queryByRole('button', { name: t('sidebar.enterPassword') })).toBeNull();
    expect(screen.getAllByRole('button', { name: t('sidebar.enterPassword') })).toHaveLength(1);
  });

  it.each(['stacked', 'split', 'switcher'])('clears folder search when the account changes in %s', layout => {
    useSettingsStore.setState({ sidebarLayout: layout });
    render(<Sidebar />);
    const search = screen.getByRole('searchbox', { name: t('sidebar.findFolder') });
    fireEvent.change(search, { target: { value: 'Project 11' } });
    act(() => useMailStore.setState({ activeAccountId: 'personal', mailboxes: [{ name: 'INBOX', path: 'INBOX' }] }));
    expect(screen.queryByRole('searchbox', { name: t('sidebar.findFolder') })).toBeNull();
    expect(screen.getByTestId('folder-row').dataset.path).toBe('INBOX');
  });


  it('finds and opens an exact folder and preserves the query while refreshing a small result list', () => {
    useSettingsStore.setState({ sidebarLayout: 'split' });
    render(<Sidebar />);
    const search = screen.getByRole('searchbox', { name: t('sidebar.findFolder') });
    fireEvent.change(search, { target: { value: 'Project 11' } });
    const result = screen.getByRole('button', { name: 'Project 11' });
    fireEvent.click(result);
    expect(openFolder).toHaveBeenCalledWith('studio', 'Project 11');
    act(() => useMailStore.setState({ mailboxes: [{ name: 'Project 11', path: 'Project 11' }] }));
    expect(screen.getByRole('searchbox', { name: t('sidebar.findFolder') }).value).toBe('Project 11');
    act(() => useMailStore.setState({ unifiedInbox: true }));
    expect(screen.queryByRole('searchbox', { name: t('sidebar.findFolder') })).toBeNull();
    act(() => useMailStore.setState({ unifiedInbox: false, mailboxes }));
    expect(screen.getByRole('searchbox', { name: t('sidebar.findFolder') }).value).toBe('');
  });

  it('keeps backup actions separate in the chooser and closes before opening backup settings', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher',
      billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
      backupSchedules: { studio: { enabled: true, interval: 'daily' } },
      backupState: { studio: { lastStatus: 'success', lastBackupTime: Date.now() } },
    });
    const onOpenBackup = vi.fn();
    render(<Sidebar onOpenBackup={onOpenBackup} />);
    const chooser = openChooser();
    const backup = within(chooser).getByRole('button', { name: t('sidebar.backupUpDate') });
    const account = within(chooser).getByRole('button', { name: 'Design studio, studio@example.com' });
    expect(account.contains(backup)).toBe(false);
    fireEvent.click(backup);
    expect(onOpenBackup).toHaveBeenCalledWith('studio');
    expect(openFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: t('workspace.accounts') })).toBeNull();
  });

  it('keeps collapsed mode unchanged and preserves direct Inbox activation in the lists', () => {
    useSettingsStore.setState({ sidebarLayout: 'split' });
    render(<Sidebar />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Personal, personal@example.com' }));
    expect(activateAccount).toHaveBeenCalledWith('personal', 'INBOX');
    act(() => useSettingsStore.setState({ sidebarCollapsed: true, sidebarLayout: 'switcher' }));
    expect(screen.queryByRole('button', { name: new RegExp(t('sidebar.switchAccount')) })).toBeNull();
    expect(screen.getByRole('button', { name: 'Personal, personal@example.com' })).toBeTruthy();
  });

  it.each(['stacked', 'split', 'switcher', 'collapsed'])('hides backup status in %s without disabling backups, then restores the account action', layout => {
    useSettingsStore.setState({
      sidebarLayout: layout === 'collapsed' ? 'stacked' : layout, sidebarCollapsed: layout === 'collapsed',
      sidebarBackupStatusLocation: 'hidden', backupGlobalEnabled: true,
      billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
      backupState: { studio: { lastStatus: 'degraded', lastBackupTime: Date.now() } },
    });
    const onOpenBackup = vi.fn();
    render(<Sidebar onOpenBackup={onOpenBackup} />);
    if (layout === 'switcher') openChooser();
    expect(screen.queryByRole('button', { name: t('sidebar.backupIncompleteClickView') })).toBeNull();
    act(() => useSettingsStore.getState().setSidebarBackupStatusLocation('avatar'));
    const scope = layout === 'switcher' ? within(screen.getByRole('dialog', { name: t('workspace.accounts') })) : screen;
    const backup = scope.getByRole('button', { name: t('sidebar.backupIncompleteClickView') });
    expect(backup.closest('button')?.parentElement.closest('button')).toBeNull();
    fireEvent.click(backup);
    expect(onOpenBackup).toHaveBeenCalledWith('studio');
    expect(openFolder).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().backupGlobalEnabled).toBe(true);
  });
});
