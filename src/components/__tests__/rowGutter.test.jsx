// @vitest-environment jsdom

// "Now the subject and text preview are not on the same line vertically":
// the custody chip and, in an unfoldable thread list, the disclosure chevron
// sat between the checkbox and the text, and only some rows had a chevron, so
// the text started at a different x per row. Every row now leads with one
// fixed-width gutter that holds all of them, the same shape on every row of a
// list whatever that row carries. jsdom has no layout, so "the same x" is
// asserted as "the same gutter": its classes and slots, never its contents.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
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
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => <span data-testid="state-icon" />,
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
const { useSettingsStore } = await import('../../stores/settingsStore');

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Invoice', from: { name: 'Bob', address: 'bob@example.com' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], previewText: 'Hi Ann, the invoice is attached.',
  ...extra,
});
const thread = () => {
  const emails = [email({ uid: 1 }), email({ uid: 2 })];
  return { threadId: 't1', subject: 'Invoice', messageCount: 2, unreadCount: 0, emails, lastEmail: emails[1] };
};
const shared = () => ({
  style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  onCloseMenu: vi.fn(), onRequestDelete: vi.fn(), isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

// `slot`: whether the list reserves the disclosure column (expandable mode).
const variants = {
  EmailRow: { compact: false, render: (slot) => <EmailRow email={email()} isSelected={false} isChecked={false} onSelect={vi.fn()} onToggleSelection={vi.fn()} threadSlot={slot} {...shared()} /> },
  CompactEmailRow: { compact: true, render: (slot) => <CompactEmailRow email={email()} isSelected={false} isChecked={false} onSelect={vi.fn()} onToggleSelection={vi.fn()} threadSlot={slot} {...shared()} /> },
  ThreadRow: { compact: false, render: (slot) => <ThreadRow rowId="r" thread={thread()} isSelected={false} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} expandable={slot} onToggleExpand={vi.fn()} {...shared()} /> },
  CompactThreadRow: { compact: true, render: (slot) => <CompactThreadRow rowId="r" thread={thread()} isSelected={false} anyChecked={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} expandable={slot} onToggleExpand={vi.fn()} {...shared()} /> },
};

// The gutter's structure, down to its fixed-size slots and not into them:
// what a slot holds is the row's own business, its width is not.
const shape = (el) => {
  const own = `${el.tagName}.${el.getAttribute('class') || ''}`;
  if (el.classList.contains('row-gutter-slot')) return own;
  return `${own}[${[...el.children].map(shape).join(',')}]`;
};

const gutterOf = (container) => {
  const row = container.querySelector('[data-testid="email-row"]');
  const gutter = row.querySelector('[data-testid="row-gutter"]');
  return { row, gutter };
};

beforeEach(() => act(() => useSettingsStore.setState({ listPreviewLines: 0 })));
afterEach(cleanup);

for (const lines of [0, 2]) {
  describe(`with ${lines} preview lines`, () => {
    beforeEach(() => act(() => useSettingsStore.setState({ listPreviewLines: lines })));

    for (const [name, { compact, render: renderRow }] of Object.entries(variants)) {
      it(`${name} leads with the gutter, holding the checkbox and the custody chip`, () => {
        const { container } = render(renderRow(false));
        const { row, gutter } = gutterOf(container);
        expect(gutter, 'no row-gutter').toBeTruthy();
        expect(row.firstElementChild).toBe(gutter);
        expect(gutter.querySelector('input[type="checkbox"]')).toBeTruthy();
        expect(gutter.querySelector('[data-testid="row-state-slot"] [data-testid="state-icon"]')).toBeTruthy();
        expect(row.querySelectorAll('[data-testid="state-icon"]').length).toBe(1);
        expect(gutter.contains(row.querySelector('[data-testid="row-sender"]'))).toBe(false);
        expect(gutter.contains(row.querySelector('[data-testid="row-subject"]'))).toBe(false);
      });

      it(`${name} stacks the chip under the checkbox only when the row has two or more lines`, () => {
        const { container } = render(renderRow(false));
        const { gutter } = gutterOf(container);
        expect(gutter.classList.contains('row-gutter-stacked')).toBe(compact || lines > 0);
      });

      it(`${name} puts the thread disclosure in the gutter, never beside the text`, () => {
        const { container } = render(renderRow(true));
        const { row, gutter } = gutterOf(container);
        const slot = gutter.querySelector('[data-testid="row-disclosure-slot"]');
        expect(slot, 'no disclosure slot while the list unfolds threads').toBeTruthy();
        const chevron = row.querySelector('[data-testid="thread-expand"]');
        if (name.includes('Thread')) expect(slot.contains(chevron)).toBe(true);
        else expect(chevron).toBeNull();
      });

      it(`${name} reserves no disclosure column while the list does not unfold threads`, () => {
        const { container } = render(renderRow(false));
        expect(gutterOf(container).gutter.querySelector('[data-testid="row-disclosure-slot"]')).toBeNull();
      });
    }

    // The whole point: one gutter shape per list, so the text column starts
    // at one x. A thread row with a chevron and a message row with none have
    // the same gutter; so do a two-line message row and a two-line thread row.
    for (const compact of [false, true]) {
      for (const slot of [false, true]) {
        it(`${compact ? 'compact' : 'default'} rows share one gutter shape${slot ? ' in an unfolding list' : ''}`, () => {
          const shapes = Object.values(variants).filter(v => v.compact === compact).map(v => {
            const { container } = render(v.render(slot));
            const s = shape(gutterOf(container).gutter);
            cleanup();
            return s;
          });
          expect(shapes[1]).toBe(shapes[0]);
        });
      }
    }
  });
}

