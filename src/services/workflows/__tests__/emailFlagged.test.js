// One flag workflow, exercised through the star.
//
// Read state, the star, \Answered and $Forwarded are the same operation with a
// different flag, so they land through the same core — and that core has five
// surfaces to satisfy in a fixed order: the rows on screen, the open copy, the
// vault, the op journal, and only then the server. The journal is what makes a
// reload or a stretch offline finish the job instead of losing it, so it goes
// in before the round-trip and comes out only when the round-trip succeeded.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockGraphSetFlagged = vi.fn().mockResolvedValue(undefined);
const mockGraphSetRead = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSetUnreadForAccount = vi.fn();

// The connectivity verdict the workflow reads. Offline is not a failure — the
// journal entry stays and replayOps sends it when the link is back.
let netOnline = true;
// What resolveGraphMessageId answers; null for the IMAP cases.
let graphId = null;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
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
  graphSetFlagged: (...a) => mockGraphSetFlagged(...a),
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
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
  graphMessageToEmail: (m) => m,
  normalizeGraphFolderName: (n) => n,
}));

vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => graphId,
  resolveGraphMessageId: async () => graphId,
  clearGraphIdMap: () => {},
}));

vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline }) },
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
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { toggleFlagged, markAnswered, markForwarded } = await import('../messageMutations');

const ACCOUNT = { id: 'a1', email: 'a1@x' };

const rowOf = (uid) => useMailStore.getState().emails.find(e => e.uid === uid);
const flagsOf = (uid) => rowOf(uid)?.flags || [];

function primeStore({ emails, selected = [], activeMailbox = 'INBOX', account = ACCOUNT } = {}) {
  useMailStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    activeMailbox,
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(emails.map(e => e.uid), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(selected),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    // Same uids across cases would otherwise hand back the previous case's
    // memoized rows.
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

// One account, INBOX, uid 7 read and uid 8 unread — the single-folder view, so
// the selection key of a row is its bare uid.
function primeInbox(flags7 = ['\\Seen']) {
  primeStore({
    emails: [
      { uid: 7, messageId: 'a@mock', subject: 'General', flags: flags7, from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z' },
      { uid: 8, messageId: 'b@mock', subject: 'Other', flags: [], from: { address: 'them@x' }, date: '2026-08-02T10:00:00Z' },
    ],
  });
  useMailStore.setState({
    selectedEmailId: 7,
    selectedEmail: { uid: 7, messageId: 'a@mock', subject: 'General', flags: flags7 },
    selectedEmailSource: 'server',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  graphId = null;
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
});

describe('toggleFlagged', () => {
  it('star on a row lands on the row, the open copy, the vault and the server, through the journal', async () => {
    primeInbox();

    await toggleFlagged(7);

    expect(flagsOf(7)).toContain('\\Flagged');
    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Flagged');
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Seen', '\\Flagged'] }]);
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      arg: { flags: ['\\Flagged'], action: 'add' },
    });
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Flagged'], 'add', 'INBOX');
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7] });

    // The journal has to precede the round-trip (a reload in between must not
    // lose the intent) and clearOps has to follow it (only success clears it).
    expect(mockQueueOp.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateEmailFlags.mock.invocationCallOrder[0]);
    expect(mockClearOps.mock.invocationCallOrder[0]).toBeGreaterThan(mockUpdateEmailFlags.mock.invocationCallOrder[0]);
  });

  it('leaves every other row alone', async () => {
    primeInbox();

    await toggleFlagged(7);

    expect(flagsOf(8)).not.toContain('\\Flagged');
  });

  it('a second toggle removes the star', async () => {
    primeInbox(['\\Seen', '\\Flagged']);

    await toggleFlagged(7);

    expect(flagsOf(7)).toEqual(['\\Seen']);
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      arg: { flags: ['\\Flagged'], action: 'remove' },
    });
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Flagged'], 'remove', 'INBOX');
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Seen'] }]);
  });

  it('offline: the row and vault change, the op stays journalled, the server is not called', async () => {
    primeInbox();
    netOnline = false;

    await toggleFlagged(7);

    expect(flagsOf(7)).toContain('\\Flagged');
    expect(mockVaultApplyFlags).toHaveBeenCalled();
    expect(mockQueueOp).toHaveBeenCalled();
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
  });

  it('a server failure keeps the journal entry and does not throw', async () => {
    primeInbox();
    mockUpdateEmailFlags.mockRejectedValueOnce(new Error('boom'));

    await expect(toggleFlagged(7)).resolves.toBeUndefined();

    expect(flagsOf(7)).toContain('\\Flagged');
    expect(mockQueueOp).toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
  });

  it('a Graph account routes the star to graphSetFlagged and never journals it', async () => {
    const graphAccount = { id: 'a1', email: 'a1@x', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };
    primeStore({
      emails: [{ uid: 7, messageId: 'a@mock', subject: 'General', flags: [], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z' }],
      account: graphAccount,
    });
    graphId = 'gid';

    await toggleFlagged(7);

    expect(mockGraphSetFlagged).toHaveBeenCalledWith('tok', 'gid', true);
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    // Graph is not an IMAP op — replayOps would only throw it away again.
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(flagsOf(7)).toContain('\\Flagged');
  });
});

