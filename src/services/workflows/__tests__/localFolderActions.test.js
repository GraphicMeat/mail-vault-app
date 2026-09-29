// What the workflows do with a message in a vault-only folder (MBOX import
// mode 3). No server holds that folder, so (D6):
//   - star and read state change the vault copy only: never a server STORE,
//     never a journal entry a replay would retry forever;
//   - opening it marks it read in the vault, never on a server;
//   - delete takes the local-only path into the deleted bin (`bin: true`),
//     never a server delete and never a journal entry;
//   - move, spam (a move), delete-everywhere and unarchive are refused: the
//     first two need a server, the last two would remove the only copy with
//     no bin copy kept;
//   - snooze (a server move) is not offered;
//   - search asks no server about it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
globalThis.window.__TAURI__ = { core: { invoke: vi.fn() } };

const NAME = 'MBOX import 2026-09-29';
const FOLDER = { name: NAME, dir: 'MBOX_import_2026-09-29', kind: 'import', created: 1, source: 'takeout.mbox' };

const m = vi.hoisted(() => ({
  send: vi.fn(),
  queueOp: vi.fn(),
  clearOps: vi.fn(),
  getLocalEmailLight: vi.fn(),
  deleteLocalEmail: vi.fn(),
  saveEmailHeaders: vi.fn(),
}));
vi.mock('../../transport', async (importOriginal) => ({
  ...await importOriginal(),
  send: (...a) => m.send(...a),
}));

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => m.getLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set([7]), archived: new Set([7]) }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexProvenance: vi.fn().mockResolvedValue(new Map()),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: (...a) => m.deleteLocalEmail(...a),
  saveEmailHeaders: (...a) => m.saveEmailHeaders(...a),
  getLocalIndexEntry: vi.fn().mockResolvedValue(null),
  queueOp: (...a) => m.queueOp(...a),
  clearOps: (...a) => m.clearOps(...a),
  noteOpFailure: vi.fn(),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

const api = vi.hoisted(() => ({
  vaultApplyFlags: vi.fn(),
  updateEmailFlags: vi.fn(),
  deleteEmail: vi.fn(),
  moveEmails: vi.fn(),
  checkMailboxStatus: vi.fn(),
  fetchEmailLight: vi.fn(),
  removeFromLocalIndex: vi.fn(),
  appendLocalIndex: vi.fn(),
  graphSetRead: vi.fn(),
}));
vi.mock('../../api', () => api);
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
vi.mock('../../graphConfig', () => ({ isGraphAccount: () => false, graphMessageToEmail: (x) => x }));
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
      cacheLimitMB: 128, hiddenAccounts: {}, getLastMailbox: () => 'INBOX', emailListStyle: 'default',
      linkAlerts: {}, linkSafetyEnabled: false, markAsReadMode: 'immediate', markAsReadDelay: 3,
      setUnreadForAccount: () => {}, setLastMailbox: () => {},
    }),
  },
}));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: true, setOnline: () => {} }) },
}));
vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { canSnooze } = await import('../snooze');
const { purgeEverywhere, applyFlagToKeys } = await import('../messageMutations');
const { resolveMessageBody } = await import('../../export/bodyResolver');
const { buildSearchTargets } = await import('../../searchTargets');
const { useSearchStore } = await import('../../../stores/searchStore');
const { selectionKey, inLocalFolder } = await import('../../../stores/slices/unifiedHelpers');

const ACCOUNT = { id: 'acct-a', email: 'a@mock.test', password: 'pw' };
const ROW = {
  uid: 7, messageId: '<imported-7@example.test>', subject: 'An imported message',
  from: { address: 'old@example.test' }, date: '2026-01-05T10:00:00Z', flags: [], isArchived: true,
};

function prime(extra = {}) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: NAME,
    mailboxScope: null,
    unifiedInbox: false,
    viewMode: 'all',
    mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Junk', name: 'Junk', specialUse: '\\Junk' }],
    localFolders: { [ACCOUNT.id]: [FOLDER] },
    emails: [],
    sentEmails: [],
    localEmails: [{ ...ROW }],
    savedEmailIds: new Set([7]),
    archivedEmailIds: new Set([7]),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    totalEmails: 1,
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
    ...extra,
  });
  useMailStore.getState().updateSortedEmails();
}

const sends = (cmd) => m.send.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  m.send.mockResolvedValue(null);
  m.queueOp.mockResolvedValue(undefined);
  m.clearOps.mockResolvedValue(undefined);
  m.deleteLocalEmail.mockResolvedValue(undefined);
  m.saveEmailHeaders.mockResolvedValue(undefined);
  m.getLocalEmailLight.mockResolvedValue({ ...ROW, html: '<p>body</p>', text: 'body' });
  for (const fn of Object.values(api)) fn.mockResolvedValue(undefined);
  api.vaultApplyFlags.mockResolvedValue({ renamed: 1 });
});

