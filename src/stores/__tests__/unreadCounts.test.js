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
const { useFollowUpStore } = await import('../followUpStore');
const {
  selectTotalUnread, unreadRows, isCompleteCache, recountInbox, shiftInbox, addArrivals, applyRecounts, forgetAccount,
  shiftFollowUps,
} = await import('../unreadCounts');

const counts = () => settings.getState().unreadPerAccount;
const unread = (uid, extra = {}) => ({ uid, flags: [], ...extra });
const seen = (uid) => ({ uid, flags: ['\\Seen'] });

beforeEach(() => {
  settings.setState({ unreadPerAccount: { a1: 7, a2: 5 }, hiddenAccounts: {}, displayNames: {}, getOrderedAccounts: undefined });
  useSnoozeStore.setState({ rows: [] });
  useFollowUpStore.setState({ rows: [] });
});

describe('the total', () => {
  const accounts = [{ id: 'a1', email: 'one@example.com' }, { id: 'a2', email: 'two@example.com' }];

  it('is the sum of the accounts that are not hidden, computed from the counts', () => {
    expect(selectTotalUnread(settings.getState(), accounts)).toBe(12);
    settings.setState({ hiddenAccounts: { a2: true } });
    expect(selectTotalUnread(settings.getState(), accounts)).toBe(7);
  });

  it('follows every write of a count', () => {
    shiftInbox([{ accountId: 'a1', mailbox: 'INBOX', row: unread(1) }], -1);
    expect(selectTotalUnread(settings.getState(), accounts)).toBe(11);
  });

  it('reads a settings object with no hidden map as nothing hidden', () => {
    expect(selectTotalUnread({ unreadPerAccount: { a1: 2 } }, accounts)).toBe(2);
    expect(selectTotalUnread({}, accounts)).toBe(0);
  });

  // A count left behind by an account that is gone still counted on the dock.
  // The badge sums the rows the sidebar shows, no more.
  it('counts no account the sidebar does not show', () => {
    settings.setState({ unreadPerAccount: { a1: 7, a2: 5, gone: 10 } });
    expect(selectTotalUnread(settings.getState(), accounts)).toBe(12);
    expect(selectTotalUnread(settings.getState(), [])).toBe(0);
  });
});

describe('the rows', () => {
  it('are the sidebar accounts in its order, labelled as it labels them, hidden ones left out', () => {
    settings.setState({
      unreadPerAccount: { a1: 7, a2: 5, a3: 1 },
      hiddenAccounts: { a3: true },
      displayNames: { a2: 'Work' },
      getOrderedAccounts: (list) => [...list].reverse(),
    });
    const list = [
      { id: 'a1', name: 'Me', email: 'one@example.com' },
      { id: 'a2', email: 'two@example.com' },
      { id: 'a3', email: 'three@example.com' },
      { id: 'a4', email: 'four@example.com' },
    ];
    expect(unreadRows(settings.getState(), list)).toEqual([
      { id: 'a4', label: 'four@example.com', unread: 0 },
      { id: 'a2', label: 'Work', unread: 5 },
      { id: 'a1', label: 'Me', unread: 7 },
    ]);
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

// A due follow-up reminder is an unread row at the top of the inbox: the
// account's number has to agree with the list.
describe('follow-up reminders', () => {
  const due = (id, accountId, extra = {}) => ({ id, accountId, state: 'due', sentMailbox: 'Sent', sentUid: 9, seen: false, ...extra });

  it('a recount counts an unread due reminder of that account', () => {
    useFollowUpStore.setState({ rows: [
      due('r1', 'a1'),
      due('read', 'a1', { seen: true }),
      due('waiting', 'a1', { state: 'waiting' }),
      due('other', 'a2'),
    ] });
    recountInbox('a1', { emails: [unread(1), seen(2)], totalEmails: 2 });
    expect(counts().a1).toBe(2);
  });

  it('a reminder going due, read or dismissed moves its account by one', () => {
    const before = [due('r1', 'a1', { state: 'waiting' })];
    const dueNow = [due('r1', 'a1')];
    shiftFollowUps(before, dueNow);
    expect(counts().a1).toBe(8);
    shiftFollowUps(dueNow, [due('r1', 'a1', { seen: true })]);
    expect(counts().a1).toBe(7);
    shiftFollowUps([due('r1', 'a1', { seen: true })], [due('r1', 'a1')]);
    expect(counts().a1).toBe(8); // marked unread again
    shiftFollowUps(dueNow, []);
    expect(counts().a1).toBe(7);
    expect(counts().a2).toBe(5);
  });

  // The counts outlive the app; the reminder rows are read again at launch.
  it('a launch does not count again a reminder an earlier session announced', () => {
    shiftFollowUps([], [due('old', 'a1', { announced: true })]);
    expect(counts().a1).toBe(7);
    shiftFollowUps([], [due('new', 'a1', { announced: false })]);
    expect(counts().a1).toBe(8);
  });
});
