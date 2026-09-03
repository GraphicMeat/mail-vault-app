// @vitest-environment jsdom
//
// Every floating surface stays inside the window. The row menu opened on a row
// near the bottom edge, and the Move-to-folder list it opens beside it, ran off
// the bottom of the window — "you just scroll up and try again" (bson73,
// discussion #1, 2026-09-03). The sum lives in one hook (useViewportShift);
// this file pins that each surface actually runs it, and that a dialog taller
// than the window scrolls instead of being cut off.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { stubGeometry, restoreGeometry } from '../../hooks/__tests__/useViewportShift.test.jsx';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
}));

const MAILBOXES = [
  { path: 'INBOX', name: 'INBOX', delimiter: '.', specialUse: null, noselect: false, children: [] },
  { path: 'Archive', name: 'Archive', delimiter: '.', specialUse: null, noselect: false, children: [] },
];
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector({ mailboxes: MAILBOXES, activeMailbox: 'INBOX' }),
}));
vi.mock('../../stores/selectionStore', () => ({
  useSelectionStore: (selector) => selector({ moveEmails: vi.fn() }),
}));

const { Popover } = await import('../ui/Popover');
const { Dialog } = await import('../ui/Dialog');
const { MoveToFolderDropdown } = await import('../MoveToFolderDropdown');

afterEach(() => { cleanup(); restoreGeometry(); document.body.innerHTML = ''; });

const VIEW = () => { window.innerWidth = 1200; window.innerHeight = 800; };

describe('Popover', () => {
  it('lifts a menu that would run off the bottom of the window', () => {
    VIEW();
    stubGeometry((el) => el.getAttribute?.('role') === 'menu',
      { top: 700, left: 100, width: 160, height: 200 }, { width: 160, height: 200 });
    render(<Popover open onClose={() => {}} role="menu" style={{ top: 700, left: 100 }}>x</Popover>);
    expect(screen.getByRole('menu').dataset.viewportShift).toBe('0,-108');
  });

  it('re-runs the sum when the caller moves the panel', () => {
    VIEW();
    stubGeometry((el) => el.getAttribute?.('role') === 'menu',
      { top: 700, left: 100, width: 160, height: 200 }, { width: 160, height: 200 });
    // First render at 0/0: the caller has not measured its anchor yet (that is
    // how RowActionMenu opens). The panel is then moved to its real place.
    const { rerender } = render(<Popover open onClose={() => {}} role="menu" style={{ top: 0, left: 0 }}>x</Popover>);
    rerender(<Popover open onClose={() => {}} role="menu" style={{ top: 700, left: 100 }}>x</Popover>);
    expect(screen.getByRole('menu').dataset.viewportShift).toBe('0,-108');
  });
});

describe('MoveToFolderDropdown', () => {
  it('lifts the folder list when it opens beside a menu item near the bottom', () => {
    VIEW();
    stubGeometry((el) => el.dataset?.testid === 'move-to-folder-dropdown',
      { top: 600, left: 300, width: 256, height: 310 }, { width: 256, height: 310 });
    render(<MoveToFolderDropdown uids={[1]} onClose={() => {}} anchorRect={null} />);
    expect(screen.getByTestId('move-to-folder-dropdown').dataset.viewportShift).toBe('0,-118');
  });

  it('does the same when anchored to a toolbar button', () => {
    VIEW();
    stubGeometry((el) => el.dataset?.testid === 'move-to-folder-dropdown',
      { top: 600, left: 300, width: 256, height: 310 }, { width: 256, height: 310 });
    render(<MoveToFolderDropdown uids={[1]} onClose={() => {}} anchorRect={{ top: 570, bottom: 596, left: 300 }} />);
    expect(screen.getByTestId('move-to-folder-dropdown').dataset.viewportShift).toBe('0,-118');
  });
});

describe('Dialog', () => {
  it('bounds a sized panel to the window and scrolls it', () => {
    render(<Dialog open onClose={() => {}} title="Tall">body</Dialog>);
    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('max-h-full');
    expect(panel.className).toContain('overflow-y-auto');
  });

  it('leaves a caller-sized panel to lay itself out', () => {
    render(<Dialog open onClose={() => {}} size="custom" panelClassName="h-[92vh]">body</Dialog>);
    const panel = screen.getByRole('dialog');
    expect(panel.className).not.toContain('overflow-y-auto');
  });
});
