// A flag written to a message reaches the copies of its row that live outside
// the store: the restore descriptors (cacheManager), the unified folder cache
// and the header memo. They paint the list before any disk read, and a stale
// row in one of them puts the old read state back on screen after the user
// changed it (or, in the descriptor's case, wins over the fresh disk row: the
// first copy of a row is the one kept).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

// What the header cache holds on disk, per `account|folder`. The daemon patches
// it when the app writes a flag (vault_apply_flags), which the mock does too.
const disk = new Map();
const readDisk = (accountId, path) => (disk.get(`${accountId}|${path}`) || []).map(row => ({ ...row }));
let holdDisk = null;
const mockGetEmailHeadersPartial = vi.fn(async (accountId, path) => {
  if (holdDisk) await holdDisk.promise;
  const emails = readDisk(accountId, path);
  return { emails, totalEmails: emails.length };
});
const mockVaultApplyFlags = vi.fn(async (accountId, mailbox, _email, changes) => {
  const rows = disk.get(`${accountId}|${mailbox}`) || [];
  for (const { uid, flags, on } of changes) {
    const row = rows.find(r => r.uid === uid);
    if (!row) continue;
    row.flags = on ? [...new Set([...(row.flags || []), ...flags])] : (row.flags || []).filter(f => !flags.includes(f));
  }
  return {};
});

vi.mock('../../db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'Archive' }]),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  readLocalEmailIndex: vi.fn().mockResolvedValue([]),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  queueOp: vi.fn().mockResolvedValue(1),
  clearOps: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
}));
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
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
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {}, setLastMailbox: vi.fn(), setUnreadForAccount: vi.fn(), getLastMailbox: () => 'INBOX',
      unreadPerAccount: {},
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

// The real cache manager, header memo and unified folder cache: the copies
// under test are module state in those.
const { useMailStore } = await import('../../../stores/mailStore');
const { saveRestoreDescriptor, getRestoreDescriptor, invalidateRestoreDescriptors } = await import('../../cacheManager');
const memo = await import('../../headerMemo');
const unifiedCache = await import('../unifiedFolderCache');
const { applySeenLocally } = await import('../messageMutations');
const { patchEverywhere } = await import('../../../stores/messageRows');

const A = { id: 'acct-1', email: 'one@mock.test', password: 'pw' };
const B = { id: 'acct-2', email: 'two@mock.test', password: 'pw' };
const SEEN = '\\Seen';
const date = (uid) => new Date(1_700_000_000_000 + uid * 1000).toISOString();
// A row of a single-account list: it names no account and no folder, the view
// it was read in does.
const bare = (uid, flags = []) => ({ uid, subject: `Msg ${uid}`, flags, date: date(uid) });
const stamped = (account, mailbox, uid, flags = []) => ({
  ...bare(uid, flags), _accountId: account.id, _accountEmail: account.email, _mailbox: mailbox,
});

const markRead = (account, mailbox, uid, isUnified = true) =>
  applySeenLocally(useMailStore, { accountId: account.id, mailbox, uid, read: true, isUnified });
const storeRow = (uid, accountId = A.id) =>
  useMailStore.getState().emails.find(e => e.uid === uid && e._accountId === accountId);
const parked = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const settle = () => new Promise(r => setTimeout(r, 30));

function primeUnified(rows) {
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    viewMode: 'all',
    emails: rows,
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(rows.map(r => r.uid)), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: rows.length,
    selectedEmail: null,
    selectedThread: null,
    loadSentHeaders: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  holdDisk = null;
  disk.clear();
  invalidateRestoreDescriptors(A.id);
  invalidateRestoreDescriptors(B.id);
  unifiedCache.clearUnifiedFolders();
  memo.forget(A.id);
  memo.forget(B.id);
  disk.set(`${A.id}|INBOX`, [30, 29, 28].map(u => stamped(A, 'INBOX', u)));
  disk.set(`${A.id}|Archive`, [90, 89].map(u => stamped(A, 'Archive', u)));
  disk.set(`${B.id}|INBOX`, [29, 27].map(u => stamped(B, 'INBOX', u)));
  disk.set(`${B.id}|Archive`, []);
});

