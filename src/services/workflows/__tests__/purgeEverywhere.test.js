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

vi.mock('../../api', () => ({
  deleteEmail: (...a) => mockDeleteEmail(...a),
  maildirDeleteMany: (...a) => mockMaildirDeleteMany(...a),
  backupPurgeUids: (...a) => mockBackupPurgeUids(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  fetchEmailLight: vi.fn(),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  graphDeleteMessage: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  hasValidCredentials: () => true,
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
  getGraphMessageId: () => null,
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

function prime({ emails, archived = [] }) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX.Spam',
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(archived),
    serverUidSet: new Set(emails.filter(e => e.source !== 'local-only').map(e => e.uid)),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
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
    prime({ emails: [{ ...serverMsg(9), source: 'local-only' }], archived: [9] });
    await purgeEverywhere([9]);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockMaildirDeleteMany).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX.Spam', [9]);
    expect(mockBackupPurgeUids).toHaveBeenCalledWith(ACCOUNT.email, 'INBOX.Spam', [9]);
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
