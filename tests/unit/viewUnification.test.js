// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

// Mock framer-motion to avoid animation issues in test
vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef(({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)),
  },
  AnimatePresence: ({ children }) => React.createElement(React.Fragment, null, children),
}));

// Mock stores
vi.mock('../../src/stores/settingsStore', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = { actionButtonDisplay: 'icon-only', signatureDisplay: 'smart' };
    return selector(state);
  }),
}));

vi.mock('../../src/stores/mailStore', () => {
  const state = { activeAccountId: 'test', activeMailbox: 'INBOX', archivedEmailIds: new Set() };
  const hook = vi.fn((selector) => selector(state));
  hook.getState = () => state;
  hook.setState = (update) => Object.assign(state, typeof update === 'function' ? update(state) : update);
  hook.subscribe = () => () => {};
  return { useMailStore: hook };
});

vi.mock('../../src/utils/senderCheck', () => ({
  checkSenderVerification: () => ({ status: 'none', tooltip: '', issues: [] }),
  parseAuthResults: () => ({ spf: null, dkim: null, dmarc: null }),
}));

vi.mock('../../src/utils/emailParser', () => ({
  getSenderName: (email) => email?.from?.name || email?.from?.address || 'Unknown',
}));

// Mock SenderVerificationBadge
vi.mock('../../src/components/email/EmailHeaderComponent', () => ({
  SenderVerificationBadge: () => null,
}));

const testEmail = {
  uid: 1,
  from: { name: 'Test Sender', address: 'test@example.com' },
  to: [{ name: 'Recipient', address: 'recipient@example.com' }],
  cc: [],
  date: '2026-03-19T10:00:00Z',
  subject: 'Test Subject',
  messageId: '<test@example.com>',
  source: 'server',
  flags: [],
  authenticationResults: '',
};

const noNameEmail = {
  ...testEmail,
  uid: 2,
  from: { address: 'noreply@example.com' },
};

describe('EmailSenderInfo', () => {
  let EmailSenderInfo;

  beforeEach(async () => {
    const mod = await import('../../src/components/email/EmailSenderInfo.jsx');
    EmailSenderInfo = mod.EmailSenderInfo;
  });

  it('renders sender name and email in single variant', () => {
    const { container } = render(
      React.createElement(EmailSenderInfo, {
        email: testEmail,
        variant: 'single',
        expanded: true,
        onToggle: vi.fn(),
        archivedEmailIds: new Set(),
      })
    );
    expect(container.textContent).toContain('Test Sender');
    expect(container.textContent).toContain('test@example.com');
  });

  it('renders sender name and email in thread variant', () => {
    const { container } = render(
      React.createElement(EmailSenderInfo, {
        email: testEmail,
        variant: 'thread',
        expanded: true,
        onToggle: vi.fn(),
        archivedEmailIds: new Set(),
      })
    );
    expect(container.textContent).toContain('Test Sender');
    expect(container.textContent).toContain('test@example.com');
  });

  it('renders clickable avatar in chat variant', () => {
    const onClick = vi.fn();
    const { container } = render(
      React.createElement(EmailSenderInfo, {
        email: testEmail,
        variant: 'chat',
        onAvatarClick: onClick,
        onNameClick: vi.fn(),
      })
    );
    // Chat variant renders a clickable avatar with cursor-pointer
    const avatarDiv = container.querySelector('.cursor-pointer');
    expect(avatarDiv).toBeTruthy();
  });

  it('shows email in name position when no sender name', () => {
    render(
      React.createElement(EmailSenderInfo, {
        email: noNameEmail,
        variant: 'single',
        expanded: false,
        onToggle: vi.fn(),
        archivedEmailIds: new Set(),
      })
    );
    expect(screen.getByText('noreply@example.com')).toBeTruthy();
  });

  it('does not define or export SenderBadge', async () => {
    const mod = await import('../../src/components/email/EmailSenderInfo.jsx');
    expect(mod.SenderBadge).toBeUndefined();
  });
});

describe('EmailActionBar', () => {
  let EmailActionBar;

  beforeEach(async () => {
    const mod = await import('../../src/components/email/EmailActionBar.jsx');
    EmailActionBar = mod.EmailActionBar;
  });

  it('renders action buttons in single variant', () => {
    render(
      React.createElement(EmailActionBar, {
        email: testEmail,
        variant: 'single',
        onReply: vi.fn(),
        onReplyAll: vi.fn(),
        onForward: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        onMove: vi.fn(),
        onToggleRead: vi.fn(),
        onOpenInWindow: vi.fn(),
        onViewSource: vi.fn(),
        isArchived: false,
        isRead: true,
        isLocalOnly: false,
        isSentEmail: false,
        singleRecipient: false,
      })
    );
    // In icon-only mode, buttons have aria-labels
    expect(screen.getByLabelText('Reply')).toBeTruthy();
    expect(screen.getByLabelText('Forward')).toBeTruthy();
    expect(screen.getByLabelText('Delete')).toBeTruthy();
    expect(screen.getByLabelText('Archive')).toBeTruthy();
  });

  it('hides reply buttons for sent emails', () => {
    cleanup();
    const { container } = render(
      React.createElement(EmailActionBar, {
        email: testEmail,
        variant: 'single',
        onReply: vi.fn(),
        onReplyAll: vi.fn(),
        onForward: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        isArchived: false,
        isRead: true,
        isLocalOnly: false,
        isSentEmail: true,
        singleRecipient: false,
      })
    );
    // Reply and Reply All should not be in this render
    const buttons = container.querySelectorAll('button');
    const labels = Array.from(buttons).map(b => b.getAttribute('aria-label')).filter(Boolean);
    expect(labels).not.toContain('Reply');
    expect(labels).not.toContain('Reply All');
    expect(labels).toContain('Forward');
  });

  it('respects icon-only display mode', () => {
    render(
      React.createElement(EmailActionBar, {
        email: testEmail,
        variant: 'single',
        onReply: vi.fn(),
        onForward: vi.fn(),
        onDelete: vi.fn(),
        isArchived: false,
        isRead: true,
        isLocalOnly: false,
        isSentEmail: false,
        singleRecipient: true,
      })
    );
    // In icon-only mode, label text should not be visible
    // but aria-labels should exist
    expect(screen.getByLabelText('Reply')).toBeTruthy();
    // The button should not have visible text "Reply" (only aria-label)
    const replyBtn = screen.getByLabelText('Reply');
    expect(replyBtn.querySelector('span')).toBeNull();
  });
});
