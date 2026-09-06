// @vitest-environment jsdom

// Where the row's glyphs sit, as a layout contract.
//
// The alert icons used to be drawn BEFORE the subject, and each one is
// conditional on that message: a row with a sender warning, a link warning and
// a tracker pushed its subject four icon widths right, its neighbour with none
// pushed it zero. Scanning a list means running your eye down one column, and
// there was no column — the subject's left edge moved on every row, and in the
// two-line variants it never lined up with the sender line above it either.
//
// So: nothing precedes the subject, every alert icon (and the star, where the
// row has one) belongs on the sender line, and in a compact row the subject is
// the line directly under the sender's. The star is not an exception: it
// reserves its width whether lit or not, so its offset was constant per row —
// but a thread row has no star, and a message row's subject one star-width
// right of its thread-row neighbour's is the same zig-zag down the column.
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

// The four alert icons render a marker instead of nothing: this file is about
// where they land, so they have to be findable in the DOM.
const marker = () => <span data-testid="alert-icon" />;
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: marker }));
vi.mock('../SenderAlertIcon', () => ({
  SenderAlertIcon: marker,
  // Truthy, or ThreadRow draws no sender alert at all.
  getSenderAlertLevel: () => ({ level: 'warning', email: { address: 'padme@naboo.gov' } }),
}));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: marker, getThreadReplyToMismatch: () => true }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: marker, getThreadTrackerInfo: () => ({ count: 1 }) }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => 'warning',
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
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], hasAttachments: true,
  _senderAlert: 'warning', _replyToMismatch: true, _linkAlert: 'warning', _trackerInfo: { count: 1 },
  ...extra,
});

const thread = () => ({
  threadId: 't1', subject: 'Senate budget review', messageCount: 2,
  emails: [email(), email({ uid: 43 })], lastEmail: email({ uid: 43 }),
  lastDate: new Date('2026-08-01T10:00:00Z'), participants: ['padme@naboo.gov'],
  unreadCount: 0,
});

const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

const variants = [
  {
    name: 'EmailRow', compact: false, star: 'sender-line',
    render: () => <EmailRow email={email()} isSelected={false} isChecked={false}
      onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
  },
  {
    name: 'CompactEmailRow', compact: true, star: 'sender-line',
    render: () => <CompactEmailRow email={email()} isSelected={false} isChecked={false}
      onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />,
  },
  {
    name: 'ThreadRow', compact: false, star: null,
    render: () => <ThreadRow rowId="r1" thread={thread()} isSelected={false} anyChecked={false}
      onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />,
  },
  {
    name: 'CompactThreadRow', compact: true, star: null,
    render: () => <CompactThreadRow rowId="r1" thread={thread()} isSelected={false} anyChecked={false}
      onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} />,
  },
];

afterEach(cleanup);

const testid = (el) => el?.getAttribute('data-testid') ?? null;

for (const { name, compact, star, render: renderRow } of variants) {
  describe(`${name} — glyph placement`, () => {
    const parts = (container) => ({
      sender: container.querySelector('[data-testid="row-sender"]'),
      subject: container.querySelector('[data-testid="row-subject"]'),
      icons: [...container.querySelectorAll('[data-testid="alert-icon"]')],
      star: container.querySelector('[data-testid="star-toggle"]'),
    });

    it('puts nothing ahead of the subject', () => {
      const { container } = render(renderRow());
      const { sender, subject } = parts(container);
      expect(sender, 'no row-sender span').toBeTruthy();
      expect(subject, 'no row-subject span').toBeTruthy();
      expect(testid(subject.previousElementSibling)).toBe(null);
    });

    it('draws every alert icon on the sender line, none in the subject cell', () => {
      const { container } = render(renderRow());
      const { sender, subject, icons } = parts(container);
      expect(icons.length).toBe(4);
      for (const icon of icons) {
        expect(icon.parentElement).toBe(sender.parentElement);
        expect(subject.parentElement.contains(icon)).toBe(false);
      }
    });

    if (compact) {
      it('draws the subject on the line directly under the sender', () => {
        const { container } = render(renderRow());
        const { sender, subject } = parts(container);
        expect(subject.parentElement).not.toBe(sender.parentElement);
        expect(subject.parentElement.previousElementSibling).toBe(sender.parentElement);
      });
    }

    if (star) {
      it('keeps the star on the sender line', () => {
        const { container } = render(renderRow());
        const { sender, subject, star: starEl } = parts(container);
        expect(starEl, 'no star-toggle').toBeTruthy();
        expect(starEl.parentElement).toBe(sender.parentElement);
        expect(subject.parentElement.contains(starEl)).toBe(false);
      });
    }
  });
}
