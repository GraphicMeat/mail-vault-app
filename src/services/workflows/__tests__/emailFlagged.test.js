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
const mockUnread = {};
const mockSetUnreadForAccount = vi.fn();

// The connectivity verdict the workflow reads. Offline is not a failure — the
// journal entry stays and replayOps sends it when the link is back.
let netOnline = true;
// What resolveGraphMessageId answers; null for the IMAP cases.
let graphId = null;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
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
      unreadPerAccount: mockUnread,
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { useSnoozeStore } = await import('../../../stores/snoozeStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { toggleFlagged, markAnswered, markForwarded, applyFlagToTargets, applySeenLocally } = await import('../messageMutations');

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
  useSearchStore.setState({ searchResults: [] });
});

describe('toggleFlagged', () => {
  it('star on a row lands on the row, the open copy, the vault and the server, through the journal', async () => {
    primeInbox();

    await toggleFlagged(7);

    expect(flagsOf(7)).toContain('\\Flagged');
    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Flagged');
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: true }]);
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      arg: { flags: ['\\Flagged'], action: 'add' },
    });
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Flagged'], 'add', 'INBOX');
    expect(mockClearOps).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      // The arg is part of the entry's identity: without it this clear also
      // empties a \\Seen entry the same message is still owed.
      arg: { flags: ['\\Flagged'], action: 'add' },
    });

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
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: false }]);
    // The toast has to name the direction that actually happened — a star
    // removed offering "Starred 1 message" back told the user the opposite
    // of what their click just did.
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.unstarred', labelParams: { count: 1 } });
  });

  // The Starred view's rows come from the daemon (views.evaluate) and are
  // shown through searchStore's searchResults, never mailStore's `emails`,
  // `localEmails` or `sentEmails`. toggleFlagged's row lookup used to check
  // only those three plus the open copy — a miss there defaulted `on` to
  // true (star), so unstarring an already-flagged row found in no list
  // re-added the flag it already had and told the user it had been starred.
  it('unstars a row found only in a view/search result list', async () => {
    primeStore({ emails: [] });
    useSearchStore.setState({
      searchResults: [
        { uid: 7, messageId: 'a@mock', subject: 'General', flags: ['\\Flagged'], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z', _accountId: 'a1', _mailbox: 'INBOX' },
      ],
    });

    await toggleFlagged(7);

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Flagged'], 'remove', 'INBOX');
    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'flag', accountId: 'a1', mailbox: 'INBOX', uids: [7],
      arg: { flags: ['\\Flagged'], action: 'remove' },
    });
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.unstarred', labelParams: { count: 1 } });
    // The row is repainted unstarred, not dropped — the view itself decides
    // what belongs in it on its next reload, not this toggle. The repaint
    // (patchSearchFlags) is fire-and-forget, so give its dynamic import a
    // tick to land.
    await vi.waitFor(() => {
      expect(useSearchStore.getState().searchResults).toHaveLength(1);
      expect(useSearchStore.getState().searchResults[0].flags).not.toContain('\\Flagged');
    });
  });

  // The vault half of the same miss: _persistVaultFlags looked for the row in
  // the mail store's lists only, so a star taken off in a view reached the
  // server and the screen but never the vault copy's file name or custody
  // entry, and the vault showed it starred until a later sync.
  it('writes the vault copy of a row found only in a view/search result list', async () => {
    primeStore({ emails: [] });
    useSearchStore.setState({
      searchResults: [
        { uid: 7, messageId: 'a@mock', subject: 'General', flags: ['\\Seen', '\\Flagged'], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z', _accountId: 'a1', _mailbox: 'INBOX' },
      ],
    });

    await toggleFlagged(7);

    await vi.waitFor(() => {
      expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: false }]);
    });
  });

  it('never takes a search row that names no folder for the vault write', async () => {
    primeStore({ emails: [] });
    useSearchStore.setState({
      searchResults: [
        { uid: 7, messageId: 'a@mock', subject: 'General', flags: ['\\Flagged'], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z', _accountId: 'a1' },
      ],
    });

    await applyFlagToTargets([{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }], '\\Flagged', false);
    await new Promise(r => setTimeout(r, 0));

    expect(mockVaultApplyFlags).not.toHaveBeenCalled();
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

  // A vault-only row's uid is a pseudo-uid no server ever issued: journalling
  // it files an op the replay can only fail once and throw away, and the STORE
  // it wraps would be aimed at whatever message that number names on the
  // server. The vault write is the whole change for this row.
  it('a vault-only row changes in the vault only — no journal entry, no server call', async () => {
    primeStore({ emails: [] });
    const local = { uid: 900001, messageId: 'v@mock', subject: 'Vault only', flags: [], source: 'local-only', from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z' };
    useMailStore.setState({ localEmails: [local] });
    useMailStore.getState().updateSortedEmails();

    await toggleFlagged(900001);

    expect(useMailStore.getState().localEmails[0].flags).toContain('\\Flagged');
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 900001, flags: ['\\Flagged'], on: true }]);
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
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
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [{ uid: 7, flags: ['\\Flagged'], on: true }]);
    expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'Sent', 'a1@x', [{ uid: 3, flags: ['\\Flagged'], on: true }]);
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

  it('marks the vault copy of a row found only in a view/search result list read', async () => {
    primeStore({ emails: [] });
    useSearchStore.setState({
      searchResults: [
        { uid: 7, messageId: 'a@mock', subject: 'General', flags: ['\\Flagged'], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z', _accountId: 'a1', _mailbox: 'INBOX' },
      ],
    });

    applySeenLocally(useMailStore, { accountId: 'a1', mailbox: 'INBOX', uid: 7, read: true });

    await vi.waitFor(() => {
      expect(mockVaultApplyFlags).toHaveBeenCalledWith('a1', 'INBOX', 'a1@x', [
        { uid: 7, flags: ['\\Seen'], on: true },
      ]);
    });
  });

  // All Inboxes lists a window of each account's mail, so its badge is moved by
  // one, never recounted from those rows (unreadCounts). A message a local
  // snooze holds out of the inbox is on no badge, so its read change moves none.
  it('a read change in All Inboxes moves the badge by one, and not for a locally snoozed message', () => {
    const row = (uid, messageId) => ({ uid, _accountId: 'a1', _mailbox: 'INBOX', messageId, subject: `m${uid}`, flags: [], from: { address: 'them@x' }, date: `2026-08-0${uid - 6}T10:00:00Z` });
    primeStore({ emails: [row(7, '<a@mock>'), row(8, '<held@mock>'), row(9, '<c@mock>')], activeMailbox: 'UNIFIED' });
    useSnoozeStore.setState({ rows: [{ id: 's1', accountId: 'a1', fromMailbox: 'INBOX', snoozedMailbox: '', messageId: '<held@mock>', state: 'snoozed' }] });
    mockUnread.a1 = 5;
    mockSetUnreadForAccount.mockClear();
    try {
      applySeenLocally(useMailStore, { accountId: 'a1', mailbox: 'INBOX', uid: 8, read: true, isUnified: true });
      expect(mockSetUnreadForAccount).not.toHaveBeenCalled();

      applySeenLocally(useMailStore, { accountId: 'a1', mailbox: 'INBOX', uid: 7, read: true, isUnified: true });
      expect(mockSetUnreadForAccount).toHaveBeenLastCalledWith('a1', 4);
    } finally {
      useSnoozeStore.setState({ rows: [] });
      delete mockUnread.a1;
    }
  });
});

