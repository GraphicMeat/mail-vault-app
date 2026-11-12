// bindStoreActions plugs the workflows into the mail store: the slices declare
// every workflow action as an unbound stub and this module replaces each one.
// The workflows are mocked here, so a call proves only what is bound to what
// and with which arguments; what a workflow does is its own test's business.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A mock per workflow export, created on first use and keyed by export name.
const h = vi.hoisted(() => {
  const fns = new Proxy({}, { get: (target, key) => (target[key] ??= vi.fn()) });
  return { fns, fwd: (name) => (...args) => h.fns[name](...args) };
});

vi.mock('../activateAccount', () => ({ activateAccount: h.fwd('activateAccount'), init: h.fwd('init'), setActiveAccount: h.fwd('setActiveAccount') }));
vi.mock('../loadSubtree', () => ({ loadSubtree: h.fwd('loadSubtree') }));
vi.mock('../prefetch', () => ({ _prefetchAllMailboxes: h.fwd('_prefetchAllMailboxes'), _prewarmAccountCaches: h.fwd('_prewarmAccountCaches') }));
vi.mock('../addAccount', () => ({ addAccount: h.fwd('addAccount') }));
vi.mock('../updateAccount', () => ({ updateAccount: h.fwd('updateAccount') }));
vi.mock('../changeServer', () => ({ changeServer: h.fwd('changeServer') }));
vi.mock('../removeAccount', () => ({ removeAccount: h.fwd('removeAccount') }));
vi.mock('../refreshAccounts', () => ({ refreshCurrentView: h.fwd('refreshCurrentView'), refreshAllAccounts: h.fwd('refreshAllAccounts') }));
vi.mock('../retryKeychainAccess', () => ({ retryKeychainAccess: h.fwd('retryKeychainAccess') }));
vi.mock('../folderOps', () => ({
  createFolder: h.fwd('createFolder'), renameFolder: h.fwd('renameFolder'),
  deleteFolder: h.fwd('deleteFolder'), deleteLocalFolder: h.fwd('deleteLocalFolder'),
}));
vi.mock('../loadUnifiedInbox', () => ({
  setUnifiedInbox: h.fwd('setUnifiedInbox'), switchUnifiedFolder: h.fwd('switchUnifiedFolder'), loadUnifiedInbox: h.fwd('loadUnifiedInbox'),
}));
vi.mock('../messageMutations', () => Object.fromEntries([
  'saveEmailLocally', 'saveEmailsLocally', 'saveSelectedLocally', 'removeLocalEmail', 'removeLocalEmails',
  'deleteEmailFromServer', 'markEmailReadStatus', 'exportEmail', 'markSelectedAsRead', 'markSelectedAsUnread',
  'setSelectedFlagged', 'toggleFlagged', 'deleteSelectedFromServer', 'moveEmails', 'purgeEverywhereReporting',
  'applyFlagToTargets', 'setDeleteUndo', 'reloadListInView', 'applySeenLocally',
].map(name => [name, h.fwd(name)])));
vi.mock('../selectEmail', () => ({
  selectEmail: h.fwd('selectEmail'), _prefetchAdjacentEmails: h.fwd('_prefetchAdjacentEmails'),
  cancelSelection: h.fwd('cancelSelection'), cancelInsightsSelection: h.fwd('cancelInsightsSelection'),
}));
vi.mock('../loadEmails', () => ({
  loadEmails: h.fwd('loadEmails'), _loadEmailsViaGraph: h.fwd('_loadEmailsViaGraph'),
  loadSentHeaders: h.fwd('loadSentHeaders'), extendSentWindows: h.fwd('extendSentWindows'),
}));
vi.mock('../loadMoreEmails', () => ({ loadMoreEmails: h.fwd('loadMoreEmails') }));

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const { useMailStore } = await import('../../../stores/mailStore');
const { workflowPort } = await import('../../../stores/workflowPorts');
const { createAccountSlice } = await import('../../../stores/slices/accountSlice');
const { createSelectionSlice } = await import('../../../stores/slices/selectionSlice');
const { createMessageListSlice } = await import('../../../stores/slices/messageListSlice');
const { bindStoreActions, storeActions } = await import('../bindStoreActions');

