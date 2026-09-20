/**
 * A server delete that FAILS must behave like a delete made offline: the row
 * stays gone, the journal entry stays, and replayOps finishes the job later.
 *
 * Before this, a refused delete lifted the tombstone, cleared the journal and
 * reloaded — so the row came back but its search hit stayed evicted for the
 * run, and a server hiccup silently threw the user's confirmed delete away.
 *
 * The exceptions are the paths with nothing to replay: a Graph delete (its
 * message id is per-session, never journalled) and a local-only row. Those
 * keep the old restore-and-throw contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(undefined);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockNoteOpFailure = vi.fn();
const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockSend = vi.fn().mockResolvedValue(undefined);
vi.mock('../../transport', () => ({ send: (...a) => mockSend(...a) }));

let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexEntry: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  noteOpFailure: (...a) => mockNoteOpFailure(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
  graphMessageToEmail: (m) => m,
}));
vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue('graph-id'),
  resolveGraphMessageId: async () => 'graph-id',
  clearGraphIdMap: () => {},
}));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline }) },
}));
vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');

const ACCT = { id: 'acct-a', email: 'a@mock.test' };
const row = (uid) => ({ uid, subject: `m${uid}`, flags: [], from: { address: 'x@mock.test' }, date: '2026-09-01T10:00:00Z' });

function prime(emails, selected = []) {
  useMailStore.setState({
    accounts: [ACCT],
    activeAccountId: ACCT.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(selected),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
  });
  useMailStore.getState().updateSortedEmails();
}

// Real timers: the workflow waits SERVER_RETRY_MS between the two attempts,
// and these cases are about what that retry leaves behind. Fake timers turn
// the wait into a race with the workflow's own dynamic imports.
beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockIsGraphAccount.mockReturnValue(false);
  mockDeleteEmail.mockResolvedValue(undefined);
});

describe('a server delete the server refuses', () => {
  it('retries once, then keeps the row evicted and the journal entry queued', async () => {
    prime([row(7)]);
    mockDeleteEmail.mockRejectedValue(new Error('socket closed'));

    await expect(useMailStore.getState().deleteEmailFromServer(7)).resolves.toBeUndefined();

    expect(mockDeleteEmail).toHaveBeenCalledTimes(2);
    expect(mockQueueOp).toHaveBeenCalledWith({ op: 'delete', accountId: ACCT.id, mailbox: 'INBOX', uids: [7] });
    // The whole point: nothing clears the entry, so replayOps owns it now.
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails).toEqual([]);
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(true);
    expect(mockNoteOpFailure).toHaveBeenCalledWith(
      { op: 'delete', accountId: ACCT.id, mailbox: 'INBOX', uid: 7 },
      expect.stringContaining('socket closed'),
    );
  });

  it('still restores the row for a Graph account, which journals nothing to replay', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    prime([row(7)]);
    mockGraphDeleteMessage.mockRejectedValue(new Error('graph exploded'));

    await expect(useMailStore.getState().deleteEmailFromServer(7)).rejects.toThrow(/graph exploded/);

    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(false);
    expect(mockQueueOp).not.toHaveBeenCalled();
  });

  it('keeps only the failed uid queued when a batch is half refused', async () => {
    prime([row(7), row(8)], [7, 8]);
    mockDeleteEmail.mockImplementation(async (_a, uid) => {
      if (uid === 8) throw new Error('socket closed');
      return { success: true };
    });

    await useMailStore.getState().deleteSelectedFromServer();

    // The group was journalled as one entry; only uid 7 landed, so only uid 7
    // may be forgotten.
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'delete', accountId: ACCT.id, mailbox: 'INBOX', uids: [7], arg: {} });
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|8`)).toBe(true);
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([]);
  });
});
