// @vitest-environment jsdom

// The bubble is where a minimized bulk session lives — it must show only
// while a session is active and the modal is closed, its count must follow
// selectedEmailIds live (so a hand-toggled checkbox moves the number), and
// its two controls must reopen the modal / end the session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

const ACCOUNTS = [{ id: 'acct-1', email: 'thecoldzero@gmail.com' }];

// A session as openBulkModal() actually produces: bound to the
// (accountId, mailbox) active when it was created.
const boundSession = (overrides) => ({
  active: true, step: 1, range: null, action: null,
  accountId: 'acct-1', mailbox: 'INBOX.Spam', viewMode: 'all',
  ...overrides,
});

const useMailStoreMock = create((set) => ({
  accounts: ACCOUNTS,
  bulkSession: null,
  bulkModalOpen: false,
  selectedEmailIds: new Set(),
  openBulkModal: vi.fn(),
  endBulkSession: vi.fn(),
}));

vi.mock('../../stores/mailStore', () => ({
  useMailStore: (selector) => useMailStoreMock(selector),
}));

import { BulkSelectionBubble } from '../BulkSelectionBubble';

describe('BulkSelectionBubble', () => {
  beforeEach(() => {
    useMailStoreMock.setState({
      accounts: ACCOUNTS,
      bulkSession: null,
      bulkModalOpen: false,
      selectedEmailIds: new Set(),
      openBulkModal: vi.fn(),
      endBulkSession: vi.fn(),
    });
  });
  afterEach(() => cleanup());

  it('renders nothing when there is no active session', () => {
    render(<BulkSelectionBubble />);
    expect(screen.queryByTestId('bulk-selection-bubble')).toBeNull();
  });

  it('renders nothing while the modal is open, even with an active session', () => {
    useMailStoreMock.setState({ bulkSession: boundSession(), bulkModalOpen: true });
    render(<BulkSelectionBubble />);
    expect(screen.queryByTestId('bulk-selection-bubble')).toBeNull();
  });

  it('renders the account, folder and live count once minimized', () => {
    useMailStoreMock.setState({
      bulkSession: boundSession(),
      bulkModalOpen: false,
      selectedEmailIds: new Set([1, 2, 3]),
    });
    render(<BulkSelectionBubble />);

    const bubble = screen.getByTestId('bulk-selection-bubble');
    expect(bubble.textContent).toContain('thecoldzero@gmail.com');
    expect(bubble.textContent).toContain('INBOX.Spam');
    expect(bubble.textContent).toContain('3 selected');
  });

  it('count follows selectedEmailIds live, moving when a row checkbox is hand-toggled', () => {
    useMailStoreMock.setState({
      bulkSession: boundSession(),
      bulkModalOpen: false,
      selectedEmailIds: new Set([1, 2, 3]),
    });
    render(<BulkSelectionBubble />);
    expect(screen.getByTestId('bulk-selection-bubble').textContent).toContain('3 selected');

    act(() => { useMailStoreMock.setState({ selectedEmailIds: new Set([1, 3]) }); });
    expect(screen.getByTestId('bulk-selection-bubble').textContent).toContain('2 selected');
  });

  it('renders "All inboxes" for a unified-mailbox session instead of the raw sentinel', () => {
    useMailStoreMock.setState({ bulkSession: boundSession({ mailbox: 'UNIFIED' }), bulkModalOpen: false });
    render(<BulkSelectionBubble />);
    expect(screen.getByTestId('bulk-selection-bubble').textContent).toContain('All inboxes');
  });

  it('clicking the bubble body calls openBulkModal', () => {
    const openBulkModal = vi.fn();
    useMailStoreMock.setState({ bulkSession: boundSession(), bulkModalOpen: false, openBulkModal });
    render(<BulkSelectionBubble />);

    fireEvent.click(screen.getByTitle('Back to bulk operations'));
    expect(openBulkModal).toHaveBeenCalledTimes(1);
  });

  it('clicking the dismiss × calls endBulkSession', () => {
    const endBulkSession = vi.fn();
    useMailStoreMock.setState({ bulkSession: boundSession(), bulkModalOpen: false, endBulkSession });
    render(<BulkSelectionBubble />);

    fireEvent.click(screen.getByTitle('End bulk selection'));
    expect(endBulkSession).toHaveBeenCalledTimes(1);
  });

  // The session's bound accountId/mailbox — not the currently-active ones —
  // are what the bubble names. They agree whenever the bubble is visible
  // (EmailList ends stale sessions), but the component must read the bound
  // fields to be correct by construction rather than by coincidence.
  it('names the session-bound account and mailbox, not unrelated store fields', () => {
    useMailStoreMock.setState({
      accounts: [...ACCOUNTS, { id: 'acct-2', email: 'other@example.com' }],
      bulkSession: boundSession({ accountId: 'acct-2', mailbox: 'Archive' }),
      bulkModalOpen: false,
    });
    render(<BulkSelectionBubble />);

    const bubble = screen.getByTestId('bulk-selection-bubble');
    expect(bubble.textContent).toContain('other@example.com');
    expect(bubble.textContent).toContain('Archive');
    expect(bubble.textContent).not.toContain('thecoldzero@gmail.com');
  });
});
