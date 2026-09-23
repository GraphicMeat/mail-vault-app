// Read-state round trip for a single open email.
//
// Three surfaces have to agree: the list row (`emails`/`sortedEmails`), the
// open viewer copy (`selectedEmail`) and the server. The action bar picks its
// label from the viewer copy, so any surface left behind makes the bar offer
// the wrong next action — mark-unread, reopen, and the button still reads
// "Mark unread" because the body cache handed back the flags it was filled
// with.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSetUnreadForAccount = vi.fn();

let markAsReadMode = 'auto';
let markAsReadDelay = 3;

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  // The flag core journals every write and clears it on success.
  queueOp: vi.fn().mockResolvedValue(1),
  clearOps: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
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
      get markAsReadMode() { return markAsReadMode; },
      get markAsReadDelay() { return markAsReadDelay; },
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
const CACHE_KEY = 'acct1-INBOX-1';

function primeStore(flags = []) {
  const emails = [
    {
      uid: 1, messageId: 'a@mock', subject: 'General', flags,
      from: { address: 'them@mock.test' }, date: '2026-08-01T10:00:00Z',
    },
  ];
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
    serverUids: serverUids(new Set([1]), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const seenOf = (uid) =>
  useMailStore.getState().sortedEmails.find(e => e.uid === uid)?.flags?.includes('\\Seen');
const viewerSeen = () =>
  useMailStore.getState().selectedEmail?.flags?.includes('\\Seen');

// A body cache entry frozen with whatever flags the email had when opened.
function seedCache(flags) {
  useMailStore.getState().addToCache(
    CACHE_KEY,
    { uid: 1, subject: 'General', flags, html: '<p>body</p>', text: 'body' },
    128,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  markAsReadMode = 'auto';
  markAsReadDelay = 3;
  mockFetchEmailLight.mockResolvedValue({ uid: 1, subject: 'General', flags: [], html: '<p>body</p>', text: 'body' });
  mockGetLocalEmailLight.mockResolvedValue(null);
});

describe('selectEmail — auto mark as read', () => {
  it('flips the list row, not just the viewer copy', async () => {
    primeStore([]);

    await useMailStore.getState().selectEmail(1);

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
    expect(viewerSeen()).toBe(true);
    expect(seenOf(1)).toBe(true);
  });

  it('refreshes the sidebar unread badge', async () => {
    primeStore([]);

    await useMailStore.getState().selectEmail(1);

    expect(mockSetUnreadForAccount).toHaveBeenCalledWith('acct1', 0);
  });

  it('marks a cache-hit reopen as read too', async () => {
    primeStore([]);
    seedCache([]);

    await useMailStore.getState().selectEmail(1);

    expect(mockFetchEmailLight).not.toHaveBeenCalled(); // served from cache
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
    expect(viewerSeen()).toBe(true);
    expect(seenOf(1)).toBe(true);
  });

  it('leaves an already-read email alone', async () => {
    primeStore(['\\Seen']);
    seedCache(['\\Seen']);

    await useMailStore.getState().selectEmail(1);

    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
  });

  it('never marks in manual mode', async () => {
    markAsReadMode = 'manual';
    primeStore([]);

    await useMailStore.getState().selectEmail(1);

    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(seenOf(1)).toBe(false);
  });

  describe('delay mode', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits for the configured delay before marking', async () => {
      markAsReadMode = 'delay';
      markAsReadDelay = 3;
      primeStore([]);

      await useMailStore.getState().selectEmail(1);
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
      expect(useMailStore.getState().markReadProgress).toEqual({
        startedAt: Date.now(),
        endsAt: Date.now() + 3000,
      });

      await vi.advanceTimersByTimeAsync(3000);
      expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
      expect(seenOf(1)).toBe(true);
      expect(useMailStore.getState().markReadProgress).toBeNull();
    });

    it('cancels the timer when the reader closes and restarts it on reopen', async () => {
      markAsReadMode = 'delay';
      primeStore([]);

      await useMailStore.getState().selectEmail(1);
      useMailStore.getState().closeEmail();
      expect(useMailStore.getState().markReadProgress).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();

      await useMailStore.getState().selectEmail(1);
      await vi.advanceTimersByTimeAsync(2999);
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockUpdateEmailFlags).toHaveBeenCalledOnce();
    });

    it('cancels a stale same-UID timer when another account and folder is selected', async () => {
      markAsReadMode = 'delay';
      const accountB = { id: 'acct2', email: 'other@mock.test' };
      const emailB = { uid: 1, subject: 'Other', flags: [], html: '<p>b</p>', text: 'b' };
      let releaseA;
      mockUpdateEmailFlags.mockImplementationOnce(() => new Promise(resolve => { releaseA = resolve; }));
      mockFetchEmailLight.mockResolvedValueOnce({ uid: 1, subject: 'General', flags: [], html: '<p>a</p>', text: 'a' });
      mockFetchEmailLight.mockResolvedValueOnce(emailB);
      primeStore([]);

      await useMailStore.getState().selectEmail(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(releaseA).toBeTypeOf('function');

      useMailStore.setState({
        accounts: [ACCOUNT, accountB], activeAccountId: accountB.id, activeMailbox: 'Sent',
        emails: [{ ...emailB, _accountId: accountB.id, _mailbox: 'Sent' }],
        selectedEmail: null, selectedEmailId: null,
      });
      await useMailStore.getState().selectEmail(1, 'server', 'Sent');
      releaseA();
      await Promise.resolve();

      expect(useMailStore.getState().selectedEmail.uid).toBe(1);
      expect(useMailStore.getState().selectedEmail.subject).toBe('Other');
      expect(useMailStore.getState().emails[0].flags).not.toContain('\\Seen');
      expect(mockUpdateEmailFlags).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(3000);
      expect(mockUpdateEmailFlags).toHaveBeenCalledTimes(2);
      expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(accountB, 1, ['\\Seen'], 'add', 'Sent');
    });

    it('ignores a mark-read completion after the reader closes', async () => {
      markAsReadMode = 'delay';
      let releaseMark;
      mockUpdateEmailFlags.mockImplementationOnce(() => new Promise(resolve => { releaseMark = resolve; }));
      primeStore([]);

      await useMailStore.getState().selectEmail(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(releaseMark).toBeTypeOf('function');

      useMailStore.getState().closeEmail();
      releaseMark();
      await Promise.resolve();

      expect(useMailStore.getState().selectedEmail).toBeNull();
      expect(useMailStore.getState().selectedEmailId).toBeNull();
      expect(seenOf(1)).toBe(false);
    });

    it('does not publish or schedule a read after closing during the body fetch', async () => {
      markAsReadMode = 'delay';
      let releaseFetch;
      mockFetchEmailLight.mockImplementationOnce(() => new Promise(resolve => { releaseFetch = resolve; }));
      primeStore([]);

      const pending = useMailStore.getState().selectEmail(1);
      await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
      useMailStore.getState().closeEmail();
      releaseFetch({ uid: 1, subject: 'General', flags: [], html: '<p>body</p>', text: 'body' });
      await pending;
      await vi.advanceTimersByTimeAsync(3000);

      expect(useMailStore.getState().selectedEmail).toBeNull();
      expect(useMailStore.getState().selectedEmailId).toBeNull();
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    });

    it('does not publish a stale body after the account and folder change during fetch', async () => {
      markAsReadMode = 'delay';
      const accountB = { id: 'acct2', email: 'other@mock.test' };
      let releaseFetch;
      mockFetchEmailLight.mockImplementationOnce(() => new Promise(resolve => { releaseFetch = resolve; }));
      primeStore([]);

      const pending = useMailStore.getState().selectEmail(1);
      await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
      useMailStore.setState({
        accounts: [ACCOUNT, accountB], activeAccountId: accountB.id, activeMailbox: 'Sent',
        selectedEmail: null, selectedEmailId: null,
      });
      releaseFetch({ uid: 1, subject: 'Old account', flags: [], html: '<p>old</p>', text: 'old' });
      await pending;

      expect(useMailStore.getState().selectedEmail).toBeNull();
      expect(useMailStore.getState().selectedEmailId).toBeNull();
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    });

    it('cancels a pending timer when the reader switches to a thread', async () => {
      markAsReadMode = 'delay';
      primeStore([]);

      await useMailStore.getState().selectEmail(1);
      useMailStore.getState().selectThread({
        threadId: 'thread-b', lastEmail: { uid: 2 }, emails: [{ uid: 2 }], messageCount: 1,
      });
      expect(useMailStore.getState().markReadProgress).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
      expect(useMailStore.getState().selectedThread.threadId).toBe('thread-b');
    });
  });
});

