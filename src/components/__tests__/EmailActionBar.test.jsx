// @vitest-environment jsdom

// The action bar is shared by the single-email viewer, the thread view and the
// chat bubbles, and each variant supports a different subset of actions. Two
// things have to hold for every button: it only renders when the variant
// actually wired a handler, and its label names the NEXT action, not the
// current state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));

const settings = vi.hoisted(() => ({ actionButtonDisplay: 'icon-label' }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector(settings),
}));

const { EmailActionBar } = await import('../email/EmailActionBar');

const EMAIL = { uid: 1, subject: 'General', to: [{ address: 'a@mock.test' }] };

// Every handler wired — what the single-email viewer passes.
function allHandlers(overrides = {}) {
  return {
    onReply: vi.fn(),
    onReplyAll: vi.fn(),
    onForward: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onToggleRead: vi.fn(),
    onOpenInWindow: vi.fn(),
    onViewSource: vi.fn(),
    onToggleEmailTheme: vi.fn(),
    ...overrides,
  };
}

function renderBar(props = {}) {
  const handlers = props.handlers ?? allHandlers();
  render(
    <EmailActionBar
      email={props.email ?? EMAIL}
      variant={props.variant ?? 'single'}
      isArchived={props.isArchived ?? false}
      isRead={props.isRead ?? true}
      isLocalOnly={props.isLocalOnly ?? false}
      isSentEmail={props.isSentEmail ?? false}
      singleRecipient={props.singleRecipient ?? false}
      emailThemeDark={props.emailThemeDark ?? false}
      disabled={props.disabled ?? {}}
      {...handlers}
    />
  );
  return handlers;
}

function openMore() {
  const more = screen.queryByRole('button', { name: 'More' });
  if (more && more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
}
function action(label) {
  const direct = screen.queryByRole('button', { name: label, exact: true });
  if (direct) return direct;
  openMore();
  return screen.getByRole('menuitem', { name: label, exact: true });
}
const labels = () => {
  openMore();
  return [...screen.queryAllByRole('button'), ...screen.queryAllByRole('menuitem')]
    .map(button => button.textContent).filter(label => label !== 'More').sort();
};

// vitest runs without `globals`, so testing-library never registers its own
// auto-cleanup — without this every render stacks another bar in the document.
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); settings.actionButtonDisplay = 'icon-label'; });

describe('EmailActionBar — every button fires its action', () => {
  const cases = [
    ['Reply', 'onReply'],
    ['Reply All', 'onReplyAll'],
    ['Forward', 'onForward'],
    ['Archive', 'onArchive'],
    ['Delete', 'onDelete'],
    ['Move', 'onMove'],
    ['Mark unread', 'onToggleRead'],
    ['Open', 'onOpenInWindow'],
    ['Source', 'onViewSource'],
    ['Dark', 'onToggleEmailTheme'],
  ];

  for (const [label, handler] of cases) {
    it(`${label} calls ${handler}`, () => {
      const handlers = renderBar();

      fireEvent.click(action(label));

      expect(handlers[handler]).toHaveBeenCalledTimes(1);
    });
  }

  it('keeps all ten actions reachable for a server email in the viewer', () => {
    renderBar();
    expect(labels()).toEqual(cases.map(([l]) => l).sort());
  });
});

describe('EmailActionBar — labels name the next action', () => {
  it('offers "Mark unread" for a read email', () => {
    renderBar({ isRead: true });
    expect(action('Mark unread')).toBeTruthy();
  });

  it('offers "Mark read" for an unread email', () => {
    renderBar({ isRead: false });
    expect(action('Mark read')).toBeTruthy();
  });

  it('offers "Unarchive" for an archived email', () => {
    renderBar({ isArchived: true });
    expect(action('Unarchive')).toBeTruthy();
  });

  it('offers "Light" while the email renders dark', () => {
    renderBar({ emailThemeDark: true });
    expect(action('Light')).toBeTruthy();
  });
});

describe('EmailActionBar — no button without a handler', () => {
  it('hides the actions the thread variant does not wire', () => {
    renderBar({
      variant: 'thread',
      handlers: allHandlers({ onArchive: null, onDelete: null, onMove: null, onToggleRead: null }),
    });

    expect(labels()).toEqual(['Reply', 'Reply All', 'Forward', 'Open', 'Source', 'Dark'].sort());
  });

  it('hides the actions the chat variant does not wire', () => {
    renderBar({
      variant: 'chat',
      handlers: allHandlers({
        onArchive: null, onDelete: null, onMove: null, onToggleRead: null,
        onViewSource: null, onToggleEmailTheme: null,
      }),
    });

    expect(labels()).toEqual(['Reply', 'Reply All', 'Forward', 'Open'].sort());
  });
});

describe('EmailActionBar — context rules', () => {
  it('drops reply actions on a sent email', () => {
    renderBar({ isSentEmail: true });
    expect(labels()).not.toContain('Reply');
    expect(labels()).not.toContain('Reply All');
  });

  it('drops Reply All when there is only one recipient', () => {
    renderBar({ singleRecipient: true });
    expect(labels()).toContain('Reply');
    expect(labels()).not.toContain('Reply All');
  });

  it('drops server-only actions for a local-only email', () => {
    renderBar({ isLocalOnly: true });
    expect(labels()).not.toContain('Archive');
    expect(labels()).not.toContain('Move');
    expect(labels()).not.toContain('Mark unread');
  });

  it('keeps Unarchive reachable for an archived local-only email', () => {
    renderBar({ isLocalOnly: true, isArchived: true });
    expect(labels()).toContain('Unarchive');
  });

  it('honours the disabled map', () => {
    const handlers = renderBar({ disabled: { delete: true, toggleRead: true, archive: true } });

    fireEvent.click(action('Delete'));
    fireEvent.click(action('Mark unread'));
    fireEvent.click(action('Archive'));

    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(handlers.onToggleRead).not.toHaveBeenCalled();
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });
  it('shows an export button only when a handler is passed', () => {
    renderBar();
    expect(labels()).not.toContain('Export');
    cleanup();
    renderBar({ handlers: allHandlers({ onExport: vi.fn() }) });
    expect(labels()).toContain('Export');
  });

  it('hands the open message to the export handler', () => {
    const handlers = renderBar({ handlers: allHandlers({ onExport: vi.fn() }) });
    fireEvent.click(action('Export'));
    expect(handlers.onExport).toHaveBeenCalledWith(EMAIL);
  });
});

