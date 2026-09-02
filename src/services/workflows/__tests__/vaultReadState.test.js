// Marking a VAULT row read, from the all-inboxes list.
//
// A message the vault holds but the server list does not is in `localEmails`
// and in no other array — deriveDisplayRows pushes it onto the list from there.
// Every read-state mutation used to map `emails` alone, so the row on screen
// never changed: the reported symptom was "mark as read does nothing at all".
// The flag also has to reach disk, or the row reverts to unread on the next
// folder switch, which looks the same to the person using it. Disk is one Rust
// call (`vaultApplyFlags`) that lands the change on the vault file name, its
// mirror copy, local-index.json and the header sidecar together — local-index
// alone was written before, and restore and the mirror read the file name.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockGetLocalIndexEntry = vi.fn();

vi.mock('../../db', () => ({
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
  normalizeGraphFolderName: (n) => n,
}));

vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

const mockSetUnreadForAccount = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
import { _selKey } from '../../../stores/slices/unifiedHelpers';

const ACCOUNT = { id: 'acct1', email: 'me@mock.test' };
const UID = 5;
// Derived, not spelled: this file's subject is read state, and a test that
// hardcodes a key format goes red every time the format is corrected.
const SEL_KEY = _selKey(vaultRow());

// The vault row as the unified loader builds it: provenance attached, archived,
// and absent from `emails` because the server list does not carry it.
function vaultRow(flags = []) {  // eslint-disable-line no-use-before-define
  return {
    uid: UID, messageId: 'v@mock', subject: 'Press slot Friday', flags,
    from: { address: 'them@mock.test' }, date: '2026-08-12T08:02:00Z',
    _accountId: ACCOUNT.id, _accountEmail: ACCOUNT.email, _mailbox: 'INBOX',
    isArchived: true, source: 'local',
  };
}

function primeUnifiedVault(flags = []) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    viewMode: 'all',
    emails: [],
    sentEmails: [],
    localEmails: [vaultRow(flags)],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set([UID]),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set([SEL_KEY]),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const rowSeen = () =>
  useMailStore.getState().sortedEmails.find(e => e.uid === UID)?.flags?.includes('\\Seen');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalIndexEntry.mockResolvedValue({ uid: UID, subject: 'Press slot Friday', flags: [] });
});

describe('marking a vault-only row read from the unified list', () => {
  it('puts the row on the list before the fix could have been proven', () => {
    primeUnifiedVault([]);
    // The row really is on screen and really is unread — otherwise the
    // assertions below would pass against nothing.
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([UID]);
    expect(rowSeen()).toBe(false);
  });

  it('flips the row the list actually renders', async () => {
    primeUnifiedVault([]);

    await useMailStore.getState().markSelectedAsRead();

    expect(rowSeen()).toBe(true);
    expect(useMailStore.getState().localEmails[0].flags).toContain('\\Seen');
  });

  it('hands the flag to the vault writer with the message\'s whole flag list', async () => {
    primeUnifiedVault([]);

    await useMailStore.getState().markSelectedAsRead();

    // The account's address names the mirror directory; the full flag list is
    // what Rust merges over the file name.
    expect(mockVaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT.email, [{ uid: UID, flags: ['\\Seen'] }],
    );
    // The old index-only write is gone — two writers would race each other.
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it('takes the flag back off again on mark-unread', async () => {
    primeUnifiedVault(['\\Seen']);

    await useMailStore.getState().markSelectedAsUnread();

    expect(rowSeen()).toBe(false);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT.email, [{ uid: UID, flags: [] }],
    );
  });

  it('keeps every other flag the message had', async () => {
    primeUnifiedVault(['\\Flagged']);

    await useMailStore.getState().markSelectedAsRead();

    expect(mockVaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT.email, [{ uid: UID, flags: ['\\Flagged', '\\Seen'] }],
    );
  });

  // A vault-only message has no server copy; a failing IMAP call must not undo
  // what already happened on screen and on disk.
  it('keeps the row read when the server call fails', async () => {
    primeUnifiedVault([]);
    mockUpdateEmailFlags.mockRejectedValueOnce(new Error('no such message'));

    await useMailStore.getState().markSelectedAsRead();

    expect(rowSeen()).toBe(true);
    expect(mockVaultApplyFlags).toHaveBeenCalled();
  });

  // Whether the vault holds the message is Rust's question now — it has the
  // directory, and answering it here from archivedEmailIds skipped the header
  // sidecar, which every synced message has and every repaint from cache reads.
  it('tells the vault writer about a server-only message too', async () => {
    primeUnifiedVault([]);
    useMailStore.setState({ archivedEmailIds: new Set() });

    await useMailStore.getState().markSelectedAsRead();

    expect(mockVaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT.email, [{ uid: UID, flags: ['\\Seen'] }],
    );
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it('writes a whole selection to the vault in one call, not one per message', async () => {
    primeUnifiedVault([]);
    const second = { ...vaultRow([]), uid: UID + 1, messageId: 'v2@mock', subject: 'Second slot' };
    useMailStore.setState(s => ({
      localEmails: [...s.localEmails, second],
      archivedEmailIds: new Set([UID, UID + 1]),
      selectedEmailIds: new Set([SEL_KEY, _selKey(second)]),
    }));
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();

    await useMailStore.getState().markSelectedAsRead();

    // The writer rewrites the whole index; two calls would race each other.
    expect(mockVaultApplyFlags).toHaveBeenCalledTimes(1);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT.email,
      expect.arrayContaining([{ uid: UID, flags: ['\\Seen'] }, { uid: UID + 1, flags: ['\\Seen'] }]),
    );
  });

  // A uid names a message only inside one (account, mailbox). The INBOX list
  // merges Sent replies into its threads and stamps them `_fromSentFolder`;
  // such a row is selected by its bare uid, and INBOX has its own message
  // under that number. Writing it under INBOX would rename a different
  // message's file — the one restore uploads.
  it('refuses to write a Sent copy merged into the INBOX list under INBOX\'s uid', async () => {
    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      viewMode: 'all',
      emails: [{ ...vaultRow([]), _accountId: undefined, _mailbox: undefined, _fromSentFolder: true, isArchived: false, source: 'server' }],
      sentEmails: [],
      localEmails: [],
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUids: serverUids(new Set([UID]), { complete: true }),
      deleteTombstones: new Set(),
      totalEmails: 1,
      selectedEmailIds: new Set([UID]),
      selectedEmail: null,
      selectedEmailId: null,
      emailCache: new Map(),
      loadEmails: vi.fn(),
      _sortedEmailsFingerprint: '',
    });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();

    await useMailStore.getState().markSelectedAsRead();

    // The row on screen still flips — that half is not in question.
    expect(rowSeen()).toBe(true);
    expect(mockVaultApplyFlags).not.toHaveBeenCalled();
  });

  it('keeps the row read when the vault writer fails', async () => {
    primeUnifiedVault([]);
    mockVaultApplyFlags.mockRejectedValueOnce(new Error('disk gone'));

    await useMailStore.getState().markSelectedAsRead();

    expect(rowSeen()).toBe(true);
    expect(useMailStore.getState().error).toBeFalsy();
  });
});
