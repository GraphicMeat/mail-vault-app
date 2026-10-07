// @vitest-environment jsdom
//
// Due follow-up reminders are pinned above the inbox list, never rows of it.
// A pinned row opens the Sent message the way the Sent folder would and marks
// the reminder read; its own x dismisses the reminder and opens nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

const mockDaemonCall = vi.fn().mockResolvedValue({});
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));

const selectEmail = vi.fn().mockResolvedValue(undefined);
const ACCOUNTS = [{ id: 'acct-1', email: 'me@one.co' }, { id: 'acct-2', email: 'me@two.co' }];
const mail = create(() => ({
  accounts: ACCOUNTS,
  activeAccountId: 'acct-1', activeMailbox: 'INBOX', unifiedFolder: null, mailboxScope: null,
  selectedEmailId: null, selectEmail: (...a) => selectEmail(...a),
}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign((s) => mail(s), { getState: () => mail.getState(), setState: (p) => mail.setState(p) }),
}));
const settings = create(() => ({ hiddenAccounts: {}, timeFormat: '24h', notificationSettings: {} }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((s) => settings(s), { getState: () => settings.getState() }),
}));

const { useFollowUpStore } = await import('../../stores/followUpStore');
const { FollowUpPinnedRows } = await import('../FollowUpPinnedRows');

const DUE = {
  id: 'f1', accountId: 'acct-1', messageId: '<asked@me>', subject: 'Quote?', recipients: 'ana@x.co',
  sentAt: Date.UTC(2026, 8, 1), remindAt: Date.UTC(2026, 8, 4), state: 'due',
  sentMailbox: 'Sent', sentUid: 77, seen: false, announced: true,
};

beforeEach(() => {
  mockDaemonCall.mockClear();
  selectEmail.mockClear();
  mail.setState({ accounts: ACCOUNTS, activeAccountId: 'acct-1', activeMailbox: 'INBOX', unifiedFolder: null, mailboxScope: null, selectedEmailId: null });
  useFollowUpStore.setState({ rows: [DUE, { ...DUE, id: 'w', state: 'waiting', sentUid: null }] });
});
afterEach(cleanup);

describe('pinned follow-up reminders', () => {
  it('pins each due reminder of the inbox, unread, naming who it went to', () => {
    render(<FollowUpPinnedRows />);
    const rows = screen.getAllByTestId('follow-up-pinned-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Quote?');
    expect(rows[0].textContent).toContain('ana@x.co');
    expect(rows[0].getAttribute('data-unread')).toBe('true');
  });

  it('opens the Sent message as the Sent folder would, and marks the reminder read', async () => {
    render(<FollowUpPinnedRows />);
    fireEvent.click(screen.getByTestId('follow-up-pinned-row'));
    expect(selectEmail).toHaveBeenCalledWith('acct-1:Sent:77', 'server', 'Sent', null,
      expect.objectContaining({ uid: 77, _accountId: 'acct-1', _mailbox: 'Sent' }));
    await waitFor(() => expect(mockDaemonCall).toHaveBeenCalledWith('follow_up.mark_seen', { id: 'f1', seen: true }));
    expect(screen.getByTestId('follow-up-pinned-row').getAttribute('data-unread')).toBe('false');
  });

  it('its x dismisses the reminder and opens nothing', async () => {
    render(<FollowUpPinnedRows />);
    const dismiss = screen.getByTestId('follow-up-dismiss');
    expect(dismiss.getAttribute('aria-label')).toBeTruthy();
    fireEvent.click(dismiss);
    await waitFor(() => expect(mockDaemonCall).toHaveBeenCalledWith('follow_up.dismiss', { id: 'f1' }));
    expect(selectEmail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('follow-up-pinned-row')).toBeNull();
  });

  it('pins nothing outside an inbox, or while searching', () => {
    mail.setState({ activeMailbox: 'Sent' });
    const { rerender } = render(<FollowUpPinnedRows />);
    expect(screen.queryByTestId('follow-up-pinned-row')).toBeNull();
    mail.setState({ activeMailbox: 'INBOX' });
    rerender(<FollowUpPinnedRows hidden />);
    expect(screen.queryByTestId('follow-up-pinned-row')).toBeNull();
  });

  it('pins every visible account\'s in All inboxes', () => {
    mail.setState({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' });
    useFollowUpStore.setState({ rows: [DUE, { ...DUE, id: 'f2', accountId: 'acct-2', sentUid: 5 }] });
    render(<FollowUpPinnedRows />);
    expect(screen.getAllByTestId('follow-up-pinned-row')).toHaveLength(2);
  });
});

describe('pinned rows from the keyboard', () => {
  it('Enter or Space on the row opens the Sent message', () => {
    for (const key of ['Enter', ' ']) {
      selectEmail.mockClear();
      render(<FollowUpPinnedRows />);
      fireEvent.keyDown(screen.getByTestId('follow-up-pinned-row'), { key });
      expect(selectEmail).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  // The x is a button inside the row: its own Enter or Space is its click
  // (the browser's), and must not reach the row and open the message.
  it('Enter or Space on the x does not open the message', () => {
    render(<FollowUpPinnedRows />);
    for (const key of ['Enter', ' ']) {
      const event = fireEvent.keyDown(screen.getByTestId('follow-up-dismiss'), { key });
      expect(event).toBe(true);
    }
    expect(selectEmail).not.toHaveBeenCalled();
  });
});

describe('a pinned row reads like the rows under it', () => {
  it('has two lines: who it went to and when it came back, then the subject', () => {
    render(<FollowUpPinnedRows />);
    const row = screen.getByTestId('follow-up-pinned-row');
    const to = screen.getByTestId('follow-up-pinned-to');
    const when = screen.getByTestId('follow-up-pinned-time');
    const subject = screen.getByTestId('follow-up-pinned-subject');
    expect(to.textContent).toContain('ana@x.co');
    expect(subject.textContent).toBe('Quote?');
    // Line one holds the recipient and the time; the subject is a line of its own.
    expect(to.parentElement).toBe(when.parentElement);
    expect(subject.parentElement).not.toBe(to.parentElement);
    expect(row.contains(screen.getByTestId('follow-up-dismiss'))).toBe(true);
    expect(subject.className).toContain('font-semibold');
    fireEvent.click(row);
    expect(screen.getByTestId('follow-up-pinned-subject').className).not.toContain('font-semibold');
  });
});

describe('a reminder of an account that is gone', () => {
  it('is not pinned, in its inbox or in All inboxes', () => {
    mail.setState({ accounts: [ACCOUNTS[1]] });
    const { rerender } = render(<FollowUpPinnedRows />);
    expect(screen.queryByTestId('follow-up-pinned-row')).toBeNull();
    mail.setState({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' });
    rerender(<FollowUpPinnedRows />);
    expect(screen.queryByTestId('follow-up-pinned-row')).toBeNull();
  });
});