const state = () => useMailStore.getState();

beforeEach(() => {
  for (const key of Object.keys(h.fns)) h.fns[key].mockReset();
});

// [store action, workflow export it calls, arguments given, arguments the workflow gets]
const SAME = undefined;
const FORWARDS = [
  ['init', 'init', ['ignored'], []],
  ['_prefetchAllMailboxes', '_prefetchAllMailboxes', [{ force: true }], SAME],
  ['_prewarmAccountCaches', '_prewarmAccountCaches', ['ignored'], []],
  ['addAccount', 'addAccount', [{ email: 'a@x.test' }], SAME],
  ['updateAccount', 'updateAccount', ['a1', { name: 'n' }], SAME],
  ['changeServer', 'changeServer', ['a1', { imapHost: 'h' }], SAME],
  ['removeAccount', 'removeAccount', ['a1'], SAME],
  ['setActiveAccount', 'setActiveAccount', ['a1'], SAME],
  ['activateAccount', 'activateAccount', ['a1', 'Archive', { silent: true }], SAME],
  ['loadSubtree', 'loadSubtree', ['a1', 'Projects', { force: true }], SAME],
  ['setUnifiedInbox', 'setUnifiedInbox', [true], SAME],
  ['switchUnifiedFolder', 'switchUnifiedFolder', ['Sent'], SAME],
  ['loadUnifiedInbox', 'loadUnifiedInbox', [{ snap: 1 }, 'INBOX'], SAME],
  ['saveEmailLocally', 'saveEmailLocally', [7], SAME],
  ['saveEmailsLocally', 'saveEmailsLocally', [[{ uid: 1 }]], SAME],
  ['saveSelectedLocally', 'saveSelectedLocally', ['ignored'], []],
  ['removeLocalEmail', 'removeLocalEmail', [7, { accountId: 'a1' }], SAME],
  ['removeLocalEmails', 'removeLocalEmails', [[{ uid: 1 }]], SAME],
  ['deleteEmailFromServer', 'deleteEmailFromServer', [7, { skipRefresh: true }], SAME],
  ['markEmailReadStatus', 'markEmailReadStatus', [7, true], SAME],
  ['exportEmail', 'exportEmail', [7, 'Subject'], SAME],
  ['refreshAllAccounts', 'refreshAllAccounts', [{ quiet: true }], SAME],
  ['retryKeychainAccess', 'retryKeychainAccess', ['ignored'], []],
  ['_prefetchAdjacentEmails', '_prefetchAdjacentEmails', [7], SAME],
  ['selectEmail', 'selectEmail', [7, 'server', 'Archive', { accountId: 'a1' }, { uid: 7 }], SAME],
  ['_cancelSelection', 'cancelSelection', [{ keepThreadTimers: true }], SAME],
  ['markSelectedAsRead', 'markSelectedAsRead', ['ignored'], []],
  ['markSelectedAsUnread', 'markSelectedAsUnread', ['ignored'], []],
  ['setSelectedFlagged', 'setSelectedFlagged', [true], SAME],
  ['toggleFlagged', 'toggleFlagged', ['a1|INBOX|7'], SAME],
  ['deleteSelectedFromServer', 'deleteSelectedFromServer', ['ignored'], []],
  ['moveEmails', 'moveEmails', [[7, 8], 'Archive'], SAME],
  ['loadEmails', 'loadEmails', [{ force: true }], SAME],
  ['_loadEmailsViaGraph', '_loadEmailsViaGraph', [{ id: 'a1' }, 'a1', 'INBOX', 3], SAME],
  ['loadMoreEmails', 'loadMoreEmails', ['ignored'], []],
  ['loadSentHeaders', 'loadSentHeaders', ['a1', { limit: 5 }], SAME],
];

