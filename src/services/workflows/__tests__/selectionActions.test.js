// Selection-bar actions (mark read/unread, delete, move) — every one of them
// has to leave the *rendered* list correct, not just `emails`.
//
// The list renders `sortedEmails` and thread objects, both memoized behind
// fingerprints that ignore flags unless the flag counter is bumped. Marking a
// selection as read used to update `emails` alone, so the rows kept showing the
// old unread state until something else forced a re-derive.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { _selKey, selectionKey } from '../../../stores/slices/unifiedHelpers';

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

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
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

const ACCOUNT = { id: 'acct1', email: 'me@mock.test' };

// Two messages in one RFC thread, both unread.
function seedThread(flags = { 1: [], 2: [] }) {
  return [
    {
      uid: 1, messageId: 'a@mock', subject: 'General', flags: flags[1],
      from: { address: 'them@mock.test' }, date: '2026-08-01T10:00:00Z',
    },
    {
      uid: 2, messageId: 'b@mock', inReplyTo: 'a@mock', subject: 'Re: General', flags: flags[2],
      from: { address: 'me@mock.test' }, date: '2026-08-02T10:00:00Z',
    },
  ];
}

function primeStore(emails, selected) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    // A case that spans folders (a subtree scope, a folder list) must not
    // leak into the next one — the store keeps both across cases.
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
    // The real one is a server round-trip; these workflows only use it to reconcile.
    loadEmails: vi.fn(),
    // Every case seeds the same uids in the same mailbox, so the memo
    // fingerprints match across cases and would hand back the previous case's
    // rows. Clear them so each case starts from its own seed.
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const seenOf = (uid) =>
  useMailStore.getState().sortedEmails.find(e => e.uid === uid)?.flags?.includes('\\Seen');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGraphAccount.mockReturnValue(false);
  mockGetGraphMessageId.mockReturnValue(null);
  mockGraphDeleteMessage.mockResolvedValue(undefined);
});

describe('markSelectedAsRead', () => {
  it('flips \\Seen in the rendered list, not just in emails', async () => {
    primeStore(seedThread(), [1, 2]);
    expect(seenOf(1)).toBe(false);

    await useMailStore.getState().markSelectedAsRead();

    expect(seenOf(1)).toBe(true);
    expect(seenOf(2)).toBe(true);
  });

  it('rebuilds threads so the row unread count drops to zero', async () => {
    primeStore(seedThread(), [1, 2]);
    const before = [...useMailStore.getState().getThreads().values()][0];
    expect(before.unreadCount).toBe(2);

    await useMailStore.getState().markSelectedAsRead();

    const after = [...useMailStore.getState().getThreads().values()][0];
    expect(after.unreadCount).toBe(0);
  });

  it('bumps _flagSeq so EmailList recomputes its threads', async () => {
    primeStore(seedThread(), [1]);
    const before = useMailStore.getState()._flagSeq;

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState()._flagSeq).toBeGreaterThan(before);
  });

  it('leaves unselected rows alone and clears the selection', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().markSelectedAsRead();

    expect(seenOf(1)).toBe(true);
    expect(seenOf(2)).toBe(false);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });

  it('updates the open viewer copy of a selected email', async () => {
    primeStore(seedThread(), [2]);
    useMailStore.setState({ selectedEmailId: 2, selectedEmail: { uid: 2, flags: [] } });

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Seen');
  });

  it('adds \\Seen on the server for every selected uid', async () => {
    primeStore(seedThread(), [1, 2]);

    await useMailStore.getState().markSelectedAsRead();

    expect(mockUpdateEmailFlags.mock.calls.map(c => [c[1], c[3]]))
      .toEqual([[1, 'add'], [2, 'add']]);
  });

  it('refreshes the sidebar unread badge', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().markSelectedAsRead();

    expect(mockSetUnreadForAccount).toHaveBeenCalledWith('acct1', 1);
  });

  it('uses the Graph API for Graph accounts instead of IMAP flags', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    mockGetGraphMessageId.mockImplementation((_a, _m, uid) => `graph-${uid}`);
    primeStore(seedThread(), [1]);

    await useMailStore.getState().markSelectedAsRead();

    expect(mockGraphSetRead).toHaveBeenCalledWith(undefined, 'graph-1', true);
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(seenOf(1)).toBe(true);
  });

  it('still updates the list when the server call fails', async () => {
    mockUpdateEmailFlags.mockRejectedValueOnce(new Error('IMAP down'));
    primeStore(seedThread(), [1]);

    await useMailStore.getState().markSelectedAsRead();

    expect(seenOf(1)).toBe(true);
  });
});