describe('the unified folder cache', () => {
  it('a message marked read in All Inboxes is still read after switching folder and back', async () => {
    primeUnified([30, 29, 28].map(u => stamped(A, 'INBOX', u)));
    await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
    expect(unifiedCache.getUnifiedFolder('INBOX')).toBeTruthy();

    markRead(A, 'INBOX', 29);
    await vi.waitFor(() => expect(mockVaultApplyFlags).toHaveBeenCalled());

    await useMailStore.getState().switchUnifiedFolder('Archive');
    await vi.waitFor(() => expect(useMailStore.getState().emails.map(e => e.uid)).toContain(90));
    await settle();

    // The way back is the cache-hit paint, before the reload reads the disk.
    holdDisk = parked();
    await useMailStore.getState().switchUnifiedFolder('INBOX');
    expect(useMailStore.getState().unifiedFolder).toBe('INBOX');
    expect(storeRow(29).flags).toContain(SEEN);
    expect(storeRow(30).flags).toEqual([]);

    holdDisk.resolve();
    holdDisk = null;
    await settle();
    expect(storeRow(29).flags).toContain(SEEN);
  });

  it('another account\'s row with the same uid stays unread in the cache', () => {
    unifiedCache.putUnifiedFolder('INBOX', [stamped(A, 'INBOX', 29), stamped(B, 'INBOX', 29)]);

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    const rows = unifiedCache.getUnifiedFolder('INBOX').emails;
    expect(rows.map(r => r.flags)).toEqual([[SEEN], []]);
  });

  it('a folder the row is not in keeps its entry, and the rows around the message are the same objects', () => {
    const inbox = [stamped(A, 'INBOX', 30), stamped(A, 'INBOX', 29), stamped(A, 'INBOX', 28)];
    const archive = [stamped(A, 'Archive', 90)];
    unifiedCache.putUnifiedFolder('INBOX', inbox);
    unifiedCache.putUnifiedFolder('Archive', archive);
    const archiveBefore = unifiedCache.getUnifiedFolder('Archive');

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    expect(unifiedCache.getUnifiedFolder('Archive')).toBe(archiveBefore);
    expect(unifiedCache.getUnifiedFolder('Archive').emails).toBe(archive);
    const after = unifiedCache.getUnifiedFolder('INBOX').emails;
    expect(after[1].flags).toEqual([SEEN]);
    expect(after[0]).toBe(inbox[0]);
    expect(after[2]).toBe(inbox[2]);
    // The list handed to the store earlier is not written into.
    expect(inbox[1].flags).toEqual([]);
  });

  it('a write that changes nothing leaves the entry\'s list alone', () => {
    const inbox = [stamped(A, 'INBOX', 29, [SEEN])];
    unifiedCache.putUnifiedFolder('INBOX', inbox);

    patchEverywhere([`${A.id}-INBOX-29`], row => row);

    expect(unifiedCache.getUnifiedFolder('INBOX').emails).toBe(inbox);
  });
});

