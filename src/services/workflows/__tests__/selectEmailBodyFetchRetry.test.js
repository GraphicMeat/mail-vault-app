// A4: the slow-Gmail investigation traced the 45s BODY_FETCH_TIMEOUT and a
// dead pooled session ("... connection lost") as its two proven-transient
// failure modes for a body fetch — neither proves anything about the message,
// unlike a proven-gone uid (MessageGoneError). One quiet retry, while the
// same email is still the one on screen, turns most of those into an
// ordinary open instead of an error the user has to act on by hand.
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const ROW = {
  uid: 500,
  messageId: '<slow-gmail@example.test>',
  subject: 'Quarterly numbers',
  from: { address: 'finance@example.test' },
  date: '2026-09-26T20:00:00Z',
  flags: [],
};

/** What the daemon's BODY_FETCH_TIMEOUT produces, worded exactly as imap.rs does. */
function timeoutError(uid, mailbox = 'INBOX') {
  return new Error(`Timed out after 45s fetching message UID ${uid} from ${mailbox}`);
}

/** What the daemon actually sends for a dropped pooled session — `imap.rs`'s
 * `conn_lost_message` rewrite, not `pool.rs`'s raw wording. */
function connectionLostError() {
  return new Error('E_CONN_LOST: The connection to imap.example.test dropped while loading message 500');
}

/** What api.fetchEmailLight throws when the server proved the uid is gone. */
function goneError(uid, mailbox = 'INBOX') {
  const err = new Error(`Message UID ${uid} is no longer in ${mailbox}`);
  err.messageGone = true;
  err.uid = uid;
  err.mailbox = mailbox;
  return err;
}

function primeStore() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails: [{ ...ROW }],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    deleteTombstones: new Set(),
    totalEmails: 1,
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
  cancelInsightsSelection(); // reset the module's selection generation between tests
});

describe('selectEmail — one quiet retry on a timed-out or dropped body fetch', () => {
  it('retries once on a timeout and shows the body with no error', async () => {
    mockFetchEmailLight
      .mockRejectedValueOnce(timeoutError(500))
      .mockResolvedValueOnce({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(2);
    const state = useMailStore.getState();
    expect(state.selectedEmail?.html).toBe('<p>the numbers</p>');
    expect(state.selectedEmail?._bodyError).toBeUndefined();
    expect(state.selectedEmailSource).toBe('server');
    // Still fenced on the same selection — the retry did not reopen anything.
    expect(state.selectedEmailId).toBe(500);
  });

  it('retries once on a dropped pooled session too', async () => {
    mockFetchEmailLight
      .mockRejectedValueOnce(connectionLostError())
      .mockResolvedValueOnce({ uid: 500, html: '<p>the numbers</p>', flags: [] });
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(2);
    expect(useMailStore.getState().selectedEmail?._bodyError).toBeUndefined();
  });

  it('gives up after one retry and reports the error like any other failed fetch', async () => {
    mockFetchEmailLight.mockRejectedValue(timeoutError(500));
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(2);
    expect(useMailStore.getState().selectedEmail?._bodyError).toContain('Timed out');
  });

  it('never retries a uid the server proved gone', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(500));
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    // Retrying a proven-gone uid would only re-ask the question the server
    // already answered — see AccountPipeline's own fix for the same fact.
    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().selectedEmail?._bodyGone).toBe(true);
  });

  it('never retries an ordinary refusal that says nothing about a timeout', async () => {
    mockFetchEmailLight.mockRejectedValue(new Error('Server refused UID FETCH 500: no response'));
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
  });

  it('does not retry once the user has switched to another email', async () => {
    // The first attempt's own await is where a real switch would land — model
    // it by bumping the module's selection generation from inside the mock,
    // the same effect a second selectEmail() call has via cancelInsightsSelection.
    mockFetchEmailLight.mockImplementation(async () => {
      cancelInsightsSelection();
      throw timeoutError(500);
    });
    primeStore();

    await useMailStore.getState().selectEmail(500, 'server');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
  });
});