describe('bindStoreActions: store actions', () => {
  it.each(FORWARDS)('%s is a function and forwards to %s', (action, workflow, args, expected) => {
    expect(state()[action]).toBeTypeOf('function');
    state()[action](...args);
    expect(h.fns[workflow]).toHaveBeenCalledTimes(1);
    expect(h.fns[workflow]).toHaveBeenCalledWith(...(expected ?? args));
  });

  it('binds every action storeActions() names, and no stub is left among them', () => {
    // refreshCurrentView starts timers: keep them on the fake clock.
    vi.useFakeTimers();
    for (const name of Object.keys(storeActions())) {
      expect(state()[name], name).toBeTypeOf('function');
      expect(() => {
        try { state()[name](); } catch (error) {
          if (/called before bindStoreActions/.test(error?.message)) throw error;
        }
      }, name).not.toThrow();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('the folder actions act on the active account, read when they are called', () => {
    useMailStore.setState({ activeAccountId: 'acct-1' });
    state().createFolder('Projects', 'Alpha');
    expect(h.fns.createFolder).toHaveBeenCalledWith('acct-1', 'Projects', 'Alpha');
    useMailStore.setState({ activeAccountId: 'acct-2' });
    state().renameFolder('Projects', 'Beta');
    state().deleteFolder('Projects');
    state().deleteLocalFolder('Local');
    expect(h.fns.renameFolder).toHaveBeenCalledWith('acct-2', 'Projects', 'Beta');
    expect(h.fns.deleteFolder).toHaveBeenCalledWith('acct-2', 'Projects');
    expect(h.fns.deleteLocalFolder).toHaveBeenCalledWith('acct-2', 'Local');
  });

  it('purgeSelectedEverywhere hands the selected keys over as an array', () => {
    useMailStore.setState({ selectedEmailIds: new Set(['a1|INBOX|1', 'a1|INBOX|2']) });
    state().purgeSelectedEverywhere({ confirm: true });
    expect(h.fns.purgeEverywhereReporting).toHaveBeenCalledWith(['a1|INBOX|1', 'a1|INBOX|2'], { confirm: true });
    useMailStore.setState({ selectedEmailIds: new Set() });
  });

  it('binding again is a no-op: the bound actions stay the same functions', () => {
    const before = state().activateAccount;
    const refresh = state().refreshCurrentView;
    bindStoreActions();
    expect(state().activateAccount).toBe(before);
    expect(state().refreshCurrentView).toBe(refresh);
  });
});

describe('slice stubs', () => {
  const set = () => {};
  const get = () => ({});

  it.each([
    ['account', () => createAccountSlice(set, get), 'activateAccount'],
    ['account', () => createAccountSlice(set, get), 'refreshCurrentView'],
    ['selection', () => createSelectionSlice(set, get), 'selectEmail'],
    ['selection', () => createSelectionSlice(set, get), '_cancelSelection'],
    ['message list', () => createMessageListSlice(set, get), 'loadEmails'],
  ])('a fresh %s slice throws from %s until it is bound', (_slice, make, name) => {
    expect(() => make()[name]()).toThrow(`mailStore action "${name}" called before bindStoreActions`);
  });
});

describe('selection actions that cancel a pending selection', () => {
  const thread = (id) => ({ threadId: id, lastEmail: { uid: 1, _accountId: 'a1', _mailbox: 'INBOX' }, emails: [] });

  it('selectThread cancels through the bound action before it writes, keeping the thread timers of a reopen', () => {
    const seen = [];
    h.fns.cancelSelection.mockImplementation((opts) => seen.push({ opts, open: state().selectedThread?.threadId ?? null }));
    useMailStore.setState({ selectedThread: null });
    state().selectThread(thread('t1'));
    state().selectThread(thread('t1'));
    state().selectThread(thread('t2'));
    expect(seen).toEqual([
      { opts: { keepThreadTimers: false }, open: null },
      { opts: { keepThreadTimers: true }, open: 't1' },
      { opts: { keepThreadTimers: false }, open: 't1' },
    ]);
    expect(state().selectedThread.threadId).toBe('t2');
  });

  it('closeEmail cancels with no argument, then clears the reader', () => {
    const seen = [];
    h.fns.cancelSelection.mockImplementation((...args) => seen.push({ args, open: state().selectedThread?.threadId ?? null }));
    useMailStore.setState({ selectedThread: thread('t9'), selectedEmailId: 'k' });
    state().closeEmail();
    expect(seen).toEqual([{ args: [], open: 't9' }]);
    expect(state().selectedThread).toBeNull();
    expect(state().selectedEmailId).toBeNull();
  });
});

describe('manual refresh throttle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 1_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  it('flashes the spinner on every click, runs once, and coalesces clicks into one trailing run', async () => {
    h.fns.refreshCurrentView.mockResolvedValue(undefined);
    state().refreshCurrentView();
    expect(state().manualRefreshSpinning).toBe(true);
    await flush();
    expect(h.fns.refreshCurrentView).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(state().manualRefreshSpinning).toBe(false);

    // Inside the cooldown: the spinner still flashes, nothing runs yet.
    state().refreshCurrentView();
    state().refreshCurrentView();
    expect(state().manualRefreshSpinning).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(state().manualRefreshSpinning).toBe(false);
    expect(h.fns.refreshCurrentView).toHaveBeenCalledTimes(1);

    // The two clicks became one trailing run when the cooldown ended.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.fns.refreshCurrentView).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fns.refreshCurrentView).toHaveBeenCalledTimes(2);
  });
});