describe('the restore descriptors', () => {
  const descriptor = (account, mailbox, rows) => ({
    accountId: account.id, mailbox, viewMode: 'all', totalEmails: rows.length,
    mailboxes: [{ path: 'INBOX' }, { path: 'Archive' }], firstWindow: rows,
  });

  it('a refresh of All Inboxes does not put the descriptor\'s unread row over a message just read', async () => {
    saveRestoreDescriptor(descriptor(A, 'INBOX', [30, 29, 28].map(u => bare(u))));
    const seed = [30, 29, 28].map(u => stamped(A, 'INBOX', u));
    primeUnified(seed);
    useMailStore.setState({ selectedEmail: seed[1], selectedEmailId: `${A.id}-INBOX-29` });

    markRead(A, 'INBOX', 29);
    await vi.waitFor(() => expect(mockVaultApplyFlags).toHaveBeenCalled());
    await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
    await settle();

    expect(storeRow(29).flags).toContain(SEEN);
    // Not laid over the reader as a change another device made.
    expect(useMailStore.getState().selectedEmail.flags).toContain(SEEN);
  });

  it('patches the row of the descriptor of its own folder, in a copy, and no other descriptor', () => {
    const rows = [bare(30), bare(29)];
    const otherAccount = [bare(29)];
    const otherFolder = [bare(29)];
    saveRestoreDescriptor(descriptor(A, 'INBOX', rows));
    saveRestoreDescriptor(descriptor(B, 'INBOX', otherAccount));
    saveRestoreDescriptor(descriptor(A, 'Archive', otherFolder));
    const before = getRestoreDescriptor(A.id, 'INBOX', 'all');
    const untouched = [getRestoreDescriptor(B.id, 'INBOX', 'all'), getRestoreDescriptor(A.id, 'Archive', 'all')];

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    const after = getRestoreDescriptor(A.id, 'INBOX', 'all');
    expect(after.firstWindow.map(r => r.flags)).toEqual([[], [SEEN]]);
    expect(after.firstWindow[0]).toBe(rows[0]);
    // The window the store painted from is not written into.
    expect(rows[1].flags).toEqual([]);
    expect(before.firstWindow).toBe(rows);
    // The descriptor is still whole: the folder tree, the ages.
    expect(after.mailboxes).toEqual(before.mailboxes);
    expect(after.timestamp).toBe(before.timestamp);
    expect(getRestoreDescriptor(B.id, 'INBOX', 'all')).toBe(untouched[0]);
    expect(getRestoreDescriptor(A.id, 'Archive', 'all')).toBe(untouched[1]);
  });

  it('places a stamped row of a merged folder by its own stamp, not the descriptor\'s', () => {
    const sentCopy = stamped(A, 'Sent', 29);
    saveRestoreDescriptor(descriptor(A, 'INBOX', [bare(29), sentCopy]));

    patchEverywhere([`${A.id}-Sent-29`], row => ({ ...row, flags: [SEEN] }));

    const window = getRestoreDescriptor(A.id, 'INBOX', 'all').firstWindow;
    expect(window.map(r => r.flags)).toEqual([[], [SEEN]]);
  });
});

describe('the header memo', () => {
  const META = { totalEmails: 3, totalCached: 3, highestModseq: 900, uidValidity: 1 };

  it('drops the folder\'s entry when a row of it is marked read from another view', async () => {
    memo.remember(A.id, 'INBOX', [bare(30), bare(29), bare(28)], META);
    primeUnified([stamped(A, 'INBOX', 29)]);

    markRead(A, 'INBOX', 29);

    // A recall would have served the unread row: the stamp does not move for a
    // flag, so the entry looked fresh.
    expect(memo.peek(A.id, 'INBOX')).toBeNull();
    expect(await memo.recall(A.id, 'INBOX', META)).toBeNull();
  });

  it('keeps every other folder\'s and account\'s entry', () => {
    memo.remember(A.id, 'Archive', [bare(29)], META);
    memo.remember(B.id, 'INBOX', [bare(29)], META);
    const kept = [memo.peek(A.id, 'Archive'), memo.peek(B.id, 'INBOX')];

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    expect(memo.peek(A.id, 'Archive')).toBe(kept[0]);
    expect(memo.peek(B.id, 'INBOX')).toBe(kept[1]);
  });

  it('leaves the view on screen\'s stamp: a mark read in the open folder is no reason to re-read it', () => {
    memo.adopt(A.id, 'INBOX', META, Date.now());
    expect(memo.isOnScreen(A.id, 'INBOX')).toBe(true);

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    expect(memo.isOnScreen(A.id, 'INBOX')).toBe(true);
  });
});

describe('the click stays instant', () => {
  it('a write reads no disk and makes no daemon call of its own', () => {
    unifiedCache.putUnifiedFolder('INBOX', [stamped(A, 'INBOX', 29)]);
    saveRestoreDescriptor({ accountId: A.id, mailbox: 'INBOX', viewMode: 'all', firstWindow: [bare(29)], mailboxes: [] });
    memo.remember(A.id, 'INBOX', [bare(29)], { totalEmails: 1, totalCached: 1, highestModseq: 1, uidValidity: 1 });
    mockGetEmailHeadersPartial.mockClear();

    patchEverywhere([`${A.id}-INBOX-29`], row => ({ ...row, flags: [SEEN] }));

    expect(mockGetEmailHeadersPartial).not.toHaveBeenCalled();
    expect(mockVaultApplyFlags).not.toHaveBeenCalled();
  });
});
