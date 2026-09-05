// A unified row that cannot be resolved must not be deleted from the ACTIVE
// account's INBOX under its bare uid. Before this guard the fallback
// `unified?.accountId || state.activeAccountId` did exactly that, and
// loadUnifiedInbox never clears activeAccountId, so the fallback had a target.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { _selKey } from '../../../stores/slices/unifiedHelpers';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockGraphSetRead = vi.fn().mockResolvedValue(undefined);
const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockMoveEmails = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockQueuePendingDeletes = vi.fn().mockResolvedValue(undefined);
const mockClearPendingDeletes = vi.fn().mockResolvedValue(undefined);
const mockSetUnreadForAccount = vi.fn();
const mockGetGraphMessageId = vi.fn().mockReturnValue(null);
const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockGetLocalIndexEntry = vi.fn().mockResolvedValue(null);
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queuePendingDeletes: (...a) => mockQueuePendingDeletes(...a),
  clearPendingDeletes: (...a) => mockClearPendingDeletes(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: (...a) => mockGraphSetRead(...a),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
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
  getGraphMessageId: (...a) => mockGetGraphMessageId(...a),
  resolveGraphMessageId: async (acct, mb, uid, opts) => opts?.row?._graphId || mockGetGraphMessageId(acct, mb, uid),
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
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));
vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');

const ACCT_A = { id: 'acct-a', email: 'a@mock.test' };
const ACCT_B = { id: 'acct-b', email: 'b@mock.test' };

const row = (uid, extra = {}) => ({
  uid, subject: `m${uid}`, flags: [], from: { address: 'x@mock.test' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function primeUnified(emails, selected = []) {
  useMailStore.setState({
    accounts: [ACCT_A, ACCT_B],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
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
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

describe('deleting from a unified list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalIndexEntry.mockResolvedValue(null);
  });

  it('refuses a row that names no account instead of aiming at the active INBOX', async () => {
    primeUnified([row(7)]); // stamped late: no _accountId, so its key is the bare uid
    await expect(useMailStore.getState().deleteEmailFromServer(7)).rejects.toThrow(/Cannot tell which account/);
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockQueuePendingDeletes).not.toHaveBeenCalled();
  });

  it('deletes a resolvable row from its own account and folder', async () => {
    const r = row(7, { _accountId: ACCT_B.id, _mailbox: 'INBOX' });
    primeUnified([r]);
    await useMailStore.getState().deleteEmailFromServer(_selKey(r));
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_B, 7, 'INBOX');
  });

  it('acts on a full key even after the row has left every list', async () => {
    primeUnified([]);
    await useMailStore.getState().deleteEmailFromServer(`${ACCT_B.id}:INBOX:9`);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_B, 9, 'INBOX');
  });

  it('the bulk path refuses an unresolvable key too', async () => {
    primeUnified([row(7)], [7]);
    await expect(useMailStore.getState().deleteSelectedFromServer()).rejects.toThrow(/Cannot tell which account/);
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    // The journal is written before the network loop, so a refusal that came
    // one line too late would still leave replayPendingDeletes an entry to
    // finish at the next launch — against a target nobody could name.
    expect(mockQueuePendingDeletes).not.toHaveBeenCalled();
  });

  // The row that is only in the vault: a compose-staged Sent copy carries
  // `_localStaged` and a pseudo-uid the server never issued. The list lookup
  // that decides this has to use the resolved uid — keyed by the raw argument
  // it misses every row in a spanning view, and a message that exists nowhere
  // but on disk gets an IMAP delete and a journal entry to retry it forever.
  it('takes the local path for a staged row named by its composite key', async () => {
    const r = row(7, { _accountId: ACCT_B.id, _mailbox: 'INBOX', _localStaged: true });
    primeUnified([r]);
    const invoke = vi.fn().mockResolvedValue(undefined);
    globalThis.window.__TAURI__ = { core: { invoke } };
    try {
      await useMailStore.getState().deleteEmailFromServer(_selKey(r));
    } finally {
      delete globalThis.window.__TAURI__;
    }
    expect(invoke).toHaveBeenCalledWith('maildir_delete', { accountId: ACCT_B.id, mailbox: 'INBOX', uid: 7 });
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockQueuePendingDeletes).not.toHaveBeenCalled();
  });

  // "The server copy is gone by our own hand" is the durable proof that makes
  // an archived row gold. It is written against the vault index, which is
  // keyed by (account, mailbox, uid) — a selection key looks up nothing there
  // and the stamp silently never lands.
  it('stamps the vault entry with the real uid, not the selection key', async () => {
    mockGetLocalIndexEntry.mockImplementation(async (acct, mb, uid) => (
      acct === ACCT_B.id && mb === 'INBOX' && uid === 7 ? { uid: 7, subject: 'm7' } : null
    ));
    const r = row(7, { _accountId: ACCT_B.id, _mailbox: 'INBOX' });
    primeUnified([r]);
    await useMailStore.getState().deleteEmailFromServer(_selKey(r));
    expect(mockGetLocalIndexEntry).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', 7);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', [
      expect.objectContaining({ uid: 7, serverDeleted: true }),
    ]);
  });
});
