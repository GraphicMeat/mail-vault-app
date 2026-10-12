// @vitest-environment jsdom

// A conversation row of All inboxes (the default expandable mode draws these,
// not single-message rows) names its account by its newest message and lights
// that account in the sidebar while pointed at, as a message row does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : (props) => React.createElement('span', { 'data-icon': String(name), ...props })),
  has: () => true,
}));
vi.mock('../LinkAlertIcon', () => ({ LinkAlertIcon: () => null }));
vi.mock('../SenderAlertIcon', () => ({ SenderAlertIcon: () => null, getSenderAlertLevel: () => null }));
vi.mock('../ReplyToAlertIcon', () => ({ ReplyToAlertIcon: () => null, getThreadReplyToMismatch: () => false }));
vi.mock('../TrackerAlertIcon', () => ({ TrackerAlertIcon: () => null, getThreadTrackerInfo: () => null }));
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', () => ({ ConnectedStateIcon: () => null, describeMessageState: () => ({ tone: 'local' }) }));
vi.mock('../../utils/linkSafety', () => ({ getLinkAlertLevel: () => null, getAlertsForEmails: () => [], getCachedAlerts: () => [] }));
const mailState = vi.hoisted(() => ({
  serverUids: { complete: false }, activeMailbox: 'UNIFIED', activeAccountId: 'acct-1', unifiedInbox: true,
  accounts: [{ id: 'acct-2', email: 'home@example.com', name: 'Home' }],
}));
vi.mock('../../stores/mailStore', () => {
  const hook = (selector) => (selector ? selector(mailState) : mailState);
  hook.getState = () => mailState;
  return { useMailStore: hook };
});

const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useAccountHoverStore } = await import('../../stores/accountHoverStore');

const email = (uid, extra = {}) => ({
  uid, _accountId: 'acct-2', _accountEmail: 'home@example.com', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Budget', from: { name: 'Padme', address: 'padme@naboo.gov' }, to: [],
  date: `2026-08-0${uid}T10:00:00Z`, flags: ['\\Seen'], ...extra,
});
const render1 = (Row, { unified = true } = {}) => {
  mailState.unifiedInbox = unified;
  const emails = [email(1), email(2)];
  return render(<Row
    thread={{ threadId: 't1', subject: 'Budget', messageCount: 2, emails, lastEmail: emails[1], unreadCount: 0 }}
    isSelected={false} onSelectThread={vi.fn()} onSetSelection={vi.fn()} anyChecked={false} style={{}}
    actions={{ saveEmailsLocally: vi.fn() }} menuOpen={false} onOpenMenu={vi.fn()} onCloseMenu={vi.fn()}
    onRequestDelete={vi.fn()} isSaving={false} onStartSaving={vi.fn()} onStopSaving={vi.fn()} />);
};

beforeEach(() => {
  useSettingsStore.setState({ displayNames: {}, accountColors: {} });
  useAccountHoverStore.setState({ accountId: null });
});
afterEach(cleanup);

describe.each([['ThreadRow', ThreadRow], ['CompactThreadRow', CompactThreadRow]])('%s account badge', (_name, Row) => {
  it('draws the account of the newest message in All inboxes', () => {
    render1(Row);
    const badge = screen.getByTestId('account-dot');
    expect(badge.dataset.accountId).toBe('acct-2');
    expect(badge.getAttribute('title')).toBe('home@example.com');
  });

  it('is absent from a single-account list', () => {
    render1(Row, { unified: false });
    expect(screen.queryByTestId('account-dot')).toBeNull();
  });

  it('lights its account while pointed at and clears it on leaving', () => {
    render1(Row);
    fireEvent.mouseEnter(screen.getByTestId('email-row'));
    expect(useAccountHoverStore.getState().accountId).toBe('acct-2');
    fireEvent.mouseLeave(screen.getByTestId('email-row'));
    expect(useAccountHoverStore.getState().accountId).toBeNull();
  });
});
