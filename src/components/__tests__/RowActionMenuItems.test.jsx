// @vitest-environment jsdom

// The shared 3-dot menu content used by EmailRow, CompactEmailRow, ThreadRow
// and CompactThreadRow. `emails` is every message the row's checkbox would
// select — one for a plain row, every message in the thread for a thread
// row — so gating and every action operate on that whole set, the same way
// SelectionActionBar derives its gating from the bulk selection.
//
// Two hazards this file guards against:
//  1. markSelectedAsRead/Unread and purgeSelectedEverywhere act on the
//     global selectedEmailIds and reset it to empty as a side effect of
//     finishing. Scoping it to this row's keys must not silently destroy an
//     unrelated bulk selection the user still has active — it must be
//     stashed and restored (minus the acted-on keys for a destructive
//     action).
//  2. Destructive items must route through onRequestDelete's parent-owned
//     confirmation, never fire immediately — an inline confirm inside a
//     virtualized row is the documented unreliable pattern this repo avoids.
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

const initialStoreState = () => ({
  activeMailbox: 'INBOX',
  activeAccountId: 'acct-1',
  selectedEmailIds: new Set(),
  setSelection: vi.fn(),
  markSelectedAsRead: vi.fn().mockResolvedValue(),
  markSelectedAsUnread: vi.fn().mockResolvedValue(),
  purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 }),
  loadEmails: vi.fn(),
});

const useMailStoreMock = create(initialStoreState);

// RowActionMenuItems reads useMailStore.getState() imperatively (the stash
// in runScoped, the multi-message delete loop) in addition to the hook form
// — the mock needs both.
function useMailStore(selector) {
  return useMailStoreMock(selector);
}
useMailStore.getState = () => useMailStoreMock.getState();

vi.mock('../../stores/mailStore', () => ({ useMailStore }));

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
    saveEmailsLocally: vi.fn().mockResolvedValue(),
    removeLocalEmail: vi.fn().mockResolvedValue(),
    deleteEmailFromServer: vi.fn().mockResolvedValue(),
  };
}