// The star reads its state off the message itself rather than off a prop the
// viewer has to keep in step — so the label names the next action for whatever
// copy of the message the bar was handed.
describe('EmailActionBar — star', () => {
  const renderStar = (flags, extra = {}) => {
    const email = { ...EMAIL, flags };
    const onToggleFlag = vi.fn();
    render(
      <EmailActionBar
        email={email}
        variant="single"
        isArchived={false}
        isRead
        isLocalOnly={extra.isLocalOnly ?? false}
        isSentEmail={false}
        singleRecipient={false}
        emailThemeDark={false}
        disabled={extra.disabled ?? {}}
        onToggleFlag={onToggleFlag}
      />
    );
    return { email, onToggleFlag };
  };

  it('offers "Star" for an unflagged message', () => {
    renderStar(['\\Seen']);
    expect(action('Star')).toBeTruthy();
  });

  it('offers "Remove star" once it is flagged', () => {
    renderStar(['\\Seen', '\\Flagged']);
    expect(action('Remove star')).toBeTruthy();
  });

  it('hands the open message to the handler', () => {
    const { email, onToggleFlag } = renderStar([]);
    fireEvent.click(action('Star'));
    expect(onToggleFlag).toHaveBeenCalledWith(email);
  });

  it('honours disabled.toggleFlag', () => {
    const { onToggleFlag } = renderStar([], { disabled: { toggleFlag: true } });
    fireEvent.click(action('Star'));
    expect(onToggleFlag).not.toHaveBeenCalled();
  });

  // A message that exists only in the vault has no server flag to write. The
  // star is the only handler wired here, so the bar renders no button at all.
  it('is not offered for a local-only message', () => {
    renderStar([], { isLocalOnly: true });
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  // The bar renders no button the variant did not wire, star included.
  it('is absent when no handler is passed', () => {
    renderBar();
    expect(labels()).not.toContain('Star');
  });
});


describe('reader toolbar action placement', () => {
  it('keeps common actions visible and focuses the menu with full keyboard navigation', () => {
    renderBar();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Reply', 'Reply All', 'Forward', 'Archive', 'Delete', 'Move', 'Mark unread', 'Dark', 'More']);
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    const open = screen.getByRole('menuitem', { name: 'Open' });
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: 'End' });
    expect(document.activeElement.textContent).toBe('Source');
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: 'ArrowDown' });
    expect(document.activeElement.textContent).toBe('Source');
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });

  it.each(['icon-only', 'icon-label', 'text-only'])('exposes everyday actions directly in %s mode', display => {
    settings.actionButtonDisplay = display;
    const handlers = renderBar({ handlers: allHandlers({ onToggleFlag: vi.fn(), onExport: vi.fn() }) });
    for (const [label, handler] of [['Move', 'onMove'], ['Mark unread', 'onToggleRead'], ['Star', 'onToggleFlag'], ['Export', 'onExport']]) {
      const button = screen.getByRole('button', { name: label, exact: true });
      fireEvent.click(button);
      expect(handlers[handler]).toHaveBeenCalledWith(EMAIL);
      expect(button.querySelector('svg') !== null).toBe(display !== 'text-only');
      expect(button.textContent).toBe(display === 'icon-only' ? '' : label);
    }
    openMore();
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Open', 'Source']);
  });

  it('anchors the folder picker to Move and exposes its expanded state', () => {
    const moveButtonRef = React.createRef();
    const props = { email: EMAIL, onMove: vi.fn(), onOpenInWindow: vi.fn(), moveButtonRef };
    const { rerender } = render(<EmailActionBar {...props} />);
    const move = screen.getByRole('button', { name: 'Move' });
    expect(moveButtonRef.current).toBe(move);
    expect(move.getAttribute('aria-expanded')).toBe('false');
    rerender(<EmailActionBar {...props} moveDropdownOpen />);
    expect(move.getAttribute('aria-expanded')).toBe('true');
    expect(moveButtonRef.current).toBe(move);
  });

  it('omits More when only everyday actions are available', () => {
    renderBar({ handlers: { onMove: vi.fn(), onToggleRead: vi.fn(), onToggleFlag: vi.fn(), onExport: vi.fn() } });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });
});


it('keeps Insights detail read-only while retaining reply and source actions', () => {
  renderBar({ email: { ...EMAIL, _insightsReadOnly: true }, handlers: allHandlers({ onToggleFlag: vi.fn() }) });
  const visible = labels();
  expect(visible).not.toContain('Delete'); expect(visible).not.toContain('Archive');
  expect(visible).not.toContain('Move'); expect(visible).not.toContain('Mark unread');
  expect(visible).not.toContain('Star');
  expect(visible).toContain('Reply'); expect(visible).toContain('Forward'); expect(visible).toContain('Source');
});
