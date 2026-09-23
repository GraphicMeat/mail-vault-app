// A message deleted from the mailbox somewhere else — another client, a phone,
// a server-side filter — leaves a row behind. The header sidecar still has it,
// so it sits in the list (at the top, if it was the newest), and every click
// on it fails. Reported 2026-08-24 against a Gmail INBOX: "Autodesk Viewer -
// 'mituvos 7_planas.dwg' is ready to view", eight clicks, eight failures, the
// row never moving. A second mail client's INBOX did not list it at all.
//
// The server's answer is now a proven one — `Ok(None)` is reachable only after
// a tagged OK with no rows (uid_still_present, src-core/src/imap/mod.rs) — and
// api.fetchEmailLight turns it into an error carrying `messageGone`. Only that
// error may prune the row; every other failure proves nothing about the server.
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

const mockProbeServerCopy = vi.fn().mockResolvedValue({ state: 'unknown' });
vi.mock('../probeServerCopy', () => ({
  probeServerCopy: (...a) => mockProbeServerCopy(...a),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');

const ACCOUNT = { id: 'acct1', email: 'thecoldzero@mock.test' };

const VANISHED = {
  uid: 31056,
  messageId: '<ufAXSvDPTQK2e3yXNk0Mtg@geopod-ismtpd-31>',
  subject: "Autodesk Viewer - 'mituvos 7_planas.dwg' is ready to view",
  from: { address: 'noreply@autodesk.com' },
  date: '2026-08-24T13:23:52Z',
  flags: [],
};

const NEIGHBOUR = {
  uid: 31051,
  messageId: '<neighbour@example.test>',
  subject: 'Still here',
  from: { address: 'someone@example.test' },
  date: '2026-08-24T12:00:00Z',
  flags: [],
};

/** What api.fetchEmailLight throws when the server proved the uid is gone. */
function goneError(uid, mailbox = 'INBOX') {
  const err = new Error(`Message UID ${uid} is no longer in ${mailbox}`);
  err.messageGone = true;
  err.uid = uid;
  err.mailbox = mailbox;
  return err;
}

function primeStore(emails = [VANISHED, NEIGHBOUR]) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails: [...emails],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    // Complete on purpose: a removal from a complete enumeration keeps it
    // complete, which is what lets an archived twin read "deleted from server".
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

const uids = () => useMailStore.getState().emails.map(e => e.uid);
const rowUids = () => useMailStore.getState().sortedEmails.map(e => e.uid);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockSaveEmailHeaders.mockResolvedValue(undefined);
});

describe('selectEmail — a row the server no longer holds', () => {
  it('drops the row, and only that row', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(uids()).toEqual([31051]);
    expect(rowUids()).toEqual([31051]);
    expect(useMailStore.getState().totalEmails).toBe(1);
  });

  it('takes the uid out of the server set, so an archived twin can read local-only', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    const set = useMailStore.getState().serverUids;
    expect(set.uids.has(31056)).toBe(false);
    expect(set.complete).toBe(true);
  });

  it('writes the removal through to the header cache — the row came back on reload before', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(mockSaveEmailHeaders).toHaveBeenCalledTimes(1);
    const [accountId, mailbox, headers, total, opts] = mockSaveEmailHeaders.mock.calls[0];
    expect(accountId).toBe('acct1');
    expect(mailbox).toBe('INBOX');
    // The prune and the count, never the rows: the cache holds them already,
    // and re-sending the list serialised the whole mailbox for one removal.
    expect(headers).toEqual([]);
    expect(total).toBe(1);
    expect(opts).toEqual({ removedUids: [31056] });
  });

  it('says why, and does not reload the whole mailbox to do it', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    // The viewer keeps the header it just rendered, with the reason on it —
    // a row that vanishes with no explanation is its own bug.
    const viewer = useMailStore.getState().selectedEmail;
    expect(viewer?.uid).toBe(31056);
    expect(viewer?._bodyError).toContain('no longer in INBOX');

    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
  });

  it('never touches the vault — this is not a delete', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(mockDeleteLocalEmail).not.toHaveBeenCalled();
  });

  it('asks the server about every folder when the vanished message is in the vault', async () => {
    // The server proved ONE mailbox lost it, which is also what an archive, a
    // filter and a delete-to-Bin look like. For a message the vault holds, the
    // difference between those and "someone else destroyed it" is the whole
    // custody claim — so ask, instead of guessing either way.
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();
    useMailStore.setState({ archivedEmailIds: new Set([31056]) });

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(mockProbeServerCopy).toHaveBeenCalledWith(31056, { accountId: ACCOUNT.id, mailbox: 'INBOX' });
  });

  it('does not sweep the server for a message the vault never kept', async () => {
    // Nothing rides on the answer: the row is leaving the list either way, and
    // a sweep is a SELECT per folder.
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(mockProbeServerCopy).not.toHaveBeenCalled();
  });

  it('keeps the row when the fetch merely failed', async () => {
    // The guard that matters. A refused fetch, a dropped socket or a timeout
    // proves nothing about what the server holds, and pruning on one would
    // hide mail that is still there. Only `messageGone` may remove a row.
    mockFetchEmailLight.mockRejectedValue(new Error('Server refused UID FETCH 31056: no response'));
    primeStore();

    await useMailStore.getState().selectEmail(31056, 'server');

    expect(uids()).toEqual([31056, 31051]);
    expect(useMailStore.getState().totalEmails).toBe(2);
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
    expect(useMailStore.getState().selectedEmail?._bodyError).toContain('refused');
  });
});

