// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { openFolder } from '../../services/workflows/loadSubtree';
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
    accountOrder: [], hiddenAccounts: {}, accountColors: {}, displayNames: {}, unreadPerAccount: {},
    expandedFolders: {}, transferHoverEnabled: false, billingProfile: null });
  useMailStore.setState({ accounts, activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false,
    mailboxes: [], emails: [], localEmails: [], connectionStatus: 'connected', connectionError: null,
    connectionErrorType: null, suspectEmptyServerData: null, loading: false, loadingMore: false,
    totalEmails: 0, viewMode: 'all', folderStatus: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('sidebar account groups', () => {
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
});
