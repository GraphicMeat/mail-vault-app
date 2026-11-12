// "UNIFIED" is the All Inboxes pseudo-folder, never a folder an account can be
// activated on. Seven callers re-activate the active account with
// `activeMailbox || 'INBOX'` (the network retry timer, change-server, settings
// saves, keychain retry), and while All Inboxes is on screen that string is
// 'UNIFIED'. activateAccount then wrote activeMailbox 'UNIFIED' with
// unifiedInbox false and the account's own untagged rows: the header said All
// Inboxes, the sidebar said the account, and opening any row threw "Cannot tell
// which account and folder hold message N" because a spanning view cannot place
// a bare uid.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

vi.mock('../../db', () => ({
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  getArchivedEmails: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../api', () => ({
  fetchEmails: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  checkMailboxStatus: vi.fn().mockResolvedValue(null),
  fetchMailboxes: vi.fn().mockResolvedValue([]),
  // The daemon lists (and stores) IMAP/JMAP folders: the server's answer, as fetchMailboxes was before.
  loadMailboxes: vi.fn().mockResolvedValue({ mailboxes: [], source: 'server', suspectEmpty: false, changed: true }),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
}));
vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
  // The tail registers this account's IDLE watcher.
  hasValidCredentials: (a) => !!(a?.password || a?.oauth2AccessToken),
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
const mockGetRestoreDescriptor = vi.fn().mockReturnValue(null);
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: (...a) => mockGetRestoreDescriptor(...a),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
const setLastMailbox = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setLastMailbox,
      setUnreadForAccount: vi.fn(),
      getLastMailbox: () => 'INBOX',
    }),
  },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }), send: vi.fn().mockResolvedValue(null) }));
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn().mockResolvedValue(false),
  markVerified: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn().mockResolvedValue({ started: false }),
  waitForSync: vi.fn().mockResolvedValue(null),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
  watchAccount: vi.fn(),
  unwatchAccount: vi.fn(),
}));
const mockRefreshFolderStatus = vi.fn().mockResolvedValue(null);
vi.mock('../folderStatus', () => ({
  refreshFolderStatus: (...args) => mockRefreshFolderStatus(...args),
}));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const { forget: forgetMemo } = await import('../../headerMemo');

const A = { id: 'acct-a', email: 'a@mock.test', password: 'pw' };
const B = { id: 'acct-b', email: 'b@mock.test', password: 'pw' };
const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });
const MAILBOXES = [{ path: 'INBOX', name: 'INBOX', children: [] }, { path: 'Archive', name: 'Archive', children: [] }];

function primeOn(account, mailbox) {
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: account.id,
    activeMailbox: mailbox,
    viewMode: 'all',
    emails: [mkHeader(1)],
    sortedEmails: [mkHeader(1)],
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([1]), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    mailboxes: MAILBOXES,
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

const descriptorFor = (account, mailbox) => ({
  accountId: account.id,
  mailbox,
  viewMode: 'all',
  totalEmails: 1,
  topVisibleIndex: 0,
  selectedUid: null,
  mailboxes: MAILBOXES,
  mailboxesFetchedAt: Date.now(),
  firstWindow: [mkHeader(7)],
  firstWindowSavedUids: [],
  firstWindowArchivedUids: [],
  serverUids: serverUids(new Set([7]), { complete: true }),
});

const loadUnifiedInbox = vi.fn().mockResolvedValue(undefined);

function primeUnified() {
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    viewMode: 'all',
    emails: [{ ...mkHeader(1), _accountId: A.id, _mailbox: 'INBOX' }, { ...mkHeader(2), _accountId: B.id, _mailbox: 'INBOX' }],
    sortedEmails: [],
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([1, 2]), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 2,
    mailboxes: MAILBOXES,
    loadSentHeaders: vi.fn(),
    loadUnifiedInbox,
  });
}

function primeSingle() {
  primeUnified();
  useMailStore.setState({
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    emails: [mkHeader(1)],
    totalEmails: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRestoreDescriptor.mockReturnValue(null);
  forgetMemo(A.id);
  forgetMemo(B.id);
});

describe('activateAccount is never aimed at the All Inboxes pseudo-folder', () => {
  it('while All Inboxes is on screen, repaints All Inboxes and keeps its tagged rows', async () => {
    primeUnified();

    await useMailStore.getState().activateAccount(A.id, 'UNIFIED');

    const s = useMailStore.getState();
    expect(s.activeMailbox).toBe('UNIFIED');
    expect(s.unifiedInbox).toBe(true);
    expect(s.emails.every(e => e._accountId && e._mailbox)).toBe(true);
    expect(s.emails).toHaveLength(2);
    expect(loadUnifiedInbox).toHaveBeenCalledTimes(1);
  });

  it('after the user moved to one inbox, a late UNIFIED re-activation changes nothing', async () => {
    primeSingle();

    await useMailStore.getState().activateAccount(A.id, 'UNIFIED');

    const s = useMailStore.getState();
    expect(s.activeMailbox).toBe('INBOX');
    expect(s.unifiedInbox).toBe(false);
    expect(s.emails.map(e => e.uid)).toEqual([1]);
    expect(loadUnifiedInbox).not.toHaveBeenCalled();
  });

  it('never leaves the split state: UNIFIED mailbox with unifiedInbox false', async () => {
    for (const prime of [primeUnified, primeSingle]) {
      prime();
      await useMailStore.getState().activateAccount(A.id, 'UNIFIED');
      await useMailStore.getState().activateAccount(A.id, 'UNIFIED', { _backgroundRefresh: true });
      const s = useMailStore.getState();
      expect(s.activeMailbox === 'UNIFIED' && !s.unifiedInbox).toBe(false);
    }
  });
});
