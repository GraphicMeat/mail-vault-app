// @vitest-environment jsdom
// Intended path: src/services/workflows/__tests__/unreadCountsRefreshHeldSourceRed.test.js
// Conditional S3 caller regression. This uses the real refreshAllAccounts
// export and the real settings count writer. Provider I/O is held at A's
// background fetch while the account store changes source.
import { beforeEach, expect, it, vi } from 'vitest';

let mailState;
const mailListeners = new Set();
const countCalls = [];
const fetches = [];
let provider;
let cacheRows;
let releaseCount;
let enteredCount;
const nativeRequest = vi.fn();
vi.mock('../../nativeSyncContext.js', () => ({
  requestNativeRefresh: (...args) => nativeRequest(...args),
  observeNativeView: vi.fn(async () => {}),
  currentNativeView: () => null,
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => mailState,
    setState: patch => {
      const prev = mailState;
      mailState = { ...mailState, ...(typeof patch === 'function' ? patch(mailState) : patch) };
      for (const listener of mailListeners) listener(mailState, prev);
    },
    subscribe: listener => { mailListeners.add(listener); return () => mailListeners.delete(listener); },
  },
}));
vi.mock('../../db', async () => {
  const { accountExpectedContext } = await vi.importActual('../../db/accounts.js');
  return {
    accountExpectedContext,
    getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
    listCachedUids: vi.fn().mockResolvedValue(null),
    getEmailHeaders: vi.fn().mockResolvedValue(null),
    getCachedMailboxes: vi.fn().mockResolvedValue([]),
    saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../api', () => ({
  fetchEmails: (...args) => { fetches.push(args); return provider(...args); },
  graphListFolders: vi.fn(),
}));
vi.mock('../../cacheManager', () => ({
  invalidateRestoreDescriptors: vi.fn(), getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn(),
}));
vi.mock('../../syncProbe', () => ({ invalidate: vi.fn().mockResolvedValue({ invalidated: true }) }));
vi.mock('../helpers/mailboxRefetch', () => ({ forceMailboxRefetch: vi.fn(), takeForcedMailboxRefetch: () => false }));
vi.mock('../folderStatus', () => ({ refreshFolderStatus: vi.fn().mockResolvedValue(null), invalidateFolderStatus: vi.fn() }));
vi.mock('../folderOps', () => ({ loadLocalFolders: vi.fn() }));
vi.mock('../adoptGraphFolderKeys', () => ({ adoptGraphFolderKeysFromListing: vi.fn() }));
vi.mock('../../graphConfig', async importOriginal => ({
  ...(await importOriginal()), isGraphAccount: () => false, storageKeyOf: f => f?.displayName,
}));
vi.mock('../../authUtils', () => ({ hasValidCredentials: () => true, ensureFreshToken: async a => a }));
vi.mock('../../../stores/slices/unifiedHelpers', async importOriginal => ({
  ...(await importOriginal()), _resolveMailboxPath: (_mailboxes, target) => target,
}));
vi.mock('../../../stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  flushSafeStorage: async () => {}, safeStorageWritable: () => true,
}));
vi.mock('../../daemonClient', async importOriginal => ({
  ...(await importOriginal()),
  daemonCall: async (method, params) => {
    if (method !== 'counts.unread') throw Error(`Unexpected daemon call ${method}`);
    countCalls.push(params);
    if (params.op === 'recountCache' && params.accountId === 'a') {
      enteredCount();
      await new Promise(resolve => { releaseCount = resolve; });
    }
    const counts = { ...params.baseline };
    if (params.op === 'recountCache') {
      counts[params.accountId] = cacheRows[params.accountId].filter(row =>
        !row.flags.includes('\\Seen')).length;
    }
    const rows = ['a', 'b'].map(id => ({ id, label: `${id}@example.test`, unread: counts[id] }));
    return { counts, rows, total: rows.reduce((sum, row) => sum + row.unread, 0),
      wrote: params.op === 'recountCache', recountSource: params.op === 'recountCache' ? 'complete' : 'none' };
  },
}));

