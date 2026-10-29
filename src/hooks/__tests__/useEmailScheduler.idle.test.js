// @vitest-environment jsdom
// The live side of the S4 cutover. The 66-case immutable archived replay keeps
// the former JS owner executable; these assertions cover the new thin feed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { create } from 'zustand';

const invoke = vi.fn(async () => {});
window.__TAURI__ = { core: { invoke: (...args) => invoke(...args) } };
const listeners = new Map();
const listenerOrder = [];
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, cb) => {
  listenerOrder.push(name);
  listeners.set(name, cb);
  return () => listeners.delete(name);
} }));

const loadEmails = vi.fn(async () => {});
const loadUnifiedInbox = vi.fn(async () => {});
const loadSubtree = vi.fn(async () => {});
const A = { id: 'a', email: 'a@test', imapHost: 'imap.test' };
const B = { id: 'b', email: 'b@test', imapHost: 'imap.test' };
const mail = create(() => ({ accounts: [A, B], activeAccountId: 'a', activeMailbox: 'INBOX',
  unifiedInbox: false, unifiedFolder: 'INBOX', mailboxScope: null, emails: [], totalEmails: 0,
  loadEmails, loadUnifiedInbox, loadSubtree, refreshAllAccounts: vi.fn(async () => ({})) }));
const facade = Object.assign(selector => mail(selector), {
  getState: () => mail.getState(), setState: value => mail.setState(value),
  subscribe: listener => mail.subscribe(listener),
});
vi.mock('../../stores/mailStore', () => ({ useMailStore: facade }));
vi.mock('../../stores/accountStore', () => ({ useAccountStore: facade }));
vi.mock('../../stores/messageListStore', () => ({ useMessageListStore: facade }));

const settings = create(() => ({ badgeEnabled: false, badgeMode: 'unread', unreadPerAccount: {},
  hiddenAccounts: {}, displayNames: {}, accountOrder: [], setLastRefreshTime: vi.fn() }));
const settingsFacade = Object.assign(selector => settings(selector), { getState: () => settings.getState() });
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: settingsFacade }));
const snoozes = create(() => ({ rows: [] }));
const hidden = create(() => ({ keys: null }));
vi.mock('../../stores/snoozeStore', () => ({ useSnoozeStore: snoozes }));
vi.mock('../../stores/viewHideStore', () => ({ useViewHideStore: hidden }));

const recount = vi.fn(async () => {});
const unreadPresentation = vi.fn(async () => ({ total: 0, rows: [] }));
vi.mock('../../stores/unreadCounts', () => ({ recountNativeInbox: (...args) => recount(...args),
  unreadPresentation: (...args) => unreadPresentation(...args) }));
const invalidateUnread = vi.fn();
const invalidateRestore = vi.fn();
vi.mock('../../services/unreadCountsClient', () => ({ invalidateUnreadConnection: () => invalidateUnread() }));
vi.mock('../../services/cacheManager', () => ({ invalidateRestoreDescriptors: (...args) => invalidateRestore(...args) }));
vi.mock('../../services/db/accounts', () => ({ accountExpectedContext: account => ({
  id: account.id, email: account.email,
}) }));

const polls = [];
const waitForSyncChanges = vi.fn((since, timeout) => new Promise(resolve => polls.push({ since, timeout, resolve })));
vi.mock('../../services/syncService', () => ({ waitForSyncChanges: (...args) => waitForSyncChanges(...args) }));
let instance = 'native-1';
const connect = vi.fn(async () => ({ instanceId: instance }));
const observe = vi.fn(async () => {});
vi.mock('../../services/nativeSyncContext.js', () => ({
  connectNativeSync: (...args) => connect(...args), observeNativeView: (...args) => observe(...args),
  currentNativeView: () => ({ accountId: mail.getState().activeAccountId, mailbox: mail.getState().activeMailbox }),
  nativeInstanceId: () => instance,
}));
const deliver = vi.fn(async () => {});
const offer = vi.fn();
vi.mock('../../services/nativeArrival.js', () => ({
  deliverPreparedNotice: (...args) => deliver(...args), offerPreparedCode: (...args) => offer(...args),
}));
const viewCounts = vi.fn();
const notesReload = vi.fn();
const noteFlags = vi.fn();
vi.mock('../../stores/viewStore', () => ({ scheduleViewCountsRefresh: (...args) => viewCounts(...args) }));
vi.mock('../../stores/notesStore', () => ({ scheduleNotesReload: (...args) => notesReload(...args),
  useNotesStore: { getState: () => ({ rereadCopyFlags: (...args) => noteFlags(...args) }) } }));
vi.mock('../../services/workflows/replayOps', () => ({ replayOps: vi.fn(async () => {}),
  wireReplayOnReconnect: vi.fn() }));