describe('setSelectedFlagged', () => {
  it('stars every selected row across two folders with one vault write per folder', async () => {
    primeStore({
      activeMailbox: 'UNIFIED',
      emails: [
        { uid: 7, messageId: 'a@mock', subject: 'In', flags: [], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z', _accountId: 'a1', _mailbox: 'INBOX', _accountEmail: 'a1@x' },
        { uid: 3, messageId: 'b@mock', subject: 'Out', flags: [], from: { address: 'a1@x' }, date: '2026-08-02T10:00:00Z', _accountId: 'a1', _mailbox: 'Sent', _accountEmail: 'a1@x' },
      ],
      selected: ['a1:INBOX:7', 'a1:Sent:3'],
    });

    await useMailStore.getState().setSelectedFlagged(true);

    expect(flagsOf(7)).toContain('\\Flagged');
    expect(flagsOf(3)).toContain('\\Flagged');
    expect(mockVaultApplyFlags).toHaveBeenCalledTimes(2);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'] }]);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'Sent', 'a1@x', [{ uid: 3, flags: ['\\Flagged'] }]);
    expect(mockUpdateEmailFlags.mock.calls.map(c => [c[1], c[4]])).toEqual([[7, 'INBOX'], [3, 'Sent']]);
    // The bulk paths hand the selection back empty, as mark read always has.
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });
});

describe('markAnswered / markForwarded', () => {
  it('writes \\Answered for a stamped replyTo', async () => {
    primeInbox();

    await markAnswered({ uid: 7, _accountId: 'a1', _mailbox: 'INBOX' });

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Answered'], 'add', 'INBOX');
    expect(flagsOf(7)).toContain('\\Answered');
  });

  // The row-menu reply: RowActionMenuItems hands replyTarget() a plain
  // single-folder list row, which carries neither _accountId nor _mailbox —
  // only the viewer's reply (selectEmail's stamp) has those. _flagRepliedTo
  // has to resolve the location the way every other flag path does instead
  // of demanding the stamp, or a reply started from the row menu never marks
  // the original \Answered.
  it('resolves an unstamped replyTo (the row-menu shape) through the active account/mailbox', async () => {
    primeInbox();

    await markAnswered({ uid: 7 });

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Answered'], 'add', 'INBOX');
    expect(flagsOf(7)).toContain('\\Answered');
  });

  it('still refuses a local-only row, a staged row, a non-numeric uid, and a row whose account does not resolve', async () => {
    primeInbox();

    await markAnswered({ uid: 9, _accountId: 'a1', _mailbox: 'INBOX', source: 'local-only' });
    await markAnswered({ uid: 9, _accountId: 'a1', _mailbox: 'INBOX', _localStaged: true });
    await markAnswered({ uid: '9', _accountId: 'a1', _mailbox: 'INBOX' });   // non-numeric uid
    await markAnswered({ uid: 9, _accountId: 'no-such-account', _mailbox: 'INBOX' });

    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
  });

  it('sends $Forwarded as a keyword, without a backslash', async () => {
    primeInbox();

    await markForwarded({ uid: 7, _accountId: 'a1', _mailbox: 'INBOX' });

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['$Forwarded'], 'add', 'INBOX');
    expect(flagsOf(7)).toContain('$Forwarded');
  });
});

// _markSelected is now one caller of the shared core rather than its own copy
// of it, so the read path has to keep working — including the journal, which
// it never had before.
describe('mark read, through the same core', () => {
  it('still adds \\Seen on the server and now journals it too', async () => {
    primeStore({
      emails: [{ uid: 7, messageId: 'a@mock', subject: 'General', flags: [], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z' }],
      selected: [7],
    });

    await useMailStore.getState().markSelectedAsRead();

    expect(flagsOf(7)).toContain('\\Seen');
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Seen'], 'add', 'INBOX');
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      arg: { flags: ['\\Seen'], action: 'add' },
    });
    expect(mockSetUnreadForAccount).toHaveBeenCalledWith('a1', 0);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });
});
