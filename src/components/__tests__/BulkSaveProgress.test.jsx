// @vitest-environment jsdom
//
// The bottom-right progress toast multiplexes three runs by mode. A move is
// the third: several server round trips with nothing on screen, so it borrows
// this toast rather than growing its own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves - ui/Button pulls in glyphs this file never names.
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

const dismissBulkProgress = vi.fn();
const dismissExportProgress = vi.fn();
const dismissMoveProgress = vi.fn();
const cancelArchive = vi.fn();

const useUiStoreMock = create(() => ({
  bulkSaveProgress: null,
  exportProgress: null,
  moveProgress: null,
  dismissBulkProgress,
  dismissExportProgress,
  dismissMoveProgress,
  cancelArchive,
}));

// The selector is passed through: a double that ignores it hands back the whole
// store and every `useUiStore(selectX)` silently reads the same object.
vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector) => useUiStoreMock(selector),
}));

import { BulkSaveProgress } from '../BulkSaveProgress';

const toast = () => document.querySelector('[data-testid="bulk-save-progress"]');

describe('BulkSaveProgress move mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStoreMock.setState({ bulkSaveProgress: null, exportProgress: null, moveProgress: null });
  });
  afterEach(() => cleanup());

  it('says nothing while no run is live', () => {
    render(<BulkSaveProgress />);
    expect(toast()).toBe(null);
  });

  it('reports a move in flight under its own mode', () => {
    useUiStoreMock.setState({
      moveProgress: { total: 3, completed: 0, errors: 0, active: true, folder: 'Archive' },
    });
    render(<BulkSaveProgress />);

    expect(toast().getAttribute('data-mode')).toBe('move');
    expect(screen.getByText('Moving...')).toBeTruthy();
  });

  // The same sentence the undo toast uses for the same move - one plural key,
  // no second way of saying it.
  it('names the count and the folder once the move lands', () => {
    useUiStoreMock.setState({
      moveProgress: { total: 3, completed: 3, errors: 0, active: false, folder: 'Archive' },
    });
    render(<BulkSaveProgress />);

    expect(screen.getByText('Moved 3 messages to Archive')).toBeTruthy();
  });

  it('drops the INBOX prefix a dotted-hierarchy server puts on the target', () => {
    useUiStoreMock.setState({
      moveProgress: { total: 1, completed: 1, errors: 0, active: false, folder: 'INBOX.Technik' },
    });
    render(<BulkSaveProgress />);

    expect(screen.getByText('Moved 1 message to Technik')).toBeTruthy();
  });

  it('dismisses through the move slot, not the archive one', () => {
    useUiStoreMock.setState({
      moveProgress: { total: 1, completed: 1, errors: 0, active: false, folder: 'Archive' },
    });
    render(<BulkSaveProgress />);

    fireEvent.click(screen.getAllByRole('button')[0]);

    expect(dismissMoveProgress).toHaveBeenCalledTimes(1);
    expect(dismissBulkProgress).not.toHaveBeenCalled();
  });

  // A move offers no cancel: the server call is already in flight per group and
  // there is nothing a half-cancelled move could mean.
  it('offers no cancel button mid-move', () => {
    useUiStoreMock.setState({
      moveProgress: { total: 3, completed: 1, errors: 0, active: true, folder: 'Archive' },
    });
    render(<BulkSaveProgress />);

    expect(screen.queryByText('Cancel')).toBe(null);
  });

  it('lets an archive keep the toast when both are live', () => {
    useUiStoreMock.setState({
      bulkSaveProgress: { total: 10, completed: 2, errors: 0, active: true },
      moveProgress: { total: 3, completed: 0, errors: 0, active: true, folder: 'Archive' },
    });
    render(<BulkSaveProgress />);

    expect(toast().getAttribute('data-mode')).toBe('archive');
    expect(screen.getByText('Archiving Emails...')).toBeTruthy();
    expect(screen.queryByText('Moving...')).toBe(null);
  });
});
