/**
 * saveEmailsLocally archives each row where the row says it lives.
 *
 * "Archive All" on a thread opened from All Inboxes used to fail every
 * message: the workflow read the mailbox off the view — the placeholder
 * 'UNIFIED', which no server has — and the account off whichever one was
 * activated last. The row itself names its account and folder, so the run is
 * one `archive_emails` per (account, mailbox), and the view's placeholder never
 * reaches a server. The same rule sends a Sent copy merged into an INBOX list
 * to the Sent folder instead of archiving INBOX's message under its uid.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockTauriInvoke = vi.fn();
const mockGetSavedEmailIds = vi.fn();
const mockGetArchivedEmailIds = vi.fn();
const mockReadLocalEmailIndex = vi.fn();

vi.mock('../../db', () => ({
  isEmailSaved: vi.fn().mockResolvedValue(false),
  archiveEmail: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  readLocalEmailIndex: (...a) => mockReadLocalEmailIndex(...a),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  saveEmails: vi.fn().mockResolvedValue(undefined),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  fetchEmail: vi.fn(),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));

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
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { saveEmailsLocally, saveSelectedLocally } = await import('../messageMutations.js');

const LUKE = { id: 'luke-id', email: 'luke@mock.test' };
const VADER = { id: 'vader-id', email: 'vader@mock.test' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `Message ${uid}`, flags: [],
  from: { address: 'partner@example.com' }, date: '2026-08-27T09:00:00Z',
  ...extra,
});

const archiveCalls = () => mockTauriInvoke.mock.calls
  .filter(([cmd]) => cmd === 'archive_emails')
  .map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  mockTauriInvoke.mockImplementation(async (cmd, args) => (
    cmd === 'archive_emails'
      ? { total: args.uids.length, completed: args.uids.length, errors: 0, active: false }
      : undefined
  ));
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockReadLocalEmailIndex.mockResolvedValue([]);
  globalThis.window.__TAURI__ = { core: { invoke: (...a) => mockTauriInvoke(...a) } };

  useMailStore.setState({
    accounts: [LUKE, VADER],
    // vader was activated last; the thread under test is luke's.
    activeAccountId: VADER.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    mailboxScope: null,
    viewMode: 'all',
    emails: [],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set(),
    bulkSaveProgress: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
});

/** The all-inboxes list: every row stamped with its account and folder. */
const unified = (emails) => useMailStore.setState({
  unifiedInbox: true,
  activeMailbox: 'UNIFIED',
  emails,
  serverUids: serverUids(emails.map(e => e.uid), { complete: false }),
});