// A list row can be behind its vault copy: the Notes to Self reader marks the
// copy it opened read, and the INBOX row of the same message, loaded behind
// the board, is not the row it maps. A star written as that row's whole flag
// list took the read state back off the vault copy and the cached header.
describe('the vault write', () => {
  it('stars the vault copy without writing back a read state the row is behind on', async () => {
    primeStore({ emails: [{ uid: 7, messageId: 'a@mock', subject: 'General', flags: [], from: { address: 'them@x' }, date: '2026-08-01T10:00:00Z' }] });
    // The copy as the daemon lands what it is sent: a whole list replaces
    // its flags, a delta moves only the flags it names.
    const held = new Set(['\\Seen']);
    mockVaultApplyFlags.mockImplementation(async (_accountId, _mailbox, _email, changes) => {
      for (const { flags, on } of changes) {
        if (on === undefined) held.clear();
        for (const flag of flags) if (on === false) held.delete(flag); else held.add(flag);
      }
      return { renamed: 1 };
    });
    try {
      await applyFlagToTargets([{ account: ACCOUNT, accountId: 'a1', mailbox: 'INBOX', uid: 7 }], '\\Flagged', true);
      await vi.waitFor(() => expect(mockVaultApplyFlags).toHaveBeenCalled());
      expect([...held].sort()).toEqual(['\\Flagged', '\\Seen']);
    } finally {
      mockVaultApplyFlags.mockReset().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
    }
  });
});
