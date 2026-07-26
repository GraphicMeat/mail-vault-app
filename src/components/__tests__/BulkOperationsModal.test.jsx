// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

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

const state = {
  sortedEmails: WINDOW,
  totalEmails: 5,
  archivedEmailIds: new Set(),
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  viewMode: 'all',
  unifiedInbox: false,
};

vi.mock('../../stores/messageListStore', () => ({
  useMessageListStore: (selector) => selector(state),
}));

vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ deleteTombstones: tombstones, archivedEmailIds: state.archivedEmailIds }),
  },
}));

vi.mock('../../services/db', () => ({
  listCachedUids: vi.fn(async () => ({ uids: CACHED_UIDS, changed: [] })),
  getEmailHeadersByUids: vi.fn(async (_a, _m, uids) => CACHED_ROWS.filter(r => uids.includes(r.uid))),
}));

import { BulkOperationsModal } from '../BulkOperationsModal';

describe('BulkOperationsModal', () => {
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
});