describe('markSelectedAsUnread', () => {
  it('clears \\Seen in the rendered list', async () => {
    primeStore(seedThread({ 1: ['\\Seen'], 2: ['\\Seen'] }), [1, 2]);
    expect(seenOf(1)).toBe(true);

    await useMailStore.getState().markSelectedAsUnread();

    expect(seenOf(1)).toBe(false);
    expect(seenOf(2)).toBe(false);
  });

  it('raises the thread unread count back to the message count', async () => {
    primeStore(seedThread({ 1: ['\\Seen'], 2: ['\\Seen'] }), [1, 2]);
    expect([...useMailStore.getState().getThreads().values()][0].unreadCount).toBe(0);

    await useMailStore.getState().markSelectedAsUnread();

    expect([...useMailStore.getState().getThreads().values()][0].unreadCount).toBe(2);
  });

  it('removes \\Seen on the server for every selected uid', async () => {
    primeStore(seedThread({ 1: ['\\Seen'], 2: ['\\Seen'] }), [1, 2]);

    await useMailStore.getState().markSelectedAsUnread();

    expect(mockUpdateEmailFlags.mock.calls.map(c => [c[1], c[3]]))
      .toEqual([[1, 'remove'], [2, 'remove']]);
  });
});

describe('deleteSelectedFromServer', () => {
  it('drops the selected rows from the rendered list immediately', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([2]);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCOUNT, 1, 'INBOX');
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });

  // The INBOX list merges the account's Sent copies in, and a uid names a
  // message only inside one folder. The map the delete resolved its rows
  // through was keyed by bare uid and let the LAST entry win — the Sent copy —
  // so deleting the folder's own message under that number deleted the Sent
  // message instead, and the row it took off the list came back at the next
  // sync (while the merged copy vanished from its thread).
  it('deletes the folder\'s own message when a merged Sent copy shares its uid', async () => {
    primeStore(seedThread(), [1]);
    useMailStore.setState({
      mailboxes: [
        { name: 'INBOX', path: 'INBOX', children: [] },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
      ],
      sentEmails: [{
        uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: ['\\Seen'],
        from: { address: 'me@mock.test' }, date: '2026-08-03T10:00:00Z',
        _accountId: ACCOUNT.id, _fromSentFolder: true, _mailbox: 'Sent',
      }],
    });

    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCOUNT, 1, 'INBOX');
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([2]);
    // The Sent copy is a different message: it stays, on the server and in the list.
    expect(useMailStore.getState().sentEmails.map(e => e.uid)).toEqual([1]);
  });

  it('keeps the row when the server delete fails', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    // The tombstone is lifted so the loadEmails() reconcile can restore it.
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
  });

  // A Graph "uid" is the message's POSITION in the folder listing, so the
  // uid → Graph id map is only right while the folder has not changed since it
  // was written. An unresolvable id used to be logged as "skipping" and then
  // fall straight through to the success bookkeeping: the row disappeared, the
  // sidecar was pruned, and the message stayed on the server until the next
  // reload put it back. That is a delete that reports success and does nothing.
  it('treats an unresolvable Graph id as a failed delete, not a silent success', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    mockGetGraphMessageId.mockReturnValue(null);
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockGraphDeleteMessage).not.toHaveBeenCalled();
    // Tombstone lifted, sidecar unpruned — the reconcile puts the row back.
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
    expect(mockSaveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(1))).toBe(false);
  });

  it('deletes the Graph message the row itself names, not the one the stale map names', async () => {
    mockIsGraphAccount.mockReturnValue(true);
    mockGetGraphMessageId.mockReturnValue('id-from-stale-map');
    const emails = seedThread();
    emails[0]._graphId = 'id-on-the-row';
    primeStore(emails, [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockGraphDeleteMessage).toHaveBeenCalledTimes(1);
    expect(mockGraphDeleteMessage.mock.calls[0][1]).toBe('id-on-the-row');
  });

  // The tombstone that hides a deleted row is store state, so a reload wipes it.
  // If the header sidecar still lists the uid, the row repaints as though it was
  // never deleted. loadEmails() cannot prune it either — it diffs the emails it
  // had against the server's, and the optimistic update already removed this uid
  // from both sides. The single-row deleteEmailFromServer has always pruned;
  // the bulk path did not, which is what an e2e reload assertion caught.
  it('prunes the deleted uid from the header sidecar so a reload cannot resurrect it', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    const prune = mockSaveEmailHeaders.mock.calls.find(c => c[4]?.removedUids?.includes(1));
    expect(prune).toBeTruthy();
    expect(prune[0]).toBe(ACCOUNT.id);
    expect(prune[1]).toBe('INBOX');
  });

  // The whole delete runs in the webview, so a reload or quit inside the loop
  // kills it before the remaining commands are sent — and the rows are already
  // hidden, so the user is shown a finished delete either way. The journal is
  // what lets the next launch finish the job, and it is only useful if it is
  // written BEFORE the first round-trip.
  it('journals the uids before the first server delete and clears them after', async () => {
    const order = [];
    mockQueuePendingDeletes.mockImplementation(async (...a) => { order.push(['queue', ...a]); });
    mockClearPendingDeletes.mockImplementation(async (...a) => { order.push(['clear', ...a]); });
    mockDeleteEmail.mockImplementation(async () => { order.push(['delete']); });
    primeStore(seedThread(), [1, 2]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(order[0]).toEqual(['queue', ACCOUNT.id, 'INBOX', [1, 2]]);
    expect(order.at(-1)).toEqual(['clear', ACCOUNT.id, 'INBOX', [1, 2]]);
    expect(order.filter(o => o[0] === 'delete')).toHaveLength(2);
  });

  // A delete that failed is still a delete that was attempted. Leaving it
  // journalled would re-issue it on every launch for the life of the install.
  it('clears the journal even when the server delete failed', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockClearPendingDeletes).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX', [1]);
  });

  it('does not prune a uid whose server delete failed', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockSaveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(1))).toBe(false);
  });

  // "Delete from Server" promises the local copy survives. It does — the
  // .eml stays in Maildir — but nothing ever cleared the optimistic
  // tombstone, so the row stayed hidden for the rest of the session instead
  // of re-rendering as "Local only".
  it('re-renders a message with a surviving local copy as local-only after a successful server delete', async () => {
    const localCopy = seedThread()[0]; // uid 1, archived locally

    // A regression here previously threw inside the try block and got
    // silently absorbed by the pre-existing failure-path catch — which
    // produces the same final row state via a different, wrong mechanism
    // (immediate lift, before the reconcile, plus a false failure log).
    // Guard both: no error logged, and the tombstone is still present at the
    // moment loadEmails() runs (proving the lift happens strictly after the
    // reconcile, not synchronously in the catch block).
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let tombstoneCountWhenLoadEmailsRan = null;

    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'INBOX',
      viewMode: 'all',
      emails: seedThread(),
      sentEmails: [],
      localEmails: [localCopy],
      savedEmailIds: new Set([1]),
      archivedEmailIds: new Set([1]),
      // Proven complete BEFORE the delete, and still holding uid 1 — so the
      // only thing that can make this row read local-only is the delete
      // itself taking uid 1 out of the set.
      serverUids: serverUids(new Set([1, 2]), { complete: true }),
      deleteTombstones: new Set(),
      totalEmails: 2,
      selectedEmailIds: new Set([1]),
      selectedEmail: null,
      selectedEmailId: null,
      // A reconcile that re-derives but never re-enumerates. This is not a
      // weakened stand-in — it is what the real loadEmails() does whenever
      // its CONDSTORE flag-only or delta-noop branch matches: those return
      // before the UID search, leaving the uid set exactly as they found it.
      // The old version of this mock pruned the uid and set complete itself,
      // which made the test pass while production shipped a row stuck on
      // `local` for the rest of the session.
      loadEmails: vi.fn(() => {
        tombstoneCountWhenLoadEmailsRan = useMailStore.getState().deleteTombstones.size;
        useMailStore.getState().updateSortedEmails();
        return Promise.resolve();
      }),
      _sortedEmailsFingerprint: '',
    });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();

    await useMailStore.getState().deleteSelectedFromServer();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    // The tombstone must still be set when loadEmails() runs — a lift that
    // happened earlier (e.g. from the failure-path catch) would show 0 here.
    expect(tombstoneCountWhenLoadEmailsRan).toBe(1);
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
    expect([...useMailStore.getState().serverUids.uids]).toEqual([2]);
    expect(useMailStore.getState().serverUids.complete).toBe(true);
    const row = useMailStore.getState().sortedEmails.find(e => e.uid === 1);
    expect(row).toBeDefined();
    expect(row.source).toBe('local-only');

    consoleErrorSpy.mockRestore();
  });

  // The same tombstone is load-bearing for a message with NO local copy —
  // without it, a stale header-cache hydration on account/folder switch
  // could resurrect a row the server delete just removed.
  it('leaves the tombstone in place and the row absent for a message with no local copy', async () => {
    primeStore(seedThread(), [1]); // uid 1 not archived — primeStore seeds archivedEmailIds empty

    await useMailStore.getState().deleteSelectedFromServer();

    expect(useMailStore.getState().deleteTombstones.size).toBe(1);
    expect(useMailStore.getState().sortedEmails.find(e => e.uid === 1)).toBeUndefined();
  });
});

