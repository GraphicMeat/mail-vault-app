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
    expect(headers.map(e => e.uid)).toEqual([31051]);
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
