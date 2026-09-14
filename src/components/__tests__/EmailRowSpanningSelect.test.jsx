// @vitest-environment jsdom

// Bug report (2026-09-14): "Cannot tell which account and folder hold message
// 282" after clicking a vault search hit. The bare "282" in that sentence is
// the key the click sent.
//
// Search results and unfolded thread members render through these rows with
// `onSelect={selectEmail}` (EmailList.jsx), and in a list spanning mailboxes a
// uid names no message: the same number is a different message in every other
// account and folder. The row knows its account; the click has to pass it on,
// whether as a selection key or as an explicit location.
import { it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  // Every icon resolves — a hand-listed set breaks the moment a shared
  // primitive imports one more glyph.
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: ({ info }) => info?.count ? <span data-testid="tracker-alert-icon" /> : null }));
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
  // Callable as a hook AND carrying .getState() — EmailRow does both.
  const state = { serverUids: { complete: false }, activeMailbox: 'UNIFIED', activeAccountId: 'acct-1' };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');

// A vault search hit from another folder of the active account, as
// db.searchLocalEmails stamps it.
const HIT = {
  uid: 282, _accountId: 'acct-1', _mailbox: 'Archive', source: 'local', isArchived: true, isLocal: true,
  subject: 'didelis laiskas', from: { name: 'G', address: 'g@mock.test' },
  to: [{ name: 'G ir G Partneriai', address: 'p@mock.test' }], date: '2017-03-02T10:00:00Z', flags: ['\\Seen'],
};

const rowProps = (onSelect) => ({
  isSelected: false, onSelect, onToggleSelection: vi.fn(), isChecked: false, style: {},
  actions: { saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), toggleFlagged: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(),
  isSaving: false, onStartSaving: vi.fn(), onStopSaving: vi.fn(),
});

afterEach(cleanup);

for (const [name, Row] of [['EmailRow', EmailRow], ['CompactEmailRow', CompactEmailRow]]) {
  it(`${name} click in a spanning view names the account of the row clicked`, () => {
    const onSelect = vi.fn();
    render(<Row email={HIT} {...rowProps(onSelect)} />);

    fireEvent.click(screen.getByTestId('email-row'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onSelect.mock.calls[0])).toContain('acct-1');
  });
}
