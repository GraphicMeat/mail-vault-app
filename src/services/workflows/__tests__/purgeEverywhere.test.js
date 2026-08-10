// Delete Everywhere spans three storage locations — server, vault Maildir and
// external backup mirror — and the interesting behaviour is which of them a
// given message actually lives in, plus what happens when the server delete
// fails. Deleting a local copy of a message still sitting on the server is
// data loss the user did not ask for; that case is the reason this file exists.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockMaildirDeleteMany = vi.fn().mockResolvedValue({ removed: 0 });
const mockBackupPurgeUids = vi.fn().mockResolvedValue({ removed: 0, queued: 0 });
// Matching non-null values by default so every test that doesn't care about
// the UIDVALIDITY guard sees a "trusted" mailbox and behaves as before it
// existed. Tests that DO care override one side to force a mismatch.
const mockCheckMailboxStatus = vi.fn().mockResolvedValue({ uidValidity: 1 });
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../api', () => ({
  deleteEmail: (...a) => mockDeleteEmail(...a),
  maildirDeleteMany: (...a) => mockMaildirDeleteMany(...a),
  backupPurgeUids: (...a) => mockBackupPurgeUids(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  fetchEmailLight: vi.fn(),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
}));

const mockGetLocalIndexProvenance = vi.fn().mockResolvedValue(new Map());
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue({ uidValidity: 1 });

vi.mock('../../db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexProvenance: (...a) => mockGetLocalIndexProvenance(...a),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  hasValidCredentials: () => true,
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockGetGraphMessageId = vi.fn().mockReturnValue(null);

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
  graphMessageToEmail: (m) => m,
}));

