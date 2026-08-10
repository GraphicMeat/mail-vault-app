// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return {
    X: icon('X'), Archive: icon('Archive'), ArchiveRestore: icon('ArchiveRestore'),
    Trash2: icon('Trash2'), ArrowRight: icon('ArrowRight'), ArrowLeft: icon('ArrowLeft'),
    AlertTriangle: icon('AlertTriangle'), HardDrive: icon('HardDrive'), Calendar: icon('Calendar'),
  };
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => ({ children, ...props }) => React.createElement('div', props, children) }),
  AnimatePresence: ({ children }) => children,
}));

// Store window holds 2 of 5 — the paginated render window.
const WINDOW = [
  { uid: 5, date: '2026-03-01T10:00:00Z' },
  { uid: 4, date: '2026-02-01T10:00:00Z' },
];
// Sidecar cache holds the whole mailbox.
// uid 2 was deleted locally (tombstoned), uid 3 is server-flagged \Deleted —
// both are hidden from the list and must stay out of a bulk run.
const CACHED_UIDS = [1, 2, 3, 4, 5];
const CACHED_ROWS = CACHED_UIDS.map(uid => ({
  uid,
  date: `2026-0${uid}-01T10:00:00Z`,
  flags: uid === 3 ? ['\\Seen', '\\Deleted'] : ['\\Seen'],
}));

const tombstones = new Set(['acct-1|INBOX|2']);
const archivedEmailIds = new Set();

// What the real openBulkModal() produces for acct-1/INBOX/'all' — the modal
// only ever renders with isOpen after that ran, so tests start from here
// rather than from a bare `null`, matching how the accountId/mailbox/
// viewMode-bound session actually comes into being.
const boundSession = () => ({ active: true, step: 1, range: null, action: null, accountId: 'acct-1', mailbox: 'INBOX', viewMode: 'all' });

// Task 5 moved step/range/action/selection into the store. The modal now
// reads and writes them live, so the mock has to actually be reactive —
// a real zustand store (already a project dep) beats hand-rolling a pub-sub.
const useMessageListStoreMock = create((set) => ({
  sortedEmails: WINDOW,
  totalEmails: 5,
  archivedEmailIds,
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  viewMode: 'all',
  unifiedInbox: false,
  bulkSession: null,
  selectedEmailIds: new Set(),
  setBulkSession: (patch) => set(state => ({
    bulkSession: { ...(state.bulkSession || { active: true, step: 1, range: null, action: null }), ...patch },
  })),
  setSelection: (keys) => set({ selectedEmailIds: new Set(keys) }),
  // Mirrors selectionSlice's real toggleEmailSelection (non-unified path) —
  // stands in for a row checkbox click while the modal is minimized.
  toggleEmailSelection: (uid) => set(state => {
    const next = new Set(state.selectedEmailIds);
    next.has(uid) ? next.delete(uid) : next.add(uid);
    return { selectedEmailIds: next };
  }),
  minimizeBulkModal: vi.fn(), // isOpen is driven by the `isOpen` prop in this test, not by store state
  endBulkSession: () => set({ bulkSession: null, selectedEmailIds: new Set() }),
}));

vi.mock('../../stores/messageListStore', () => ({
  useMessageListStore: (selector) => useMessageListStoreMock(selector),
}));

vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ deleteTombstones: tombstones, archivedEmailIds }),
  },
}));

vi.mock('../../services/db', () => ({
  listCachedUids: vi.fn(async () => ({ uids: CACHED_UIDS, changed: [] })),
  getEmailHeadersByUids: vi.fn(async (_a, _m, uids) => CACHED_ROWS.filter(r => uids.includes(r.uid))),
}));

// Backup-configured flag the legend reads. A plain mutable object, same
// pattern as `archivedEmailIds`/`tombstones` above — mutate it per-test,
// reset in beforeEach.
const backupState = { externalBackupLocation: null };
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector(backupState),
}));

import { BulkOperationsModal } from '../BulkOperationsModal';