const { useEmailScheduler } = await import('../useEmailScheduler.js');
const tick = async () => { await act(async () => { await Promise.resolve(); }); };
const nextPoll = async () => {
  await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
  return polls.shift();
};
const ready = async () => {
  await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(viewCounts).toHaveBeenCalled());
  await vi.waitFor(() => expect(notesReload).toHaveBeenCalled());
};
const answer = async value => {
  const poll = await nextPoll();
  await act(async () => { poll.resolve({ instanceId: instance, resyncRequired: false, ...value }); });
  return poll;
};
const source = account => ({ accountId: account, mailbox: 'INBOX', sourceRef: `${account}-owner`,
  newEmails: 1, updatedFlags: 0, gen: 1, at: 1 });

beforeEach(() => {
  listeners.clear(); listenerOrder.length = 0; polls.length = 0;
  instance = 'native-1';
  mail.setState({ accounts: [A, B], activeAccountId: 'a', activeMailbox: 'INBOX',
    unifiedInbox: false, unifiedFolder: 'INBOX', mailboxScope: null, emails: [], totalEmails: 0 });
  settings.setState({ badgeEnabled: false, badgeMode: 'unread', unreadPerAccount: {},
    hiddenAccounts: {}, displayNames: {}, accountOrder: [] });
  loadEmails.mockClear(); loadUnifiedInbox.mockClear(); loadSubtree.mockClear();
  connect.mockClear(); observe.mockClear(); recount.mockClear(); deliver.mockClear(); offer.mockClear();
  invalidateUnread.mockClear(); invalidateRestore.mockClear();
  viewCounts.mockClear(); notesReload.mockClear(); noteFlags.mockClear();
  invoke.mockClear(); waitForSyncChanges.mockClear();
});
afterEach(() => { cleanup(); });