// A message whose body the vault already holds opens without a fetch — and
// used to open without ever being marked read. Every other path through
// selectEmail (cache hit, Graph, IMAP) marks on open; the vault branch fell
// straight through to the publish, so an archived message, or any search hit
// answered from the vault, stayed unread until it was reopened from the
// in-memory cache. Reported 2026-09-21 as "opening the first email from a
// search list does not trigger the delayed mark as read".
describe('selectEmail — a body served from the vault', () => {
  const vaultBody = (flags = []) => ({
    uid: 1, messageId: 'a@mock', subject: 'General', flags, html: '<p>vault</p>', text: 'vault',
  });

  it('marks it read on open, without fetching', async () => {
    primeStore([]);
    mockGetLocalEmailLight.mockResolvedValue(vaultBody());

    await useMailStore.getState().selectEmail(1);

    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
    expect(viewerSeen()).toBe(true);
    expect(seenOf(1)).toBe(true);
  });

  it('leaves the server alone for a vault-only copy, and still marks it read here', async () => {
    primeStore([]);
    mockGetLocalEmailLight.mockResolvedValue(vaultBody());

    await useMailStore.getState().selectEmail(1, 'local-only');

    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(seenOf(1)).toBe(true);
  });

  it('leaves the server alone for a row the server no longer holds', async () => {
    primeStore([]);
    useMailStore.setState(state => ({ emails: state.emails.map(e => ({ ...e, serverDeleted: true })) }));
    useMailStore.getState().updateSortedEmails();
    mockGetLocalEmailLight.mockResolvedValue(vaultBody());

    await useMailStore.getState().selectEmail(1);

    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(seenOf(1)).toBe(true);
  });

  describe('delay mode', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs the countdown, then marks', async () => {
      markAsReadMode = 'delay';
      markAsReadDelay = 3;
      primeStore([]);
      mockGetLocalEmailLight.mockResolvedValue(vaultBody());

      await useMailStore.getState().selectEmail(1);

      expect(useMailStore.getState().markReadProgress).toEqual({
        startedAt: Date.now(), endsAt: Date.now() + 3000,
      });
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);
      expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
      expect(seenOf(1)).toBe(true);
      expect(useMailStore.getState().markReadProgress).toBeNull();
    });
  });
});