describe('BulkOperationsModal', () => {
  beforeEach(() => {
    useMessageListStoreMock.setState({
      bulkSession: boundSession(),
      selectedEmailIds: new Set(),
      sortedEmails: WINDOW,
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      viewMode: 'all',
    });
    archivedEmailIds.clear();
    backupState.externalBackupLocation = null;
  });
  afterEach(() => cleanup());

  it('selects the whole cached mailbox minus deleted messages, not just the loaded window', async () => {
    const onConfirm = vi.fn();
    render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);

    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());

    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText('3 emails selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getByText('Start Archive'));

    // 5 and 4 from the window, 1 only from the cache; 2 tombstoned, 3 \Deleted.
    expect(onConfirm).toHaveBeenCalledWith({ action: 'archive', uids: [5, 4, 1] });
  });

  // Backdrop, header X, and Escape all delegate to the `onClose` prop, which
  // the real app wires to minimizeBulkModal (EmailList.jsx) — the session and
  // the selection must survive, so none of these three may call
  // endBulkSession (which wipes both). Asserted on observable store state
  // rather than spying on an action reference, matching bulkSession.test.js.
  it('backdrop click minimizes (calls onClose) without ending the session', async () => {
    const onClose = vi.fn();
    render(<BulkOperationsModal isOpen onClose={onClose} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
    fireEvent.click(screen.getByText('All'));

    fireEvent.click(document.querySelector('.bg-black\\/50'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMessageListStoreMock.getState().bulkSession).not.toBeNull();
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(3);
  });

  it('header X minimizes (calls onClose) without ending the session', async () => {
    const onClose = vi.fn();
    render(<BulkOperationsModal isOpen onClose={onClose} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
    fireEvent.click(screen.getByText('All'));

    // The header X has no accessible name — find it by its lucide icon mock.
    fireEvent.click(document.querySelector('[data-icon="X"]').closest('button'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMessageListStoreMock.getState().bulkSession).not.toBeNull();
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(3);
  });

  it('Escape minimizes (calls onClose) without ending the session', async () => {
    const onClose = vi.fn();
    render(<BulkOperationsModal isOpen onClose={onClose} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
    fireEvent.click(screen.getByText('All'));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMessageListStoreMock.getState().bulkSession).not.toBeNull();
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(3);
  });

  it('step-1 Cancel ends the session (endBulkSession), not just a minimize', async () => {
    const onClose = vi.fn();
    render(<BulkOperationsModal isOpen onClose={onClose} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
    fireEvent.click(screen.getByText('All'));

    fireEvent.click(screen.getByText('Cancel'));

    expect(useMessageListStoreMock.getState().bulkSession).toBeNull();
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(0);
  });

  // Regression test for the reopen-wipes-hand-edit bug: the sync effect used
  // to list `isOpen` as a dependency, so reopening after a minimize re-ran it
  // and silently overwrote a checkbox the user had toggled by hand.
  it('a hand-toggled checkbox survives a minimize/reopen cycle and is what confirm sends', async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />
    );
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());

    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText('3 emails selected')).toBeTruthy(); // uids 5, 4, 1

    // Minimize.
    rerender(<BulkOperationsModal isOpen={false} onClose={vi.fn()} onConfirm={onConfirm} />);

    // Hand-toggle a row checkbox while minimized — same store action a real
    // EmailRow checkbox calls, mutating selectedEmailIds directly.
    useMessageListStoreMock.getState().toggleEmailSelection(4);
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(2);

    // Reopen — same session, same range, same pool.
    rerender(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());

    // The hand edit must have survived the reopen, not been reset to 3.
    expect(screen.getByText('2 emails selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getByText('Start Archive'));

    expect(onConfirm).toHaveBeenCalledWith({ action: 'archive', uids: [5, 1] });
  });

  // The sidecar cache read is async — a range picked before it lands must
  // still widen from the paginated window to the full mailbox once it does.
  it('widens the selection once the sidecar cache lands, for a range picked while it was still loading', async () => {
    const onConfirm = vi.fn();
    render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);

    // Pick "All" synchronously, before the mocked async cache read resolves —
    // the pool is still just the 2-item paginated window at this point.
    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText('2 emails selected')).toBeTruthy();

    // Cache lands — pool grows to the full (filtered) mailbox.
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
    expect(screen.getByText('3 emails selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getByText('Start Archive'));
    expect(onConfirm).toHaveBeenCalledWith({ action: 'archive', uids: [5, 4, 1] });
  });

  // Regression test for the second wipe route the reviewer found: once the
  // sidecar cache has landed (the pool has "settled"), later pool-size
  // churn in the SAME mailbox — new mail arriving, a flag change — must not
  // re-derive the selection and overwrite a hand edit. Only a genuine range
  // or custom-date edit may do that from this point on.
  it('a same-mailbox pool-size change after the pool has settled does not overwrite a hand-edited selection', async () => {
    const onConfirm = vi.fn();
    render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull()); // settled

    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText('3 emails selected')).toBeTruthy(); // 5, 4, 1

    // Hand edit: drop uid 4.
    act(() => { useMessageListStoreMock.getState().toggleEmailSelection(4); });
    expect(screen.getByText('2 emails selected')).toBeTruthy();

    // New mail arrives in the same mailbox — sortedEmails (the window) grows.
    act(() => {
      useMessageListStoreMock.setState({ sortedEmails: [...WINDOW, { uid: 6, date: '2026-04-01T10:00:00Z' }] });
    });

    // The pool already settled before the hand edit — this churn must not
    // re-derive the selection back from the range.
    expect(screen.getByText('2 emails selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getByText('Start Archive'));
    expect(onConfirm).toHaveBeenCalledWith({ action: 'archive', uids: [5, 1] });
  });

  // Explicit guard, driven directly: correctness here must not rest on
  // EmailList's sibling teardown effect winning a child-before-parent
  // ordering race. A session bound to a mailbox other than the live one
  // must never reach setSelection, regardless of whether or when anything
  // outside this component ends the stale session.
  it('the sync effect does not write a selection when the session is bound to a stale mailbox', async () => {
    useMessageListStoreMock.setState({
      bulkSession: { active: true, step: 1, range: { type: 'all' }, action: null, accountId: 'acct-1', mailbox: 'INBOX', viewMode: 'all' },
      activeMailbox: 'Sent', // live store has already moved on — the session's binding is stale
      selectedEmailIds: new Set(),
    });

    render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());

    // A range is already picked (range: { type: 'all' }) and the pool has
    // settled — everything needed to trigger a resync is present except a
    // matching mailbox. The guard must have bailed before ever calling
    // setSelection.
    expect(useMessageListStoreMock.getState().selectedEmailIds.size).toBe(0);

    useMessageListStoreMock.setState({ activeMailbox: 'INBOX' });
  });

  // Task 9: storage legend + Delete Everywhere action and its own confirm.
  describe('storage legend and Delete Everywhere', () => {
    it('legend shows server and local-archive counts and omits any backup count, even when backup is configured', async () => {
      archivedEmailIds.add(1); // uid 1 is in the "All" selection (5, 4, 1)
      backupState.externalBackupLocation = { displayPath: '/Volumes/Backup', status: 'ready' };

      render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
      fireEvent.click(screen.getByText('All'));
      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('3 on server')).toBeTruthy();
      expect(screen.getByText('1 archived here')).toBeTruthy();
      // Configured backup is called out, but never with a count attached.
      expect(screen.getByText('backup configured')).toBeTruthy();
      expect(screen.queryByText(/\d+\s*(in|on)?\s*backup/i)).toBeNull();
    });

    it('legend omits the backup note entirely when no backup is configured', async () => {
      backupState.externalBackupLocation = null;

      render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
      fireEvent.click(screen.getByText('All'));
      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('3 on server')).toBeTruthy();
      expect(screen.queryByText('backup configured')).toBeNull();
    });

    it('Delete Everywhere renders as an action and produces the delete_everywhere id, with its own red confirmation distinct from plain delete', async () => {
      const onConfirm = vi.fn();
      render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);
      await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
      fireEvent.click(screen.getByText('All'));
      fireEvent.click(screen.getByText('Next'));

      // Select it — at this point the footer still says "Start", so the row
      // label is the only element with this exact text.
      fireEvent.click(screen.getByText('Delete Everywhere'));

      // The footer confirm button now shares the row's label text; its
      // accessible name is the exact string (no description appended),
      // unlike the row button's, so this resolves it unambiguously.
      fireEvent.click(screen.getByRole('button', { name: 'Delete Everywhere' }));

      // Its own confirmation — distinct header and body from the plain delete confirm.
      expect(screen.getByText('Delete Everywhere?')).toBeTruthy();
      expect(screen.queryByText('Confirm Delete')).toBeNull();
      expect(screen.getByText(/Permanently remove 3 emails from the server, this computer, and your external backup\?/)).toBeTruthy();
      expect(screen.getByText('There will be no copy left anywhere. This cannot be undone.')).toBeTruthy();
      expect(screen.queryByText(/Are you sure\? This will permanently delete/)).toBeNull();

      fireEvent.click(screen.getByText('Yes, Delete Everywhere'));
      expect(onConfirm).toHaveBeenCalledWith({ action: 'delete_everywhere', uids: [5, 4, 1] });
    });

    it('plain Delete from Server confirmation copy is unchanged by the new delete_everywhere branch', async () => {
      const onConfirm = vi.fn();
      render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={onConfirm} />);
      await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
      fireEvent.click(screen.getByText('All'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Delete from Server'));
      fireEvent.click(screen.getByText('Confirm Delete'));

      expect(screen.getByText('Confirm Delete', { selector: 'h2' })).toBeTruthy();
      expect(screen.getByText(/Are you sure\? This will permanently delete 3 emails from the server\./)).toBeTruthy();
      expect(screen.getByText('This cannot be undone.')).toBeTruthy();
      expect(screen.queryByText(/no copy left anywhere/)).toBeNull();

      fireEvent.click(screen.getByText('Yes, Delete'));
      expect(onConfirm).toHaveBeenCalledWith({ action: 'delete', uids: [5, 4, 1] });
    });
  });

  // Fix round 1: "Delete from Server" used to unconditionally claim a local
  // and backup copy survive. That's the same class of error the whole
  // feature exists to fix, just pointed the other way — must be conditional
  // on the live archived/backup state, matching the legend above it.
  describe('Delete from Server description reflects live archived/backup state', () => {
    // "All" selects uids 5, 4, 1 (3 emails) — see WINDOW/CACHED_ROWS at top.
    const openToStep2 = async () => {
      render(<BulkOperationsModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText(/Reading all/)).toBeNull());
      fireEvent.click(screen.getByText('All'));
      fireEvent.click(screen.getByText('Next'));
    };

    it('none archived: warns the deletion is permanent, does not say "kept"', async () => {
      // archivedEmailIds is empty by default (cleared in beforeEach).
      await openToStep2();
      expect(screen.getByText('Remove from server. No copy exists on this computer — this is permanent.')).toBeTruthy();
      expect(screen.queryByText(/kept/)).toBeNull();
    });

    it('all archived, no backup configured: only the local copy is named as kept', async () => {
      archivedEmailIds.add(5); archivedEmailIds.add(4); archivedEmailIds.add(1);
      backupState.externalBackupLocation = null;
      await openToStep2();
      expect(screen.getByText('Remove from server only. Your copy on this computer is kept.')).toBeTruthy();
      expect(screen.queryByText(/permanent/)).toBeNull();
    });

    it('all archived, backup configured: both copies are named as kept', async () => {
      archivedEmailIds.add(5); archivedEmailIds.add(4); archivedEmailIds.add(1);
      backupState.externalBackupLocation = { displayPath: '/Volumes/Backup', status: 'ready' };
      await openToStep2();
      expect(screen.getByText('Remove from server only. Your copies on this computer and in backup are kept.')).toBeTruthy();
    });

    it('some but not all archived: only says copies survive for the already-archived ones', async () => {
      archivedEmailIds.add(1); // 1 of 3 selected
      backupState.externalBackupLocation = { displayPath: '/Volumes/Backup', status: 'ready' }; // must not change this branch's wording
      await openToStep2();
      expect(screen.getByText('Remove from server only. Copies are kept only for the emails already archived here.')).toBeTruthy();
      expect(screen.queryByText(/permanent/)).toBeNull();
    });
  });
});
