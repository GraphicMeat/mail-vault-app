// Bug report (2026-09-14): a message found by search in the vault will not
// open - "Cannot tell which account and folder hold message 282. Reload the
// list and try again." The user searched "from the inbox"; the hit was in Sent.
//
// Both halves of that sentence are the same state. The current All Inboxes
// scope is the selected unified folder, so this regression explicitly asks for
// all folders to include Sent. The refusal only exists in a view that spans
// mailboxes (selectEmail.js, `isUnified && !unified`), and `_resolveUnifiedContext`
// answers from the loaded lists only, never from searchResults, so a Sent hit
// must carry its own account/folder identity through selection.
//
// Shape of the real account (info@moderniosaplikacijos.lt, mailboxes.json):
// INBOX, Sent (\Sent), Sent Messages (\Sent, listed later), and the message
// "didelis laiskas" filed twice in Sent as uid 282 and 283 under one
// Message-ID. The key here is the one the hit's row names (`_selKey`): what the
// list row's click must send is pinned in EmailRowSpanningSelect.test.jsx, and
// the same full key in a folder branch in selectEmailSearchHitUnresolved.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _selKey } from '../../../stores/slices/unifiedHelpers';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockFetchEmails = vi.fn();
const mockGetEmailHeadersPartial = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSearch = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../mailSearch.js', () => ({
  startMailSearch: (...args) => mockSearch.start(...args),
  cancelMailSearch: (...args) => mockSearch.cancel(...args),
}));

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX' }]),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
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
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: vi.fn().mockResolvedValue({ exists: 0 }),
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
  effectiveSearchMailboxConcurrency: () => 1,
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
      addSearchToHistory: () => {},
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
const { useSearchStore } = await import('../../../stores/searchStore');

const ACCT_A = { id: 'acct-a', email: 'info@moderniosaplikacijos.lt', imapHost: 'h', password: 'x' };

// Two real, distinct vault files under one Message-ID (Sent/282 and
// Sent/283 in the actual account) — db.searchLocalEmails stamps each with its
// own folder, the way the local Maildir search really does.
const MESSAGE_ID = '<640a1b1e-b1be-41bb-a270-9566012b3ef4@Spark>';
const searchHit = (uid) => ({
  uid, _accountId: ACCT_A.id, _mailbox: 'Sent', source: 'local', isArchived: true, isLocal: true,
  messageId: MESSAGE_ID, subject: 'didelis laiskas',
  from: { name: 'info', address: ACCT_A.email },
  to: [{ name: 'G ir G Partneriai', address: 'gng@example.test' }],
  date: '2017-03-02T10:00:00Z', flags: ['\\Seen'],
});
const LOADED_ROW = { uid: 900, messageId: '<900@mock>', subject: 'recent', date: '2026-09-01T10:00:00Z', flags: ['\\Seen'] };

function baseState() {
  useMailStore.setState({
    accounts: [ACCT_A],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    mailboxes: [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', children: [] },
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent', children: [] },
      { path: 'Sent Messages', name: 'Sent Messages', specialUse: '\\Sent', children: [] },
    ],
    viewMode: 'all',
    emails: [],
    sortedEmails: [],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    loadingEmail: false,
    error: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [LOADED_ROW], totalEmails: 1 });
  mockFetchEmails.mockResolvedValue({ emails: [LOADED_ROW] });
  mockSearch.start.mockImplementation(async (request, onProgress) => {
    onProgress({
      searchId: request.searchId,
      sequence: 1,
      lane: 'local',
      rows: [searchHit(282), searchHit(283)],
      completed: 1,
      total: 1,
      localMode: 'index',
      coverage: { indexed: 2, total: 2, complete: true, matched: 2, shown: 2 },
      terminal: 'complete',
    });
    return { unlisten: vi.fn() };
  });
  baseState();
  useSearchStore.setState({
    searchActive: false, searchQuery: '', searchResults: [], isSearching: false,
    searchProgress: null, searchIndexCoverage: null,
    // 'local': the vault half is the one that found it. The api mock has no
    // searchEmails, so 'all' would throw inside performSearch and come back as
    // an empty result list.
    searchFilters: { location: 'local', folder: 'current', sender: '', dateFrom: null, dateTo: null, hasAttachments: false },
  });
});

async function searchFromUnifiedInbox() {
  useMailStore.setState({ unifiedInbox: true });
  await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
  expect(useMailStore.getState().activeMailbox).toBe('UNIFIED');
  useSearchStore.getState().setSearchFilters({ location: 'local', folder: 'all' });
  useSearchStore.setState({ searchQuery: 'didelis laiskas' });
  await useSearchStore.getState().performSearch();
  return useSearchStore.getState().searchResults;
}