describe('a message in a local folder', () => {
  it('is starred in the vault only: no journal entry, no server STORE', async () => {
    prime();
    await useMailStore.getState().toggleFlagged(7);

    expect(api.vaultApplyFlags).toHaveBeenCalledWith(ACCOUNT.id, NAME, ACCOUNT.email, [{ uid: 7, flags: ['\\Flagged'], on: true }]);
    expect(m.queueOp).not.toHaveBeenCalled();
    expect(api.updateEmailFlags).not.toHaveBeenCalled();
    expect(useMailStore.getState().sortedEmails[0].flags).toContain('\\Flagged');
  });

  it('is marked unread in the vault only', async () => {
    prime({ localEmails: [{ ...ROW, flags: ['\\Seen'] }] });
    await useMailStore.getState().markEmailReadStatus(7, false);

    expect(api.vaultApplyFlags).toHaveBeenCalledWith(ACCOUNT.id, NAME, ACCOUNT.email, [{ uid: 7, flags: ['\\Seen'], on: false }]);
    expect(m.queueOp).not.toHaveBeenCalled();
    expect(api.updateEmailFlags).not.toHaveBeenCalled();
  });

  it('is marked read in the vault when opened, never on a server', async () => {
    prime();
    await useMailStore.getState().selectEmail(7, 'local');

    await vi.waitFor(() => expect(api.vaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, NAME, ACCOUNT.email, [{ uid: 7, flags: ['\\Seen'], on: true }]));
    expect(api.updateEmailFlags).not.toHaveBeenCalled();
    expect(useMailStore.getState().selectedEmail?.subject).toBe(ROW.subject);
  });

  it('is never fetched from a server when the vault cannot serve it, nor are its neighbours prefetched from one', async () => {
    const OLDER = { ...ROW, uid: 8, messageId: '<imported-8@example.test>', date: '2026-01-04T10:00:00Z' };
    prime({ localEmails: [{ ...ROW }, { ...OLDER }], savedEmailIds: new Set([7, 8]), archivedEmailIds: new Set([7, 8]) });
    // uid 7: no vault copy answers; uid 8: a light row with no body yet.
    m.getLocalEmailLight.mockImplementation(async (accountId, mailbox, uid) => (uid === 8 ? { ...OLDER } : null));

    await useMailStore.getState().selectEmail(7, 'local');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(api.fetchEmailLight).not.toHaveBeenCalled();
    expect(useMailStore.getState().selectedEmail?._bodyError).toBeTruthy();
  });

  it('gives an export or a chat view no server fallback either', async () => {
    prime();
    m.getLocalEmailLight.mockResolvedValue(null);
    const answer = await resolveMessageBody({ ...ROW, _accountId: ACCOUNT.id, _mailbox: NAME }, useMailStore.getState());

    expect(answer.ok).toBe(false);
    expect(api.fetchEmailLight).not.toHaveBeenCalled();
  });

  it('goes to the deleted bin when deleted: the local-only path, no server delete, no journal', async () => {
    prime();
    await useMailStore.getState().deleteEmailFromServer(7);

    expect(sends('maildir_delete')).toEqual([{ accountId: ACCOUNT.id, mailbox: NAME, uid: 7, bin: true }]);
    expect(api.deleteEmail).not.toHaveBeenCalled();
    expect(m.queueOp).not.toHaveBeenCalled();
    // Nothing server-shaped is written for it either: no "we deleted the
    // server copy" stamp, and no header cache for a folder no server lists.
    expect(api.appendLocalIndex).not.toHaveBeenCalled();
    expect(m.saveEmailHeaders.mock.calls.filter(([, mailbox]) => mailbox === NAME)).toEqual([]);
  });

  it('goes to the deleted bin from a selection delete too', async () => {
    prime({ selectedEmailIds: new Set([7]) });
    await useMailStore.getState().deleteSelectedFromServer();

    expect(sends('maildir_delete')).toEqual([{ accountId: ACCOUNT.id, mailbox: NAME, uid: 7, bin: true }]);
    expect(api.deleteEmail).not.toHaveBeenCalled();
    expect(m.queueOp).not.toHaveBeenCalled();
    expect(api.appendLocalIndex).not.toHaveBeenCalled();
    expect(m.saveEmailHeaders.mock.calls.filter(([, mailbox]) => mailbox === NAME)).toEqual([]);
  });

  it('is not moved to a server folder, nor to spam', async () => {
    prime();
    await useMailStore.getState().moveEmails([7], 'Archive');
    await useMailStore.getState().moveEmails([7], 'Junk');

    expect(api.moveEmails).not.toHaveBeenCalled();
    expect(m.queueOp).not.toHaveBeenCalled();
  });

  it('is not deleted everywhere: that would skip the bin', async () => {
    prime();
    await purgeEverywhere([7]);

    expect(api.checkMailboxStatus).not.toHaveBeenCalled();
    expect(api.deleteEmail).not.toHaveBeenCalled();
    expect(sends('maildir_delete_many')).toEqual([]);
    expect(sends('maildir_delete')).toEqual([]);
  });

  it('is not unarchived: that would remove the only copy with no bin copy kept', async () => {
    prime();
    await useMailStore.getState().removeLocalEmails([{ uid: 7, location: { accountId: ACCOUNT.id, mailbox: NAME } }]);
    await useMailStore.getState().removeLocalEmail(7);

    expect(sends('maildir_delete_many')).toEqual([]);
    expect(m.deleteLocalEmail).not.toHaveBeenCalled();
  });

  it('cannot be snoozed (a snooze is a server move)', () => {
    prime();
    const state = useMailStore.getState();
    expect(canSnooze({ ...ROW }, state)).toBe(false);
    // The same message in a server folder can.
    expect(canSnooze({ ...ROW }, { ...state, activeMailbox: 'INBOX' })).toBe(true);
  });

  it('is searched in the vault only: no server lane for the folder', async () => {
    prime();
    const [target] = await buildSearchTargets(useMailStore.getState(), { hiddenAccounts: {} }, { folder: 'current', location: 'all' });

    expect(target.localMailboxes).toEqual([NAME]);
    expect(target.serverMailboxes).toEqual([]);
  });
});