// The single-row delete behind the row menu, the viewer's delete button and the
// `#` shortcut. It used to hold the row on screen (and a modal over a backdrop)
// for the whole server round trip; the bulk paths never did.
describe('deleteEmailFromServer', () => {
  it('pulls the row out of the list before the server answers', async () => {
    let release;
    mockDeleteEmail.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    primeStore(seedThread(), []);

    const pending = useMailStore.getState().deleteEmailFromServer(1);
    // Enough ticks for the workflow's dynamic store import and the optimistic
    // write, nowhere near enough for a server delete that has not been released.
    await new Promise(r => setTimeout(r, 0));

    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([2]);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCOUNT, 1, 'INBOX');
    release();
    await pending;
  });

  it('puts the row back when the server refuses', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), []);

    await expect(useMailStore.getState().deleteEmailFromServer(1)).rejects.toThrow('nope');

    // Tombstone lifted and a reconcile asked for — the same contract the bulk
    // path uses to restore a row whose delete failed.
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
    expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
  });

  // The row vanishes before the server answers, so a reload in that window has
  // to leave something the next launch can finish — the same journal the bulk
  // path writes.
  it('journals the uid before the row goes and clears it once the server confirms', async () => {
    primeStore(seedThread(), []);

    await useMailStore.getState().deleteEmailFromServer(1);

    expect(mockQueuePendingDeletes).toHaveBeenCalledWith('acct1', 'INBOX', [1]);
    expect(mockClearPendingDeletes).toHaveBeenCalledWith('acct1', 'INBOX', [1]);
  });

  it('clears the journal when the delete fails, so no replay deletes a restored row', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), []);

    await expect(useMailStore.getState().deleteEmailFromServer(1)).rejects.toThrow('nope');

    expect(mockClearPendingDeletes).toHaveBeenCalledWith('acct1', 'INBOX', [1]);
  });

  it('clears the viewer when the deleted row was the open email', async () => {
    primeStore(seedThread(), []);
    useMailStore.setState({ selectedEmailId: 1, selectedEmail: { uid: 1 } });

    await useMailStore.getState().deleteEmailFromServer(1);

    expect(useMailStore.getState().selectedEmailId).toBeNull();
    expect(useMailStore.getState().selectedEmail).toBeNull();
  });
});

