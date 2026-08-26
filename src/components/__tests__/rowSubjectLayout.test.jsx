// @vitest-environment jsdom

// The subject column of every list row, guarded as a layout contract.
//
// Twice now the subject has rendered at literally 0px while the store held
// the text — once in EmailRow (fixed in 66a79a7), once in ThreadRow. Both
// times the shape was identical: a fixed w-48 sender/participants column that
// only yields once the flex line overflows, `min-w-0` on the subject column so
// the line never overflowed, and a subject span with no flex-grow competing
// against shrink-0 siblings (count badge, attachment icon, date). The span
// lost every pixel and the row read as a message with no subject.
//
// jsdom does not lay out, so this file cannot measure widths — it asserts the
// mechanism that produces them:
//   * the subject column carries a real px floor, never min-w-0, so a narrow
//     pane pushes the deficit onto the sender column (which allows down to
//     80px) instead of onto the subject;
//   * the subject span itself is flex-1 min-w-0, so it truncates with an
//     ellipsis rather than collapsing.
// Measured widths at a 320/350px pane live in the browser check recorded in
// the fix commit; this is the part that runs in CI.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

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
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  // EmailRow asks this whether the row is the only copy, to decide the gold
  // row wash. These are layout tests, so answer with the ordinary vault tone.
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => null,
  getAlertsForEmails: () => [],
  getCachedAlerts: () => [],
}));
vi.mock('../../stores/mailStore', () => {
  // Callable as a hook AND carrying .getState() — EmailRow does both, and a
  // bare object made every row throw before it could lay anything out.
  const state = { serverUids: { complete: false } };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});
vi.mock('../../stores/slices/unifiedHelpers', () => ({ emailScopeKey: (e) => `acct-1:INBOX:${e.uid}` }));

const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');
const { EmailRow, CompactEmailRow } = await import('../EmailRow');

afterEach(cleanup);

const SUBJECT = 'Senate budget review for the outer rim';

const email = (uid, extra = {}) => ({
  uid, _accountId: 'acct-1', source: 'server', isArchived: false,
  subject: SUBJECT, from: { name: 'Padme Amidala', address: 'padme@naboo.gov' },
  date: '2023-11-04T10:00:00Z', flags: ['\\Seen'], hasAttachments: true, ...extra,
});

const thread = () => {
  const emails = [email(1001), email(1002), email(1003)];
  return { threadId: 't1', subject: SUBJECT, emails, lastEmail: emails[2], messageCount: 3, unreadCount: 0 };
};

const noopActions = { saveEmailsLocally: vi.fn(), saveEmailLocally: vi.fn() };
const rowProps = {
  isSelected: false, onSelectThread: vi.fn(), onSelect: vi.fn(), onToggleSelection: vi.fn(), onSetSelection: vi.fn(),
  anyChecked: false, isChecked: false, style: {}, actions: noopActions, menuOpen: false,
  onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(), isSaving: false,
  onStartSaving: vi.fn(), onStopSaving: vi.fn(),
};

/** The span rendering the subject text, and the flex line it competes on. */
function subjectSpanAndColumn() {
  const span = screen.getAllByText(SUBJECT).find(el => el.tagName === 'SPAN');
  expect(span, 'no <span> rendered the subject').toBeTruthy();
  return { span, column: span.parentElement };
}

const cases = [
  ['ThreadRow', () => <ThreadRow thread={thread()} {...rowProps} />, { floor: true }],
  ['CompactThreadRow', () => <CompactThreadRow thread={thread()} {...rowProps} />, { floor: false }],
  ['EmailRow', () => <EmailRow email={email(1001)} {...rowProps} />, { floor: true }],
  ['CompactEmailRow', () => <CompactEmailRow email={email(1001)} {...rowProps} />, { floor: false }],
];

describe('list row subject column', () => {
  for (const [name, renderRow, { floor }] of cases) {
    describe(name, () => {
      it('lets the subject span grow and truncate instead of shrinking away', () => {
        render(renderRow());
        const { span } = subjectSpanAndColumn();
        // flex-1 without min-w-0 cannot truncate; min-w-0 without flex-1 has no
        // width to start from. Both, or the span collapses.
        expect(span.className).toMatch(/\bflex-1\b/);
        expect(span.className).toMatch(/\bmin-w-0\b/);
        expect(span.className).toMatch(/\btruncate\b/);
      });

      if (floor) {
        it('floors the subject column in px so the sender column absorbs the deficit', () => {
          render(renderRow());
          const { column } = subjectSpanAndColumn();
          expect(column.className).not.toMatch(/\bmin-w-0\b/);
          const px = column.className.match(/min-w-\[(\d+)px\]/);
          expect(px, `subject column has no px floor: "${column.className}"`).toBeTruthy();
          // 120px is what a sender + date + attachment row needs; a thread row
          // also carries the count badge, so it floors higher.
          expect(Number(px[1])).toBeGreaterThanOrEqual(120);
        });
      }
    });
  }

  it('floors the thread row above the plain row — it carries the count badge too', () => {
    const { unmount } = render(<ThreadRow thread={thread()} {...rowProps} />);
    const threadFloor = Number(subjectSpanAndColumn().column.className.match(/min-w-\[(\d+)px\]/)[1]);
    unmount();
    render(<EmailRow email={email(1001)} {...rowProps} />);
    const emailFloor = Number(subjectSpanAndColumn().column.className.match(/min-w-\[(\d+)px\]/)[1]);
    expect(threadFloor).toBeGreaterThan(emailFloor);
  });
});