describe('Sent window subscription', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('extends the Sent windows once, after a burst of list writes is over', async () => {
    h.fns.extendSentWindows.mockResolvedValue(undefined);
    useMailStore.setState({ emails: [{ uid: 1 }] });
    await vi.advanceTimersByTimeAsync(100);
    useMailStore.setState({ emails: [{ uid: 1 }, { uid: 2 }] });
    await vi.advanceTimersByTimeAsync(149);
    expect(h.fns.extendSentWindows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fns.extendSentWindows).toHaveBeenCalledTimes(1);
    useMailStore.setState({ emails: [] });
  });
});

describe('workflow ports for the other stores', () => {
  it.each([
    ['retryKeychainAccess', 'retryKeychainAccess', [], []],
    ['cancelInsightsSelection', 'cancelInsightsSelection', [{ keepThreadTimers: false }], SAME],
    ['applyFlagToTargets', 'applyFlagToTargets', [[{ uid: 1 }], '\\Flagged', true, { undoable: false }], SAME],
    ['setDeleteUndo', 'setDeleteUndo', [[{ uid: 1 }], { afterRestore: () => {} }], SAME],
    ['deleteEmailFromServer', 'deleteEmailFromServer', [7, { accountId: 'a1' }], SAME],
    ['reloadListInView', 'reloadListInView', [], []],
    ['applySeenLocally', 'applySeenLocally', [useMailStore, { uid: 1, read: true }], SAME],
  ])('port %s forwards to the workflow', (port, workflow, args, expected) => {
    workflowPort(port)(...args);
    expect(h.fns[workflow]).toHaveBeenCalledTimes(1);
    expect(h.fns[workflow]).toHaveBeenCalledWith(...(expected ?? args));
  });

  it('a port nobody bound throws when called', () => {
    expect(() => workflowPort('noSuchPort')()).toThrow('workflow port "noSuchPort" called before bindStoreActions');
  });
});

describe('boundStore', () => {
  // Red before boundStore.js existed: the import below failed to resolve.
  it('hands out the one mail store, with its workflow actions attached', async () => {
    const bound = await import('../boundStore');
    expect(bound.useMailStore).toBe(useMailStore);
    expect(typeof bound.useMailStore.getState().loadEmails).toBe('function');
    await bound.useMailStore.getState().loadEmails({ force: true });
    expect(h.fns.loadEmails).toHaveBeenCalledWith({ force: true });
  });
});
