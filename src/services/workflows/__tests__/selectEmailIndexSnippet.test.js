// Download modes (Track H, H5): a message with no copy on this computer (On
// Demand, or evicted by Keep Recent / Index Only) opens on the search index's
// stored snippet at once, with a loading marker, and the full body swaps in
// when the server answers. Still fenced on the selection: a switch to another
// message before the fetch returns never swaps the old body in.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockGetEmailHeadersByUids = vi.fn().mockResolvedValue([]);
const mockDeleteLocalEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
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

vi.mock('../probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { cancelInsightsSelection } = await import('../selectEmail');

const ACCOUNT = { id: 'acct1', email: 'thecoldzero@mock.test' };
const row = (uid, subject) => ({
  uid, messageId: `<m${uid}@example.test>`, subject,
  from: { address: 'finance@example.test' }, date: '2020-01-01T12:00:00Z', flags: [],
});
const ROW_A = row(500, 'Quarterly numbers');
const ROW_B = row(501, 'Lunch');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function primeStore() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails: [{ ...ROW_A }, { ...ROW_B }],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    deleteTombstones: new Set(),
    totalEmails: 2,
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
  mockSaveEmailHeaders.mockResolvedValue(undefined);
  mockGetEmailHeadersByUids.mockImplementation(async (accountId, mailbox, uids) =>
    uids.map(uid => ({ uid, previewText: `snippet of ${uid}` })));
  cancelInsightsSelection();
});

describe('selectEmail: vault miss opens on the index snippet', () => {
  it('shows the snippet at once, then swaps in the fetched body', async () => {
    const body = deferred();
    mockFetchEmailLight.mockReturnValueOnce(body.promise);
    primeStore();

    const opening = useMailStore.getState().selectEmail(500, 'server');
    await vi.waitFor(() => expect(useMailStore.getState().selectedEmail?.text).toBe('snippet of 500'));
    let state = useMailStore.getState();
    expect(state.selectedEmail._bodyLoading).toBe(true);
    expect(state.selectedEmail.subject).toBe('Quarterly numbers');
    expect(state.loadingEmail).toBe(false);
    expect(mockGetEmailHeadersByUids).toHaveBeenCalledWith('acct1', 'INBOX', [500]);

    body.resolve({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    await opening;
    state = useMailStore.getState();
    expect(state.selectedEmail.html).toBe('<p>the numbers</p>');
    expect(state.selectedEmail._bodyLoading).toBeUndefined();
    // The snippet never reaches the body cache: a reopen must not show it.
    expect(state.getFromCache('acct1-INBOX-500')?.html).toBe('<p>the numbers</p>');
  });

  it('uses a preview the list row already carries without asking the index', async () => {
    const body = deferred();
    mockFetchEmailLight.mockReturnValueOnce(body.promise);
    primeStore();
    useMailStore.setState({ emails: [{ ...ROW_A, previewText: 'from the row' }, { ...ROW_B }] });
    useMailStore.getState().updateSortedEmails();

    const opening = useMailStore.getState().selectEmail(500, 'server');
    await vi.waitFor(() => expect(useMailStore.getState().selectedEmail?.text).toBe('from the row'));
    expect(mockGetEmailHeadersByUids).not.toHaveBeenCalled();
    body.resolve({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    await opening;
  });

  it('a switch to another email before the fetch returns does not swap the old body in', async () => {
    const bodyA = deferred();
    mockFetchEmailLight
      .mockReturnValueOnce(bodyA.promise)
      .mockResolvedValueOnce({ uid: 501, html: '<p>lunch</p>', flags: [] });
    primeStore();

    const openingA = useMailStore.getState().selectEmail(500, 'server');
    await vi.waitFor(() => expect(useMailStore.getState().selectedEmail?.text).toBe('snippet of 500'));
    await useMailStore.getState().selectEmail(501, 'server');
    expect(useMailStore.getState().selectedEmail.html).toBe('<p>lunch</p>');

    bodyA.resolve({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    await openingA;
    const state = useMailStore.getState();
    expect(state.selectedEmailId).toBe(501);
    expect(state.selectedEmail.html).toBe('<p>lunch</p>');
  });

  it('a snippet that arrives after the body never replaces it', async () => {
    const snippet = deferred();
    mockGetEmailHeadersByUids.mockReturnValueOnce(snippet.promise);
    mockFetchEmailLight.mockResolvedValueOnce({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');
    snippet.resolve([{ uid: 500, previewText: 'late snippet' }]);
    await new Promise(r => setTimeout(r, 0));
    expect(useMailStore.getState().selectedEmail.html).toBe('<p>the numbers</p>');
    expect(useMailStore.getState().selectedEmail._bodyLoading).toBeUndefined();
  });

  it('a failed snippet read never holds up or breaks the open', async () => {
    mockGetEmailHeadersByUids.mockRejectedValueOnce(new Error('daemon busy'));
    mockFetchEmailLight.mockResolvedValueOnce({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');
    expect(useMailStore.getState().selectedEmail.html).toBe('<p>the numbers</p>');
    expect(useMailStore.getState().selectedEmail._bodyError).toBeUndefined();
  });

  it('the Insights reader (an explicit location) shows the snippet first too', async () => {
    const body = deferred();
    mockFetchEmailLight.mockReturnValueOnce(body.promise);
    primeStore();
    const header = { ...ROW_A, _accountId: 'acct1', _mailbox: 'INBOX', _insightsReadOnly: true };
    const location = { accountId: 'acct1', mailbox: 'INBOX', uid: 500, header };

    const opening = useMailStore.getState().selectEmail(500, 'server', null, location);
    await vi.waitFor(() => expect(useMailStore.getState().selectedEmail?.text).toBe('snippet of 500'));
    expect(useMailStore.getState().selectedEmail._bodyLoading).toBe(true);
    expect(useMailStore.getState().selectedEmail._insightsReadOnly).toBe(true);
    expect(useMailStore.getState().loadingEmail).toBe(false);

    body.resolve({ uid: 500, messageId: ROW_A.messageId, html: '<p>the numbers</p>', flags: [] });
    await opening;
    expect(useMailStore.getState().selectedEmail.html).toBe('<p>the numbers</p>');
    expect(useMailStore.getState().selectedEmail._bodyLoading).toBeUndefined();
  });
});
