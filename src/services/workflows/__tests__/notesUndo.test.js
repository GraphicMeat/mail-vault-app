// Notes to Self and the undo slot, through the real flag core.
//
// A board card is no list row: it keeps its own copy of each note's flags and
// reads its star off them, and the daemon reads the star off the vault file.
// The report: undoing a star taken off (or put on) from the board changed the
// server and left the card, and the vault copy, as they were. The next
// Refresh read the old star back from the vault.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 1 });
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockDaemonCall = vi.fn().mockResolvedValue({});

vi.mock('../../daemonClient', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  isDaemonAvailable: async () => true,
  getDaemonStatus: async () => ({}),
  DaemonError: class DaemonError extends Error {},
}));

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphSetFlagged: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
  getCleanBase64: (b64) => b64,
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
  graphMessageToEmail: (m) => m,
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

vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: true }) },
}));

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
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { useNotesStore } = await import('../../../stores/notesStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { toggleFlagged, setDeleteUndo } = await import('../messageMutations');

const ACCOUNT = { id: 'a1', email: 'a1@x' };
const KEY = 'id:n1@x';

// One note, filed in INBOX, read. The board over another folder's list: no
// row of it is loaded.
const note = (extra = {}) => ({
  key: KEY,
  copies: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, messageId: '<n1@x>', flags: ['\\Seen'] }],
  subject: 'Buy milk',
  snippet: '',
  date: 1_790_000_000,
  accountId: 'a1',
  column: 'Notes',
  links: [],
  attachments: [],
  starred: false,
  done: false,
  ...extra,
});
const other = () => ({
  ...note(),
  key: 'id:n2@x',
  copies: [{ accountId: 'a1', mailbox: 'INBOX', uid: 8, messageId: '<n2@x>', flags: [] }],
});

function primeStore(emails = []) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(emails.map(e => e.uid), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    undo: null,
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

// Seeded directly: open() would ask the daemon for the list.
function openBoard(cards) {
  useNotesStore.setState({
    isOpen: true, status: 'ready', cards, busy: {},
    accounts: [{ accountId: 'a1', address: 'a1@x', knownMailboxes: ['INBOX'] }],
  });
}

const cardOf = key => useNotesStore.getState().cards.find(card => card.key === key);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
  mockVaultApplyFlags.mockResolvedValue({ renamed: 1 });
  mockDaemonCall.mockResolvedValue({});
  useSearchStore.setState({ searchResults: [] });
  useNotesStore.getState().close();
});

describe('a note star and its undo', () => {
  it('undoing a star put on from the board takes it off the card, the vault copy and the server', async () => {
    primeStore();
    openBoard([note(), other()]);

    await useNotesStore.getState().toggleStar(note());
    expect(cardOf(KEY).starred).toBe(true);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: true }]);
    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 7, ['\\Flagged'], 'add', 'INBOX');
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.starred' });

    const untouched = cardOf('id:n2@x');
    mockVaultApplyFlags.mockClear();
    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    await vi.waitFor(() => expect(cardOf(KEY).starred).toBe(false));
    expect(cardOf(KEY).copies[0].flags).toEqual(['\\Seen']);
    // The daemon lists the star from the vault file: a server-only undo
    // came back with the next Refresh.
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: false }]);
    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 7, ['\\Flagged'], 'remove', 'INBOX');
    expect(cardOf('id:n2@x')).toBe(untouched);
  });

  it('undoing a star taken off from the board puts it back on the card and the vault copy', async () => {
    primeStore();
    const starred = note({ starred: true, copies: [{ ...note().copies[0], flags: ['\\Seen', '\\Flagged'] }] });
    openBoard([starred]);

    await useNotesStore.getState().toggleStar(starred);
    expect(cardOf(KEY).starred).toBe(false);
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.unstarred' });

    mockVaultApplyFlags.mockClear();
    await useMailStore.getState().runUndo();

    await vi.waitFor(() => expect(cardOf(KEY).starred).toBe(true));
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: true }]);
  });

  it('keeps the star on the card when only the vault copy could not be written', async () => {
    primeStore();
    openBoard([note()]);
    mockVaultApplyFlags.mockRejectedValue(new Error('vault gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useNotesStore.getState().toggleStar(note());

    warn.mockRestore();
    expect(cardOf(KEY).starred).toBe(true);
  });

  /// The toast outlives a trip to the board: a star put on in the list and
  /// undone once the board shows it has to reach the card as well.
  it('undoing a star put on in the list takes it off the card the board now shows', async () => {
    primeStore([{ uid: 7, messageId: '<n1@x>', subject: 'Buy milk', flags: ['\\Seen'], from: { address: 'a1@x' }, date: '2026-08-01T10:00:00Z' }]);
    await toggleFlagged(7);
    openBoard([note({ starred: true, copies: [{ ...note().copies[0], flags: ['\\Seen', '\\Flagged'] }] })]);

    await useMailStore.getState().runUndo();

    await vi.waitFor(() => expect(cardOf(KEY).starred).toBe(false));
  });
});

describe('a delete undo with a caller of its own', () => {
  it('runs the caller once the messages are back, and not when they could not come back', async () => {
    primeStore();
    const afterRestore = vi.fn();
    mockDaemonCall.mockImplementation(async method => (method === 'deleted.recover'
      ? { recovered: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }] } : {}));

    await setDeleteUndo([{ accountId: 'a1', mailbox: 'INBOX', uid: 7, binId: 'bin-1' }], { afterRestore });
    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);
    expect(afterRestore).toHaveBeenCalledTimes(1);

    afterRestore.mockClear();
    mockDaemonCall.mockImplementation(async method => (method === 'deleted.recover'
      ? { recovered: [], failed: [{ id: 'bin-2', error: 'deletedBin.recoverFailed' }] } : {}));
    await setDeleteUndo([{ accountId: 'a1', mailbox: 'INBOX', uid: 8, binId: 'bin-2' }], { afterRestore });
    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);
    expect(afterRestore).not.toHaveBeenCalled();
  });

  it('a caller that cannot repaint does not turn a finished undo into a failed one', async () => {
    primeStore();
    mockDaemonCall.mockImplementation(async method => (method === 'deleted.recover'
      ? { recovered: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }] } : {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await setDeleteUndo([{ accountId: 'a1', mailbox: 'INBOX', uid: 7, binId: 'bin-1' }], {
      afterRestore: async () => { throw new Error('board gone'); },
    });

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);
    warn.mockRestore();
  });
});
