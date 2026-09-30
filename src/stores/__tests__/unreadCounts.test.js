// The one owner of the sidebar's per-account unread counts, and the total the
// dock badge shows, which is derived from them and stored nowhere.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';

const settings = create(() => ({
  unreadPerAccount: {},
  hiddenAccounts: {},
  setUnreadForAccount: (id, n) => settings.setState(s => ({ unreadPerAccount: { ...s.unreadPerAccount, [id]: n } })),
  setUnreadPerAccount: (m) => settings.setState({ unreadPerAccount: m }),
}));
vi.mock('../settingsStore', () => ({ useSettingsStore: settings }));
vi.mock('../../services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { useSnoozeStore } = await import('../snoozeStore');
const {
  selectTotalUnread, isCompleteCache, recountInbox, shiftInbox, addArrivals, applyRecounts, forgetAccount,
} = await import('../unreadCounts');

const counts = () => settings.getState().unreadPerAccount;
const unread = (uid, extra = {}) => ({ uid, flags: [], ...extra });
const seen = (uid) => ({ uid, flags: ['\\Seen'] });

beforeEach(() => {
  settings.setState({ unreadPerAccount: { a1: 7, a2: 5 }, hiddenAccounts: {} });
  useSnoozeStore.setState({ rows: [] });
});

describe('the total', () => {
  it('is the sum of the accounts that are not hidden, computed from the counts', () => {
    expect(selectTotalUnread(settings.getState())).toBe(12);
    settings.setState({ hiddenAccounts: { a2: true } });
    expect(selectTotalUnread(settings.getState())).toBe(7);
  });

  it('follows every write of a count', () => {
    shiftInbox([{ accountId: 'a1', mailbox: 'INBOX', row: unread(1) }], -1);
    expect(selectTotalUnread(settings.getState())).toBe(11);
  });

  it('reads a settings object with no hidden map as nothing hidden', () => {
    expect(selectTotalUnread({ unreadPerAccount: { a1: 2 } })).toBe(2);
    expect(selectTotalUnread({})).toBe(0);
  });
});

describe('a recount', () => {
  it('counts a complete cache', () => {
    expect(recountInbox('a1', { emails: [unread(1), seen(2), unread(3)], totalEmails: 3 })).toBe(true);
    expect(counts().a1).toBe(2);
  });

  it('never counts a partial one: the rows it lacks would read as fewer unread', () => {
    expect(isCompleteCache({ emails: [unread(1)], totalEmails: 500 })).toBe(false);
    expect(recountInbox('a1', { emails: [unread(1)], totalEmails: 500 })).toBe(false);
    expect(counts().a1).toBe(7);
  });

  it('never counts a cache it could not read', () => {
    expect(recountInbox('a1', null)).toBe(false);
    expect(counts().a1).toBe(7);
  });

  it('leaves out what a local snooze holds out of the inbox', () => {
    useSnoozeStore.setState({ rows: [{ id: 's', accountId: 'a1', fromMailbox: 'INBOX', snoozedMailbox: '', messageId: '<h@x>', state: 'snoozed' }] });
    recountInbox('a1', { emails: [unread(1, { messageId: '<h@x>' }), unread(2, { messageId: '<b@x>' })], totalEmails: 2 });
    expect(counts().a1).toBe(1);
  });
});

describe('a shift', () => {
  it('moves the INBOX count by one per entry', () => {
    shiftInbox([{ accountId: 'a1', mailbox: 'INBOX', row: unread(1) }, { accountId: 'a2', mailbox: 'INBOX', row: unread(2) }], -1);
    expect(counts()).toEqual({ a1: 6, a2: 4 });
  });

  it('ignores every other folder', () => {
    shiftInbox([{ accountId: 'a1', mailbox: 'Sent', row: unread(1) }, { accountId: 'a1', mailbox: 'Projects/Alpha', row: unread(2) }], -1);
    expect(counts()).toEqual({ a1: 7, a2: 5 });
  });

  it('never goes below zero', () => {
    settings.setState({ unreadPerAccount: { a1: 0 } });
    shiftInbox([{ accountId: 'a1', mailbox: 'INBOX', row: unread(1) }], -1);
    expect(counts().a1).toBe(0);
  });

  it('does not move for a message a local snooze holds out of the inbox: it was never counted', () => {
    useSnoozeStore.setState({ rows: [{ id: 's', accountId: 'a1', fromMailbox: 'INBOX', snoozedMailbox: '', messageId: '<h@x>', state: 'snoozed' }] });
    shiftInbox([{ accountId: 'a1', mailbox: 'INBOX', row: unread(1, { messageId: '<h@x>' }) }], -1);
    expect(counts().a1).toBe(7);
  });
});

describe('the other writers', () => {
  it('adds arrivals to a count it cannot recount', () => {
    addArrivals('a2', 2);
    expect(counts().a2).toBe(7);
  });

  it('merges the counts a refresh measured and keeps the rest', () => {
    applyRecounts({ a2: 1 });
    expect(counts()).toEqual({ a1: 7, a2: 1 });
  });

  it('forgets a removed account', () => {
    forgetAccount('a1');
    expect(counts()).toEqual({ a2: 5 });
  });
});
