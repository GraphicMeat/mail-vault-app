// @vitest-environment jsdom
//
// FolderSelector: the source filter, folder search and folder list as one
// module, mounted by the sidebar either in its own Folders section or under
// the selected account row.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FolderSelector } from '../FolderSelector';
import { useMailStore } from '../../../stores/mailStore';
import '../../../services/workflows/bindStoreActions';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

const mailboxes = [
  { name: 'INBOX', path: 'INBOX', delimiter: '/' },
  { name: 'Projects', path: 'Projects', delimiter: '/' },
  { name: 'Receipts', path: 'Receipts', delimiter: '/' },
];

const base = {
  accountId: 'studio', mailboxes, activeMailbox: 'INBOX', expanded: new Set(),
  onToggle: () => {}, onSelect: vi.fn(), onContextMenu: () => {}, onNewFolder: vi.fn(), onOpenMail: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  useMailStore.setState({ viewMode: 'all' });
  useSettingsStore.setState({ sidebarStyle: 'list', expandedFolders: {} });
});
afterEach(cleanup);

const rows = () => [...screen.getByTestId('sidebar-folder-list').querySelectorAll('[data-testid="folder-row"]')].map(r => r.dataset.path);

describe('FolderSelector', () => {
  it('switches the mail source and returns to the mail view', () => {
    render(<FolderSelector {...base} />);
    const group = screen.getByRole('group', { name: t('sidebar.mailSource') });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(within(group).getByRole('button', { name: t('sidebar.viewServer') }));
    expect(useMailStore.getState().viewMode).toBe('server');
    expect(base.onOpenMail).toHaveBeenCalled();
    expect(within(group).getByRole('button', { name: t('sidebar.viewServer') }).getAttribute('aria-pressed')).toBe('true');
  });

  it('filters folders by the search and clears the search when the account changes', () => {
    const { rerender } = render(<FolderSelector {...base} />);
    const search = screen.getByRole('searchbox', { name: t('sidebar.findFolder') });
    fireEvent.change(search, { target: { value: 'proj' } });
    expect(rows()).toEqual(['Projects']);
    rerender(<FolderSelector {...base} accountId="personal" />);
    expect(screen.getByRole('searchbox', { name: t('sidebar.findFolder') }).value).toBe('');
    expect(rows()).toEqual(['INBOX', 'Projects', 'Receipts']);
  });

  it('opens the folder that is picked', () => {
    render(<FolderSelector {...base} />);
    fireEvent.click(screen.getByTestId('sidebar-folder-list').querySelector('[data-path="Receipts"]'));
    expect(base.onSelect).toHaveBeenCalledWith('Receipts');
  });

  it('shows its Folders heading with New folder only in the section variant', () => {
    const { rerender } = render(<FolderSelector {...base} heading />);
    expect(screen.getByRole('heading', { name: t('sidebar.folders') })).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-folder-btn'));
    expect(base.onNewFolder).toHaveBeenCalled();
    rerender(<FolderSelector {...base} />);
    expect(screen.queryByRole('heading', { name: t('sidebar.folders') })).toBeNull();
    expect(screen.queryByTestId('new-folder-btn')).toBeNull();
  });

  it('lists the All Inboxes folders, without New folder, when the unified inbox is open', () => {
    render(<FolderSelector {...base} heading unifiedInbox />);
    expect(within(screen.getByTestId('sidebar-folder-list')).getByText(t('sidebar.inbox'))).toBeTruthy();
    expect(screen.queryByTestId('new-folder-btn')).toBeNull();
  });
});
