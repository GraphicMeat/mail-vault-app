// @vitest-environment jsdom

// Who a list row names.
//
// Every row used to draw `getSenderName(email)`. In an outgoing folder that is
// the account itself on every row — six rows all reading your own name, and no
// way to tell which message went to whom. An outgoing row names the RECIPIENT
// instead, prefixed with the existing "To:" key so the two kinds of row stay
// distinguishable at a glance.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => false }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null, getThreadTrackerInfo: () => null }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => null,
  getAlertsForEmails: () => [],
  getCachedAlerts: () => [],
}));

// The view the rows fall back to when a row carries no `_mailbox` of its own.
const mailState = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
vi.mock('../../stores/mailStore', () => {
  const hook = (selector) => (selector ? selector(mailState) : mailState);
  hook.getState = () => mailState;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: true,
  subject: 'Senate budget review',
  from: { name: 'Rare', address: 'rare@mock.test' },
  to: [{ name: 'Padme Amidala', address: 'padme@naboo.gov' }],
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'],
  ...extra,
});

const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

const messageRows = [
  ['EmailRow', EmailRow],
  ['CompactEmailRow', CompactEmailRow],
];
const threadRows = [
  ['ThreadRow', ThreadRow],
  ['CompactThreadRow', CompactThreadRow],
];

const renderMessage = (Row, e) => render(
  <Row email={e} isSelected={false} isChecked={false} onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
);
const renderThread = (Row, emails) => render(
  <Row
    thread={{
      threadId: 't1', subject: 'Senate budget review', messageCount: emails.length,
      emails, lastEmail: emails[emails.length - 1], unreadCount: 0,
    }}
    isSelected={false} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()}
  />,
);

const party = () => screen.getByTestId('row-sender').textContent;

afterEach(cleanup);

describe.each(messageRows)('%s names the right party', (_name, Row) => {
  it('names the sender in INBOX', () => {
    renderMessage(Row, email());
    expect(party()).toContain('Rare');
    expect(party()).not.toContain('To:');
  });

  it('names the recipient, prefixed, in an outgoing folder', () => {
    renderMessage(Row, email({ _mailbox: '[Gmail]/Sent Mail' }));
    expect(party()).toBe('To: Padme Amidala');
  });

  it('names the recipient on a Sent copy the INBOX list merged in', () => {
    renderMessage(Row, email({ _fromSentFolder: true }));
    expect(party()).toBe('To: Padme Amidala');
  });

  it('falls back to the sender rather than a dangling "To:"', () => {
    renderMessage(Row, email({ _mailbox: 'Sent', to: [] }));
    expect(party()).toContain('Rare');
    expect(party().trim()).not.toBe('To:');
  });
});

describe.each(threadRows)('%s names the right participants', (_name, Row) => {
  it('lists senders in INBOX', () => {
    renderThread(Row, [email(), email({ uid: 43, from: { name: 'Yoda', address: 'yoda@mock.test' } })]);
    expect(party()).toBe('Rare, Yoda');
  });

  it('lists recipients, deduped on their address, in an outgoing folder', () => {
    renderThread(Row, [
      email({ _mailbox: 'Sent' }),
      email({ uid: 43, _mailbox: 'Sent', to: [{ name: 'Padme', address: 'PADME@naboo.gov' }] }),
      email({ uid: 44, _mailbox: 'Sent', to: [{ name: 'Yoda', address: 'yoda@mock.test' }] }),
    ]);
    expect(party()).toBe('Padme Amidala, Yoda');
  });
});