const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
const { recountNativeInbox, setListStore } = await import('../../../stores/unreadCounts');
const { refreshAllAccounts } = await import('../refreshAccounts');
const A = { id: 'a', email: 'a@example.test', imapHost: 'imap.a.example.test' };
const B = { id: 'b', email: 'b@example.test', imapHost: 'imap.b.example.test' };
const row = (uid, seen = false) => ({ uid, flags: seen ? ['\\Seen'] : [], messageId: `m${uid}@example.test` });
const releaseAResult = { emails: [row(1, true)], total: 1, hasMore: false };
const bResult = { emails: [row(21), row(22)], total: 2, hasMore: false };

// Raw merge observations must name B alone after A changed. This walks the
// request tree because the accepted native envelope is pinned only at S3
// activation; it deliberately does not infer the result from a count value.
function rawObservationIds(value) {
  if (Array.isArray(value)) return value.flatMap(rawObservationIds);
  if (!value || typeof value !== 'object') return [];
  const own = typeof value.accountId === 'string'
    && (Object.hasOwn(value, 'cache') || Object.hasOwn(value, 'emails')
      || Object.hasOwn(value, 'rows') || Object.hasOwn(value, 'observation'))
    ? [value.accountId] : [];
  return [...own, ...Object.values(value).flatMap(rawObservationIds)];
}

beforeEach(() => {
  mailListeners.clear();
  countCalls.length = 0;
  fetches.length = 0;
  cacheRows = { a: releaseAResult.emails, b: bResult.emails };
  releaseCount = null;
  enteredCount = null;
  nativeRequest.mockReset().mockResolvedValue({ receipt: { status: 'complete' }, uncertain: false });
  useSettingsStore.setState({ unreadPerAccount: { a: 9, b: 5 }, hiddenAccounts: {} });
  mailState = { accounts: [A, B], activeAccountId: 'other', activeMailbox: 'INBOX',
    unifiedInbox: false, unifiedFolder: null, mailboxScope: null, emails: [],
    loadEmails: vi.fn().mockResolvedValue(undefined) };
  setListStore(useMailStore);
});

const cases = [
  { name: 'source replacement', change: set => set([{ ...A, imapHost: 'other.example.test' }, B]), expectedA: 9 },
  { name: 'remove and readd same ID', change: set => { set([B]); set([{ ...A }, B]); }, expectedA: 9 },
  { name: 'source changes away and back', change: set => { set([{ ...A, imapHost: 'other.example.test' }, B]); set([{ ...A }, B]); }, expectedA: 9 },
  { name: 'harmless object hydration', change: set => set([{ ...A, name: 'Renamed' }, B]), expectedA: 0 },
];
for (const scenario of cases) {
  it(`refresh held A: ${scenario.name} keeps B's merge and fences A as required`, async () => {
    let releaseIntent;
    const heldIntent = new Promise(resolve => { releaseIntent = resolve; });
    nativeRequest.mockImplementationOnce(() => heldIntent);
    const countEntered = new Promise(resolve => { enteredCount = resolve; });
    const work = refreshAllAccounts();
    await vi.waitFor(() => expect(nativeRequest).toHaveBeenCalledTimes(1));
    const aCount = recountNativeInbox('a');
    await countEntered;
    const bCount = recountNativeInbox('b');
    scenario.change(accounts => useMailStore.setState({ accounts }));
    releaseCount();
    await Promise.all([aCount, bCount]);
    releaseIntent({ receipt: { status: 'complete' }, uncertain: false });
    await work;

    expect(fetches).toEqual([]);
    expect(nativeRequest).toHaveBeenCalledWith({});
    expect(countCalls.filter(params => params.op === 'recountCache').map(params => params.accountId))
      .toEqual(['a', 'b']);
    expect(useSettingsStore.getState().unreadPerAccount, `W4S3_U3_RED ${scenario.name}: stale A must not publish; B must survive`).toEqual({ a: scenario.expectedA, b: 2 });
    if (scenario.expectedA === 9) {
      expect(countCalls.find(params => params.op === 'recountCache' && params.accountId === 'a')
        .baseline.a).toBe(9);
      expect(countCalls.find(params => params.op === 'recountCache' && params.accountId === 'b')
        .baseline.a).toBe(9);
    }
    expect(mailListeners.size).toBe(0);
  });
}
