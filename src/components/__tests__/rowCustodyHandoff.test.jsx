// @vitest-environment jsdom

// A row plays the custody handoff when its message lands in the vault. Server
// view writes isArchived false on every row it lists, so the row's own flag
// never moves there; the keyed archived set does, and the row reads it by the
// rule the buttons and the status icon use (isRowArchived).
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

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
vi.mock('../RowActionMenu', () => ({ RowActionMenu: () => null }));
vi.mock('../RowActionMenuItems', () => ({ RowActionMenuItems: () => null }));
vi.mock('../RowQuickActions', () => ({ RowQuickActions: () => null }));
vi.mock('../email/MessageStateIcon', async (importOriginal) => ({
  ...(await importOriginal()),
  ConnectedStateIcon: () => null,
}));
vi.mock('../../utils/linkSafety', () => ({
  getLinkAlertLevel: () => null,
  getAlertsForEmails: () => [],
  getCachedAlerts: () => [],
}));
vi.mock('../../stores/mailStore', async () => {
  const { create } = await import('zustand');
  const store = create(() => ({}));
  const hook = (selector) => store(selector || (state => state));
  hook.getState = store.getState;
  hook.setState = store.setState;
  return { useMailStore: hook };
});

const { useMailStore } = await import('../../stores/mailStore');
const { EmailRow, CompactEmailRow } = await import('../EmailRow');
const { ThreadRow, CompactThreadRow } = await import('../ThreadRow');

const email = (uid) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', isArchived: false,
  subject: 'Budget', from: { name: 'Padme', address: 'padme@naboo.gov' },
  date: '2026-08-01T10:00:00Z', flags: ['\\Seen'],
});
const thread = () => {
  const emails = [email(1001), email(1002)];
  return { threadId: 't1', subject: 'Budget', emails, lastEmail: emails[1], messageCount: 2, unreadCount: 0 };
};
const rowProps = {
  isSelected: false, onSelectThread: vi.fn(), onSelect: vi.fn(), onToggleSelection: vi.fn(), onSetSelection: vi.fn(),
  anyChecked: false, isChecked: false, style: {}, actions: { saveEmailsLocally: vi.fn(), saveEmailLocally: vi.fn() },
  menuOpen: false, onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), onRequestDelete: vi.fn(), isSaving: false,
  onStartSaving: vi.fn(), onStopSaving: vi.fn(),
};

const cases = [
  ['EmailRow', () => <EmailRow email={email(1001)} {...rowProps} />, 'acct-1:INBOX:1001'],
  ['CompactEmailRow', () => <CompactEmailRow email={email(1001)} {...rowProps} />, 'acct-1:INBOX:1001'],
  ['ThreadRow', () => <ThreadRow thread={thread()} {...rowProps} />, 'acct-1:INBOX:1002'],
  ['CompactThreadRow', () => <CompactThreadRow thread={thread()} {...rowProps} />, 'acct-1:INBOX:1002'],
];

afterEach(cleanup);

describe('row custody handoff in Server view', () => {
  for (const [name, renderRow, key] of cases) {
    it(`${name} plays the handoff when its message lands in the keyed archived set`, () => {
      useMailStore.setState({
        activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null, unifiedInbox: false, viewMode: 'server',
        serverUids: { uids: new Set(), complete: true }, archivedEmailIds: new Set(),
      }, true);
      const { container } = render(renderRow());
      expect(container.querySelector('[data-landed]')).toBeNull();

      act(() => useMailStore.setState({ archivedEmailIds: new Set([key]) }));
      expect(container.querySelector('[data-landed]')?.getAttribute('data-landed')).toBe('local');
    });
  }
});
