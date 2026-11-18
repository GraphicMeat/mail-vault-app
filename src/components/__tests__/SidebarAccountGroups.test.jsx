// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePrivacyStore } from '../../stores/privacyStore';
import { openFolder } from '../../services/workflows/loadSubtree';
import { getUnifiedFolder, putUnifiedFolder } from '../../services/workflows/unifiedFolderCache';
import { t } from '../../i18n';
import '../../services/workflows/bindStoreActions';

vi.mock('../../services/workflows/loadSubtree', () => ({ openFolder: vi.fn() }));
vi.mock('../../services/db', async importOriginal => ({
  ...await importOriginal(),
  readLocalEmailIndex: async () => [],
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
}));
const accounts = [
  { id: 'a', name: 'Alice', email: 'alice@example.com' },
  { id: 'b', name: 'Bob', email: 'bob@example.com' },
  { id: 'c', name: 'Carol', email: 'carol@example.com' },
];
beforeEach(() => {
  useSettingsStore.setState({ sidebarLayout: 'stacked', sidebarCollapsed: false, sidebarStyle: 'list',
    sidebarBackupStatusLocation: 'avatar', accountGroups: { a: 'Personal', b: 'Work', c: 'Work' },
    accountOrder: [], hiddenAccounts: {}, accountColors: {}, displayNames: {}, unreadPerAccount: {}, collapsedAccountGroups: {},
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null });
  useMailStore.setState({ accounts, activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false, unifiedGroup: null,
    mailboxes: [], emails: [], localEmails: [], connectionStatus: 'connected', connectionError: null,
    connectionErrorType: null, suspectEmptyServerData: null, loading: false, loadingMore: false,
    totalEmails: 0, viewMode: 'all', folderStatus: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); usePrivacyStore.setState({ enabled: false }); vi.restoreAllMocks(); });

describe('sidebar account groups', () => {
  it('opens a group inbox and leaves All Inboxes unselected', async () => {
    const onOpenMail = vi.fn();
    const load = useMailStore.getState().loadUnifiedInbox;
    useMailStore.setState({ loadUnifiedInbox: vi.fn().mockResolvedValue() });
    render(<Sidebar onOpenMail={onOpenMail} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: 'Work inbox' }));
    await vi.waitFor(() => expect(useMailStore.getState().unifiedGroup).toBe('Work'));
    expect(onOpenMail).toHaveBeenCalled();
    expect(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: 'Work inbox' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('all-inboxes-btn').hasAttribute('aria-current')).toBe(false);
    useMailStore.setState({ loadUnifiedInbox: load });
  });
  it('folds, keeps unread sum, and restores the fold after remount', () => {
    useSettingsStore.setState({ unreadPerAccount: { b: 3, c: 4 } });
    const view = render(<Sidebar />);
    const work = () => screen.getByRole('group', { name: 'Work' });
    const toggle = () => within(work()).getByRole('button', { name: 'Collapse Work' });
    fireEvent.click(toggle());
    expect(within(work()).getByRole('button', { name: 'Expand Work' }).getAttribute('aria-expanded')).toBe('false');
    expect(work().textContent).toContain('7');
    expect(within(work()).queryByRole('button', { name: /Bob/ })).toBeNull();
    view.unmount();
    render(<Sidebar />);
    expect(within(work()).getByRole('button', { name: 'Expand Work' })).toBeTruthy();
    fireEvent.click(within(work()).getByRole('button', { name: 'Expand Work' }));
    expect(within(work()).getByRole('button', { name: /Bob/ })).toBeTruthy();
  });
  it('falls back to All Inboxes when the open group disappears', async () => {
    const load = useMailStore.getState().loadUnifiedInbox;
    useMailStore.setState({ unifiedInbox: true, unifiedGroup: 'Work', loadUnifiedInbox: vi.fn().mockResolvedValue() });
    render(<Sidebar />);
    act(() => useSettingsStore.setState({ accountGroups: { a: 'Personal' } }));
    await vi.waitFor(() => expect(useMailStore.getState().unifiedGroup).toBeNull());
    useMailStore.setState({ loadUnifiedInbox: load });
  });
  it('reloads an open group when an account moves out', async () => {
    const load = useMailStore.getState().loadUnifiedInbox;
    const reload = vi.fn().mockResolvedValue();
    useMailStore.setState({ unifiedInbox: true, unifiedGroup: 'Work', activeMailbox: 'UNIFIED',
      emails: [{ uid: 1, _accountId: 'c', _mailbox: 'INBOX', subject: 'Moved account' }], loadUnifiedInbox: reload });
    putUnifiedFolder('INBOX', [{ uid: 1, _accountId: 'c', _mailbox: 'INBOX' }]);
    render(<Sidebar />);
    act(() => useSettingsStore.setState({ accountGroups: { a: 'Personal', b: 'Work', c: 'Personal' } }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(getUnifiedFolder('INBOX')).toBeUndefined();
    expect(useMailStore.getState().emails.some(email => email._accountId === 'c')).toBe(false);
    expect(useMailStore.getState().unifiedGroup).toBe('Work');
    useMailStore.setState({ loadUnifiedInbox: load });
  });
  it('keeps a group named toString expanded and toggleable', () => {
    useSettingsStore.setState({ accountGroups: { a: 'toString', b: 'Work', c: 'Work' } });
    render(<Sidebar />);
    const group = () => screen.getByRole('group', { name: 'toString' });
    expect(within(group()).getByRole('button', { name: /Alice/ })).toBeTruthy();
    fireEvent.click(within(group()).getByRole('button', { name: 'Collapse toString' }));
    expect(within(group()).queryByRole('button', { name: /Alice/ })).toBeNull();
    fireEvent.click(within(group()).getByRole('button', { name: 'Expand toString' }));
    expect(within(group()).getByRole('button', { name: /Alice/ })).toBeTruthy();
  });
  it('opens a folded group from the chooser and exposes matches during search', async () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher', collapsedAccountGroups: { Work: true } });
    const load = useMailStore.getState().loadUnifiedInbox;
    useMailStore.setState({ loadUnifiedInbox: vi.fn().mockResolvedValue() });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Switch account/ }));
    const chooser = screen.getByRole('dialog', { name: 'Accounts' });
    expect(within(chooser).queryByRole('button', { name: /Bob/ })).toBeNull();
    fireEvent.change(within(chooser).getByRole('searchbox'), { target: { value: 'bob' } });
    expect(within(chooser).getByRole('button', { name: /Bob/ })).toBeTruthy();
    fireEvent.click(within(chooser).getByRole('button', { name: 'Work inbox' }));
    await vi.waitFor(() => expect(useMailStore.getState().unifiedGroup).toBe('Work'));
    expect(screen.queryByRole('dialog', { name: 'Accounts' })).toBeNull();
    useMailStore.setState({ loadUnifiedInbox: load });
  });
  it('opens a group from the rail while account avatars stay visible', async () => {
    useSettingsStore.setState({ sidebarCollapsed: true, collapsedAccountGroups: { Work: true } });
    const load = useMailStore.getState().loadUnifiedInbox;
    useMailStore.setState({ loadUnifiedInbox: vi.fn().mockResolvedValue() });
    render(<Sidebar />);
    const rail = document.querySelector('.sidebar-collapsed-accounts');
    expect(rail.querySelectorAll('button[aria-label*="@"]')).toHaveLength(3);
    fireEvent.click(within(rail).getByRole('button', { name: 'Work inbox' }));
    await vi.waitFor(() => expect(useMailStore.getState().unifiedGroup).toBe('Work'));
    expect(rail.querySelectorAll('button[aria-label*="@"]')).toHaveLength(3);
    useMailStore.setState({ loadUnifiedInbox: load });
  });
  it('renders named groups and keeps account order', () => {
    render(<Sidebar />);
    const personal = screen.getByRole('group', { name: 'Personal' });
    const work = screen.getByRole('group', { name: 'Work' });
    expect(within(personal).getByRole('button', { name: /Alice/ })).toBeTruthy();
    expect([...work.querySelectorAll('.sidebar-account-open')].map(row => row.getAttribute('aria-label')))
      .toEqual(['Bob, bob@example.com', 'Carol, carol@example.com']);
    expect(within(screen.getByTestId('sidebar-account-list')).queryByRole('heading')).toBeNull();
  });
  it('puts ungrouped accounts first without a wrapper', () => {
    useSettingsStore.setState({ accountGroups: { b: 'Work' } });
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-account-list');
    expect(list.querySelector('[aria-label="Work"]').previousElementSibling.textContent).toContain('Carol');
    expect(list.querySelector('[aria-label="Work"]').textContent).toContain('Bob');
  });
  it('keeps the old row DOM when no groups exist', () => {
    useSettingsStore.setState({ accountGroups: {} });
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-account-list');
    expect(list.querySelector('.sidebar-group-label')).toBeNull();
    expect(list.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect(list.querySelectorAll('.sidebar-account-open')).toHaveLength(3);
  });
  it('omits hidden accounts and their empty groups', () => {
    useSettingsStore.setState({ hiddenAccounts: { a: true } });
    render(<Sidebar />);
    expect(screen.queryByRole('group', { name: 'Personal' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Work' })).toBeTruthy();
  });
  it('groups filtered chooser results', () => {
    useSettingsStore.setState({ sidebarLayout: 'switcher' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Switch account/ }));
    const chooser = screen.getByRole('dialog', { name: 'Accounts' });
    fireEvent.change(within(chooser).getByRole('searchbox'), { target: { value: 'bob' } });
    expect(within(chooser).getByRole('group', { name: 'Work' })).toBeTruthy();
    expect(within(chooser).queryByRole('group', { name: 'Personal' })).toBeNull();
  });
  it('opens a grouped account and keeps its connection notice under its row', () => {
    vi.useFakeTimers();
    const onOpenAccounts = vi.fn();
    render(<Sidebar onOpenAccounts={onOpenAccounts} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: /Bob/ }));
    expect(openFolder).toHaveBeenCalledWith('b', 'INBOX');
    act(() => useMailStore.setState({ activeAccountId: 'b', connectionStatus: 'error', connectionErrorType: 'passwordMissing' }));
    act(() => vi.advanceTimersByTime(3000));
    const work = screen.getByRole('group', { name: 'Work' });
    fireEvent.click(within(work).getByRole('button', { name: t('sidebar.enterPassword') }));
    expect(onOpenAccounts).toHaveBeenCalledWith('b', 'connection');
  });
  it('separates collapsed sections without changing account order', () => {
    useSettingsStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    const rail = document.querySelector('.sidebar-collapsed-accounts');
    expect(rail.querySelectorAll('.sidebar-collapsed-divider')).toHaveLength(1);
    expect([...rail.querySelectorAll('button[aria-label*="@"]')].map(row => row.getAttribute('aria-label')))
      .toEqual(['Alice, alice@example.com', 'Bob, bob@example.com', 'Carol, carol@example.com']);
  });
  it('masks group labels, accessible names, and divider titles in privacy mode', () => {
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
    usePrivacyStore.setState({ enabled: true });
    const { rerender } = render(<Sidebar />);
    const list = screen.getByTestId('sidebar-account-list');
    expect(list.textContent).not.toContain('Personal');
    expect(list.textContent).not.toContain('Work');
    expect(list.querySelector('[role="group"][aria-label="Personal"]')).toBeNull();
    expect(list.querySelector('[role="group"][aria-label="Work"]')).toBeNull();
    useSettingsStore.setState({ sidebarCollapsed: true });
    rerender(<Sidebar />);
    const divider = document.querySelector('.sidebar-collapsed-divider');
    expect(divider).toBeTruthy();
    expect(divider.title).not.toBe('Work');
  });
});
