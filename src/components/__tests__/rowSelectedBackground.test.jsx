// @vitest-environment jsdom

// The open message has to be visible in the list. A 2px left border alone is
// easy to miss — especially on an unread row, which already carries its own
// background — so a selected row also gets the accent tint.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const { useSettingsStore } = await import('../../stores/settingsStore');

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
  ['EmailRow', (sel, unread, related) =>
    <EmailRow email={email(unread ? { flags: [] } : {})} isSelected={sel} isRelated={related} isChecked={false}
      onSelect={vi.fn()} onToggleSelection={vi.fn()} {...shared()} />],
  ['CompactEmailRow', (sel, unread, related) =>
    <CompactEmailRow email={email(unread ? { flags: [] } : {})} isSelected={sel} isRelated={related} isChecked={false}
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

// The second highlighting mode (`emailRowHighlight: 'selection'`): hover goes
// quiet and the open row is what is lit, with the rest of its thread a step
// lighter. The four blocks above are the guarantee that turning this on is the
// only way to change any of it.
describe.each(variants)('%s in selection mode', (name, renderRow) => {
  const row = (container) => container.querySelector('[data-testid="email-row"]');
  const cls = (container) => row(container).className.split(/\s+/);

  beforeEach(() => useSettingsStore.setState({ emailRowHighlight: 'selection' }));
  afterEach(() => useSettingsStore.setState({ emailRowHighlight: 'hover' }));

  it('fills the open row with the marking grey', () => {
    const c = cls(render(renderRow(true, false)).container);
    expect(c).toContain('bg-mail-row-selected');
    // The accent tint is the "live thing" colour and the border shifts the
    // row's content by 2px; neither belongs to a neutral marking.
    expect(c).not.toContain('bg-mail-accent-tint');
    expect(c).not.toContain('border-l-mail-accent');
    expect(c).not.toContain('pl-[14px]');
  });

  it('never reacts to the pointer', () => {
    for (const args of [[false, false], [true, false], [false, true]]) {
      const { container } = render(renderRow(...args));
      expect(cls(container)).not.toContain('hover:bg-mail-surface-hover');
      cleanup();
    }
  });

  it('a selected unread row does not also ask for the unread surface', () => {
    const c = cls(render(renderRow(true, true)).container);
    expect(c).toContain('bg-mail-row-selected');
    expect(c).not.toContain('bg-mail-surface');
  });

  it('an unmarked unread row keeps its own surface', () => {
    const c = cls(render(renderRow(false, true)).container);
    expect(c).toContain('bg-mail-surface');
    expect(c).not.toContain('bg-mail-row-selected');
    expect(c).not.toContain('bg-mail-row-related');
  });
});

// A thread row that holds the open message is already `isSelected`, so only the
// message rows carry the sibling ground.
describe.each(variants.slice(0, 2))('%s sibling ground', (_name, renderRow) => {
  const cls = (container) => container.querySelector('[data-testid="email-row"]').className.split(/\s+/);

  afterEach(() => useSettingsStore.setState({ emailRowHighlight: 'hover' }));

  it('paints the lighter grey on the rest of the open message’s thread', () => {
    useSettingsStore.setState({ emailRowHighlight: 'selection' });
    const c = cls(render(renderRow(false, false, true)).container);
    expect(c).toContain('bg-mail-row-related');
    expect(c).not.toContain('bg-mail-row-selected');
    expect(c).not.toContain('hover:bg-mail-surface-hover');
  });

  it('ignores the sibling flag entirely while hover is the mode', () => {
    useSettingsStore.setState({ emailRowHighlight: 'hover' });
    const c = cls(render(renderRow(false, false, true)).container);
    expect(c).not.toContain('bg-mail-row-related');
    expect(c).toContain('hover:bg-mail-surface-hover');
  });
});

// An unfolded thread row is the container of the conversation, not the message
// being read — the member rows carry the mark. Folded, it IS the row you
// opened. Only the marking mode has a sibling ground to demote to.
describe('an unfolded thread row holding the open message', () => {
  const cls = (container) => container.querySelector('[data-testid="email-row"]').className.split(/\s+/);
  const renderThread = (props) =>
    render(<ThreadRow rowId="r1" thread={thread()} isSelected anyChecked={false}
      onSelectThread={vi.fn()} onSetSelection={vi.fn()} {...shared()} {...props} />).container;

  afterEach(() => useSettingsStore.setState({ emailRowHighlight: 'hover' }));

  it('takes the sibling grey while unfolded', () => {
    useSettingsStore.setState({ emailRowHighlight: 'selection' });
    const c = cls(renderThread({ expandable: true, expanded: true }));
    expect(c).toContain('bg-mail-row-related');
    expect(c).not.toContain('bg-mail-row-selected');
  });

  it('takes the marking grey once folded', () => {
    useSettingsStore.setState({ emailRowHighlight: 'selection' });
    const c = cls(renderThread({ expandable: true, expanded: false }));
    expect(c).toContain('bg-mail-row-selected');
    expect(c).not.toContain('bg-mail-row-related');
  });

  it('is untouched in hover mode — an unfolded thread keeps the accent tint', () => {
    const c = cls(renderThread({ expandable: true, expanded: true }));
    expect(c).toContain('bg-mail-accent-tint');
    expect(c).toContain('border-l-mail-accent');
  });
});
