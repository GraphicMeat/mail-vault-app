// A move is a delete plus an append, and it has the same durability problem:
// the rows leave the list the moment the user clicks, but the round trip runs
// in the webview and a reload or a quit inside it loses the intent. So the move
// goes through the op journal like every other mutation — written per (account,
// mailbox) BEFORE the server call, cleared only after it — and offline it stays
// journalled for replayOps instead of failing.
//
// It also brings something back: the uids the messages have in the DESTINATION
// (COPYUID), which is what an undo addresses the moved copy by.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { _selKey } from '../../../stores/slices/unifiedHelpers';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
const mockGraphMoveEmails = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);

// The connectivity verdict the workflow reads. Offline is not a failure — the
// journal entry stays and replayOps sends it when the link is back.
let netOnline = true;
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
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue({ success: true, written: [] }),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  graphMoveEmails: (...a) => mockGraphMoveEmails(...a),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: (...a) => mockMoveEmails(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));

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
      setUnreadForAccount: vi.fn(),
    }),
  },
}));

// `reloadListInView` reaches for the whole-account refresh when the view is
// UNIFIED, and nothing here awaits it: it walks every account, dies on a
// settings store this file only stubs the parts it needs of, and vitest fails
// the RUN on the unhandled rejection while every test still passes. The
// refresh is not what these cases are about; the module has these two exports
// and no more.
vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');

const ACCOUNT = { id: 'a1', email: 'a1@x' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [],
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function primeStore({ emails, selected = [], activeMailbox = 'INBOX', account = ACCOUNT, mailboxes = [], unified = false } = {}) {
  useMailStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    activeMailbox,
    unifiedInbox: unified,
    unifiedFolder: unified ? 'INBOX' : null,
    mailboxScope: null,
    mailboxes,
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
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  graphId = null;
  mockMoveEmails.mockResolvedValue({ success: true, moved: 2, newUids: [41, 42] });
});

describe('moveEmails', () => {
  it('journals the move per folder before the server call and clears it after', async () => {
    const callOrder = [];
    mockQueueOp.mockImplementation(async () => { callOrder.push('queueOp'); return 1; });
    mockClearOps.mockImplementation(async () => { callOrder.push('clearOps'); });
    mockMoveEmails.mockImplementation(async () => {
      callOrder.push('moveEmails');
      return { success: true, moved: 2, newUids: [41, 42] };
    });
    primeStore({ emails: [row(7), row(8)], selected: [7, 8] });

    const result = await useMailStore.getState().moveEmails([7, 8], 'Archive');

    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'move', accountId: 'a1', mailbox: 'INBOX', uids: [7, 8], arg: { target: 'Archive' },
    });
    expect(mockClearOps).toHaveBeenCalledWith({
      op: 'move', accountId: 'a1', mailbox: 'INBOX', uids: [7, 8], arg: { target: 'Archive' },
    });
    // The journal has to precede the round trip (a reload in between must not
    // lose the intent) and clear only after it (only success clears it).
    expect(callOrder).toEqual(['queueOp', 'moveEmails', 'clearOps']);

    // What an undo needs: where the messages came from and where they landed.
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]).toMatchObject({
      accountId: 'a1', from: 'INBOX', to: 'Archive',
      srcUids: [7, 8], dstUids: [41, 42], messageIds: ['m7@mock', 'm8@mock'],
    });
    expect(useMailStore.getState().emails).toEqual([]);
  });

  it('reports no destination uids when the server sent no COPYUID', async () => {
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: null });
    primeStore({ emails: [row(7)] });

    const result = await useMailStore.getState().moveEmails([7], 'Archive');

    // Never a guess: a made-up uid addresses a different message.
    expect(result.moved[0].dstUids).toBeNull();
  });

  it('offline: rows leave the list, the op stays journalled, the server is not called', async () => {
    netOnline = false;
    primeStore({ emails: [row(7), row(8)] });

    const result = await useMailStore.getState().moveEmails([7], 'Archive');

    expect(mockQueueOp).toHaveBeenCalledWith({
      op: 'move', accountId: 'a1', mailbox: 'INBOX', uids: [7], arg: { target: 'Archive' },
    });
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([8]);
    expect(result.moved[0]).toMatchObject({ from: 'INBOX', to: 'Archive', srcUids: [7], dstUids: null, deferred: true });
  });

  it('a skipped unstamped row keeps its tick and stays in the list', async () => {
    // Stamped late: no `_accountId`, so its selection key is the bare uid and
    // nothing can say which account or folder it lives in. Refusing the whole
    // batch over it would strand a move that destroys nothing.
    const unstamped = row(7);
    const stamped = row(8, { _accountId: ACCOUNT.id, _mailbox: 'INBOX' });
    primeStore({
      emails: [unstamped, stamped],
      selected: [7, _selKey(stamped)],
      activeMailbox: 'UNIFIED',
      unified: true,
    });

    const result = await useMailStore.getState().moveEmails([7, _selKey(stamped)], 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [8], 'INBOX', 'Archive');
    expect(mockQueueOp).toHaveBeenCalledTimes(1);
    expect(result.moved.map(m => m.srcUids)).toEqual([[8]]);
    // The row nothing could place is still on screen and still ticked — it was
    // not moved, so the list must not pretend it was.
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([7]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([7]);
  });

  it('a row-menu move clears only its own keys, leaving an unrelated bulk selection intact', async () => {
    // selectedEmailIds holds 9 from an unrelated bulk-select elsewhere in the
    // list; this move targets only row 7 (e.g. via that row's own menu). It
    // must clear 7 from the selection without touching 9.
    primeStore({ emails: [row(7), row(9)], selected: [9] });

    await useMailStore.getState().moveEmails([7], 'Archive');

    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([9]);
  });

  it('a Graph group is not journalled', async () => {
    const graphAccount = { id: 'a1', email: 'a1@x', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };
    graphId = 'gid';
    primeStore({
      emails: [row(7)],
      account: graphAccount,
      mailboxes: [{ name: 'Archive', path: 'Archive', _graphFolderId: 'gfolder', children: [] }],
    });

    const result = await useMailStore.getState().moveEmails([7], 'Archive');

    expect(mockGraphMoveEmails).toHaveBeenCalledWith('tok', ['gid'], 'gfolder');
    // Graph is addressed by a per-session message id, not a replayable uid —
    // replayOps would only throw the entry away again.
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(result.moved).toEqual([]);
    // The rows still leave the list: the move happened, it just has no undo.
    expect(useMailStore.getState().emails).toEqual([]);
  });
});
