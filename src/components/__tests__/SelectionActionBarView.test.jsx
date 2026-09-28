// @vitest-environment jsdom

// The selection bar's face without a selection behind it: Settings draws it
// over sample rows. It reads the rows it is handed, never the selection, and
// with `preview` nothing it offers does anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../MoveToFolderDropdown', () => ({ MoveToFolderDropdown: () => <div data-testid="move-dropdown" /> }));
vi.mock('../SnoozePicker', () => ({ SnoozePicker: () => <div data-testid="snooze-picker" /> }));

const spies = () => ({
  clearSelection: vi.fn(),
  saveSelectedLocally: vi.fn(),
  markSelectedAsRead: vi.fn(),
  markSelectedAsUnread: vi.fn(),
  deleteSelectedFromServer: vi.fn(),
  purgeSelectedEverywhere: vi.fn(),
  removeLocalEmails: vi.fn(),
  setSelectedFlagged: vi.fn(),
  moveEmails: vi.fn(),
});
const useMailStoreMock = create(() => ({}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign((selector) => useMailStoreMock(selector), {
    getState: () => useMailStoreMock.getState(),
    setState: (patch) => useMailStoreMock.setState(patch),
  }),
}));
const openExport = vi.fn();
vi.mock('../../stores/exportStore', () => ({ useExportStore: { getState: () => ({ openExport }) } }));

const { SelectionActionBarView } = await import('../SelectionActionBar');

const row = (uid, flags) => ({ uid, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', flags, isArchived: false });
const ROWS = [row(1, ['\\Flagged']), row(2, ['\\Flagged'])];
const CONFIG = {
  mode: 'inline', palette: 'neutral', favoriteId: null, radialPagination: false, radialLayout: 'flat',
  selectionDisplay: 'icon-only', selectionActionLimit: 3,
  entries: ['markRead', 'markUnread', 'archive', 'star', 'unstar', 'move', 'spam', 'deleteServer',
    'deleteEverywhere', 'export', 'snooze'].map(action => ({ id: action, action })),
};
const button = action => document.querySelector(`[data-quick-action="${action}"]`);

beforeEach(() => {
  // No selection at all: the view must not need one.
  useMailStoreMock.setState({
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', accounts: [{ id: 'acct-1' }],
    mailboxes: [{ name: 'Junk', path: 'Junk', specialUse: '\\Junk' }],
    emails: [], sortedEmails: [], localEmails: [], sentEmails: [],
    selectedEmailIds: new Set(), archivedEmailIds: new Set(),
    getSelectionSummary: vi.fn(() => ({ threads: 0, emails: 0 })),
    ...spies(),
  }, true);
  openExport.mockClear();
});
afterEach(cleanup);

describe('SelectionActionBarView', () => {
  it('reads the rows it is given: count, what applies and the star in its state', () => {
    render(<SelectionActionBarView rows={ROWS} config={CONFIG} preview />);
    expect(screen.getByText('2 selected')).toBeTruthy();
    // Both unread: mark read applies, mark unread does not.
    expect(button('markRead').disabled).toBe(false);
    expect(button('markUnread').disabled).toBe(true);
    // Both starred: only Unstar applies, and it is drawn filled.
    expect(button('star').disabled).toBe(true);
    expect(button('unstar').disabled).toBe(false);
    expect(button('unstar').querySelector('svg').getAttribute('fill')).toBe('currentColor');
    expect(button('star').querySelector('svg').getAttribute('fill')).toBe('none');
  });

  it('sits in the page instead of floating over the list, marked as a preview', () => {
    const { container } = render(<SelectionActionBarView rows={ROWS} config={CONFIG} preview />);
    const root = container.firstElementChild;
    expect(root.hasAttribute('data-quick-actions-preview')).toBe(true);
    expect(root.className).not.toMatch(/\bfixed\b/);
    expect(document.querySelector('[data-testid="selection-action-bar"]')).toBeNull();
  });

  it('runs nothing, whichever action or Clear is pressed', async () => {
    render(<SelectionActionBarView rows={ROWS} config={CONFIG} preview />);
    const pressed = [];
    for (const item of document.querySelectorAll('[data-quick-action]')) {
      if (item.disabled) continue;
      pressed.push(item.dataset.quickAction);
      fireEvent.click(item);
    }
    fireEvent.click(screen.getByTitle('Clear selection'));
    await Promise.resolve();

    expect(pressed).toEqual(expect.arrayContaining(['markRead', 'archive', 'unstar', 'move', 'spam', 'deleteServer', 'export']));
    const state = useMailStoreMock.getState();
    for (const name of Object.keys(spies())) expect(state[name], name).not.toHaveBeenCalled();
    expect(openExport).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="move-dropdown"]')).toBeNull();
    expect(document.querySelector('[data-testid="snooze-picker"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
