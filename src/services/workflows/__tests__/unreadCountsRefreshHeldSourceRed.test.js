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
let nativeCounts;
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
    return { counts: { ...nativeCounts }, rows: [
      { id: 'a', label: 'a@example.test', unread: nativeCounts.a },
      { id: 'b', label: 'b@example.test', unread: nativeCounts.b },
    ], total: nativeCounts.a + nativeCounts.b, wrote: true };
  },
}));

const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');
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
  nativeCounts = { a: 9, b: 2 };
  useSettingsStore.setState({ unreadPerAccount: { a: 9, b: 5 }, hiddenAccounts: {} });
  mailState = { accounts: [A, B], activeAccountId: 'other', activeMailbox: 'INBOX',
    unifiedInbox: false, unifiedFolder: null, mailboxScope: null, emails: [],
    loadEmails: vi.fn().mockResolvedValue(undefined) };
});

const cases = [
  { name: 'source replacement', change: set => set([{ ...A, imapHost: 'other.example.test' }, B]), expectedA: 9 },
  { name: 'remove and readd same ID', change: set => { set([B]); set([{ ...A }, B]); }, expectedA: 9 },
  { name: 'source changes away and back', change: set => { set([{ ...A, imapHost: 'other.example.test' }, B]); set([{ ...A }, B]); }, expectedA: 9 },
  { name: 'harmless object hydration', change: set => set([{ ...A, name: 'Renamed' }, B]), expectedA: 0 },
];
for (const scenario of cases) {
  it(`refresh held A: ${scenario.name} keeps B's merge and fences A as required`, async () => {
    let entered, release;
    const aEntered = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    provider = async account => {
      if (account.id === 'a') { entered(); return held; }
      return bResult;
    };
    nativeCounts = { a: scenario.expectedA, b: 2 };
    const work = refreshAllAccounts();
    await aEntered;
    scenario.change(accounts => useMailStore.setState({ accounts }));
    release(releaseAResult);
    await work;

    expect(fetches.map(([account]) => account.id)).toEqual(['a', 'b']);
    expect(useSettingsStore.getState().unreadPerAccount, `W4S3_U3_RED ${scenario.name}: stale A must not publish; B must survive`).toEqual({ a: scenario.expectedA, b: 2 });
    if (scenario.expectedA === 9) {
      expect(countCalls.some(params => rawObservationIds(params).includes('b'))).toBe(true);
      expect(countCalls.every(params => !rawObservationIds(params).includes('a'))).toBe(true);
    }
    expect(mailListeners.size).toBe(0);
  });
}
