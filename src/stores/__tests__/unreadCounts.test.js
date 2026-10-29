import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const native = vi.fn();
const settings = create((set, get) => ({
  unreadPerAccount: {}, hiddenAccounts: {}, displayNames: {}, accountOrder: [], hideViewMail: false,
  setUnreadPerAccount: counts => set({ unreadPerAccount: counts }),
  setUnreadForAccount: (id, count) => set({ unreadPerAccount: { ...get().unreadPerAccount, [id]: count } }),
}));
vi.mock('../settingsStore', () => ({ useSettingsStore: settings }));
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...args) => native(...args) }));
const { useSnoozeStore } = await import('../snoozeStore');
const { useFollowUpStore } = await import('../followUpStore');
const { useViewHideStore } = await import('../viewHideStore');
const { useTagStore } = await import('../tagStore');
const { useAutoTagStore } = await import('../autoTagStore');
const { setListStore, recountInbox, recountNativeInbox, shiftInbox, shiftFollowUps,
  unreadPresentation, forgetAccount } = await import('../unreadCounts');
const { invalidateUnreadConnection, whenUnreadIdle } = await import('../../services/unreadCountsClient');

const answer = (counts, wrote = true, rows = []) => ({ counts, rows,
  total: rows.reduce((sum, row) => sum + row.unread, 0), wrote });
const row = (uid, flags = []) => ({ uid, flags, messageId: `<m${uid}@example.test>` });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  invalidateUnreadConnection();
  native.mockReset();
  setListStore(null);
  settings.setState({ unreadPerAccount: { a: 7, b: 5 }, hiddenAccounts: {},
    displayNames: {}, accountOrder: [], hideViewMail: false });
  useSnoozeStore.setState({ rows: [] });
  useFollowUpStore.setState({ rows: [] });
  useViewHideStore.setState({ keys: null });
  useTagStore.setState({ byRow: {} });
  useAutoTagStore.setState({ rules: [] });
});

