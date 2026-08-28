// @vitest-environment jsdom

// Task 10 added a second destructive action (Delete everywhere) alongside
// the existing Delete (server-only). Both share one confirmation popover —
// these tests cover that the popover shows different copy and fires a
// different store action depending on which button was clicked, tracked via
// `deleteMode` rather than the old boolean `showDeleteConfirm`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves. A hand-listed set breaks the moment a shared
  // primitive (ui/Button pulls in Loader, ui/Dialog pulls in X) imports one
  // more glyph — vitest then fails the whole file with "No export defined".
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  // forwardRef, like the real motion.div: ui/Dialog puts its focus-trap ref on
  // the panel, and a plain function component swallows it — the trap and the
  // Escape handler then never arm, silently.
  //
  // What this double does NOT cover: it also spreads `initial`/`animate`/`exit`
  // onto a plain div, so they become DOM attributes. A spec asserting a visual
  // state under this mock is asserting an attribute and believing it is the
  // animation — jsdom runs no CSS and framer's transforms never happen. Assert
  // attributes and structure here; anything about how it MOVES belongs in a
  // spec that does not mock framer-motion at all.
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

vi.mock('../MoveToFolderDropdown', () => ({
  MoveToFolderDropdown: () => React.createElement('div', { 'data-testid': 'move-dropdown' }),
}));

const useMailStoreMock = create(() => ({
  selectedEmailIds: new Set([1, 2]),
  archivedEmailIds: new Set(),
  clearSelection: vi.fn(),
  saveSelectedLocally: vi.fn(),
  markSelectedAsRead: vi.fn(),
  markSelectedAsUnread: vi.fn(),
  deleteSelectedFromServer: vi.fn().mockResolvedValue(),
  purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 2, failed: 0, queuedBackup: 0, needsResync: 0 }),
  removeLocalEmail: vi.fn(),
  getSelectionSummary: vi.fn(() => ({ threads: 2, emails: 2 })),
}));

// getState as well as the hook: the Export button resolves selection keys back
// to rows imperatively, and a double that is only callable as a hook throws the
// moment someone clicks it — while every render-only test stays green.
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(
    (selector) => useMailStoreMock(selector),
    { getState: () => useMailStoreMock.getState() },
  ),
}));

const openExport = vi.fn();
vi.mock('../../stores/exportStore', () => ({
  useExportStore: { getState: () => ({ openExport }) },
}));

import { SelectionActionBar } from '../SelectionActionBar';

describe('SelectionActionBar delete confirmation', () => {
  beforeEach(() => {
    useMailStoreMock.setState({
      selectedEmailIds: new Set([1, 2]),
      archivedEmailIds: new Set(),
      clearSelection: vi.fn(),
      saveSelectedLocally: vi.fn(),
      markSelectedAsRead: vi.fn(),
      markSelectedAsUnread: vi.fn(),
      deleteSelectedFromServer: vi.fn().mockResolvedValue(),
      purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 2, failed: 0, queuedBackup: 0, needsResync: 0 }),
      removeLocalEmail: vi.fn(),
      getSelectionSummary: vi.fn(() => ({ threads: 2, emails: 2 })),
    });
  });
  afterEach(() => cleanup());

  it('renders both a server-only Delete and a Delete everywhere trigger', () => {
    render(<SelectionActionBar />);
    expect(screen.getByTitle('Delete from server')).toBeTruthy();
    expect(screen.getByTitle('Delete everywhere')).toBeTruthy();
  });

  it('Delete shows server-only confirmation copy, no backup/vault-destroying mention', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));

    const copy = screen.getByText(/Delete 2 emails from the server\?/);
    expect(copy).toBeTruthy();
    expect(copy.textContent).not.toMatch(/backup/i);
  });

  // The fixture's two selected uids are not in archivedEmailIds, so the vault
  // clause must be the permanent one. The bug this guards: the bar used to say
  // "This cannot be undone" for every server delete, archived or not.
  it('says a server delete is permanent only when the vault has no copy', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));
    expect(screen.getByText(/No copy is in your vault, so this cannot be undone\./)).toBeTruthy();
  });

  it('promises the vault copy survives when every selected message is archived', () => {
    useMailStoreMock.setState({ archivedEmailIds: new Set([1, 2]) });
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));

    const copy = screen.getByText(/Delete 2 emails from the server\?/);
    expect(copy.textContent).toMatch(/Your vault keeps the copies/);
    expect(copy.textContent).not.toMatch(/cannot be undone/i);
  });

  it('Delete everywhere shows the everywhere confirmation copy', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete everywhere'));

    const copy = screen.getByText(/No copy will be left anywhere/);
    expect(copy.textContent).toMatch(/server, your vault, and your backup drive/);
  });

  // The reported defect, at the moment it matters: two ticked conversation
  // rows, and the confirmation offered to delete "11 emails" — a number the
  // user had never seen. When the two units differ, both go in the sentence.
  it('names conversations as well as messages when a selection spans threads', () => {
    useMailStoreMock.setState({ getSelectionSummary: vi.fn(() => ({ threads: 2, emails: 11 })) });
    render(<SelectionActionBar />);

    fireEvent.click(screen.getByTitle('Delete everywhere'));

    expect(screen.getByText(/Delete 11 emails in 2 conversations from the server/)).toBeTruthy();
  });

  it('confirming after Delete everywhere calls purgeSelectedEverywhere, not deleteSelectedFromServer', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete everywhere'));

    const confirmButtons = screen.getAllByRole('button', { name: 'Delete everywhere' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(useMailStoreMock.getState().purgeSelectedEverywhere).toHaveBeenCalledTimes(1);
    expect(useMailStoreMock.getState().deleteSelectedFromServer).not.toHaveBeenCalled();
  });

  it('confirming after Delete (server-only) calls deleteSelectedFromServer, not purgeSelectedEverywhere', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));

    const confirmButtons = screen.getAllByRole('button', { name: 'Delete from server' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(useMailStoreMock.getState().deleteSelectedFromServer).toHaveBeenCalledTimes(1);
    expect(useMailStoreMock.getState().purgeSelectedEverywhere).not.toHaveBeenCalled();
  });
});