describe('a vault search hit in Sent, from an All Inboxes all-folders search', () => {
  // Precondition, green at HEAD: the search half already tags each hit with
  // its real account and folder, so everything the click needs is on the row.
  it('is found by performSearch, tagged with its real folder', async () => {
    const rows = await searchFromUnifiedInbox();
    // The daemon receives explicit target metadata; all local folders are
    // represented by null rather than a frontend fan-out of mailbox reads.
    expect(mockSearch.start).toHaveBeenCalledTimes(1);
    expect(mockSearch.start.mock.calls[0][0]).toMatchObject({
      query: 'didelis laiskas',
      location: 'local',
      targets: [expect.objectContaining({ accountId: ACCT_A.id, localMailboxes: null })],
    });
    // Two files, one Message-ID: search shows the message once, the first copy.
    expect(rows.map(r => r.uid)).toEqual([282]);
    for (const row of rows) {
      expect(row._accountId).toBe(ACCT_A.id);
      expect(row._mailbox).toBe('Sent');
    }
  });

  it('opens from Sent by the key its row names', async () => {
    const hit = (await searchFromUnifiedInbox()).find(r => r.uid === 282);
    // The loaded window holds recent INBOX mail only, as it really does.
    expect(useMailStore.getState().sortedEmails.some(e => e.uid === 282)).toBe(false);
    // maildir_read_light's LightEmail for the real Sent/282: its file has no
    // top-level Content-Type, so it parses as one text/plain part and `html`
    // serializes as null (not absent).
    mockGetLocalEmailLight.mockResolvedValue({
      uid: 282, messageId: MESSAGE_ID, subject: 'didelis laiskas', text: 'didelis laiskas', html: null, attachments: [], flags: ['\\Seen'],
    });

    await useMailStore.getState().selectEmail(_selKey(hit), hit.source, hit._mailbox);

    const state = useMailStore.getState();
    expect(state.error).toBe(null);
    expect(state.selectedEmail?.uid).toBe(282);
    expect(state.selectedEmail?._accountId).toBe(ACCT_A.id);
    expect(state.selectedEmail?._mailbox).toBe('Sent');
    expect(mockGetLocalEmailLight).toHaveBeenCalledWith(ACCT_A.id, 'Sent', 282);
  });

  it('does not open a cached body that disagrees with the clicked search row', async () => {
    const hit = (await searchFromUnifiedInbox()).find(r => r.uid === 282);
    const localOnlyHit = { ...hit, source: 'local-only' };
    useMailStore.getState().addToCache(`${ACCT_A.id}-Sent-282`, {
      uid: 282, messageId: '<stale-cache@example.test>', subject: 'wrong cached message',
      text: 'wrong cached body', html: '<p>wrong cached body</p>',
    }, 128);
    mockGetLocalEmailLight.mockResolvedValue(null);

    await useMailStore.getState().selectEmail(
      _selKey(localOnlyHit), localOnlyHit.source, localOnlyHit._mailbox, undefined, localOnlyHit,
    );

    const state = useMailStore.getState();
    expect(state.selectedEmail?.messageId).toBe(hit.messageId);
    expect(state.selectedEmail?.subject).toBe(hit.subject);
    expect(state.selectedEmail?._bodyError).toBeTruthy();
    expect(state.selectedEmail?.text).not.toBe('wrong cached body');
  });

  it('does not open a Maildir body that disagrees with the clicked search row', async () => {
    const hit = (await searchFromUnifiedInbox()).find(r => r.uid === 282);
    const localOnlyHit = { ...hit, source: 'local-only' };
    mockGetLocalEmailLight.mockResolvedValue({
      uid: 282, messageId: '<stale-maildir@example.test>', subject: 'wrong Maildir message',
      text: 'wrong Maildir body', html: '<p>wrong Maildir body</p>', flags: [],
    });

    await useMailStore.getState().selectEmail(
      _selKey(localOnlyHit), localOnlyHit.source, localOnlyHit._mailbox, undefined, localOnlyHit,
    );

    const state = useMailStore.getState();
    expect(state.selectedEmail?.messageId).toBe(hit.messageId);
    expect(state.selectedEmail?.subject).toBe(hit.subject);
    expect(state.selectedEmail?._bodyError).toBeTruthy();
    expect(state.selectedEmail?.text).not.toBe('wrong Maildir body');
  });
});
