// Marking a VAULT row read, from the all-inboxes list.
//
// A message the vault holds but the server list does not is in `localEmails`
// and in no other array — deriveDisplayRows pushes it onto the list from there.
// Every read-state mutation used to map `emails` alone, so the row on screen
// never changed: the reported symptom was "mark as read does nothing at all".
// The flag also has to reach local-index.json, or the row reverts to unread on
// the next folder switch, which looks the same to the person using it.
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

vi.mock('../../api', () => ({
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

  it('writes the flag into local-index.json so it survives a reload', async () => {
    primeUnifiedVault([]);

    await useMailStore.getState().markSelectedAsRead();

    expect(mockAppendLocalIndex).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', [expect.objectContaining({ uid: UID, flags: ['\\Seen'] })],
    );
  });

  it('takes the flag back off again on mark-unread', async () => {
    primeUnifiedVault(['\\Seen']);
    mockGetLocalIndexEntry.mockResolvedValue({ uid: UID, flags: ['\\Seen'] });

    await useMailStore.getState().markSelectedAsUnread();

    expect(rowSeen()).toBe(false);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', [expect.objectContaining({ flags: [] })],
    );
  });

  // A vault-only message has no server copy; a failing IMAP call must not undo
  // what already happened on screen and on disk.
  it('keeps the row read when the server call fails', async () => {
    primeUnifiedVault([]);
    mockUpdateEmailFlags.mockRejectedValueOnce(new Error('no such message'));

    await useMailStore.getState().markSelectedAsRead();

    expect(rowSeen()).toBe(true);
    expect(mockAppendLocalIndex).toHaveBeenCalled();
  });

  it('leaves the vault index alone for a message the vault does not hold', async () => {
    primeUnifiedVault([]);
    useMailStore.setState({ archivedEmailIds: new Set() });

    await useMailStore.getState().markSelectedAsRead();

    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });
});
