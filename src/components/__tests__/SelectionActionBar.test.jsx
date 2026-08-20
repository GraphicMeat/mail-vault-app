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
  return {
    MailOpen: icon('MailOpen'), Mail: icon('Mail'), Trash2: icon('Trash2'),
    Archive: icon('Archive'), ArchiveRestore: icon('ArchiveRestore'), X: icon('X'),
    AlertTriangle: icon('AlertTriangle'), FolderSymlink: icon('FolderSymlink'), ShieldX: icon('ShieldX'),
  };
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => ({ children, ...props }) => React.createElement('div', props, children) }),
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

vi.mock('../../stores/mailStore', () => ({
  useMailStore: (selector) => useMailStoreMock(selector),
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

  it('Delete shows server-only confirmation copy, no backup/computer mention', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));

    const copy = screen.getByText(/Delete 2 emails from server\?/);
    expect(copy).toBeTruthy();
    expect(copy.textContent).not.toMatch(/backup/i);
  });

  it('Delete everywhere shows the everywhere confirmation copy', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete everywhere'));

    const copy = screen.getByText(/No copy will be left anywhere/);
    expect(copy.textContent).toMatch(/server, this computer, and your external backup/);
  });

  it('confirming after Delete everywhere calls purgeSelectedEverywhere, not deleteSelectedFromServer', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete everywhere'));

    const confirmButtons = screen.getAllByText('Delete');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(useMailStoreMock.getState().purgeSelectedEverywhere).toHaveBeenCalledTimes(1);
    expect(useMailStoreMock.getState().deleteSelectedFromServer).not.toHaveBeenCalled();
  });

  it('confirming after Delete (server-only) calls deleteSelectedFromServer, not purgeSelectedEverywhere', () => {
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByTitle('Delete from server'));

    const confirmButtons = screen.getAllByText('Delete');
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