describe('selectEmail — cached body, current flags', () => {
  it('reopens with the read state the list holds, not the cached one', async () => {
    markAsReadMode = 'manual';
    primeStore([]);            // row was marked unread after being read
    seedCache(['\\Seen']);     // body cached while it was still read

    await useMailStore.getState().selectEmail(1);

    expect(viewerSeen()).toBe(false);
  });

  it('keeps the cached body', async () => {
    markAsReadMode = 'manual';
    primeStore([]);
    seedCache(['\\Seen']);

    await useMailStore.getState().selectEmail(1);

    expect(useMailStore.getState().selectedEmail.html).toBe('<p>body</p>');
  });
});

// A Sent copy the INBOX list merged in, opened by its own folder (EmailRow
// hands selectEmail `_mailbox`). INBOX has its own message under that uid, and
// every lookup of "the clicked row" by bare uid handed that one back: its
// flags painted the Sent copy's viewer, and its Message-ID made the Sent
// copy's own vault file look like another message's.
describe('selectEmail — a Sent copy opened from the INBOX list', () => {
  const SENT_ROW = {
    uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: [],
    from: { address: ACCOUNT.email }, date: '2026-08-01T11:00:00Z',
    _accountId: ACCOUNT.id, _fromSentFolder: true, _mailbox: 'Sent',
  };
  const primeWithSent = () => {
    markAsReadMode = 'manual';
    primeStore(['\\Seen']);
    useMailStore.setState({
      mailboxes: [
        { name: 'INBOX', path: 'INBOX', children: [] },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
      ],
      sentEmails: [SENT_ROW],
    });
  };

  it('paints a cache hit with the Sent row\'s flags, not INBOX\'s same-numbered row', async () => {
    primeWithSent();
    useMailStore.getState().addToCache(
      'acct1-Sent-1',
      { uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: ['\\Seen'], html: '<p>sent</p>', text: 'sent' },
      128,
    );

    await useMailStore.getState().selectEmail(1, 'server', 'Sent');

    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    expect(viewerSeen()).toBe(false); // the Sent row is unread; INBOX 1 is read
  });

  it('keeps a vault copy whose Message-ID matches the Sent row, not INBOX\'s', async () => {
    primeWithSent();
    mockGetLocalEmailLight.mockResolvedValue({ uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: [], html: '<p>vault</p>', text: 'vault' });

    await useMailStore.getState().selectEmail(1, 'server', 'Sent');

    expect(mockGetLocalEmailLight).toHaveBeenCalledWith(ACCOUNT.id, 'Sent', 1);
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    expect(useMailStore.getState().selectedEmail?.html).toBe('<p>vault</p>');
  });
});