describe('S4 native change feed consumer', () => {
  it('installs typed, reconnect and lag listeners before context attachment and first poll', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    expect(listenerOrder).toEqual(['notify', 'code-ready', 'daemon-reconnected', 'daemon-events-lagged']);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(waitForSyncChanges).toHaveBeenCalledWith(null, 25000);
    expect(invalidateUnread).toHaveBeenCalled();
  });

  it('repaints once per reply, recounts flags and uses native prepared notices', async () => {
    mail.setState({ activeMailbox: 'INBOX' });
    renderHook(() => useEmailScheduler());
    await ready(); loadEmails.mockClear(); recount.mockClear(); viewCounts.mockClear(); notesReload.mockClear();
    const change = { ...source('a'), updatedFlags: 1 };
    const notice = { id: 'n1', accountId: 'a', sourceRef: 'a-owner', instanceId: instance };
    await answer({ gen: 1, changes: [change, change], notifications: [notice] });
    await vi.waitFor(() => expect(loadEmails).toHaveBeenCalledTimes(1));
    expect(loadEmails).toHaveBeenCalledWith({ rereadFlags: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(notice);
    expect(recount).toHaveBeenCalledWith('a', expect.objectContaining({ arrivalCount: 1 }));
    expect(noteFlags).toHaveBeenCalledWith('a', 'INBOX');
    expect(viewCounts).toHaveBeenCalledTimes(1);
    expect(notesReload).toHaveBeenCalledTimes(1);
  });

  it('buffers a typed event until its source reply, then rejects replacement context', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    const first = { id: 'n1', accountId: 'a', sourceRef: 'a-owner', instanceId: instance };
    listeners.get('notify')({ payload: first });
    expect(deliver).not.toHaveBeenCalled();
    await answer({ gen: 1, changes: [source('a')], notifications: [] });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(first));
    mail.setState({ accounts: [{ ...A, email: 'replacement@test' }, B] });
    listeners.get('notify')({ payload: { ...first, id: 'late' } });
    listeners.get('code-ready')({ payload: { ...first, code: '123456', uid: 2 } });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(offer).not.toHaveBeenCalled();
  });

  for (const scenario of [
    { name: 'replacement', change: () => mail.setState({ accounts: [{ ...A, email: 'changed@test' }, B] }), stale: true },
    { name: 'remove and readd', change: () => {
      mail.setState({ accounts: [B] }); mail.setState({ accounts: [A, B] });
    }, stale: true },
    { name: 'away and back', change: () => {
      mail.setState({ accounts: [{ ...A, email: 'changed@test' }, B] });
      mail.setState({ accounts: [A, B] });
    }, stale: true },
    { name: 'harmless hydration', change: () => mail.setState({ accounts: [{ ...A, name: 'Renamed' }, B] }), stale: false },
  ]) {
    it(`keeps B's live change while a held A poll sees ${scenario.name}`, async () => {
      renderHook(() => useEmailScheduler());
      await ready(); recount.mockClear(); deliver.mockClear();
      const first = source('a');
      const second = { ...source('b'), gen: 2 };
      scenario.change();
      await answer({ gen: 2, changes: [first, second], notifications: [
        { id: 'old-a', accountId: 'a', sourceRef: 'a-owner', instanceId: instance },
        { id: 'live-b', accountId: 'b', sourceRef: 'b-owner', instanceId: instance },
      ] });
      await vi.waitFor(() => expect(recount.mock.calls.some(([id]) => id === 'b')).toBe(true));
      expect(recount.mock.calls.some(([id]) => id === 'a')).toBe(!scenario.stale);
      expect(deliver.mock.calls.map(([notice]) => notice.id))
        .toEqual(scenario.stale ? ['live-b'] : ['old-a', 'live-b']);
    });
  }

  it('delivers the first prepared notice of an account added while a poll is in flight', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    const poll = await nextPoll();
    const C = { id: 'c', email: 'c@test', imapHost: 'imap.test' };
    mail.setState({ accounts: [A, B, C] });
    const notice = { id: 'n-c', accountId: 'c', sourceRef: 'c-owner', instanceId: instance };
    await act(async () => { poll.resolve({ instanceId: instance, resyncRequired: false, gen: 1,
      changes: [source('c')], notifications: [notice] }); });
    // The daemon spent its one claim when it prepared this notice.
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(notice));
    expect(recount).toHaveBeenCalledWith('c', expect.objectContaining({ arrivalCount: 1 }));
  });

  it('still drops a notice whose account was replaced while its poll was in flight', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    const poll = await nextPoll();
    mail.setState({ accounts: [{ ...A, email: 'replacement@test' }, B] });
    const notice = { id: 'n-a', accountId: 'a', sourceRef: 'a-owner', instanceId: instance };
    await act(async () => { poll.resolve({ instanceId: instance, resyncRequired: false, gen: 1,
      changes: [source('a')], notifications: [notice] }); });
    await tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('keeps its listeners and polling when one change recount rejects', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    recount.mockRejectedValueOnce(new Error('daemon recount unavailable'));
    const first = { id: 'n1', accountId: 'a', sourceRef: 'a-owner', instanceId: instance };
    await answer({ gen: 1, changes: [source('a')], notifications: [first] });
    // The loop asks for the next change at once; it does not tear down and
    // rebind (which would clear every parked source for five seconds).
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0), { timeout: 1000 });
    expect(listeners.has('notify')).toBe(true);
    expect(listeners.has('code-ready')).toBe(true);
    expect(listeners.has('daemon-reconnected')).toBe(true);
    expect(listeners.has('daemon-events-lagged')).toBe(true);
    expect(deliver).toHaveBeenCalledWith(first);
  });

  it('waits for the accounts to load before it attaches the native context or polls', async () => {
    mail.setState({ accounts: [] });
    renderHook(() => useEmailScheduler());
    await tick(); await tick();
    expect(connect).not.toHaveBeenCalled();
    expect(waitForSyncChanges).not.toHaveBeenCalled();
    // The typed listeners are already live, so nothing emitted meanwhile is lost.
    expect(listenerOrder).toEqual(['notify', 'code-ready', 'daemon-reconnected', 'daemon-events-lagged']);
    mail.setState({ accounts: [A, B] });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(waitForSyncChanges).toHaveBeenCalledWith(null, 25000));
  });

  it('recovers status and current state on lag without synthesizing old notices', async () => {
    renderHook(() => useEmailScheduler());
    await ready(); connect.mockClear(); deliver.mockClear();
    listeners.get('daemon-events-lagged')({ payload: {} });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(deliver).not.toHaveBeenCalled();
    await answer({ gen: 65, changes: [], notifications: [], resyncRequired: true });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('repaints unified current folder once, and ignores an unrelated folder', async () => {
    mail.setState({ activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Archive' });
    renderHook(() => useEmailScheduler());
    await ready(); loadUnifiedInbox.mockClear(); loadEmails.mockClear();
    await answer({ gen: 1, changes: [{ ...source('a'), mailbox: 'INBOX' }], notifications: [] });
    expect(loadUnifiedInbox).not.toHaveBeenCalled();
    await answer({ gen: 2, changes: [{ ...source('b'), gen: 2, mailbox: 'Archive' }], notifications: [] });
    await vi.waitFor(() => expect(loadUnifiedInbox).toHaveBeenCalledTimes(1));
    expect(loadUnifiedInbox).toHaveBeenCalledWith(null, 'Archive');
    expect(loadEmails).not.toHaveBeenCalled();
  });

  it('removes listeners and ignores a parked reply after unmount', async () => {
    const hook = renderHook(() => useEmailScheduler());
    const poll = await nextPoll();
    hook.unmount();
    expect(listeners.size).toBe(0);
    await act(async () => { poll.resolve({ instanceId: instance, gen: 1,
      changes: [source('a')], notifications: [] }); });
    await tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not schedule provider pages, watchers or JS arrival policy', async () => {
    renderHook(() => useEmailScheduler());
    await ready();
    await answer({ gen: 1, changes: [source('a')], notifications: [] });
    expect(invoke.mock.calls.some(([name]) => name === 'sync.watch' || name === 'sync.now'
      || name === 'notify.decide' || name === 'imap_fetch_emails')).toBe(false);
  });
});