// ── All Inboxes ────────────────────────────────────────────────────────────
//
// The same row, in the view the 2026-09-21 report was filed from. The store
// was already pruned here; the header cache was not, because the durable half
// of the removal was gated on `!isUnified`. loadUnifiedInbox reads each
// account's header cache (never a live listing), so the dead row came back on
// the next paint of the view and failed again on every click — for up to six
// hours, until the daemon's own timed reconcile pruned it.
describe('selectEmail — a vanished row in a spanning view', () => {
  const stamp = (e) => ({ ...e, _accountId: ACCOUNT.id, _mailbox: 'INBOX' });

  function primeUnified() {
    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'UNIFIED',
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      viewMode: 'all',
      emails: [stamp(VANISHED), stamp(NEIGHBOUR)],
      sentEmails: [],
      localEmails: [],
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      // Cross-account merges are never a complete enumeration.
      serverUids: serverUids(new Set([31056, 31051]), { complete: false }),
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

  it('writes the removal through to that account’s header cache', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeUnified();

    await useMailStore.getState().selectEmail(`${ACCOUNT.id}:INBOX:31056`, 'server');

    expect(uids()).toEqual([31051]);
    const prune = mockSaveEmailHeaders.mock.calls.find(c => c[4]?.removedUids?.includes(31056));
    expect(prune).toBeDefined();
    const [accountId, mailbox, headers, total] = prune;
    expect(accountId).toBe('acct1');
    expect(mailbox).toBe('INBOX');
    // Rows and count belong to no single mailbox here, so the write is the
    // prune and nothing else — it must not stamp the merged list onto one
    // account's cache.
    expect(headers).toEqual([]);
    expect(total).toBe(null);
  });

  it('does not reload the mailbox behind a spanning view', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31056));
    primeUnified();

    await useMailStore.getState().selectEmail(`${ACCOUNT.id}:INBOX:31056`, 'server');

    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
  });
});

// ── The prefetch knew first ────────────────────────────────────────────────
//
// In the report, the adjacent-row prefetch got the server's proven "gone" at
// 19:43Z and dropped it; the user's first failing click was at 19:51Z. The
// answer is the same answer — act on it.
describe('_prefetchAdjacentEmails — a neighbour the server no longer holds', () => {
  // The prefetch reads forward, so the vanished row has to be the OLDER one:
  // the open message is 31056 and 31051 is the row under it.
  function primeForPrefetch() {
    primeStore();
    useMailStore.setState({ selectedEmailId: VANISHED.uid });
  }

  it('prunes the row instead of swallowing the answer', async () => {
    mockFetchEmailLight.mockRejectedValue(goneError(31051));
    primeForPrefetch();

    await useMailStore.getState()._prefetchAdjacentEmails(VANISHED.uid);

    expect(uids()).toEqual([31056]);
    expect(mockSaveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(31051))).toBe(true);
  });

  it('keeps a neighbour whose fetch merely failed', async () => {
    mockFetchEmailLight.mockRejectedValue(new Error('Server refused UID FETCH 31051: no response'));
    primeForPrefetch();

    await useMailStore.getState()._prefetchAdjacentEmails(VANISHED.uid);

    expect(uids()).toEqual([31056, 31051]);
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
  });
});