describe('markEmailReadStatus', () => {
  // A flag change is not one of the three things allowed to close the reader
  // (delete, move, the close button). It used to close on unread, which read
  // as the message being taken away for having been marked.
  it('keeps the viewer open when the open email is marked unread', async () => {
    primeStore(['\\Seen']);
    useMailStore.setState({ selectedEmailId: 1, selectedEmail: { uid: 1, flags: ['\\Seen'] }, selectedEmailSource: 'server' });

    await useMailStore.getState().markEmailReadStatus(1, false);

    expect(seenOf(1)).toBe(false);
    expect(useMailStore.getState().selectedEmailId).toBe(1);
    expect(useMailStore.getState().selectedEmail?.flags).not.toContain('\\Seen');
  });

  it('drops the stale cached copy so a reopen re-reads the flags', async () => {
    primeStore(['\\Seen']);
    seedCache(['\\Seen']);
    useMailStore.setState({ selectedEmailId: 1, selectedEmail: { uid: 1, flags: ['\\Seen'] } });

    await useMailStore.getState().markEmailReadStatus(1, false);

    expect(useMailStore.getState().getFromCache(CACHE_KEY)?.flags).not.toContain('\\Seen');
  });

  it('keeps the email open when marking it read', async () => {
    primeStore([]);
    useMailStore.setState({ selectedEmailId: 1, selectedEmail: { uid: 1, flags: [] } });

    await useMailStore.getState().markEmailReadStatus(1, true);

    expect(useMailStore.getState().selectedEmail?.flags).toContain('\\Seen');
    expect(useMailStore.getState().selectedEmailId).toBe(1);
  });

  it('leaves a different open email alone when marking one unread', async () => {
    primeStore(['\\Seen']);
    useMailStore.setState({ selectedEmailId: 2, selectedEmail: { uid: 2, flags: ['\\Seen'] } });

    await useMailStore.getState().markEmailReadStatus(1, false);

    expect(useMailStore.getState().selectedEmailId).toBe(2);
    expect(useMailStore.getState().selectedEmail?.uid).toBe(2);
  });

  // The INBOX list merges the account's Sent copies in for context, and a
  // Sent message with no INBOX reply is a row of its own there — opened by
  // its own folder (EmailRow hands selectEmail `_mailbox`). The viewer's
  // toggle then passes the bare uid, and INBOX holds a different message
  // under that number: the write has to follow the open copy's folder.
  it('marks the open Sent copy under its own folder, not INBOX\'s message with the same uid', async () => {
    markAsReadMode = 'manual';
    primeStore(['\\Seen']);
    useMailStore.setState({
      mailboxes: [
        { name: 'INBOX', path: 'INBOX', children: [] },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
      ],
      sentEmails: [{
        uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: ['\\Seen'],
        from: { address: ACCOUNT.email }, date: '2026-08-01T11:00:00Z',
        _accountId: ACCOUNT.id, _fromSentFolder: true, _mailbox: 'Sent',
      }],
    });
    mockFetchEmailLight.mockResolvedValue({ uid: 1, messageId: 's@mock', subject: 'Sent copy', flags: ['\\Seen'], html: '<p>sent</p>', text: 'sent' });

    await useMailStore.getState().selectEmail(1, 'server', 'Sent');
    await useMailStore.getState().markEmailReadStatus(1, false);

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'remove', 'Sent');
    expect(mockUpdateEmailFlags).not.toHaveBeenCalledWith(expect.anything(), 1, ['\\Seen'], 'remove', 'INBOX');
    expect(seenOf(1)).toBe(true); // INBOX's own message 1, untouched
    expect(useMailStore.getState().sentEmails[0].flags).not.toContain('\\Seen');
    // …and the Sent copy the toggle was pressed in stays open.
    expect(useMailStore.getState().selectedEmail?.messageId).toBe('s@mock');
  });
});

// The badge is a count of the inbox, and it used to be written only by the
// loads and by a \Seen change — so a message deleted or moved out of the inbox
// left it on the old number until the next server round trip finished. Both
// cases below run with no round trip at all (`loadEmails` is a stub in
// primeStore), which is what the report looked like: an empty folder under a
// badge that said 1, catching up "after a while".
describe('sidebar unread badge', () => {
  it('drops as soon as the unread row leaves the inbox list', () => {
    primeStore([]);
    expect(mockSetUnreadForAccount).toHaveBeenLastCalledWith('acct1', 1);

    // What every delete/move does first: the row goes, optimistically.
    useMailStore.setState({ emails: [], totalEmails: 0 });
    useMailStore.getState().updateSortedEmails();

    expect(mockSetUnreadForAccount).toHaveBeenLastCalledWith('acct1', 0);
  });

  it('is not overwritten by another folder that is on screen', () => {
    primeStore([]);
    expect(mockSetUnreadForAccount).toHaveBeenLastCalledWith('acct1', 1);

    // The deleted message, unread, in the Bin — the folder the user is now
    // looking at. Its unread is not the account's inbox count.
    useMailStore.setState({
      activeMailbox: 'Trash',
      emails: [{
        uid: 9, messageId: 'b@mock', subject: 'Binned', flags: [],
        from: { address: 'them@mock.test' }, date: '2026-08-02T10:00:00Z',
      }],
      totalEmails: 1,
      serverUids: serverUids(new Set([9]), { complete: false }),
    });
    useMailStore.getState().updateSortedEmails();

    // Still the inbox's count, not the Bin's one unread.
    expect(mockSetUnreadForAccount).toHaveBeenLastCalledWith('acct1', 1);
  });
});
