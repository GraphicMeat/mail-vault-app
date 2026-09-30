// loadUnifiedInbox reads every account's cache (an await per account), builds
// the merged list from those rows and commits it, first as a 50-row batch and
// then in growing prefixes. A flag the user wrote after the seed was painted
// (opening a message in All Inboxes marks it read) is in the store, not in the
// rows read from disk, so each of those commits used to put the old flags back.
// The commits now three-way merge the flags against the live store.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetEmailHeadersPartial = vi.fn();

vi.mock('../../db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX' }]),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  readLocalEmailIndex: vi.fn().mockResolvedValue([]),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
}));
vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
  fetchMailboxes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
  hasValidCredentials: () => true,
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  getAccountCacheMailboxes: vi.fn().mockReturnValue([{ path: 'INBOX' }]),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {}, setLastMailbox: vi.fn(), setUnreadForAccount: vi.fn(), getLastMailbox: () => 'INBOX',
    }),
  },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }) }));
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn(), markVerified: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), toSyncAccount: (a) => a, watchAccount: vi.fn(), unwatchAccount: vi.fn(),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { applySeenLocally } = await import('../messageMutations');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const stamped = (uid, flags = []) => ({
  uid, subject: `Msg ${uid}`, flags,
  date: new Date(1_700_000_000_000 + uid * 1000).toISOString(),
  _accountId: ACCOUNT.id, _accountEmail: ACCOUNT.email, _mailbox: 'INBOX',
});

function primeUnified(seedUids) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    emails: seedUids.map(u => stamped(u)),
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(seedUids), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: seedUids.length,
    loadSentHeaders: vi.fn(),
  });
}

function parked() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const markRead = (uid) =>
  applySeenLocally(useMailStore, { accountId: ACCOUNT.id, mailbox: 'INBOX', uid, read: true, isUnified: true });
const storeRow = (uid) => useMailStore.getState().emails.find(e => e.uid === uid);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadUnifiedInbox — a flag written while the disk read is on the wire survives its commit', () => {
  it('the first batch keeps \\Seen', async () => {
    const seed = [30, 29, 28];
    primeUnified(seed);
    const disk = parked();
    mockGetEmailHeadersPartial.mockReturnValue(disk.promise);

    const done = useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
    await vi.waitFor(() => expect(mockGetEmailHeadersPartial).toHaveBeenCalled());

    markRead(29);
    disk.resolve({ emails: seed.map(u => stamped(u)), totalEmails: 3 });
    await done;

    expect(storeRow(29).flags).toContain('\\Seen');
    expect(storeRow(30).flags).toEqual([]);
  });

  it('a write between the progressive chunks survives the next chunk and the ones after it', async () => {
    const uids = Array.from({ length: 120 }, (_, i) => 120 - i); // three chunks of 50
    primeUnified(uids.slice(0, 3));
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: uids.map(u => stamped(u)), totalEmails: 120 });

    // The first batch (50 rows) lands, then the loader yields before the next
    // chunk: the user opens message 100 in that gap.
    let written = false;
    const unsubscribe = useMailStore.subscribe((s) => {
      if (!written && s.emails.length === 50 && s.loadingProgress) {
        written = true;
        queueMicrotask(() => markRead(100));
      }
    });
    await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
    unsubscribe();

    expect(written).toBe(true);
    expect(useMailStore.getState().emails).toHaveLength(120);
    expect(storeRow(100).flags).toContain('\\Seen');
    expect(storeRow(99).flags).toEqual([]);
  });
});