// A search or saved-view hit from a local folder, as the daemon stamps it: it
// only knows the server's folder names, so the hit names its folder by the
// vault directory (`_mailbox: <dir>`, `_localOnlyFolder: true`). The view on
// screen is a server folder. Every guard must know the dir as the same folder.
describe('a search hit from a local folder, named by its directory', () => {
  const DIR = FOLDER.dir;
  const HIT = {
    ...ROW, _accountId: ACCOUNT.id, _mailbox: DIR, vaultDir: DIR, _localOnlyFolder: true,
    source: 'local', isLocal: true, isArchived: true,
  };
  let KEY;
  const primeHit = (extra = {}) => {
    prime({ activeMailbox: 'INBOX', localEmails: [], savedEmailIds: new Set(), archivedEmailIds: new Set(), ...extra });
    useSearchStore.setState({ searchResults: [{ ...HIT }], searchActive: true });
    KEY = selectionKey(HIT, useMailStore.getState());
  };
  const noServer = () => {
    expect(api.updateEmailFlags).not.toHaveBeenCalled();
    expect(api.deleteEmail).not.toHaveBeenCalled();
    expect(api.moveEmails).not.toHaveBeenCalled();
    expect(api.fetchEmailLight).not.toHaveBeenCalled();
    expect(m.queueOp).not.toHaveBeenCalled();
  };

  it('is marked read in the vault only when opened', async () => {
    primeHit();
    await useMailStore.getState().selectEmail(KEY, 'local', DIR, null, { ...HIT });

    await vi.waitFor(() => expect(api.vaultApplyFlags).toHaveBeenCalledWith(
      ACCOUNT.id, DIR, ACCOUNT.email, [{ uid: 7, flags: ['\\Seen'], on: true }]));
    noServer();
  });

  it('is starred and marked read in the vault only', async () => {
    primeHit();
    await useMailStore.getState().toggleFlagged(KEY);
    await applyFlagToKeys([KEY], '\\Seen', true);

    expect(api.vaultApplyFlags).toHaveBeenCalledWith(ACCOUNT.id, DIR, ACCOUNT.email, [{ uid: 7, flags: ['\\Flagged'], on: true }]);
    noServer();
  });

  it('goes to the deleted bin when deleted, one or from a selection, with nothing written for a server', async () => {
    primeHit();
    await useMailStore.getState().deleteEmailFromServer(7, { accountId: ACCOUNT.id, mailboxOverride: DIR });
    primeHit({ selectedEmailIds: new Set() });
    useMailStore.setState({ selectedEmailIds: new Set([KEY]) });
    await useMailStore.getState().deleteSelectedFromServer();

    expect(sends('maildir_delete')).toEqual([
      { accountId: ACCOUNT.id, mailbox: DIR, uid: 7, bin: true },
      { accountId: ACCOUNT.id, mailbox: DIR, uid: 7, bin: true },
    ]);
    expect(api.appendLocalIndex).not.toHaveBeenCalled();
    expect(m.saveEmailHeaders.mock.calls.filter(([, mailbox]) => mailbox === DIR)).toEqual([]);
    noServer();
  });

  it('is offered no server action: it counts as local, cannot be snoozed, moved or purged', async () => {
    primeHit();
    const state = useMailStore.getState();
    expect(inLocalFolder(HIT, state)).toBe(true);
    expect(canSnooze({ ...HIT }, state)).toBe(false);

    await useMailStore.getState().moveEmails([KEY], 'Junk');
    await purgeEverywhere([KEY]);

    expect(api.checkMailboxStatus).not.toHaveBeenCalled();
    expect(sends('maildir_delete_many')).toEqual([]);
    noServer();
  });
});
