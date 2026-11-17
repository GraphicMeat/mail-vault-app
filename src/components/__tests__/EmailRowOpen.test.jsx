// @vitest-environment jsdom

// A double click on a list row opens the message in its own window and must
// not reload the message the first click already opened: the second click of
// the pair (event.detail 2) is not another "open this".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ openEmailInWindow: vi.fn(async () => true) }));

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
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null }));
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../services/bodyScan', () => ({
  getLinkAlertLevel: () => null,
  getAlertsForEmails: () => [],
  getCachedAlerts: () => [],
}));
vi.mock('../../services/workflows/readerWindow', () => ({ openEmailInWindow: (...args) => mocks.openEmailInWindow(...args) }));
vi.mock('../../stores/mailStore', () => {
  const state = { serverUids: { complete: false }, activeMailbox: 'INBOX', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');

const onSelect = vi.fn();
const email = {
  uid: 42, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Senate budget review', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'],
};
const rowProps = () => ({
  isSelected: false, onSelect, onToggleSelection: vi.fn(), isChecked: false, style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

for (const [name, Row] of [['EmailRow', EmailRow], ['CompactEmailRow', CompactEmailRow]]) {
  describe(`${name} - double click`, () => {
    it('opens the message on a single click', () => {
      render(<Row email={email} {...rowProps()} />);
      fireEvent.click(screen.getByTestId('email-row'), { detail: 1 });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('does not open the same message again on the second click of a double click', () => {
      render(<Row email={email} {...rowProps()} />);
      const row = screen.getByTestId('email-row');
      fireEvent.click(row, { detail: 1 });
      fireEvent.click(row, { detail: 2 });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('opens the message in a new window on a double click', () => {
      render(<Row email={email} {...rowProps()} />);
      fireEvent.doubleClick(screen.getByTestId('email-row'));
      expect(mocks.openEmailInWindow).toHaveBeenCalledTimes(1);
      expect(mocks.openEmailInWindow.mock.calls[0][0]).toBe(email);
    });

    it('does not open a window on a single click', () => {
      render(<Row email={email} {...rowProps()} />);
      fireEvent.click(screen.getByTestId('email-row'), { detail: 1 });
      expect(mocks.openEmailInWindow).not.toHaveBeenCalled();
    });

    it('selects through the list\'s own select when the window needs the message first', async () => {
      render(<Row email={email} {...rowProps()} />);
      fireEvent.doubleClick(screen.getByTestId('email-row'));
      const select = mocks.openEmailInWindow.mock.calls[0][1];
      await select();
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0][3]).toBe(email);
    });
  });
}