describe('moveEmails', () => {
  it('drops the moved rows from the rendered list without waiting for a reload', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().moveEmails([1], 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'INBOX', 'Archive');
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([2]);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });

  // The row menu, the bulk bar and the M shortcut hand this workflow SELECTION
  // KEYS — what the checkbox writes (selectionKey). A single folder's list keys
  // its own rows by bare uid, but a row it merged in from another folder gets
  // the full `account:folder:uid`, and the single-folder branch passed the keys
  // straight through to `imap_move_emails`, whose `uids` is a Vec<u32>:
  //
  //   invalid args `uids` for command `imap_move_emails`: invalid type:
  //   string "e7ce0440-…:INBOX:34363", expected u32
  //
  // (bson73, discussion #1, 2026-09-03.) A key names a message; the wire wants
  // the uid, under the folder the key names.
  const MAILBOXES = [
    { name: 'INBOX', path: 'INBOX', children: [] },
    { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
  ];
  const onlyNumbersReachedTheWire = () => {
    for (const [, uids] of mockMoveEmails.mock.calls) {
      for (const u of uids) expect(typeof u).toBe('number');
    }
  };

  it('moves a merged Sent copy under Sent and the folder\'s own message under INBOX, never a key', async () => {
    primeStore(seedThread(), []);
    useMailStore.setState({
      mailboxes: MAILBOXES,
      sentEmails: [{
        uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: ['\\Seen'],
        from: { address: 'me@mock.test' }, date: '2026-08-03T10:00:00Z',
        _accountId: ACCOUNT.id, _fromSentFolder: true, _mailbox: 'Sent',
      }],
    });
    const state = useMailStore.getState();
    // What a thread row's menu hands over: the INBOX message by bare uid, the
    // merged Sent copy by its full key.
    const keys = [state.emails[0], state.sentEmails[0]].map(e => selectionKey(e, state));
    expect(keys).toEqual([1, `${ACCOUNT.id}:Sent:1`]);

    await state.moveEmails(keys, 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledTimes(2);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'INBOX', 'Archive');
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'Sent', 'Archive');
    onlyNumbersReachedTheWire();
    // Both rows leave the list; INBOX's uid 2 is untouched.
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([2]);
    expect(useMailStore.getState().sentEmails).toEqual([]);
  });

  it('moves a row from another folder under that folder, not the one on screen', async () => {
    // A search hit: the list shows INBOX.Technik, the row came from INBOX.
    primeStore([{
      uid: 34363, messageId: 'h@mock', subject: 'Hetzner status', flags: [],
      from: { address: 'status@hetzner.test' }, date: '2026-09-01T10:00:00Z', _mailbox: 'INBOX',
    }], []);
    useMailStore.setState({ activeMailbox: 'INBOX.Technik', mailboxes: MAILBOXES });
    const state = useMailStore.getState();
    const key = selectionKey(state.emails[0], state);
    expect(key).toBe(`${ACCOUNT.id}:INBOX:34363`);

    await state.moveEmails([key], 'INBOX.Technik.Hetzner Server');

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [34363], 'INBOX', 'INBOX.Technik.Hetzner Server');
    onlyNumbersReachedTheWire();
    expect(useMailStore.getState().emails).toEqual([]);
  });

  it('moves a branch listing folder by folder', async () => {
    // A subtree list spans folders; the same uid can name a message in each.
    primeStore([
      { uid: 1, messageId: 'k1@mock', subject: 'Nested one', flags: [], from: { address: 'a@mock.test' },
        date: '2026-08-01T10:00:00Z', _accountId: ACCOUNT.id, _mailbox: 'Kunden' },
      { uid: 1, messageId: 'k2@mock', subject: 'Nested two', flags: [], from: { address: 'b@mock.test' },
        date: '2026-08-02T10:00:00Z', _accountId: ACCOUNT.id, _mailbox: 'Kunden.Company XY' },
    ], []);
    useMailStore.setState({
      activeMailbox: 'Kunden',
      mailboxScope: { root: 'Kunden', paths: ['Kunden', 'Kunden.Company XY'] },
    });
    const state = useMailStore.getState();
    const keys = state.emails.map(e => selectionKey(e, state));
    expect(keys).toEqual([`${ACCOUNT.id}:Kunden:1`, `${ACCOUNT.id}:Kunden.Company XY:1`]);

    await state.moveEmails(keys, 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledTimes(2);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'Kunden', 'Archive');
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'Kunden.Company XY', 'Archive');
    onlyNumbersReachedTheWire();
    expect(useMailStore.getState().emails).toEqual([]);
  });

  it('drops a moved search hit from the results list', async () => {
    // The reporter's path: an all-folders search from Sent lists INBOX hits,
    // each under the folder it came from.
    const hit = {
      uid: 42, messageId: 'x@mock', subject: 'Cross folder thread check', flags: [],
      from: { address: 'partner@example.com' }, date: '2026-09-01T10:00:00Z',
      _accountId: ACCOUNT.id, _mailbox: 'INBOX', source: 'server-search',
    };
    primeStore([], []);
    useMailStore.setState({ activeMailbox: 'Sent', mailboxes: MAILBOXES });
    const { useSearchStore } = await import('../../../stores/searchStore');
    useSearchStore.setState({ searchActive: true, searchResults: [hit] });
    const state = useMailStore.getState();
    const key = selectionKey(hit, state);
    expect(key).toBe(`${ACCOUNT.id}:INBOX:42`);

    await state.moveEmails([key], 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [42], 'INBOX', 'Archive');
    expect(useSearchStore.getState().searchResults).toEqual([]);
    useSearchStore.setState({ searchActive: false, searchResults: [] });
  });

  it('skips a key that names no row it can place, and moves the rest', async () => {
    primeStore(seedThread(), []);
    const state = useMailStore.getState();

    await state.moveEmails([1, 'no-such-account:INBOX:9'], 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'INBOX', 'Archive');
    onlyNumbersReachedTheWire();
  });
});

