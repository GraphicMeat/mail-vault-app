// Bug report (2026-09-14): the body-load retry button and FullViewEmailModal's
// initial fetch both call `selectEmail(uid, source)` with a bare uid. That is
// exactly the mistake `requireUnifiedContext` was built to refuse: in a
// spanning view a message outside the loaded lists (an old search hit,
// insights' Explorer target) is opened by its full key
// (`accountId:mailbox:uid`, EmailRow's `openRow`), and a bare-uid retry on
// that same message throws "Cannot tell which account and folder hold message
// ..." instead of reloading it - turning a transient fetch failure into a
// dead end with no way back to the message.
//
// Mocks copied from selectEmailVaultSearchHitInSent.test.js so this spec
// stands alone.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t as tr } from '../../../i18n/index.js';
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
const mockSearchLocalEmails = vi.fn();

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  searchLocalEmails: (...a) => mockSearchLocalEmails(...a),
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

const ACCT_A = { id: 'acct-a', email: 'info@moderniosaplikacijos.lt', imapHost: 'h', password: 'x' };
const MESSAGE_ID = '<640a1b1e-b1be-41bb-a270-9566012b3ef4@Spark>';
// The loaded window: recent INBOX mail only. Sent/282 below is deliberately
// absent from it - that is the "outside the loaded list" the retry has to
// survive.
const LOADED_ROW = { uid: 900, messageId: '<900@mock>', subject: 'recent', date: '2026-09-01T10:00:00Z', flags: ['\\Seen'] };

function baseState() {
  useMailStore.setState({
    accounts: [ACCT_A],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    mailboxes: [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', children: [] },
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent', children: [] },
    ],
    viewMode: 'all',
    emails: [LOADED_ROW],
    sortedEmails: [LOADED_ROW],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 1,
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
  baseState();
});

describe('retrying a spanning-view row that is outside the loaded lists', () => {
  it('opens Sent/282 by its full key, then the fixed retry (same key) succeeds again', async () => {
    mockGetLocalEmailLight.mockResolvedValue({
      uid: 282, messageId: MESSAGE_ID, subject: 'didelis laiskas', text: 'didelis laiskas', html: null, attachments: [], flags: ['\\Seen'],
    });

    // The initial open, exactly as EmailRow's openRow sends it for a row
    // outside the loaded window (a search hit, or an insights target).
    await useMailStore.getState().selectEmail(`${ACCT_A.id}:Sent:282`, 'local', 'Sent');
    let state = useMailStore.getState();
    expect(state.error).toBe(null);
    expect(state.selectedEmail?.uid).toBe(282);
    expect(state.selectedEmail?._accountId).toBe(ACCT_A.id);
    expect(state.selectedEmail?._mailbox).toBe('Sent');

    // The retry the fixed callers now build: `_selKey(selectedEmail)`, not the
    // bare uid. Same message, same result.
    const retryKey = _selKey(state.selectedEmail);
    expect(retryKey).toBe(`${ACCT_A.id}:Sent:282`);
    await useMailStore.getState().selectEmail(retryKey, 'server');

    state = useMailStore.getState();
    expect(state.error).toBe(null);
    expect(state.selectedEmail?.uid).toBe(282);
    expect(state.selectedEmail?._accountId).toBe(ACCT_A.id);
    expect(state.selectedEmail?._mailbox).toBe('Sent');
    expect(state.error).not.toBe(tr('errors.unresolvedUnifiedRow', { key: 282 }));
  });

  it('documents the bug: the OLD bare-uid retry throws the unresolved-row error and drops the open message', async () => {
    mockGetLocalEmailLight.mockResolvedValue({
      uid: 282, messageId: MESSAGE_ID, subject: 'didelis laiskas', text: 'didelis laiskas', html: null, attachments: [], flags: ['\\Seen'],
    });

    await useMailStore.getState().selectEmail(`${ACCT_A.id}:Sent:282`, 'local', 'Sent');
    expect(useMailStore.getState().selectedEmail?.uid).toBe(282);

    // What EmailViewer's retry button and FullViewEmailModal's effect sent
    // before the fix - the row's bare uid, unreachable in a spanning view.
    await useMailStore.getState().selectEmail(useMailStore.getState().selectedEmail.uid, 'server');

    const state = useMailStore.getState();
    expect(state.error).toBe(tr('errors.unresolvedUnifiedRow', { key: 282 }));
    expect(state.selectedEmail).toBe(null);
  });
});
