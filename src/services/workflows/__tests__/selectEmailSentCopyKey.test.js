// One selection key, in a list that does not span mailboxes.
//
// The INBOX list merges the account's own Sent copies in, so a reply you wrote
// is drawn as a row there. Every row decides "am I the open one?" through
// `selectionKey`, which gives that merged copy the full `accountId:Sent:uid`
// key — INBOX's own message under number 7 is a different message, and a bare
// uid cannot say which of the two was clicked. selectEmail wrote `rowKey`
// instead, which is the bare uid outside a spanning view: the two keys never
// compared equal, so clicking your own reply highlighted nothing.
//
// `selectThread` has written `selectionKey` since the merged-Sent-row fix;
// this is the click path catching up.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { selectionKey } from '../../../stores/slices/unifiedHelpers';

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
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
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

vi.mock('../probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const ACCT = { id: 'a1', email: 'me@mock.test' };

// The INBOX row and the reply the list merged in from Sent. Same account, same
// number, two different messages.
const INBOX_ROW = {
  uid: 7, messageId: 'inbox7@mock', subject: 'Their message', flags: [],
  from: { address: 'them@mock.test' }, date: '2026-09-01T10:00:00Z',
  _accountId: ACCT.id, _mailbox: 'INBOX',
};
const SENT_COPY = {
  uid: 7, messageId: 'sent7@mock', subject: 'Re: Their message', flags: ['\\Seen'],
  from: { address: ACCT.email }, date: '2026-09-01T11:00:00Z',
  _accountId: ACCT.id, _mailbox: 'Sent', _fromSentFolder: true, _isSent: true,
};

function prime(over = {}) {
  useMailStore.setState({
    accounts: [ACCT],
    activeAccountId: ACCT.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    viewMode: 'all',
    emails: [INBOX_ROW],
    sortedEmails: [INBOX_ROW, SENT_COPY],
    sentEmails: [SENT_COPY],
    localEmails: [],
    getSentMailboxPath: () => 'Sent',
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([7]), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 2,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    loadingEmail: false,
    error: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockFetchEmailLight.mockResolvedValue({ uid: 7, subject: 'Re: Their message', html: '<p>body</p>', flags: [] });
  prime();
});

describe('selectEmail writes the key the rows compare against', () => {
  it('gives a merged Sent copy its full key, the one selectionKey hands the row', async () => {
    await useMailStore.getState().selectEmail(7, 'server', 'Sent');

    const s = useMailStore.getState();
    expect(s.selectedEmailId).toBe(selectionKey(SENT_COPY, s));
    expect(s.selectedEmailId).toBe('a1:Sent:7');
    expect(s.error).toBe(null);
  });

  // The folder's own row is still the bare uid — a full key here would break
  // every reader that compares against `e.uid`.
  it('keeps the folder\'s own row on a bare uid', async () => {
    await useMailStore.getState().selectEmail(7, 'server');

    const s = useMailStore.getState();
    expect(s.selectedEmailId).toBe(7);
    expect(s.selectedEmailId).toBe(selectionKey(INBOX_ROW, s));
    expect(s.error).toBe(null);
  });
});