describe('RowActionMenuItems', () => {
  beforeEach(() => {
    useMailStoreMock.setState(initialStoreState());
  });
  afterEach(() => cleanup());

  it('an archived server-backed row shows Unarchive, not Archive, plus both deletes', () => {
    const email = baseEmail({ isArchived: true, source: 'server' });
    render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Unarchive')).toBeTruthy();
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.getByText('Delete from server')).toBeTruthy();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('an unarchived server-backed row shows Archive, not Unarchive, plus both deletes', () => {
    const email = baseEmail({ isArchived: false, source: 'server' });
    render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Archive')).toBeTruthy();
    expect(screen.queryByText('Unarchive')).toBeNull();
    expect(screen.getByText('Delete from server')).toBeTruthy();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('a local-only row hides Delete from server but keeps Delete everywhere', () => {
    // Local-only rows are always archived (computeDisplayEmails/updateSortedEmails
    // force isArchived: true wherever source becomes 'local-only').
    const email = baseEmail({ isArchived: true, source: 'local-only' });
    render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Unarchive')).toBeTruthy();
    expect(screen.queryByText('Delete from server')).toBeNull();
    expect(screen.getByText('Delete everywhere')).toBeTruthy();
  });

  it('Mark as unread shows for a read email, Mark as read for an unread one', () => {
    const read = baseEmail({ flags: ['\\Seen'] });
    const { unmount } = render(<RowActionMenuItems emails={[read]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Mark as unread')).toBeTruthy();
    expect(screen.queryByText('Mark as read')).toBeNull();
    unmount();

    const unread = baseEmail({ flags: [] });
    render(<RowActionMenuItems emails={[unread]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Mark as read')).toBeTruthy();
    expect(screen.queryByText('Mark as unread')).toBeNull();
  });

  describe('thread rows (multi-message sets)', () => {
    it('shows both Archive and Unarchive when the thread has a mix of both', () => {
      const emails = [
        baseEmail({ uid: 1, isArchived: false, source: 'server' }),
        baseEmail({ uid: 2, isArchived: true, source: 'server' }),
      ];
      render(<RowActionMenuItems emails={emails} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      expect(screen.getByText('Archive')).toBeTruthy();
      expect(screen.getByText('Unarchive')).toBeTruthy();
    });

    it('shows both Mark as read and Mark as unread when the thread has a mix of both', () => {
      const emails = [
        baseEmail({ uid: 1, flags: ['\\Seen'] }),
        baseEmail({ uid: 2, flags: [] }),
      ];
      render(<RowActionMenuItems emails={emails} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      expect(screen.getByText('Mark as read')).toBeTruthy();
      expect(screen.getByText('Mark as unread')).toBeTruthy();
    });

    it('Archive only archives the unarchived messages in the set', async () => {
      const emails = [
        baseEmail({ uid: 1, isArchived: false, source: 'server' }),
        baseEmail({ uid: 2, isArchived: true, source: 'server' }),
      ];
      const actions = makeActions();
      render(<RowActionMenuItems emails={emails} actions={actions} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Archive'));
      await Promise.resolve();
      expect(actions.saveEmailsLocally).toHaveBeenCalledWith([1]);
    });

    it('Unarchive only unarchives the archived messages in the set', async () => {
      const emails = [
        baseEmail({ uid: 1, isArchived: false, source: 'server' }),
        baseEmail({ uid: 2, isArchived: true, source: 'server' }),
      ];
      const actions = makeActions();
      render(<RowActionMenuItems emails={emails} actions={actions} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Unarchive'));
      await Promise.resolve();
      expect(actions.removeLocalEmail).toHaveBeenCalledWith(2);
      expect(actions.removeLocalEmail).toHaveBeenCalledTimes(1);
    });

    it('Delete from server deletes every server-backed message with per-message mailbox resolution, skipping local-only', async () => {
      const emails = [
        baseEmail({ uid: 1, source: 'server' }),
        baseEmail({ uid: 2, source: 'server' }),
        baseEmail({ uid: 3, source: 'local-only', isArchived: true }),
      ];
      const actions = makeActions();
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={emails} actions={actions} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete from server'));
      const [executor, label] = onRequestDelete.mock.calls[0];
      expect(label).toMatch(/^2 emails will be permanently deleted/);
      await executor();

      expect(actions.deleteEmailFromServer).toHaveBeenCalledTimes(2);
      expect(actions.deleteEmailFromServer).toHaveBeenCalledWith(1, { skipRefresh: true, mailboxOverride: 'INBOX' });
      expect(actions.deleteEmailFromServer).toHaveBeenCalledWith(2, { skipRefresh: true, mailboxOverride: 'INBOX' });
      expect(useMailStoreMock.getState().loadEmails).toHaveBeenCalledTimes(1);
    });

    it('Delete everywhere scopes to every message in the set, including local-only ones', async () => {
      const emails = [
        baseEmail({ uid: 1, source: 'server' }),
        baseEmail({ uid: 2, source: 'local-only', isArchived: true }),
      ];
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={emails} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete everywhere'));
      const [executor, label] = onRequestDelete.mock.calls[0];
      expect(label).toMatch(/^2 emails will be removed/);
      await executor();

      expect(useMailStoreMock.getState().setSelection).toHaveBeenCalledWith([1, 2]);
    });
  });

  describe('a destructive action never fires immediately', () => {
    it('Delete everywhere routes through onRequestDelete instead of purging immediately', () => {
      const email = baseEmail({ isArchived: false, source: 'server' });
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

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
      render(<RowActionMenuItems emails={[email]} actions={actions} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete from server'));

      expect(onRequestDelete).toHaveBeenCalledTimes(1);
      expect(actions.deleteEmailFromServer).not.toHaveBeenCalled();
    });
  });

  describe('unified inbox selection keys', () => {
    it('builds the accountId:uid selection key in unified inbox mode, not a raw uid', async () => {
      useMailStoreMock.setState({ activeMailbox: 'UNIFIED' });
      const email = baseEmail({ uid: 7, _accountId: 'acct-9', isArchived: false, source: 'server' });
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete everywhere'));
      const [executor] = onRequestDelete.mock.calls[0];
      await executor();

      expect(useMailStoreMock.getState().setSelection).toHaveBeenCalledWith(['acct-9:7']);
    });
  });

  describe('a pre-existing bulk selection survives a row-scoped action', () => {
    it('Mark as read restores the prior selection untouched', async () => {
      useMailStoreMock.setState({ selectedEmailIds: new Set([1, 2, 3]) });
      const email = baseEmail({ uid: 99, flags: [] }); // not part of the prior selection
      const onClose = vi.fn();
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={onClose} />);

      fireEvent.click(screen.getByText('Mark as read'));
      await Promise.resolve();
      await Promise.resolve();

      const calls = useMailStoreMock.getState().setSelection.mock.calls;
      expect(calls[0][0]).toEqual([99]); // scoped to this row first
      expect(calls[calls.length - 1][0]).toEqual([1, 2, 3]); // then restored intact
      expect(onClose).toHaveBeenCalled();
    });

    it('Mark as unread restores the prior selection untouched', async () => {
      useMailStoreMock.setState({ selectedEmailIds: new Set([1, 2, 3]) });
      const email = baseEmail({ uid: 99, flags: ['\\Seen'] });
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Mark as unread'));
      await Promise.resolve();
      await Promise.resolve();

      const calls = useMailStoreMock.getState().setSelection.mock.calls;
      expect(calls[calls.length - 1][0]).toEqual([1, 2, 3]);
    });

    it('Delete everywhere restores the prior selection minus the acted-on key', async () => {
      // Row's own uid (2) happens to already be part of the prior selection —
      // it must not survive the restore, since that message is now gone.
      useMailStoreMock.setState({ selectedEmailIds: new Set([1, 2, 3]) });
      const email = baseEmail({ uid: 2, isArchived: false, source: 'server' });
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete everywhere'));
      const [executor] = onRequestDelete.mock.calls[0];
      await executor();

      const calls = useMailStoreMock.getState().setSelection.mock.calls;
      expect(calls[0][0]).toEqual([2]); // scoped to this row first
      expect(calls[calls.length - 1][0]).toEqual([1, 3]); // restored minus the deleted row
    });

    it('Delete everywhere on a row outside the prior selection restores it unchanged', async () => {
      useMailStoreMock.setState({ selectedEmailIds: new Set([1, 2, 3]) });
      const email = baseEmail({ uid: 99, isArchived: false, source: 'server' });
      const onRequestDelete = vi.fn();
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={onRequestDelete} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Delete everywhere'));
      const [executor] = onRequestDelete.mock.calls[0];
      await executor();

      const calls = useMailStoreMock.getState().setSelection.mock.calls;
      expect(calls[calls.length - 1][0]).toEqual([1, 2, 3]);
    });

    it('a row that was not previously selected ends up not selected afterward', async () => {
      useMailStoreMock.setState({ selectedEmailIds: new Set() }); // nothing selected
      const email = baseEmail({ uid: 5, flags: [] });
      render(<RowActionMenuItems emails={[email]} actions={makeActions()} onRequestDelete={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Mark as read'));
      await Promise.resolve();
      await Promise.resolve();

      const calls = useMailStoreMock.getState().setSelection.mock.calls;
      expect(calls[calls.length - 1][0]).toEqual([]);
    });
  });
});
