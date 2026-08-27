// Reply and forward leave from the mailbox the message is in — which means the
// message has to still know which one that was. It doesn't: a body comes back
// from the server (or the vault) with no account on it, and the row click that
// asked for it forwarded a bare uid. Compose then fell through to whichever
// identity had sent last, and the reply left from the wrong mailbox.
// Reported 2026-08-26 against a thread read in rare@graphicmeat.com.
//
// selectEmail is where the account is known, so it is where the stamp belongs.
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

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
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

vi.mock('../../api', () => ({
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

describe('selectEmail — the account a message was read from', () => {
  it('stamps it on a body fetched from the server', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>' });
    primeStore();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().selectedEmail._accountId).toBe(A.id);
  });

  it('stamps the row\'s account in the unified list, not whichever one is active', async () => {
    const foreign = { ...MSG, _accountId: B.id, _mailbox: 'INBOX' };
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>' });
    primeStore({ unified: true, emails: [foreign] });

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().selectedEmail._accountId).toBe(B.id);
  });

  it('leaves an account already on the message alone', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, _accountId: B.id, html: '<p>body</p>' });
    primeStore();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().selectedEmail._accountId).toBe(B.id);
  });
});