// getGraphMessageId is imported from cacheManager, not graphConfig.
vi.mock('../../cacheManager', () => ({
  getGraphMessageId: (...a) => mockGetGraphMessageId(...a),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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

const { useMailStore } = await import('../../../stores/mailStore');
const { purgeEverywhere } = await import('../messageMutations');

// 36-char UUID: db/emails.js parses `accountId-mailbox-uid` with a fixed-width
// prefix and silently no-ops on anything shorter.
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', email: 'me@mock.test' };

function prime({ emails, archived = [], localOnly = [], serverUids, sent = [], provenance }) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX.Spam',
    viewMode: 'all',
    emails,
    sentEmails: sent,
    // Rows still on the server live in `emails`. A row purged from the server
    // but still archived locally lives only in `localEmails` — the real
    // production placement for the "local-only" case, and where
    // updateSortedEmails() derives `source: 'local-only'` for it.
    localEmails: localOnly,
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(archived),
    serverUidSet: new Set(serverUids !== undefined ? serverUids : emails.filter(e => e.source !== 'local-only').map(e => e.uid)),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  mockGetLocalIndexProvenance.mockResolvedValue(provenance || new Map());
  useMailStore.getState().updateSortedEmails();
}

const serverMsg = (uid) => ({
  uid, messageId: `m${uid}@mock`, subject: `Spam ${uid}`, flags: [],
  from: { address: 'them@mock.test' }, date: '2026-08-01T10:00:00Z',
});

beforeEach(() => {
  mockDeleteEmail.mockReset().mockResolvedValue(undefined);
  mockMaildirDeleteMany.mockReset().mockResolvedValue({ removed: 0 });
  mockBackupPurgeUids.mockReset().mockResolvedValue({ removed: 0, queued: 0 });
  mockGetLocalIndexProvenance.mockReset().mockResolvedValue(new Map());
  mockCheckMailboxStatus.mockReset().mockResolvedValue({ uidValidity: 1 });
  mockGetEmailHeadersMeta.mockReset().mockResolvedValue({ uidValidity: 1 });
  mockGraphDeleteMessage.mockReset().mockResolvedValue(undefined);
  mockIsGraphAccount.mockReset().mockReturnValue(false);
  mockGetGraphMessageId.mockReset().mockReturnValue(null);
});

describe('purgeEverywhere — storage matrix', () => {
  it('server only: deletes from server, still sweeps local (idempotent no-op)', async () => {
    prime({ emails: [serverMsg(1)] });
    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(mockDeleteEmail.mock.calls[0][1]).toBe(1);
    expect(mockDeleteEmail.mock.calls[0][2]).toBe('INBOX.Spam');
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1]);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('server + vault: purges the archived local copy', async () => {
    prime({ emails: [serverMsg(1)], archived: [1] });
    await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [1]);
  });

  it('all three: reports the queued backup count when the volume is away', async () => {
    mockBackupPurgeUids.mockResolvedValue({ removed: 0, queued: 2 });
    prime({ emails: [serverMsg(1), serverMsg(2)], archived: [1, 2] });

    const res = await purgeEverywhere([1, 2]);

    expect(res.queuedBackup).toBe(2);
    expect(res.deleted).toBe(2);
  });

  it('local-only message: never calls the server', async () => {
    // uid 9 is local-only because it was composed here, not because it's
    // merely absent from `emails` — the index provenance entry is what
    // proves that, and is what makes this local-only rather than unproven.
    prime({
      emails: [],
      archived: [9],
      localOnly: [serverMsg(9)],
      provenance: new Map([[9, 'local_sent']]),
    });
    await purgeEverywhere([9]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [9]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [9]);
  });

  it('collision: a still-server-side row with a stale local-only duplicate still gets deleted from the server', async () => {
    // Reproduces the cold-load race: an archived row that's still on the
    // server can exist in BOTH `emails` and `localEmails` at once (the local
    // archive read lands before the server window fills in). updateSortedEmails()
    // only revisits a localEmails entry when its uid is absent from `emails`,
    // so a localEmails duplicate stamped 'local-only' before the server uid
    // arrived stays stamped that way for the rest of the session. On a uid
    // collision the real, server-backed `emails` copy must win the lookup —
    // not the stale `localEmails` duplicate.
    prime({
      emails: [serverMsg(1)],
      archived: [1],
      localOnly: [{ ...serverMsg(1), source: 'local-only' }],
    });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('regression: an archived row still in `emails` is never misread as local-only just because serverUidSet lags', async () => {
    // Simulates the restore-descriptor paint (activateAccount.js:459) and the
    // offline window: serverUidSet can be empty or stale while archivedEmailIds
    // is already populated. The row is still server-backed — it's in `emails`,
    // which updateSortedEmails() always stamps `source: 'server'` — so it must
    // go through the normal server-delete path. Treating an incomplete
    // serverUidSet as proof of absence would classify it as local-only instead:
    // the server delete gets skipped while the vault/backup copies are
    // destroyed anyway, the inverse of the rule this workflow exists to enforce.
    prime({ emails: [serverMsg(1)], archived: [1] });
    useMailStore.setState({ serverUidSet: new Set() });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('a _localStaged duplicate sitting in localEmails never shadows a server-backed row in emails', async () => {
    // Provenance already settles which SOURCE wins a uid, looked up by
    // (accountId, mailbox, uid) rather than from whichever object survives
    // the emailMap collision. What the localEmails-first ordering still
    // guards is `_localStaged`, which is read straight off the winning
    // object: if a stale duplicate carrying `_localStaged: true` ever sat in
    // `localEmails` under the same uid as a genuine server-backed row in
    // `emails`, the wrong ordering would let that duplicate's flag decide
    // the verdict and skip the server delete outright.
    prime({
      emails: [serverMsg(1)],
      archived: [1],
      localOnly: [{ ...serverMsg(1), _localStaged: true }],
    });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(1);
  });

  it('server delete fails: local and backup copies are left alone', async () => {
    mockDeleteEmail.mockRejectedValue(new Error('NO [CANNOT] EXPUNGE failed'));
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockMaildirDeleteMany).not.toHaveBeenCalled();
    expect(mockBackupPurgeUids).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(res.deleted).toBe(0);
  });

  it('mixed batch: only the uids whose server delete succeeded are purged locally', async () => {
    mockDeleteEmail.mockImplementation((_a, uid) =>
      uid === 3 ? Promise.reject(new Error('boom')) : Promise.resolve());
    prime({ emails: [1, 2, 3, 4].map(serverMsg), archived: [1, 2, 3, 4] });

    const res = await purgeEverywhere([1, 2, 3, 4]);

    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1, 2, 4]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [1, 2, 4]);
    expect(res.deleted).toBe(3);
    expect(res.failed).toBe(1);
  });

  it('failed uid keeps no tombstone, so the reconcile can restore its row', async () => {
    mockDeleteEmail.mockRejectedValue(new Error('boom'));
    prime({ emails: [serverMsg(1)] });

    await purgeEverywhere([1]);

    const ts = useMailStore.getState().deleteTombstones;
    expect([...ts].some(k => k.endsWith('|1'))).toBe(false);
  });
});

describe('purgeEverywhere — positive local-only proof', () => {
  it('archived row absent from serverUidSet still gets a server delete attempt', async () => {
    // The exact shape of the third data-loss route: a locally archived message
    // that IS on the server, sitting outside the loaded window, so nothing in
    // the store knows the server has it. Index provenance says 'local' —
    // archived FROM the server — so the server delete must be attempted.
    prime({
      emails: [],
      archived: [1],
      localOnly: [{ ...serverMsg(1), source: 'local-only' }],
      serverUids: [],
      provenance: new Map([[1, 'local']]),
    });

    await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1]);
  });

  it('a composed-here message is proven local-only and never hits the server', async () => {
    prime({
      emails: [],
      archived: [9],
      localOnly: [{ ...serverMsg(9), source: 'local-only' }],
      serverUids: [],
      provenance: new Map([[9, 'local_sent']]),
    });

    await purgeEverywhere([9]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [9]);
  });

  it('a staged draft is proven local-only', async () => {
    prime({
      emails: [],
      archived: [7],
      localOnly: [{ ...serverMsg(7), source: 'local-only' }],
      serverUids: [],
      provenance: new Map([[7, 'local_draft']]),
    });

    await purgeEverywhere([7]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
  });

  it('no index entry at all means unproven, so the server is tried first', async () => {
    prime({
      emails: [],
      archived: [3],
      localOnly: [{ ...serverMsg(3), source: 'local-only' }],
      serverUids: [],
      provenance: new Map(),
    });

    await purgeEverywhere([3]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
  });

  it('_localStaged still proves local-only without an index entry', async () => {
    // The compose optimistic entry lives in sentEmails with a pseudo-uid and
    // has no index row yet.
    prime({
      emails: [],
      sent: [{ ...serverMsg(1700000000), _localStaged: true }],
      provenance: new Map(),
    });

    await purgeEverywhere([1700000000]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
  });
});

describe('purgeEverywhere — UIDVALIDITY guard', () => {
  it('matching uidValidity behaves as today', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 42 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 42 });
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [1]);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.needsResync).toBe(0);
  });

  it('mismatched uidValidity skips the server, vault and backup deletes and reports the uids', async () => {
    // A server-side UID reissue (change-server flow, or the server's own) means
    // the vault uid for this mailbox may now name an unrelated message. Neither
    // the vault nor local-index.json carries a UIDVALIDITY stamp, so this is
    // the only place that can catch it before a uid gets spent on a delete.
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 2 });
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).not.toHaveBeenCalled();
    expect(mockBackupPurgeUids).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.needsResync).toBe(1);

    // Reconcile must be able to restore the row — same contract as an
    // ordinary failed server delete.
    const ts = useMailStore.getState().deleteTombstones;
    expect([...ts].some(k => k.endsWith('|1'))).toBe(false);
  });

  it('unknown/null uidValidity on either side is treated as a mismatch', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: null });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 5 });
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(res.needsResync).toBe(1);
  });

  it('a proven local-only message purges regardless of the mailbox UIDVALIDITY verdict', async () => {
    // The guard only gates uids headed for a SERVER delete. A proven
    // local-only message's purge touches local files under the uid it was
    // archived/staged under, with no server round trip — a server-side UID
    // reissue renumbers nothing on disk. Gating this too would turn deleting
    // an offline-composed message into a permanent failure for an operation
    // that never touches the server. No target here is headed for a server
    // delete, so the group is never even formed — no STATUS call happens.
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 2 });
    prime({
      emails: [],
      archived: [9],
      localOnly: [{ ...serverMsg(9), source: 'local-only' }],
      serverUids: [],
      provenance: new Map([[9, 'local_sent']]),
    });

    const res = await purgeEverywhere([9]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockCheckMailboxStatus).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [9]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [9]);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.needsResync).toBe(0);
  });

  it('checkMailboxStatus rejecting (offline, unsupported) is treated as a mismatch, not thrown', async () => {
    // Pins the fail-closed contract against a future refactor that moves the
    // uidValidity comparison out of the try — a rejected STATUS call must
    // hold the uid back exactly like an explicit mismatch, never propagate.
    mockCheckMailboxStatus.mockRejectedValue(new Error('offline'));
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(res.needsResync).toBe(1);
  });

  it('Graph account: purges normally, no STATUS call — Graph ids carry no UID space to poison', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    mockGetGraphMessageId.mockReturnValue('graph-msg-1');
    prime({ emails: [serverMsg(1)], archived: [1] });

    const res = await purgeEverywhere([1]);

    expect(mockGraphDeleteMessage).toHaveBeenCalledTimes(1);
    expect(mockCheckMailboxStatus).not.toHaveBeenCalled();
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [1]);
    expect(res.deleted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.needsResync).toBe(0);
  });
});