describe('one native unread projection lane', () => {
  it('asks native for presentation and never writes a rows-only response', async () => {
    const accounts = create(() => ({ accounts: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] }));
    setListStore(accounts);
    native.mockResolvedValue(answer({ a: 7, b: 5 }, false,
      [{ id: 'a', label: 'Alpha', unread: 7 }]));
    settings.setState({ hiddenAccounts: { b: true } });
    expect((await unreadPresentation()).total).toBe(7);
    expect(native).toHaveBeenCalledExactlyOnceWith('counts.unread', expect.objectContaining({
      op: 'rows', baseline: { a: 7, b: 5 }, presentation: expect.objectContaining({
        accounts: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], hiddenAccounts: { b: true },
      }),
    }));
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 5 });
  });

  it('keeps a read shift behind a held complete recount with B intact', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(answer({ a: 0, b: 5 }));
    const recount = recountInbox('a', { emails: [row(1), row(2, ['\\Seen'])], totalEmails: 2 });
    const shift = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    expect(native).toHaveBeenCalledTimes(1);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 5 });
    held.resolve(answer({ a: 1, b: 5 }));
    await Promise.all([recount, shift]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountRows', 'shift']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 1, b: 5 });
    expect(settings.getState().unreadPerAccount).toEqual({ a: 0, b: 5 });
  });

  it('passes a partial-cache arrival fallback in the same original-bound request', async () => {
    native.mockResolvedValue(answer({ a: 9, b: 5 }));
    await recountNativeInbox('a', { arrivalCount: 2 });
    const request = native.mock.calls[0][1];
    expect(request).toMatchObject({ op: 'recountCache', accountId: 'a', arrivalCount: 2 });
    expect(request).not.toHaveProperty('cache');
    expect(settings.getState().unreadPerAccount).toEqual({ a: 9, b: 5 });
  });

  it('rebases once when settings hydrate during a held reply', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(answer({ a: 2, b: 9 }));
    const task = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    settings.setState({ unreadPerAccount: { a: 10, b: 9 } });
    held.resolve(answer({ a: 1, b: 5 }));
    await task;
    expect(native.mock.calls.map(call => call[1].baseline)).toEqual([
      { a: 7, b: 5 }, { a: 10, b: 9 },
    ]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 2, b: 9 });
  });

  it('preserves counts after an invalid native answer and serves later work', async () => {
    native.mockResolvedValueOnce({ counts: {}, wrote: true })
      .mockResolvedValueOnce(answer({ a: 7, b: 4 }));
    expect(await recountInbox('a', { emails: [], totalEmails: 0 })).toBe(false);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 5 });
    await shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 4 });
  });

  it('keeps raw reminder transitions ordered behind a held operation', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(answer({ a: 8, b: 5 }))
      .mockResolvedValueOnce(answer({ a: 7, b: 5 }))
      .mockResolvedValueOnce(answer({ a: 8, b: 5 }))
      .mockResolvedValueOnce(answer({ a: 7, b: 5 }));
    const first = recountInbox('a', { emails: [], totalEmails: 0 });
    const reminder = { id: 'r', accountId: 'a', state: 'due', sentMailbox: 'Sent', sentUid: 1, seen: false };
    const due = shiftFollowUps([], [reminder]);
    const seen = shiftFollowUps([reminder], [{ ...reminder, seen: true }]);
    const unread = shiftFollowUps([{ ...reminder, seen: true }], [reminder]);
    const dismissed = shiftFollowUps([reminder], []);
    held.resolve(answer({ a: 7, b: 5 }));
    await Promise.all([first, due, seen, unread, dismissed]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual([
      'recountRows', 'followUps', 'followUps', 'followUps', 'followUps',
    ]);
    expect(native.mock.calls[1][1].after).toEqual([reminder]);
    expect(native.mock.calls[2][1].before).toEqual([reminder]);
    expect(native.mock.calls[3][1]).toMatchObject({ before: [{ ...reminder, seen: true }], after: [reminder] });
    expect(native.mock.calls[4][1]).toMatchObject({ before: [reminder], after: [] });
    expect(native.mock.calls.map(call => call[1].baseline.a)).toEqual([7, 7, 8, 7, 8]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 5 });
  });

  it('retains read, delete and undo shifts behind a held partial recount', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: Math.max(0, request.baseline.a + request.sign) })));
    const recount = recountInbox('a', { emails: [row(1)], totalEmails: 500 });
    const read = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    const deleted = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(2) }], -1, 'unreadOnly');
    const undo = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(2) }], 1, 'unreadOnly');
    held.resolve(answer({ a: 7, b: 5 }, false));
    expect(await recount).toBe(false);
    expect(await Promise.all([read, deleted, undo])).toEqual([true, true, true]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountRows', 'shift', 'shift', 'shift']);
    expect(native.mock.calls.map(call => call[1].baseline.a)).toEqual([7, 7, 6, 5]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 6, b: 5 });
  });

  it('does not double-decrement when a held cache read sees the persisted read flag', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: Math.max(0, request.baseline.a - 1) })))
      .mockResolvedValueOnce({ ...answer({ a: 1, b: 5 }), recountSource: 'complete' });
    const cacheRead = recountNativeInbox('a');
    const localRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    held.resolve({ ...answer({ a: 1, b: 5 }), recountSource: 'complete' }); // native cache already contains Seen
    await Promise.all([cacheRead, localRead]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountCache', 'shift', 'recountCache']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 2, b: 5 });
    expect(native.mock.calls[2][1]).toMatchObject({ op: 'recountCache', accountId: 'a' });
    expect(native.mock.calls[2][1]).not.toHaveProperty('arrivalCount');
    expect(settings.getState().unreadPerAccount, 'W4S3_POST_FLAG_READ_RED').toEqual({ a: 1, b: 5 });
  });

  it('repairs a held complete pre-flag cache result after the raw local read', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => Promise.resolve(request.op === 'shift'
        ? answer({ ...request.baseline, a: Math.max(0, request.baseline.a - 1) })
        : { ...answer({ a: 2, b: 5 }), recountSource: 'complete' }));
    const combined = recountNativeInbox('a', { arrivalCount: 1 });
    const localRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    held.resolve({ ...answer({ a: 3, b: 5 }), recountSource: 'complete' }); // arrival reached cache; Seen had not
    await Promise.all([combined, localRead]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountCache', 'shift', 'recountCache']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 2, b: 5 });
    expect(native.mock.calls[2][1]).toMatchObject({ op: 'recountCache', accountId: 'a' });
    expect(native.mock.calls[2][1]).not.toHaveProperty('arrivalCount');
    expect(settings.getState().unreadPerAccount, 'W4S3_COMBINED_OLD_RED').toEqual({ a: 2, b: 5 });
  });

  it('repairs a held complete post-flag cache result without double-applying the raw local read', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => Promise.resolve(request.op === 'shift'
        ? answer({ ...request.baseline, a: Math.max(0, request.baseline.a - 1) })
        : { ...answer({ a: 2, b: 5 }), recountSource: 'complete' }));
    const combined = recountNativeInbox('a', { arrivalCount: 1 });
    const localRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    held.resolve({ ...answer({ a: 2, b: 5 }), recountSource: 'complete' }); // arrival and Seen both reached cache
    await Promise.all([combined, localRead]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountCache', 'shift', 'recountCache']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 2, b: 5 });
    expect(native.mock.calls[2][1]).not.toHaveProperty('arrivalCount');
    expect(settings.getState().unreadPerAccount, 'W4S3_COMBINED_POST_RED').toEqual({ a: 2, b: 5 });
  });

  it('retains a held partial-cache arrival fallback before the later negative shift', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: Math.max(0, request.baseline.a - 1) })));
    const combined = recountNativeInbox('a', { arrivalCount: 1 });
    const localRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1, 'changedReadState');
    held.resolve({ ...answer({ a: 3, b: 5 }), recountSource: 'arrivalFallback' });
    await Promise.all([combined, localRead]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountCache', 'shift']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 3, b: 5 });
    expect(settings.getState().unreadPerAccount).toEqual({ a: 2, b: 5 });
  });

  it('keeps valid shifts and B when the fresh complete-cache repair fails', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => {
        if (request.op === 'recountCache') return Promise.reject(new Error('cache unavailable'));
        const target = request.entries[0].accountId;
        return Promise.resolve(answer({ ...request.baseline,
          [target]: Math.max(0, request.baseline[target] - 1) }));
      });
    const combined = recountNativeInbox('a', { arrivalCount: 1 });
    const aRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    const bRead = shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
    held.resolve({ ...answer({ a: 3, b: 5 }), recountSource: 'complete' });
    await Promise.all([combined, aRead, bRead]);
    await whenUnreadIdle();
    expect(native.mock.calls.map(call => call[1].op)).toEqual([
      'recountCache', 'shift', 'shift', 'recountCache',
    ]);
    expect(settings.getState().unreadPerAccount,
      'W4S3_FRESH_FAILURE_RED old complete answer must not overwrite valid shifts').toEqual({ a: 1, b: 4 });
  });

  it('does not rebind a fresh repair to replacement A while B remains valid', async () => {
    const original = { id: 'a', imapHost: 'one.example.test' };
    const replacement = { id: 'a', imapHost: 'two.example.test' };
    const accounts = create(() => ({ accounts: [original, { id: 'b', imapHost: 'b.example.test' }] }));
    setListStore(accounts);
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => {
        const target = request.entries?.[0]?.accountId;
        if (target === 'a') accounts.setState({ accounts: [replacement, { id: 'b', imapHost: 'b.example.test' }] });
        return Promise.resolve(answer({ ...request.baseline,
          ...(target ? { [target]: Math.max(0, request.baseline[target] - 1) } : {}) }));
      });
    const combined = recountNativeInbox('a', { arrivalCount: 1 });
    const aRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    const bRead = shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
    held.resolve({ ...answer({ a: 3, b: 5 }), recountSource: 'complete' });
    await Promise.all([combined, aRead, bRead]);
    await whenUnreadIdle();
    expect(native.mock.calls.filter(call => call[1].op === 'recountCache')).toHaveLength(1);
    expect(settings.getState().unreadPerAccount,
      'W4S3_FRESH_SOURCE_RED old A must not publish or authorize a new-owner repair').toEqual({ a: 2, b: 4 });
  });

  it('repairs unrelated cache changes after superseding a pure held read', async () => {
    settings.setState({ unreadPerAccount: { a: 2, b: 5 } });
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementation((_, request) => Promise.resolve(request.op === 'shift'
        ? answer({ ...request.baseline, a: Math.max(0, request.baseline.a - 1) })
        : answer({ a: 3, b: 5 })));
    const cacheRead = recountNativeInbox('a');
    const localRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    held.resolve(answer({ a: 3, b: 5 })); // two unrelated arrivals and local Seen are in the old aggregate
    await Promise.all([cacheRead, localRead]);
    await whenUnreadIdle();
    expect(native.mock.calls.map(call => call[1].op)).toEqual(['recountCache', 'shift', 'recountCache']);
    expect(native.mock.calls[1][1].baseline).toEqual({ a: 2, b: 5 });
    expect(settings.getState().unreadPerAccount,
      'W4S3_PURE_REPAIR_RED fresh cache must recover unrelated changes').toEqual({ a: 3, b: 5 });
  });

  it('drops a fresh repair overtaken by another raw shift without starting a second repair', async () => {
    settings.setState({ unreadPerAccount: { a: 3, b: 5 } });
    const held = deferred();
    const fresh = deferred();
    const freshStarted = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: request.baseline.a - 1 })))
      .mockImplementationOnce(() => { freshStarted.resolve(); return fresh.promise; })
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: request.baseline.a - 1 })));
    const cacheRead = recountNativeInbox('a');
    const firstRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    held.resolve({ ...answer({ a: 2, b: 5 }), recountSource: 'complete' });
    await firstRead;
    expect(native.mock.calls.map(call => call[1].op), 'W4S3_FRESH_OVERTAKEN_RED').toEqual([
      'recountCache', 'shift', 'recountCache',
    ]);
    await freshStarted.promise;
    const secondRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(2) }], -1);
    fresh.resolve({ ...answer({ a: 1, b: 5 }), recountSource: 'complete' });
    await Promise.all([cacheRead, secondRead]);
    await whenUnreadIdle();
    expect(native.mock.calls.map(call => call[1].op)).toEqual([
      'recountCache', 'shift', 'recountCache', 'shift',
    ]);
    expect(native.mock.calls[3][1].baseline).toEqual({ a: 2, b: 5 });
    expect(settings.getState().unreadPerAccount).toEqual({ a: 1, b: 5 });
  });

  it('refuses a held fresh repair after original A changes while B keeps moving', async () => {
    const original = { id: 'a', imapHost: 'one.example.test' };
    const replacement = { id: 'a', imapHost: 'two.example.test' };
    const accounts = create(() => ({ accounts: [original, { id: 'b', imapHost: 'b.example.test' }] }));
    setListStore(accounts);
    settings.setState({ unreadPerAccount: { a: 3, b: 5 } });
    const held = deferred();
    const fresh = deferred();
    const freshStarted = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        a: request.baseline.a - 1 })))
      .mockImplementationOnce(() => { freshStarted.resolve(); return fresh.promise; })
      .mockImplementationOnce((_, request) => Promise.resolve(answer({ ...request.baseline,
        b: request.baseline.b - 1 })));
    const cacheRead = recountNativeInbox('a');
    const aRead = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    held.resolve({ ...answer({ a: 2, b: 5 }), recountSource: 'complete' });
    await aRead;
    expect(native.mock.calls.map(call => call[1].op), 'W4S3_FRESH_SOURCE_HELD_RED').toEqual([
      'recountCache', 'shift', 'recountCache',
    ]);
    await freshStarted.promise;
    const bRead = shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
    accounts.setState({ accounts: [replacement, { id: 'b', imapHost: 'b.example.test' }] });
    fresh.resolve({ ...answer({ a: 0, b: 5 }), recountSource: 'complete' });
    await Promise.all([cacheRead, bRead]);
    await whenUnreadIdle();
    expect(native.mock.calls.map(call => call[1].op)).toEqual([
      'recountCache', 'shift', 'recountCache', 'shift',
    ]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 2, b: 4 });
  });

  it('preserves arrival-before-shift order at zero', async () => {
    settings.setState({ unreadPerAccount: { a: 0, b: 5 } });
    native.mockImplementation((_, request) => Promise.resolve({
      ...answer({ ...request.baseline,
        a: request.op === 'shift' ? Math.max(0, request.baseline.a - 1) : request.baseline.a + 1 }),
      ...(request.op === 'recountCache' ? { recountSource: 'arrivalFallback' } : {}),
    }));
    const arrival = recountNativeInbox('a', { arrivalCount: 1 });
    const shift = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    await Promise.all([arrival, shift]);
    expect(native.mock.calls.map(call => call[1].baseline.a)).toEqual([0, 1]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 0, b: 5 });

    native.mockClear();
    const shiftedFirst = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    const arrivedSecond = recountNativeInbox('a', { arrivalCount: 1 });
    await Promise.all([shiftedFirst, arrivedSecond]);
    expect(native.mock.calls.map(call => call[1].baseline.a)).toEqual([0, 0]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 1, b: 5 });
  });

  it('leaves A untouched after a rejected native answer and still publishes B', async () => {
    native.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(answer({ a: 7, b: 4 }));
    const failed = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    const b = shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
    expect(await Promise.all([failed, b])).toEqual([false, true]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 4 });
  });

  it('coalesces only adjacent pending pure recounts of the same target', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(answer({ a: 2, b: 5 }));
    const first = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    const old = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    const latest = recountInbox('a', { emails: [row(1), row(2)], totalEmails: 2 });
    held.resolve(answer({ a: 6, b: 5 }));
    await Promise.all([first, old, latest]);
    expect(native.mock.calls).toHaveLength(2);
    expect(native.mock.calls[1][1]).toMatchObject({ op: 'recountRows', accountId: 'a',
      cache: { totalEmails: 2 } });
    expect(settings.getState().unreadPerAccount).toEqual({ a: 2, b: 5 });
  });

  it('latches a source replacement while the native reply is held', async () => {
    const accounts = create(() => ({ accounts: [{ id: 'a', imapHost: 'one.example.test' }] }));
    setListStore(accounts);
    const held = deferred();
    native.mockImplementationOnce(() => held.promise);
    const task = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    accounts.setState({ accounts: [{ id: 'a', imapHost: 'two.example.test' }] });
    accounts.setState({ accounts: [{ id: 'a', imapHost: 'one.example.test' }] });
    held.resolve(answer({ a: 1, b: 5 }));
    expect(await task).toBe(false);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 5 });
  });

  it('forgets only the account that native removal confirmed', async () => {
    native.mockResolvedValue(answer({ b: 5 }));
    await forgetAccount('a');
    expect(native.mock.calls[0][1]).toMatchObject({ op: 'merge', kind: 'forget', accountId: 'a' });
    expect(settings.getState().unreadPerAccount).toEqual({ b: 5 });
  });

  it('does not coalesce a recount across an arrival or shift barrier', async () => {
    const held = deferred();
    native.mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(answer({ a: 2, b: 5 }))
      .mockResolvedValueOnce({ ...answer({ a: 4, b: 5 }), recountSource: 'arrivalFallback' })
      .mockResolvedValueOnce(answer({ a: 3, b: 5 }));
    const first = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    const before = recountInbox('a', { emails: [row(1), row(2)], totalEmails: 2 });
    const arrival = recountNativeInbox('a', { arrivalCount: 2 });
    const after = shiftInbox([{ accountId: 'a', mailbox: 'INBOX', row: row(1) }], -1);
    held.resolve(answer({ a: 1, b: 5 }));
    await Promise.all([first, before, arrival, after]);
    expect(native.mock.calls.map(call => call[1].op)).toEqual([
      'recountRows', 'recountRows', 'recountCache', 'shift',
    ]);
    expect(native.mock.calls.map(call => call[1].baseline.a)).toEqual([7, 1, 2, 4]);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 3, b: 5 });
  });

  it('lets harmless object hydration publish but drops a late reconnect answer', async () => {
    const accounts = create(() => ({ accounts: [{ id: 'a', imapHost: 'one.example.test', name: 'Old' }] }));
    setListStore(accounts);
    const first = deferred();
    native.mockImplementationOnce(() => first.promise);
    const hydration = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
    accounts.setState({ accounts: [{ id: 'a', imapHost: 'one.example.test', name: 'New' }] });
    first.resolve(answer({ a: 1, b: 5 }));
    expect(await hydration).toBe(true);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 1, b: 5 });

    const late = deferred();
    native.mockImplementationOnce(() => late.promise);
    const task = recountInbox('a', { emails: [], totalEmails: 0 });
    invalidateUnreadConnection();
    late.resolve(answer({ a: 0, b: 5 }));
    expect(await task).toBe(false);
    expect(settings.getState().unreadPerAccount).toEqual({ a: 1, b: 5 });
  });

  it('bounds a held native answer and keeps later B work live', async () => {
    vi.useFakeTimers();
    try {
      native.mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(answer({ a: 7, b: 4 }));
      const stalled = recountInbox('a', { emails: [row(1)], totalEmails: 1 });
      const later = shiftInbox([{ accountId: 'b', mailbox: 'INBOX', row: row(2) }], -1);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await stalled).toBe(false);
      expect(await later).toBe(true);
      expect(settings.getState().unreadPerAccount).toEqual({ a: 7, b: 4 });
    } finally { vi.useRealTimers(); }
  });
});
