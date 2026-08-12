// Selection-bar actions (mark read/unread, delete, move) — every one of them
// has to leave the *rendered* list correct, not just `emails`.
//
// The list renders `sortedEmails` and thread objects, both memoized behind
// fingerprints that ignore flags unless the flag counter is bumped. Marking a
// selection as read used to update `emails` alone, so the rows kept showing the
// old unread state until something else forced a re-derive.
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
const mockSetUnreadForAccount = vi.fn();
const mockGetGraphMessageId = vi.fn().mockReturnValue(null);
const mockIsGraphAccount = vi.fn().mockReturnValue(false);

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
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: (...a) => mockGraphSetRead(...a),
  deleteEmail: (...a) => mockDeleteEmail(...a),
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
  setGraphIdMap: () => {},
  getGraphMessageId: (...a) => mockGetGraphMessageId(...a),
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
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUidSet: new Set(emails.map(e => e.uid)),
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

  it('keeps the row when the server delete fails', async () => {
    mockDeleteEmail.mockRejectedValueOnce(new Error('nope'));
    primeStore(seedThread(), [1]);

    await useMailStore.getState().deleteSelectedFromServer();

    // The tombstone is lifted so the loadEmails() reconcile can restore it.
    expect(useMailStore.getState().deleteTombstones.size).toBe(0);
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
      serverUidSet: new Set([1, 2]),
      deleteTombstones: new Set(),
      totalEmails: 2,
      selectedEmailIds: new Set([1]),
      selectedEmail: null,
      selectedEmailId: null,
      // Stand-in for the real server round-trip: a genuine reconcile would
      // find uid 1 gone from the server and drop it from serverUidSet.
      loadEmails: vi.fn(() => {
        tombstoneCountWhenLoadEmailsRan = useMailStore.getState().deleteTombstones.size;
        useMailStore.setState(s => ({
          serverUidSet: new Set([...s.serverUidSet].filter(u => u !== 1)),
        }));
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

describe('moveEmails', () => {
  it('drops the moved rows from the rendered list without waiting for a reload', async () => {
    primeStore(seedThread(), [1]);

    await useMailStore.getState().moveEmails([1], 'Archive');

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [1], 'INBOX', 'Archive');
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([2]);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });
});
