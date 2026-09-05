// @vitest-environment jsdom

// The open message has to be visible in the list. A 2px left border alone is
// easy to miss — especially on an unread row, which already carries its own
// background — so a selected row also gets the accent tint.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
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
vi.mock('../../stores/mailStore', () => {
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Senate budget review', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], ...extra,
});

const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

const thread = (extra = {}) => ({
  threadId: 't1', subject: 'Senate budget review', messageCount: 2,
  emails: [email(), email({ uid: 43 })], lastEmail: email({ uid: 43 }),
  lastDate: new Date('2026-08-01T10:00:00Z'), participants: ['padme@naboo.gov'],
  unreadCount: 0, ...extra,
});

const variants = [
  ['EmailRow', (sel, unread) =>
    <EmailRow email={email(unread ? { flags: [] } : {})} isSelected={sel} isChecked={false}
      onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />],
  ['CompactEmailRow', (sel, unread) =>
    <CompactEmailRow email={email(unread ? { flags: [] } : {})} isSelected={sel} isChecked={false}
      onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />],
  ['ThreadRow', (sel, unread) =>
    <ThreadRow rowId="r1" thread={thread(unread ? { unreadCount: 1, emails: [email({ flags: [] })], lastEmail: email({ flags: [] }) } : {})}
      isSelected={sel} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />],
  ['CompactThreadRow', (sel, unread) =>
    <CompactThreadRow rowId="r1" thread={thread(unread ? { unreadCount: 1, emails: [email({ flags: [] })], lastEmail: email({ flags: [] }) } : {})}
      isSelected={sel} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />],
];

afterEach(cleanup);

describe.each(variants)('%s selected background', (_name, renderRow) => {
  const row = (container) => container.querySelector('[data-testid="email-row"]');

  it('paints the accent tint when selected, and keeps the left border', () => {
    const { container } = render(renderRow(true, false));
    const cls = row(container).className;
    expect(cls).toContain('bg-mail-accent-tint');
    expect(cls).toContain('border-l-mail-accent');
  });

  it('paints no tint when not selected', () => {
    const { container } = render(renderRow(false, false));
    expect(row(container).className).not.toContain('bg-mail-accent-tint');
  });

  it('an unselected unread row keeps its own surface', () => {
    const { container } = render(renderRow(false, true));
    const cls = row(container).className;
    expect(cls).toContain('bg-mail-surface');
    expect(cls).not.toContain('bg-mail-accent-tint');
  });

  it('a selected unread row does not also ask for the unread surface', () => {
    const { container } = render(renderRow(true, true));
    const cls = row(container).className;
    expect(cls).toContain('bg-mail-accent-tint');
    // Both are plain, equal-specificity utilities; whichever the stylesheet
    // declares last would win, so the unread surface is simply not requested.
    expect(cls.split(/\s+/)).not.toContain('bg-mail-surface');
  });
});
