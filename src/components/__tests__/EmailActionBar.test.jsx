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

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector({ actionButtonDisplay: 'icon-and-text' }),
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
      email={EMAIL}
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

const labels = () => screen.getAllByRole('button').map(b => b.textContent);

// vitest runs without `globals`, so testing-library never registers its own
// auto-cleanup — without this every render stacks another bar in the document.
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

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

      fireEvent.click(screen.getByRole('button', { name: label }));

      expect(handlers[handler]).toHaveBeenCalledTimes(1);
    });
  }

  it('shows all ten actions for a server email in the viewer', () => {
    renderBar();
    expect(labels()).toEqual(cases.map(([l]) => l));
  });
});

describe('EmailActionBar — labels name the next action', () => {
  it('offers "Mark unread" for a read email', () => {
    renderBar({ isRead: true });
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeTruthy();
  });

  it('offers "Mark read" for an unread email', () => {
    renderBar({ isRead: false });
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeTruthy();
  });

  it('offers "Unarchive" for an archived email', () => {
    renderBar({ isArchived: true });
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
  });

  it('offers "Light" while the email renders dark', () => {
    renderBar({ emailThemeDark: true });
    expect(screen.getByRole('button', { name: 'Light' })).toBeTruthy();
  });
});

describe('EmailActionBar — no button without a handler', () => {
  it('hides the actions the thread variant does not wire', () => {
    renderBar({
      variant: 'thread',
      handlers: allHandlers({ onArchive: null, onDelete: null, onMove: null, onToggleRead: null }),
    });

    expect(labels()).toEqual(['Reply', 'Reply All', 'Forward', 'Open', 'Source', 'Dark']);
  });

  it('hides the actions the chat variant does not wire', () => {
    renderBar({
      variant: 'chat',
      handlers: allHandlers({
        onArchive: null, onDelete: null, onMove: null, onToggleRead: null,
        onViewSource: null, onToggleEmailTheme: null,
      }),
    });

    expect(labels()).toEqual(['Reply', 'Reply All', 'Forward', 'Open']);
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(handlers.onToggleRead).not.toHaveBeenCalled();
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });
});
