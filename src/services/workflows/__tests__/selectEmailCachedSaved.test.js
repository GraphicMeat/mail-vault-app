// Opening a server message used to re-list the whole vault folder
// (getSavedEmailIds) just to learn whether the body it had fetched was now
// cached, and then replaced the view's saved set with that one folder's (wrong
// in a spanning view). The daemon already knows: imap_get_email_light caches
// the body and answers `cached: true`, which api.fetchEmailLight carries as
// `email.vaultCached`. selectEmail adds the SERVER's uid from that, with no
// vault read at all.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockDeleteLocalEmail = vi.fn().mockResolvedValue(undefined);
const mockGetVaultUidSets = vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() });
const mockSend = vi.fn().mockResolvedValue(null);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: (...a) => mockGetVaultUidSets(...a),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: (...a) => mockDeleteLocalEmail(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

// Every daemon call this path makes, so the test can prove none is a vault read.
vi.mock('../../transport', async (importOriginal) => ({
  ...await importOriginal(),
  send: (...a) => mockSend(...a),
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
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
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

const A = { id: 'acctA', email: 'rare@mock.test' };
const B = { id: 'acctB', email: 'grill@mock.test' };

const MSG = {
  uid: 42,
  messageId: '<msg42@example.test>',
  subject: 'Price for what?',
  from: { address: 'someone@example.test' },
  date: '2026-08-26T21:27:00Z',
  flags: ['\\Seen'],
};

function primeStore({ unified = false, emails = [MSG] } = {}) {
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: A.id,
    activeMailbox: unified ? 'UNIFIED' : 'INBOX',
    viewMode: 'all',
    emails: [...emails],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(emails.map(e => e.uid)), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  useMailStore.getState().updateSortedEmails();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
});

const VAULT_READS = ['vault_uid_sets', 'vault_light_rows', 'maildir_list', 'maildir_read_light_batch', 'maildir_exists'];
const vaultReads = () => mockSend.mock.calls.map(([cmd]) => cmd).filter(cmd => VAULT_READS.includes(cmd));

describe('selectEmail marks a body the daemon cached as saved, with no vault read', () => {
  it('adds the uid when the fetch reports it cached', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>', vaultCached: true });
    primeStore();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().savedEmailIds.has(42)).toBe(true);
    expect(mockGetVaultUidSets).not.toHaveBeenCalled();
    expect(vaultReads()).toEqual([]);
  });

  it('adds the server\'s uid, the one the file was stored under', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, uid: 43, html: '<p>body</p>', vaultCached: true });
    primeStore();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().savedEmailIds.has(43)).toBe(true);
  });

  it('keeps every other id a spanning view already holds', async () => {
    const foreign = { ...MSG, _accountId: B.id, _mailbox: 'INBOX' };
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>', vaultCached: true });
    primeStore({ unified: true, emails: [foreign] });
    useMailStore.setState({ savedEmailIds: new Set([7, 8]) });

    await useMailStore.getState().selectEmail(42, 'server');

    expect([...useMailStore.getState().savedEmailIds].sort((a, b) => a - b)).toEqual([7, 8, 42]);
    expect(vaultReads()).toEqual([]);
  });

  it('adds nothing when the daemon did not cache it', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>' });
    primeStore();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().savedEmailIds.has(42)).toBe(false);
    expect(vaultReads()).toEqual([]);
  });
});
