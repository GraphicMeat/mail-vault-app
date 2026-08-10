// @vitest-environment jsdom

// The shared 3-dot menu content used by EmailRow, CompactEmailRow, ThreadRow
// and CompactThreadRow. Task 10 replaced three drifted copies (two items)
// with this one component gated to match SelectionActionBar's six actions.
// These tests cover the gating matrix (archived / unarchived / local-only)
// and that both destructive items route through onRequestDelete's
// parent-owned confirmation instead of firing immediately — an inline
// confirm inside a virtualized row is the documented unreliable pattern
// this repo avoids.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return {
    MailOpen: icon('MailOpen'),
    Mail: icon('Mail'),
    Archive: icon('Archive'),
    ArchiveRestore: icon('ArchiveRestore'),
    FolderSymlink: icon('FolderSymlink'),
    Trash2: icon('Trash2'),
    ShieldX: icon('ShieldX'),
  };
});

// MoveToFolderDropdown pulls in its own store deps (mailboxes, search input,
// etc.) that are irrelevant here — the menu only needs to toggle it open.
vi.mock('../MoveToFolderDropdown', () => ({
  MoveToFolderDropdown: ({ uids }) => React.createElement('div', { 'data-testid': 'move-dropdown' }, JSON.stringify(uids)),
}));

const useMailStoreMock = create(() => ({
  activeMailbox: 'INBOX',
  setSelection: vi.fn(),
  markSelectedAsRead: vi.fn(),
  markSelectedAsUnread: vi.fn(),
  purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 }),
}));

vi.mock('../../stores/mailStore', () => ({
  useMailStore: (selector) => useMailStoreMock(selector),
}));

import { RowActionMenuItems } from '../RowActionMenuItems';

const baseEmail = (overrides) => ({
  uid: 42,
  flags: [],
  isArchived: false,
  source: 'server',
  ...overrides,
});

function makeActions() {
  return {
    saveEmailLocally: vi.fn().mockResolvedValue(),
    removeLocalEmail: vi.fn().mockResolvedValue(),
    deleteEmailFromServer: vi.fn().mockResolvedValue(),
  };
}

describe('RowActionMenuItems', () => {
  beforeEach(() => {
    useMailStoreMock.setState({
      activeMailbox: 'INBOX',
      setSelection: vi.fn(),
      markSelectedAsRead: vi.fn(),
      markSelectedAsUnread: vi.fn(),
      purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 }),
    });
  });
  afterEach(() => cleanup());

  it('an archived server-backed row shows Unarchive, not Archive, plus both deletes', () => {
    const email = baseEmail({ isArchived: true, source: 'server' });
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Unarchive')).toBeTruthy();
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.getByText('Delete from server')).toBeTruthy();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('an unarchived server-backed row shows Archive, not Unarchive, plus both deletes', () => {
    const email = baseEmail({ isArchived: false, source: 'server' });
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Archive')).toBeTruthy();
    expect(screen.queryByText('Unarchive')).toBeNull();
    expect(screen.getByText('Delete from server')).toBeTruthy();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('a local-only row hides Delete from server but keeps Delete everywhere', () => {
    // Local-only rows are always archived (computeDisplayEmails/updateSortedEmails
    // force isArchived: true wherever source becomes 'local-only').
    const email = baseEmail({ isArchived: true, source: 'local-only' });
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Unarchive')).toBeTruthy();
    expect(screen.queryByText('Delete from server')).toBeNull();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('Mark as unread shows for a read email, Mark as read for an unread one', () => {
    const read = baseEmail({ flags: ['\\Seen'] });
    const { unmount } = render(<RowActionMenuItems email={read} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Mark as unread')).toBeTruthy();
    expect(screen.queryByText('Mark as read')).toBeNull();
    unmount();

    const unread = baseEmail({ flags: [] });
    render(<RowActionMenuItems email={unread} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Mark as read')).toBeTruthy();
    expect(screen.queryByText('Mark as unread')).toBeNull();
  });

  it('Delete everywhere routes through onRequestDelete instead of purging immediately', () => {
    const email = baseEmail({ isArchived: false, source: 'server' });
    const onRequestDelete = vi.fn();
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Delete everywhere'));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(useMailStoreMock.getState().purgeSelectedEverywhere).not.toHaveBeenCalled();
    const [executor, label] = onRequestDelete.mock.calls[0];
    expect(typeof executor).toBe('function');
    expect(label).toMatch(/removed from the server, this computer, and your external backup/);
  });

  it('Delete from server also routes through onRequestDelete, not deleteEmailFromServer directly', () => {
    const email = baseEmail({ isArchived: false, source: 'server' });
    const onRequestDelete = vi.fn();
    const actions = makeActions();
    render(<RowActionMenuItems email={email} actions={actions} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Delete from server'));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(actions.deleteEmailFromServer).not.toHaveBeenCalled();
  });

  it('the Delete everywhere executor scopes selection to this row before purging', async () => {
    const email = baseEmail({ uid: 7, isArchived: false, source: 'server' });
    const onRequestDelete = vi.fn();
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Delete everywhere'));
    const [executor] = onRequestDelete.mock.calls[0];
    await executor();

    expect(useMailStoreMock.getState().setSelection).toHaveBeenCalledWith([7]);
    expect(useMailStoreMock.getState().purgeSelectedEverywhere).toHaveBeenCalledTimes(1);
  });

  it('builds the accountId:uid selection key in unified inbox mode, not a raw uid', async () => {
    useMailStoreMock.setState({ activeMailbox: 'UNIFIED' });
    const email = baseEmail({ uid: 7, _accountId: 'acct-9', isArchived: false, source: 'server' });
    const onRequestDelete = vi.fn();
    render(<RowActionMenuItems email={email} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Delete everywhere'));
    const [executor] = onRequestDelete.mock.calls[0];
    await executor();

    expect(useMailStoreMock.getState().setSelection).toHaveBeenCalledWith(['acct-9:7']);
  });
});
