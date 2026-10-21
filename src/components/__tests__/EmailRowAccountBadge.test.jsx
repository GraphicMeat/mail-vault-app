// @vitest-environment jsdom

// A row of a view that spans accounts says which account holds it: the
// account's initial on its colour, as the sidebar draws it, and pointing at the
// row lights that account in the sidebar. A search from All inboxes is such a
// view, and its hits carry the account id only (the daemon stamps no address).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : (props) => React.createElement('span', { 'data-icon': String(name), ...props })),
  has: () => true,
}));
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => null }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null }));
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', () => ({
  ConnectedStateIcon: () => null,
  describeMessageState: () => ({ tone: 'local' }),
}));
vi.mock('../../services/bodyScan', () => ({ getLinkAlertLevel: () => null, getAlertsForEmails: () => [], getCachedAlerts: () => [] }));
vi.mock('../../stores/mailStore', () => {
  const state = {
    serverUids: { complete: false }, activeMailbox: 'UNIFIED', activeAccountId: 'acct-1',
    accounts: [{ id: 'acct-1', email: 'work@example.com', name: 'Work' }, { id: 'acct-2', email: 'home@example.com' }],
  };
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useMailStore: hook };
});

const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useAccountHoverStore } = await import('../../stores/accountHoverStore');

const email = (extra = {}) => ({
  uid: 42, _accountId: 'acct-2', _accountEmail: 'home@example.com', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Budget', from: { name: 'Padme', address: 'padme@naboo.gov' }, date: '2026-08-01T10:00:00Z', flags: ['\\Seen'], ...extra,
});
const props = (extra = {}) => ({
  rowId: 42, email: email(), isSelected: false, onSelect: vi.fn(), onToggleSelection: vi.fn(), isChecked: false,
  actions: {}, unifiedInbox: true, accountColors: {}, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), ...extra,
});

beforeEach(() => {
  useSettingsStore.setState({ displayNames: { 'acct-2': 'Home base' } });
  useAccountHoverStore.setState({ accountId: null });
});
afterEach(cleanup);

describe.each([['EmailRow', EmailRow], ['CompactEmailRow', CompactEmailRow]])('%s account badge', (_name, Row) => {
  it("draws the account's initial on its colour, with the address as tooltip", () => {
    useSettingsStore.setState({ accountColors: { 'acct-2': '#123456' } });
    render(<Row {...props({ accountColors: { 'acct-2': '#123456' } })} />);
    const badge = screen.getByTestId('account-dot');
    // "Home base": two words, so the sidebar's two-letter initials.
    expect(badge.textContent).toBe('HB');
    expect(badge.getAttribute('title')).toBe('home@example.com');
    expect(badge.style.backgroundColor).toBe('rgb(18, 52, 86)');
  });

  it('is absent outside a spanning view', () => {
    render(<Row {...props({ unifiedInbox: false })} />);
    expect(screen.queryByTestId('account-dot')).toBeNull();
  });

  it('lights its account while the pointer is on the row and clears it on leaving', () => {
    render(<Row {...props()} />);
    fireEvent.mouseEnter(screen.getByTestId('email-row'));
    expect(useAccountHoverStore.getState().accountId).toBe('acct-2');
    fireEvent.mouseLeave(screen.getByTestId('email-row'));
    expect(useAccountHoverStore.getState().accountId).toBeNull();
  });

  it('does not wipe the light another row took when it unmounts', () => {
    const { unmount } = render(<Row {...props()} />);
    fireEvent.mouseEnter(screen.getByTestId('email-row'));
    useAccountHoverStore.setState({ accountId: 'acct-1' });
    unmount();
    expect(useAccountHoverStore.getState().accountId).toBe('acct-1');
  });

  it('clears its own light when it unmounts under the pointer', () => {
    const { unmount } = render(<Row {...props()} />);
    fireEvent.mouseEnter(screen.getByTestId('email-row'));
    unmount();
    expect(useAccountHoverStore.getState().accountId).toBeNull();
  });

  it('sets nothing in a single-account view', () => {
    render(<Row {...props({ unifiedInbox: false })} />);
    fireEvent.mouseEnter(screen.getByTestId('email-row'));
    expect(useAccountHoverStore.getState().accountId).toBeNull();
  });
});
