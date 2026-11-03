/**
 * A server delete that FAILS must behave like a delete made offline: the row
 * stays gone, the daemon's queue entry stays, and the daemon finishes the job
 * later (its in-submit retries, then its replay worker).
 *
 * Before this, a refused delete lifted the tombstone, cleared the journal and
 * reloaded — so the row came back but its search hit stayed evicted for the
 * run, and a server hiccup silently threw the user's confirmed delete away.
 *
 * The exceptions are the paths with nothing to replay: a Graph delete (its
 * message id is per-session, never queued) and a local-only row. Those keep
 * the old restore-and-throw contract.
 *
 * The daemon seam: `api.deleteQueueSubmit` answers each uid `landed`,
 * `queued` (still owed) or `dropped`; `delete-queue-landed` settles a queued
 * one later (`onDeleteQueueLanded`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(undefined);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockNoteOpFailure = vi.fn();
const mockSubmit = vi.fn();
// The daemon's answer for a group: every uid `refuse` names stays owed, and
// is named in `refused` with the reason its last round got.
const TIMED_OUT = 'E_BIN_CAPTURE:timeout: timed out after 45s';
const answer = (refuse = () => false, reason = TIMED_OUT) => async ({ uids }) => ({
  landed: uids.filter(uid => !refuse(uid)).map(uid => ({ kind: 'deleted', uid, trash: 'Trash', trashUid: 100 + uid, binId: null })),
  queued: uids.filter(refuse),
  refused: uids.filter(refuse).map(uid => ({ uid, reason })),
  dropped: [],
});
const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockSend = vi.fn().mockResolvedValue(undefined);
vi.mock('../../transport', () => ({ send: (...a) => mockSend(...a) }));

let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
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
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  deleteQueueSubmit: (...a) => mockSubmit(...a),
  deleteQueueList: vi.fn().mockResolvedValue([]),
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
const { onDeleteQueueLanded } = await import('../messageMutations');
const { t } = await import('../../../i18n/index.js');

// The one status line a refused submit leaves: why, and that MailVault goes
// on. A bin capture's reason has a sentence of its own; anything else is the
// reason's own words in the generic frame, without its closing period.
const notYet = (reasonKey) => t('list.deleteNotYet', { reason: t(reasonKey).replace(/[.。]$/, '') });
const expectOneWarning = (message) => {
  const s = useMailStore.getState();
  expect(s.error).toBe(message);
  // A warning, not the error toast: nothing failed for good.
  expect(s.errorType).toBe('warning');
  expect(s.errorTypeFor).toBe(s.error);
};
const expectOneNotYet = (key) => {
  const s = useMailStore.getState();
  expect(s.error).toBe(key.startsWith('list.') ? t(key) : notYet(key));
  // A warning, not the error toast: nothing failed for good.
  expect(s.errorType).toBe('warning');
  expect(s.errorTypeFor).toBe(s.error);
};

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

// The daemon retries a refusal itself (six rounds in a submit, then its
// replay worker); these cases see what its answer leaves behind in the app.
beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockIsGraphAccount.mockReturnValue(false);
  mockSubmit.mockImplementation(answer());
});

describe('a server delete the server refuses', () => {
  it('keeps the row evicted and the queue entry owed, and says once why it is not deleted yet', async () => {
    prime([row(7)]);
    useMailStore.setState({ error: null });
    mockSubmit.mockImplementation(answer(() => true));

    await expect(useMailStore.getState().deleteEmailFromServer(7)).resolves.toBeUndefined();

    // One submit: the retries are the daemon's.
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith({ accountId: ACCT.id, mailbox: 'INBOX', uids: [7] }, { mode: 'auto', bin: true, arg: {} });
    // Owed, not failed: the row stays gone, and one warning says why the
    // server still has it (Settings › Unfinished server actions lists it).
    expectOneNotYet('list.deleteNotYet_timeout');
    // The app keeps no journal of its own and sends nothing itself.
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(mockGraphDeleteMessage).not.toHaveBeenCalled();
    expect(mockNoteOpFailure).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails).toEqual([]);
    // The row stays gone, so the count does too: it drops with the row, not
    // on a server answer that never came.
    expect(useMailStore.getState().totalEmails).toBe(0);
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(true);
  });

  it('says nothing for a uid still owed that nothing refused (offline, or another submit has it)', async () => {
    prime([row(7)]);
    useMailStore.setState({ error: null });
    mockSubmit.mockResolvedValue({ landed: [], queued: [7], refused: [], dropped: [] });

    await useMailStore.getState().deleteEmailFromServer(7);

    expect(useMailStore.getState().error).toBeNull();
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(true);
  });

  it('a refusal that is not a bin capture reads in its own words', async () => {
    prime([row(7)]);
    useMailStore.setState({ error: null });
    mockSubmit.mockImplementation(answer(() => true, 'errors.keychainBusy'));

    await useMailStore.getState().deleteEmailFromServer(7);

    expectOneNotYet('errors.keychainBusy');
  });

  // Each bin-capture reason reads as one sentence of its own, never the
  // errors.E_BIN_CAPTURE_* copy ("Try again ... was not deleted") wrapped.
  for (const why of ['fetch', 'timeout', 'write']) {
    it(`a ${why} refusal says so in a sentence of its own`, async () => {
      prime([row(7)]);
      useMailStore.setState({ error: null });
      mockSubmit.mockImplementation(answer(() => true, `E_BIN_CAPTURE:${why}: detail for the log`));

      await useMailStore.getState().deleteEmailFromServer(7);

      const key = `list.deleteNotYet_${why}`;
      expect(t(key)).not.toBe(key);
      expectOneWarning(t(key));
      expect(t(key)).not.toMatch(/Try again|was not deleted/);
      expect(t(key)).toMatch(/MailVault keeps trying\.$/);
    });
  }

  // A busy account is transient: the daemon's next round usually sends it, so
  // a delete answered after its first round says nothing about it.
  it('a busy refusal says nothing; the row stays hidden while the daemon retries', async () => {
    prime([row(7), row(8)]);
    useMailStore.setState({ error: null });
    mockSubmit.mockImplementation(answer(() => true, 'E_BIN_CAPTURE:busy: account busy'));

    await useMailStore.getState().deleteEmailFromServer(7);

    expect(useMailStore.getState().error).toBeNull();
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(true);
  });

  // A dropped socket is as transient as a busy account: the daemon's next
  // round opens a new one. Same wording `is_connection_lost` (pool.rs) matches.
  it('a dropped connection says nothing; the row stays hidden while the daemon retries', async () => {
    for (const raw of [
      'Failed to delete email: SELECT Trash failed: connection lost',
      'Failed to delete email: connection reset by peer (os error 54)',
      'Failed to delete email: connection closed via error',
      'Failed to delete email: An existing connection was forcibly closed (os error 10054)',
    ]) {
      prime([row(7), row(8)]);
      useMailStore.setState({ error: null });
      mockSubmit.mockImplementation(answer(() => true, raw));

      await useMailStore.getState().deleteEmailFromServer(7);

      expect(useMailStore.getState().error).toBeNull();
      expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(true);
    }
  });

  it('a busy refusal beside another reason says the other one', async () => {
    prime([row(7), row(8), row(9)], [7, 8]);
    useMailStore.setState({ error: null });
    mockSubmit.mockImplementation(async ({ uids }) => ({
      landed: [], queued: uids, dropped: [],
      refused: [{ uid: 7, reason: 'E_BIN_CAPTURE:busy: account busy' }, { uid: 8, reason: 'E_BIN_CAPTURE:timeout: timed out after 45s' }],
    }));

    await useMailStore.getState().deleteSelectedFromServer();

    expectOneNotYet('list.deleteNotYet_timeout');
  });

  it('a bin-capture refusal with no reason this app knows uses the generic sentence', async () => {
    for (const raw of ['E_BIN_CAPTURE:sideways: x', 'E_BIN_CAPTURE: no reason given']) {
      prime([row(7)]);
      useMailStore.setState({ error: null });
      mockSubmit.mockImplementation(answer(() => true, raw));

      await useMailStore.getState().deleteEmailFromServer(7);

      expectOneWarning(notYet('errors.E_BIN_CAPTURE'));
    }
  });

  it("a server's own words lose their closing period inside the sentence", async () => {
    for (const raw of ['Failed to delete email: copy refused', 'Failed to delete email: copy refused.']) {
      prime([row(7)]);
      useMailStore.setState({ error: null });
      mockSubmit.mockImplementation(answer(() => true, raw));

      await useMailStore.getState().deleteEmailFromServer(7);

      expectOneWarning('Not deleted yet: Failed to delete email: copy refused. MailVault keeps trying.');
    }
  });

  it('still restores the row for a Graph account, which queues nothing to replay', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    prime([row(7)]);
    mockGraphDeleteMessage.mockRejectedValue(new Error('graph exploded'));

    await expect(useMailStore.getState().deleteEmailFromServer(7)).rejects.toThrow(/graph exploded/);

    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|7`)).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockQueueOp).not.toHaveBeenCalled();
  });

  it('keeps only the refused uid owed when a batch is half refused', async () => {
    prime([row(7), row(8)], [7, 8]);
    mockSubmit.mockImplementation(answer((uid) => uid === 8));

    await useMailStore.getState().deleteSelectedFromServer();

    // The group is one submit, naming both messages for Settings.
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const [group, { arg }] = mockSubmit.mock.calls[0];
    expect(group).toEqual({ accountId: ACCT.id, mailbox: 'INBOX', uids: [7, 8] });
    expect(arg.messages.map((m) => m.uid)).toEqual([7, 8]);
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|8`)).toBe(true);
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([]);
    expect(mockClearOps).not.toHaveBeenCalled();
  });

  it('says it once for a batch, however many uids were refused', async () => {
    prime([row(7), row(8), row(9)], [7, 8, 9]);
    useMailStore.setState({ error: null });
    const set = vi.spyOn(useMailStore, 'setState');
    mockSubmit.mockImplementation(answer((uid) => uid !== 9));

    await useMailStore.getState().deleteSelectedFromServer();

    expectOneNotYet('list.deleteNotYet_timeout');
    const said = set.mock.calls.filter(([patch]) => patch && typeof patch === 'object' && 'error' in patch && patch.error);
    expect(said).toHaveLength(1);
    set.mockRestore();
  });
});

describe('a server delete that is refused and then lands', () => {
  it('stays gone, and the later landing says nothing more', async () => {
    prime([row(7), row(8)], [7, 8]);
    useMailStore.setState({ error: null });
    mockSubmit.mockImplementation(answer((uid) => uid === 8));

    await useMailStore.getState().deleteSelectedFromServer();
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|8`)).toBe(true);
    expectOneNotYet('list.deleteNotYet_timeout');
    useMailStore.setState({ error: null });

    // The daemon's replay worker lands it a pass later.
    await onDeleteQueueLanded({ accountId: ACCT.id, mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 8, trash: 'Trash', trashUid: 108, binId: null }] });

    expect(useMailStore.getState().emails).toEqual([]);
    expect(useMailStore.getState().error).toBeNull();
    expect(mockNoteOpFailure).not.toHaveBeenCalled();
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    // What the open folder reloads is the daemon's pruned cache; the tombstone
    // is no longer needed to keep the row hidden.
    expect(useMailStore.getState().deleteTombstones.has(`${ACCT.id}|INBOX|8`)).toBe(false);
    expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
  });
});
