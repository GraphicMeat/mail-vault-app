// @vitest-environment jsdom

// One quick-actions menu per list, not one per row.
//
// Every row used to mount RowQuickActions (two dozen store subscriptions, a
// descriptor per action and a Popover portal) whether or not anyone pointed
// at it. A row now mounts it only while it is live: hovered, focused,
// right-clicked, or holding the list's one open menu (EmailList's
// activeMenuRowId) through a follow-up like the folder picker.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useCallback, useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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
vi.mock('../RowQuickActions', () => ({
  RowQuickActions: ({ emails, openAt, onBusyChange }) => (
    <div data-testid="row-actions" data-uids={emails.map(e => e.uid).join(',')}
      data-open-at={openAt ? `${openAt.x},${openAt.y}` : ''}>
      <button data-testid="busy" onClick={() => onBusyChange?.(true)} />
      <button data-testid="idle" onClick={() => onBusyChange?.(false)} />
    </div>
  ),
}));
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

const email = (uid) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: `Message ${uid}`, from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'],
});
const thread = (id) => {
  const emails = [email(id * 10), email(id * 10 + 1)];
  return { threadId: `t${id}`, subject: `Thread ${id}`, emails, lastEmail: emails[1], messageCount: 2, unreadCount: 0 };
};

const shared = () => ({
  isSelected: false, style: {}, actions: { saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  onRequestDelete: vi.fn(), isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});
const variants = [
  ['EmailRow', (i, props) => <EmailRow rowId={i} email={email(i)} onSelect={vi.fn()} onToggleSelection={vi.fn()} isChecked={false} {...props} />, i => String(i)],
  ['CompactEmailRow', (i, props) => <CompactEmailRow rowId={i} email={email(i)} onSelect={vi.fn()} onToggleSelection={vi.fn()} isChecked={false} {...props} />, i => String(i)],
  ['ThreadRow', (i, props) => <ThreadRow rowId={i} thread={thread(i)} onSelectThread={vi.fn()} onSetSelection={vi.fn()} anyChecked={false} {...props} />, i => `${i * 10},${i * 10 + 1}`],
  ['CompactThreadRow', (i, props) => <CompactThreadRow rowId={i} thread={thread(i)} onSelectThread={vi.fn()} onSetSelection={vi.fn()} anyChecked={false} {...props} />, i => `${i * 10},${i * 10 + 1}`],
];

// EmailList's lifted menu state, as the list wires it into every row.
function List({ count, renderRow }) {
  const [active, setActive] = useState(null);
  const open = useCallback(id => setActive(id), []);
  const close = useCallback(id => setActive(current => (id === undefined || current === id ? null : current)), []);
  const props = shared();
  return <>{Array.from({ length: count }, (_, i) => (
    <React.Fragment key={i}>{renderRow(i, { ...props, menuOpen: active === i, onOpenMenu: open, onCloseMenu: close })}</React.Fragment>
  ))}</>;
}

afterEach(cleanup);

for (const [name, renderRow, uidsOf] of variants) {
  describe(`${name}: one menu per list`, () => {
    it('mounts no quick actions on 200 rows nobody has pointed at', () => {
      render(<List count={200} renderRow={renderRow} />);
      expect(screen.getAllByTestId('email-row')).toHaveLength(200);
      expect(screen.queryAllByTestId('row-actions')).toHaveLength(0);
    });

    it("a right-click on row N mounts exactly one, with N's messages, at the pointer", () => {
      render(<List count={200} renderRow={renderRow} />);
      fireEvent.pointerDown(screen.getAllByTestId('email-row')[137], { button: 2, clientX: 12, clientY: 34 });
      const mounted = screen.getAllByTestId('row-actions');
      expect(mounted).toHaveLength(1);
      expect(mounted[0].dataset.uids).toBe(uidsOf(137));
      expect(mounted[0].dataset.openAt).toBe('12,34');
    });

    it('mounts them on the hovered row only, and drops them when the pointer leaves', () => {
      render(<List count={20} renderRow={renderRow} />);
      const rows = screen.getAllByTestId('email-row');
      fireEvent.pointerEnter(rows[3]);
      expect(screen.getAllByTestId('row-actions').map(n => n.dataset.uids)).toEqual([uidsOf(3)]);
      fireEvent.pointerLeave(rows[3]);
      fireEvent.pointerEnter(rows[4]);
      expect(screen.getAllByTestId('row-actions').map(n => n.dataset.uids)).toEqual([uidsOf(4)]);
    });

    // A real right-click opens the wheel on pointerdown and focuses its first
    // wedge. Its mousedown must not then drop focus to the body: on Windows
    // WebView2 that blur unmounted the wheel before the list's hold rendered.
    // With it suppressed, any blur that leaves the row lets go.
    it("a right-click's mousedown keeps focus; a blur out of the row lets go", () => {
      render(<List count={20} renderRow={renderRow} />);
      const row = screen.getAllByTestId('email-row')[2];
      fireEvent.pointerEnter(row);
      fireEvent.pointerDown(row, { button: 2, clientX: 12, clientY: 34 });
      expect(fireEvent.mouseDown(row, { button: 2 })).toBe(false);
      expect(screen.getAllByTestId('row-actions').map(n => n.dataset.uids)).toEqual([uidsOf(2)]);
      fireEvent.focusOut(screen.getByTestId('busy'), { relatedTarget: null });
      expect(screen.queryAllByTestId('row-actions')).toHaveLength(0);
    });

    // A trackpad swipe runs its action through the row's quick actions
    // (utils/rowActionRegistry.js), so a sideways wheel wakes the row even
    // when no hover reached it first, as after a scroll under a still pointer.
    it('mounts them on a sideways wheel, not on a vertical scroll', () => {
      render(<List count={20} renderRow={renderRow} />);
      const rows = screen.getAllByTestId('email-row');
      fireEvent.wheel(rows[6], { deltaX: 0, deltaY: 40 });
      expect(screen.queryAllByTestId('row-actions')).toHaveLength(0);
      fireEvent.wheel(rows[7], { deltaX: 30, deltaY: 2 });
      expect(screen.getAllByTestId('row-actions').map(n => n.dataset.uids)).toEqual([uidsOf(7)]);
    });

    it('keeps them on a row whose menu or follow-up is open after the pointer leaves', () => {
      render(<List count={20} renderRow={renderRow} />);
      const row = screen.getAllByTestId('email-row')[5];
      fireEvent.pointerEnter(row);
      fireEvent.click(screen.getByTestId('busy'));
      fireEvent.pointerLeave(row);
      expect(screen.getAllByTestId('row-actions').map(n => n.dataset.uids)).toEqual([uidsOf(5)]);
      fireEvent.click(screen.getByTestId('idle'));
      expect(screen.queryAllByTestId('row-actions')).toHaveLength(0);
    });
  });
}

// ThreadRow used to call useMemo and useMenuAtPointer after its
// `!thread?.lastEmail` early return: a row that lost its newest message
// rendered fewer hooks than the last time, and React threw.
for (const [name, Row] of [['ThreadRow', ThreadRow], ['CompactThreadRow', CompactThreadRow]]) {
  it(`${name} survives losing its lastEmail between renders`, () => {
    const props = { ...shared(), rowId: 1, onSelectThread: vi.fn(), onSetSelection: vi.fn(), anyChecked: false, menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn() };
    const { rerender, container } = render(<Row thread={thread(1)} {...props} />);
    expect(() => rerender(<Row thread={{ ...thread(1), lastEmail: null }} {...props} />)).not.toThrow();
    expect(container.querySelector('[data-testid="email-row"]')).toBeNull();
    expect(() => rerender(<Row thread={thread(1)} {...props} />)).not.toThrow();
  });
}