// The bar and the bulk modal read the same selection and must not disagree
// about it on screen. The modal says "65 emails selected"; the bar led with
// the conversation count, so the pair read "52 selected (65 emails)" over an
// archive that processed 65.
describe('SelectionActionBar selection count', () => {
  beforeEach(() => {
    useMailStoreMock.setState({
      selectedEmailIds: new Set(Array.from({ length: 65 }, (_, i) => i + 1)),
      archivedEmailIds: new Set(),
      getSelectionSummary: vi.fn(() => ({ threads: 52, emails: 65 })),
    });
  });
  afterEach(() => cleanup());

  it('leads with the message count the actions operate on', () => {
    render(<SelectionActionBar />);
    expect(screen.getByText('65 selected (52 conversations)')).toBeTruthy();
  });

  it('drops the parenthetical when no messages share a conversation', () => {
    useMailStoreMock.setState({ getSelectionSummary: vi.fn(() => ({ threads: 65, emails: 65 })) });
    render(<SelectionActionBar />);
    expect(screen.getByText('65 selected')).toBeTruthy();
  });
});

describe('SelectionActionBar export', () => {
  const row = (uid, accountId) => ({ uid, subject: `m${uid}`, _accountId: accountId });

  beforeEach(() => {
    openExport.mockClear();
    useMailStoreMock.setState({
      selectedEmailIds: new Set([1, 2]),
      archivedEmailIds: new Set(),
      activeMailbox: 'INBOX',
      sortedEmails: [row(1), row(2), row(3)],
      clearSelection: vi.fn(),
      saveSelectedLocally: vi.fn(),
      markSelectedAsRead: vi.fn(),
      markSelectedAsUnread: vi.fn(),
      deleteSelectedFromServer: vi.fn().mockResolvedValue(),
      purgeSelectedEverywhere: vi.fn().mockResolvedValue({ deleted: 0, failed: 0, queuedBackup: 0, needsResync: 0 }),
      removeLocalEmail: vi.fn(),
      getSelectionSummary: vi.fn(() => ({ threads: 2, emails: 2 })),
    });
  });
  afterEach(() => cleanup());

  it('offers an export button while a selection is live', () => {
    render(<SelectionActionBar />);
    expect(screen.getByTitle('Export selected')).toBeTruthy();
  });

  it('hands over only the selected rows', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Export selected'));
    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openExport.mock.calls[0][0].messages.map(m => m.uid)).toEqual([1, 2]);
  });

  // A unified selection key is accountId:uid. Resolving on the bare uid would
  // sweep in the other account's message 1 — the row that merges folders,
  // acting across them.
  it('does not pull another account\'s message with the same uid into a unified selection', () => {
    useMailStoreMock.setState({
      activeMailbox: 'UNIFIED',
      selectedEmailIds: new Set(['acct-1:1']),
      sortedEmails: [row(1, 'acct-1'), row(1, 'acct-2')],
    });
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Export selected'));
    const sent = openExport.mock.calls[0][0].messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]._accountId).toBe('acct-1');
  });

  it('opens nothing when no selected key resolves to a loaded row', () => {
    useMailStoreMock.setState({ selectedEmailIds: new Set([99]), sortedEmails: [row(1), row(2)] });
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Export selected'));
    expect(openExport).not.toHaveBeenCalled();
  });
});
