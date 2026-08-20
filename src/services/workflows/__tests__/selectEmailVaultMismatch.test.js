// The vault Maildir is keyed (accountId, mailbox, uid) and carries no
// UIDVALIDITY stamp, so a uid the vault archived under one generation of a
// mailbox names a different message after the server reissues its UID space —
// a change-server migration, or a reissue the server does on its own.
//
// Real instance: rare@graphicmeat.com moved to Purelymail. The server's INBOX
// uid 1 is "Welcome to Purelymail!"; the vault's INBOX uid 1 is a Hostinger
// welcome mail from the previous host. selectEmail prefers the vault copy, so
// clicking the Purelymail row rendered the Hostinger message whole — sender,
// date, subject and body. Nothing errored: the read landed on a real message,
// just not this one.
//
// useChatBodyLoader has guarded this with bodyMatchesHeader() since the thread
// -view instance; the single-message viewer never got the same guard.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);

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
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
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
  setGraphIdMap: () => {},
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

const ACCOUNT = { id: 'acct1', email: 'rare@mock.test' };

// The server's uid 1 in the reissued UID space.
const SERVER_HEADER = {
  uid: 1,
  messageId: '<welcome@purelymail.test>',
  subject: 'Welcome to Purelymail!',
  flags: ['\\Seen'],
  from: { address: 'support@purelymail.test' },
  date: '2026-06-03T06:34:36Z',
};

// What the vault still holds under uid 1, from the previous host.
const STALE_VAULT_COPY = {
  uid: 1,
  messageId: '<older@hostinger.test>',
  subject: 'Get started with business email',
  from: { address: 'team@hostinger.test' },
  date: '2026-03-19T07:56:23Z',
  html: '<p>previous host welcome</p>',
  text: 'previous host welcome',
};

const SERVER_BODY = {
  ...SERVER_HEADER,
  html: '<p>purelymail welcome</p>',
  text: 'purelymail welcome',
};

function primeStore(emails = [SERVER_HEADER]) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(emails.map(e => e.uid)), { complete: false }),
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

const viewer = () => useMailStore.getState().selectedEmail;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockFetchEmailLight.mockResolvedValue(SERVER_BODY);
});

describe('selectEmail — vault copy that belongs to another message', () => {
  it('discards a vault body whose Message-ID contradicts the row and fetches from the server', async () => {
    mockGetLocalEmailLight.mockResolvedValue(STALE_VAULT_COPY);
    primeStore();

    await useMailStore.getState().selectEmail(1, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    expect(viewer().messageId).toBe('<welcome@purelymail.test>');
    expect(viewer().subject).toBe('Welcome to Purelymail!');
  });

  it('never caches the mismatched vault body under the row it was read for', async () => {
    mockGetLocalEmailLight.mockResolvedValue(STALE_VAULT_COPY);
    primeStore();

    await useMailStore.getState().selectEmail(1, 'server');

    const cached = useMailStore.getState().getFromCache(`${ACCOUNT.id}-INBOX-1`);
    expect(cached?.messageId).toBe('<welcome@purelymail.test>');
  });

  it('still serves the vault copy when the Message-IDs agree', async () => {
    mockGetLocalEmailLight.mockResolvedValue({ ...SERVER_HEADER, html: '<p>vault</p>', text: 'vault' });
    primeStore();

    await useMailStore.getState().selectEmail(1, 'server');

    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    expect(viewer().text).toBe('vault');
    expect(useMailStore.getState().selectedEmailSource).toBe('local');
  });

  it('still serves a vault copy that carries no Message-ID — absence is not a contradiction', async () => {
    mockGetLocalEmailLight.mockResolvedValue({ uid: 1, subject: 'Welcome to Purelymail!', html: '<p>vault</p>', text: 'vault' });
    primeStore();

    await useMailStore.getState().selectEmail(1, 'server');

    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    expect(viewer().text).toBe('vault');
  });

  it('reports a body error for a local-only row whose vault copy is another message', async () => {
    // Nothing on the server to fall back to: rendering the wrong message is the
    // only other option, so the viewer must say the body could not be loaded.
    mockGetLocalEmailLight.mockResolvedValue(STALE_VAULT_COPY);
    primeStore([{ ...SERVER_HEADER, source: 'local-only' }]);

    await useMailStore.getState().selectEmail(1, 'local-only');

    expect(viewer().messageId).toBe('<welcome@purelymail.test>');
    expect(viewer()._bodyError).toBeTruthy();
    expect(useMailStore.getState().selectedEmailSource).toBe('header-only');
  });
});