describe('saveEmailsLocally — a thread opened from All Inboxes', () => {
  it("archives under the row's own account and folder, never the view's placeholder", async () => {
    const rows = [42, 43, 44].map(uid => row(uid, { _accountId: LUKE.id, _accountEmail: LUKE.email, _mailbox: 'INBOX' }));
    unified(rows);

    await saveEmailsLocally(rows);

    expect(archiveCalls()).toEqual([
      expect.objectContaining({ accountId: LUKE.id, mailbox: 'INBOX', uids: [42, 43, 44] }),
    ]);
    expect(JSON.parse(archiveCalls()[0].accountJson).id).toBe(LUKE.id);
    expect(useMailStore.getState().bulkSaveProgress).toEqual({ total: 3, completed: 3, errors: 0, active: false });
    expect(useMailStore.getState().error).toBeNull();
  });

  it('runs one archive per account when the rows span two', async () => {
    const rows = [
      row(42, { _accountId: LUKE.id, _mailbox: 'INBOX' }),
      row(42, { _accountId: VADER.id, _mailbox: 'INBOX' }),
      row(43, { _accountId: LUKE.id, _mailbox: 'INBOX' }),
    ];
    unified(rows);

    await saveEmailsLocally(rows);

    expect(archiveCalls().map(c => [c.accountId, c.mailbox, c.uids])).toEqual([
      [LUKE.id, 'INBOX', [42, 43]],
      [VADER.id, 'INBOX', [42]],
    ]);
    expect(useMailStore.getState().bulkSaveProgress).toEqual({ total: 3, completed: 3, errors: 0, active: false });
  });

  it("folds that account's archived ids and vault rows into the merged view", async () => {
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => (
      accountId === LUKE.id && mailbox === 'INBOX' ? new Set([42]) : new Set()
    ));
    mockReadLocalEmailIndex.mockImplementation(async (accountId) => (accountId === LUKE.id ? [row(42)] : []));
    const rows = [row(42, { _accountId: LUKE.id, _mailbox: 'INBOX' })];
    unified(rows);
    // Another account's archived row is already in the union; it must survive.
    useMailStore.setState({
      archivedEmailIds: new Set([7]),
      localEmails: [row(7, { _accountId: VADER.id, _mailbox: 'INBOX' })],
    });

    await saveEmailsLocally(rows);

    const s = useMailStore.getState();
    expect([...s.archivedEmailIds].sort()).toEqual([42, 7]);
    expect(s.localEmails).toEqual([
      expect.objectContaining({ uid: 7, _accountId: VADER.id }),
      expect.objectContaining({ uid: 42, _accountId: LUKE.id, _accountEmail: LUKE.email, _mailbox: 'INBOX' }),
    ]);
  });

  it("archives a ticked selection under each row's account too", async () => {
    const rows = [
      row(42, { _accountId: LUKE.id, _mailbox: 'INBOX' }),
      row(42, { _accountId: VADER.id, _mailbox: 'INBOX' }),
    ];
    unified(rows);
    useMailStore.setState({ selectedEmailIds: new Set([`${LUKE.id}:INBOX:42`, `${VADER.id}:INBOX:42`]) });

    await saveSelectedLocally();

    expect(archiveCalls().map(c => [c.accountId, c.mailbox, c.uids])).toEqual([
      [LUKE.id, 'INBOX', [42]],
      [VADER.id, 'INBOX', [42]],
    ]);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });

  it('reports a failed account without claiming the rest failed', async () => {
    mockTauriInvoke.mockImplementation(async (cmd, args) => {
      if (cmd !== 'archive_emails') return undefined;
      if (args.accountId === LUKE.id) throw new Error('connection refused');
      return { total: args.uids.length, completed: args.uids.length, errors: 0, active: false };
    });
    const rows = [
      row(42, { _accountId: LUKE.id, _mailbox: 'INBOX' }),
      row(42, { _accountId: VADER.id, _mailbox: 'INBOX' }),
    ];
    unified(rows);

    await saveEmailsLocally(rows);

    expect(useMailStore.getState().bulkSaveProgress).toEqual({ total: 2, completed: 1, errors: 1, active: false });
  });
});

describe("saveEmailsLocally — a single folder's list", () => {
  it('archives untagged rows in the folder on screen', async () => {
    const rows = [row(1), row(2)];
    useMailStore.setState({ emails: rows });

    await saveEmailsLocally(rows);

    expect(archiveCalls()).toEqual([
      expect.objectContaining({ accountId: VADER.id, mailbox: 'INBOX', uids: [1, 2] }),
    ]);
    expect(mockGetArchivedEmailIds).toHaveBeenCalledWith(VADER.id, 'INBOX');
  });

  it("sends a merged Sent copy to the Sent folder and keeps its uid out of the folder's archived set", async () => {
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => (
      mailbox === 'INBOX' ? new Set([1]) : new Set([6])
    ));
    const rows = [row(1), row(6, { _fromSentFolder: true, _mailbox: 'Sent' })];
    useMailStore.setState({ emails: [rows[0]], sentEmails: [rows[1]] });

    await saveEmailsLocally(rows);

    expect(archiveCalls().map(c => [c.accountId, c.mailbox, c.uids])).toEqual([
      [VADER.id, 'INBOX', [1]],
      [VADER.id, 'Sent', [6]],
    ]);
    // INBOX's own message 6 is a different message; nothing was archived under it.
    const { archivedEmailIds } = useMailStore.getState();
    expect(archivedEmailIds.has(1)).toBe(true);
    expect(archivedEmailIds.has(6)).toBe(false);
  });

  it('skips a row whose location it cannot resolve rather than guessing a folder', async () => {
    // A foreign account's row with no folder tag: no folder is known for it.
    await saveEmailsLocally([row(9, { _accountId: LUKE.id })]);

    expect(archiveCalls()).toEqual([]);
    expect(useMailStore.getState().bulkSaveProgress).toBeNull();
  });
});
