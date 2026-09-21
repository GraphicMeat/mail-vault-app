/**
 * The same vanished row as `selectEmailVanishedRow.test.js`, reached through
 * the OTHER body-fetch RPC.
 *
 * `imap_get_email_light` reports proven absence as `{success:false, gone:true}`
 * and `api.fetchEmailLight` turns that into a `messageGone` error, which
 * `selectEmail` prunes on. `imap_get_email` reports the identical fact as an
 * RPC error whose message starts with `E_UID_GONE:` — a shape `api.fetchEmail`
 * did not read, so archiving a message someone had already deleted elsewhere
 * showed "Could not copy that email into your vault. Nothing was removed from
 * the server. (E_UID_GONE: Message UID 30 is no longer in INBOX)" — the raw
 * daemon token in front of the user, a claim about the server copy that is
 * false, and the stale row still sitting in the list.
 *
 * Both halves are pinned here: the parse in `api.fetchEmail`, and the prune in
 * `saveEmailLocally`. Including the negative — only a PROVEN absence may take a
 * row out of the list; an ordinary fetch failure proves nothing about the
 * server and must leave the row where it is.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockIsEmailSaved = vi.fn();
const mockArchiveEmail = vi.fn().mockResolvedValue(undefined);
const mockFetchEmail = vi.fn();
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockTauriInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  isEmailSaved: (...a) => mockIsEmailSaved(...a),
  archiveEmail: (...a) => mockArchiveEmail(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  fetchEmail: (...a) => mockFetchEmail(...a),
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

vi.mock('../../transport', () => ({ send: (...a) => mockTauriInvoke(...a) }));

const { useMailStore } = await import('../../../stores/mailStore');
const { saveEmailLocally } = await import('../messageMutations.js');

const ACCOUNT = { id: 'acct1', email: 'luke@mock.test' };
const ROW = {
  uid: 30, messageId: 'luke30@mock', subject: 'Luke message 30', flags: [],
  from: { address: 'luke@mock.test' }, date: '2026-08-27T09:00:00Z',
};

/** What api.fetchEmail throws once it reads the daemon's E_UID_GONE reply. */
function messageGoneError(uid = 30, mailbox = 'INBOX') {
  const err = new Error(`Message UID ${uid} is no longer in ${mailbox}`);
  err.name = 'MessageGoneError';
  err.messageGone = true;
  err.uid = uid;
  err.mailbox = mailbox;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEmailSaved.mockResolvedValue(false);
  mockTauriInvoke.mockResolvedValue(undefined);
  globalThis.window.__TAURI__ = { core: { invoke: (...a) => mockTauriInvoke(...a) } };

  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails: [ROW],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([ROW.uid], { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    selectedEmailIds: new Set(),
    selectedEmailId: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
});

describe('saveEmailLocally on a message the server proved is gone', () => {
  it('takes the row out of the list instead of reporting a vault failure', async () => {
    mockFetchEmail.mockRejectedValue(messageGoneError());

    await saveEmailLocally(30);

    const { emails, totalEmails, error } = useMailStore.getState();
    expect(emails.some(e => e.uid === 30)).toBe(false);
    expect(totalEmails).toBe(0);
    // The old banner said "Nothing was removed from the server" — about a
    // message the server no longer has — with the raw E_UID_GONE token in it.
    expect(error).toBeNull();
  });

  it('does not throw, so the row action has nothing to report either', async () => {
    mockFetchEmail.mockRejectedValue(messageGoneError());
    await expect(saveEmailLocally(30)).resolves.toBeUndefined();
  });

  it('keeps the uid out of the header sidecar, so a reload cannot bring it back', async () => {
    mockFetchEmail.mockRejectedValue(messageGoneError());

    await saveEmailLocally(30);

    expect(mockSaveEmailHeaders).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', expect.any(Array), expect.anything(),
      expect.objectContaining({ removedUids: [30] }),
    );
    expect(useMailStore.getState().serverUids.uids.has(30)).toBe(false);
  });

  it('does not stamp custody with a delete this app never issued', async () => {
    mockFetchEmail.mockRejectedValue(messageGoneError());

    await saveEmailLocally(30);

    // markServerDeleted routes through the same transport mock. The server
    // dropped this message on its own; claiming otherwise turns a row gold and
    // tells the user their vault holds the only copy by our hand.
    expect(mockTauriInvoke).not.toHaveBeenCalledWith('maildir_apply_flags', expect.anything());
    expect(useMailStore.getState().localEmails.some(e => e.serverDeleted)).toBe(false);
  });
});

describe('saveEmailLocally on an ordinary fetch failure', () => {
  it('leaves the row alone and reports it — nothing here proves the server lost it', async () => {
    mockFetchEmail.mockRejectedValue(new Error('Connection lost while fetching UID 30'));

    await expect(saveEmailLocally(30)).rejects.toThrow('Connection lost');

    const { emails, totalEmails, error } = useMailStore.getState();
    expect(emails.some(e => e.uid === 30)).toBe(true);
    expect(totalEmails).toBe(1);
    expect(error).toContain('Nothing was removed from the server');
  });

  it('does not prune on a message that merely failed to fetch twice', async () => {
    mockFetchEmail.mockRejectedValue(new Error('Failed to fetch email: timed out'));

    await expect(saveEmailLocally(30)).rejects.toThrow();
    await expect(saveEmailLocally(30)).rejects.toThrow();

    expect(useMailStore.getState().emails.some(e => e.uid === 30)).toBe(true);
    expect(mockSaveEmailHeaders).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ removedUids: expect.anything() }),
    );
  });
});

describe('saveEmailLocally from All Inboxes', () => {
  it('prunes the row from the account and folder it actually lives in', async () => {
    const OTHER = { id: 'acct2', email: 'leia@mock.test' };
    const MINE = { ...ROW, _accountId: OTHER.id, _mailbox: 'Archive' };
    // Same bare uid in the view under a different account — a spanning list
    // merges them, so a prune keyed on the number alone takes the wrong row.
    // `saveEmailLocally` resolves the row's own location out of the spanning
    // list, so the first match wins — MINE, not the active account's row.
    const THEIRS = { ...ROW, _accountId: ACCOUNT.id, _mailbox: 'INBOX', messageId: 'luke30b@mock' };
    useMailStore.setState({
      accounts: [ACCOUNT, OTHER],
      activeMailbox: 'UNIFIED',
      emails: [MINE, THEIRS],
      totalEmails: 2,
      serverUids: serverUids([30], { complete: true }),
    });
    mockFetchEmail.mockRejectedValue(messageGoneError(30, 'Archive'));

    await saveEmailLocally(30);

    const { emails, error } = useMailStore.getState();
    expect(emails).toHaveLength(1);
    expect(emails[0]._accountId).toBe(ACCOUNT.id);
    expect(error).toBeNull();
    // All Inboxes is built entirely out of each account's header cache, so a
    // removal that only filters the store comes straight back on the next
    // paint. The durable half runs here too — the uid prune and nothing else,
    // since the rows in memory are not this mailbox's to write (ce0caab8).
    expect(mockSaveEmailHeaders).toHaveBeenCalledWith(
      OTHER.id, 'Archive', [], null, { removedUids: [30] },
    );
  });
});