// The reader's thread is a snapshot from buildThreads that nothing re-derives.
// Deleting one of its messages used to leave that message in the open thread
// as a ghost row — or, when it was the newest one (the one selectedEmailId
// names), close the whole thread over a single message.
describe('deleteEmailFromServer with a thread open', () => {
  const openThread = (emails) => {
    const lastEmail = emails[emails.length - 1];
    useMailStore.setState({
      selectedThread: { threadId: 'a@mock', subject: 'General', emails, lastEmail, messageCount: emails.length },
      selectedEmailId: lastEmail.uid,
    });
  };

  it('takes the deleted message out of the open thread and keeps the rest open', async () => {
    const emails = seedThread();
    primeStore(emails, []);
    openThread(emails);

    await useMailStore.getState().deleteEmailFromServer(2);

    const thread = useMailStore.getState().selectedThread;
    expect(thread.emails.map(e => e.uid)).toEqual([1]);
    expect(thread.messageCount).toBe(1);
    expect(thread.lastEmail.uid).toBe(1);
    // The list row stays open: the key now names a surviving message.
    expect(useMailStore.getState().selectedEmailId).toBe(1);
  });

  it('closes the reader only when the thread has no message left', async () => {
    const emails = seedThread();
    primeStore(emails, []);
    openThread([emails[0]]);

    await useMailStore.getState().deleteEmailFromServer(1);

    expect(useMailStore.getState().selectedThread).toBeNull();
    expect(useMailStore.getState().selectedEmailId).toBeNull();
  });

  it('leaves an open thread alone when the deleted message is not in it', async () => {
    const emails = seedThread();
    primeStore(emails, []);
    openThread([emails[1]]);
    const before = useMailStore.getState().selectedThread;

    await useMailStore.getState().deleteEmailFromServer(1);

    expect(useMailStore.getState().selectedThread).toBe(before);
  });

  it('matches the message by folder: a merged Sent copy sharing the uid stays in the thread', async () => {
    const emails = seedThread();
    const sentCopy = {
      uid: 1, messageId: 's@mock', subject: 'Re: General', flags: ['\\Seen'],
      from: { address: 'me@mock.test' }, date: '2026-08-03T10:00:00Z',
      _accountId: ACCOUNT.id, _fromSentFolder: true, _mailbox: 'Sent',
    };
    primeStore(emails, []);
    useMailStore.setState({
      mailboxes: [
        { name: 'INBOX', path: 'INBOX', children: [] },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
      ],
      sentEmails: [sentCopy],
    });
    openThread([emails[0], sentCopy]);
    useMailStore.setState({ selectedEmailId: 1 });

    await useMailStore.getState().deleteEmailFromServer(1);

    const thread = useMailStore.getState().selectedThread;
    expect(thread.emails).toEqual([sentCopy]);
    expect(useMailStore.getState().selectedEmailId).toBe(_selKey(sentCopy));
  });

  it('puts the message back in the open thread when the server refuses', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    const emails = seedThread();
    primeStore(emails, []);
    openThread(emails);

    await expect(useMailStore.getState().deleteEmailFromServer(2)).rejects.toThrow('nope');

    expect(useMailStore.getState().selectedThread.emails.map(e => e.uid)).toEqual([1, 2]);
    expect(useMailStore.getState().selectedEmailId).toBe(2);
  });

  it('does not reopen a thread the user has already left when the server refuses', async () => {
    let reject;
    mockDeleteEmail.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const emails = seedThread();
    primeStore(emails, []);
    openThread(emails);

    const pending = useMailStore.getState().deleteEmailFromServer(2);
    await new Promise(r => setTimeout(r, 0));
    useMailStore.getState().closeEmail();
    reject(new Error('nope'));
    await expect(pending).rejects.toThrow('nope');

    expect(useMailStore.getState().selectedThread).toBeNull();
    expect(useMailStore.getState().selectedEmailId).toBeNull();
  });
});
