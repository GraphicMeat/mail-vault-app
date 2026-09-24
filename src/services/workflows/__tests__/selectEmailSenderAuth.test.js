// The viewer's SPF/DKIM shield reads `authenticationResults` (and
// `returnPath`) off the message it is handed. Only the header sync row carries
// them: the light body fetch (LightFullEmail) and the vault light read never
// did, so every open message published without them and the shield never
// drew. selectEmail's withAccount now carries them over from the row, the way
// it already carried listId/listUnsubscribe/precedence.
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

const AUTH = 'mx.google.com; dkim=pass header.i=@example.test; spf=pass smtp.mailfrom=example.test; dmarc=pass';
const ROW = { ...MSG, authenticationResults: AUTH, returnPath: '<bounce@example.test>' };

describe('selectEmail keeps the row\'s sender-auth headers on the opened message', () => {
  it('server fetch', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>' });
    primeStore({ emails: [ROW] });

    await useMailStore.getState().selectEmail(42, 'server');

    const opened = useMailStore.getState().selectedEmail;
    expect(opened.authenticationResults).toBe(AUTH);
    expect(opened.returnPath).toBe('<bounce@example.test>');
  });

  it('vault copy', async () => {
    mockGetLocalEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>' });
    primeStore({ emails: [ROW] });

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().selectedEmail.authenticationResults).toBe(AUTH);
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });

  it('a body that carries its own value keeps it', async () => {
    mockFetchEmailLight.mockResolvedValue({ ...MSG, html: '<p>body</p>', authenticationResults: 'own; spf=fail' });
    primeStore({ emails: [ROW] });

    await useMailStore.getState().selectEmail(42, 'server');

    expect(useMailStore.getState().selectedEmail.authenticationResults).toBe('own; spf=fail');
  });
});
