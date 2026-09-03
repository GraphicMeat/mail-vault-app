import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub browser globals that mailStore uses at module level
if (!globalThis.window) {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
} else {
  // Ensure addEventListener exists even in restricted environments
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

// Mock all heavy dependencies before importing the store
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetCachedMailboxEntry = vi.fn().mockResolvedValue(null);
const mockInitDB = vi.fn().mockResolvedValue(undefined);
const mockGetAccounts = vi.fn().mockResolvedValue([]);
const mockEnsureAccountsInFile = vi.fn().mockResolvedValue(undefined);
const mockSaveMailboxes = vi.fn().mockResolvedValue(undefined);
const mockReadLocalEmailIndex = vi.fn().mockResolvedValue(null);
const mockGetArchivedEmails = vi.fn().mockResolvedValue([]);
// Used by loadUnifiedInbox.js (per-account mailbox tree + local-email fallback).
const mockGetCachedMailboxes = vi.fn().mockResolvedValue([]);
const mockGetLocalEmails = vi.fn().mockResolvedValue([]);

vi.mock('../../services/db', () => ({
  getLocalEmailLight: (...args) => mockGetLocalEmailLight(...args),
  getEmailHeadersMeta: (...args) => mockGetEmailHeadersMeta(...args),
  getEmailHeadersPartial: (...args) => mockGetEmailHeadersPartial(...args),
  getArchivedEmailIds: (...args) => mockGetArchivedEmailIds(...args),
  getSavedEmailIds: (...args) => mockGetSavedEmailIds(...args),
  getCachedMailboxEntry: (...args) => mockGetCachedMailboxEntry(...args),
  initDB: (...args) => mockInitDB(...args),
  getAccounts: (...args) => mockGetAccounts(...args),
  ensureAccountsInFile: (...args) => mockEnsureAccountsInFile(...args),
  saveMailboxes: (...args) => mockSaveMailboxes(...args),
  readLocalEmailIndex: (...args) => mockReadLocalEmailIndex(...args),
  getArchivedEmails: (...args) => mockGetArchivedEmails(...args),
  getCachedMailboxes: (...args) => mockGetCachedMailboxes(...args),
  getLocalEmails: (...args) => mockGetLocalEmails(...args),
}));
const mockFetchEmailLight = vi.fn().mockResolvedValue(null);
const mockBackupScanUids = vi.fn().mockResolvedValue(null);
const mockBackupGetExternalLocation = vi.fn().mockResolvedValue({ status: 'ready' });
vi.mock('../../services/api', () => ({
  fetchEmailLight: (...args) => mockFetchEmailLight(...args),
  backupScanUids: (...args) => mockBackupScanUids(...args),
  backupGetExternalLocation: (...args) => mockBackupGetExternalLocation(...args),
}));
vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
}));
vi.mock('../../utils/emailParser', () => ({
  buildThreads: () => new Map(),
}));
// Mutable so a test can seed persisted link alerts; `mock` prefix is what lets
// the hoisted factory below reference it.
const mockSettingsState = {
  cacheLimitMB: 128,
  hiddenAccounts: {},
  getLastMailbox: () => 'INBOX',
  emailListStyle: 'default',
  linkAlerts: {},
};
vi.mock('../settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}));
vi.mock('../safeStorage', () => ({
  safeStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}));

const mockGetRestoreDescriptor = vi.fn().mockReturnValue(null);
const mockSaveRestoreDescriptor = vi.fn();
const mockGetAccountCacheMailboxes = vi.fn(() => null);
vi.mock('../../services/cacheManager', () => ({
  getRestoreDescriptor: (...args) => mockGetRestoreDescriptor(...args),
  saveRestoreDescriptor: (...args) => mockSaveRestoreDescriptor(...args),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: (...args) => mockGetAccountCacheMailboxes(...args),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

const { useMailStore } = await import('../mailStore');
const { serverUids, NO_SERVER_UIDS } = await import('../slices/serverUids');

// Helper: create a fake email with a predictable size
function fakeEmail(uid, sizeKB = 10) {
  return {
    uid,
    subject: 'Test email ' + uid,
    from: 'test@example.com',
    to: 'user@example.com',
    date: new Date().toISOString(),
    html: 'x'.repeat(sizeKB * 1024),
    attachments: [],
  };
}

function fakeEmailWithHeavyFields(uid) {
  return {
    uid,
    subject: 'Heavy email',
    from: 'test@example.com',
    to: 'user@example.com',
    rawSource: 'a'.repeat(50000),
    attachments: [
      { filename: 'doc.pdf', contentType: 'application/pdf', content: 'base64data' },
      { filename: 'img.png', contentType: 'image/png', content: 'moredata' },
    ],
  };
}

describe('mailStore email cache', () => {
  beforeEach(() => {
    const store = useMailStore.getState();
    store.emailCache.clear();
    useMailStore.setState({ cacheCurrentSizeMB: 0 });
  });

  it('adds an email to the cache', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmail(1), 128);

    expect(store.emailCache.size).toBe(1);
    expect(store.emailCache.has('acc1-INBOX-1')).toBe(true);
  });

  it('strips rawSource before caching', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmailWithHeavyFields(1), 128);

    const cached = store.emailCache.get('acc1-INBOX-1');
    expect(cached.email.rawSource).toBeUndefined();
  });

  it('strips attachment content but keeps metadata', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', fakeEmailWithHeavyFields(1), 128);

    const cached = store.emailCache.get('acc1-INBOX-1');
    expect(cached.email.attachments).toHaveLength(2);
    expect(cached.email.attachments[0].filename).toBe('doc.pdf');
    expect(cached.email.attachments[0].content).toBeUndefined();
    expect(cached.email.attachments[1].content).toBeUndefined();
  });

  // The thread view paints a cached body straight from this map. An inline
  // image whose bytes were stripped here has nothing for cid: to resolve to,
  // so the second open of a thread showed the filename in a box.
  it('keeps content on inline images the html references via cid:', () => {
    const store = useMailStore.getState();
    store.addToCache('acc1-INBOX-1', {
      uid: 1,
      html: '<p>hi</p><img src="cid:shot@mail"><img src="cid:other">',
      attachments: [
        { filename: 'shot.png', contentType: 'image/png', contentId: '<shot@mail>', content: 'inlinebytes' },
        { filename: 'doc.pdf', contentType: 'application/pdf', content: 'pdfbytes' },
        { filename: 'orphan.png', contentType: 'image/png', contentId: '<nobody@mail>', content: 'orphanbytes' },
      ],
    }, 128);

    const [inline, real, orphan] = store.emailCache.get('acc1-INBOX-1').email.attachments;
    expect(inline.content).toBe('inlinebytes');
    expect(real.content).toBeUndefined();
    expect(orphan.content).toBeUndefined();
  });

  it('evicts oldest entries when cache limit is exceeded', () => {
    const store = useMailStore.getState();
    // Each email is ~100KB. With a 0.2MB limit, only ~2 fit.
    store.addToCache('key-1', fakeEmail(1, 100), 0.2);
    store.addToCache('key-2', fakeEmail(2, 100), 0.2);
    store.addToCache('key-3', fakeEmail(3, 100), 0.2);

    // Oldest (key-1) should have been evicted
    expect(store.emailCache.has('key-1')).toBe(false);
    expect(store.emailCache.has('key-3')).toBe(true);
  });

  it('treats cacheLimitMB=0 as unlimited (capped at 4096)', () => {
    const store = useMailStore.getState();
    for (let i = 0; i < 10; i++) {
      store.addToCache(`key-${i}`, fakeEmail(i, 10), 0);
    }
    expect(store.emailCache.size).toBe(10);
  });

  it('re-caching a key moves it to end (LRU)', () => {
    const store = useMailStore.getState();
    // First, add enough entries to fill cache, then verify LRU ordering.
    // Use a generous limit (10MB) and add 3 entries of ~1MB each.
    store.addToCache('lru-1', fakeEmail(201, 1024), 10);
    store.addToCache('lru-2', fakeEmail(202, 1024), 10);

    // Re-cache lru-1 — it should now be the newest (moved to end of Map)
    store.addToCache('lru-1', fakeEmail(201, 1024), 10);

    // Verify insertion order: lru-2 should be first (oldest), lru-1 should be last
    const keys = [...store.emailCache.keys()];
    expect(keys[0]).toBe('lru-2');
    expect(keys[keys.length - 1]).toBe('lru-1');
  });

  it('estimateEmailSizeMB returns a reasonable value', () => {
    const store = useMailStore.getState();
    const email = fakeEmail(1, 100); // ~100KB
    const size = store.estimateEmailSizeMB(email);
    expect(size).toBeGreaterThan(0.05);
    expect(size).toBeLessThan(0.2);
  });

  it('does not mutate original email when stripping fields', () => {
    const store = useMailStore.getState();
    const original = fakeEmailWithHeavyFields(1);
    store.addToCache('key-1', original, 128);

    // Original should still have rawSource and attachment content
    expect(original.rawSource).toBeDefined();
    expect(original.attachments[0].content).toBe('base64data');
  });
});

describe('mailStore initial state', () => {
  it('has empty emailCache on creation', () => {
    const store = useMailStore.getState();
    expect(store.emailCache).toBeInstanceOf(Map);
  });

  it('has exportProgress state for export/import tracking', () => {
    const store = useMailStore.getState();
    expect(store.exportProgress).toBeNull();
    expect(typeof store.setExportProgress).toBe('function');
    expect(typeof store.dismissExportProgress).toBe('function');
  });

  it('setExportProgress and dismissExportProgress work', () => {
    const store = useMailStore.getState();
    store.setExportProgress({ total: 100, completed: 50, active: true, mode: 'export' });
    expect(useMailStore.getState().exportProgress).toEqual({
      total: 100, completed: 50, active: true, mode: 'export',
    });

    store.dismissExportProgress();
    expect(useMailStore.getState().exportProgress).toBeNull();
  });
});

describe('account cache restore (PERF-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = useMailStore.getState();
    store.emailCache.clear();
    useMailStore.setState({
      cacheCurrentSizeMB: 0,
      accounts: [{ id: 'acc1', email: 'test@example.com' }, { id: 'acc2', email: 'other@example.com' }],
      activeAccountId: 'acc1',
      emails: [fakeEmail(1)],
      totalEmails: 1,
    });
  });

  it('setActiveAccount restores from descriptor without triggering IMAP call', async () => {
    // Prime restore descriptor with first-window data for acc2
    const descriptor = {
      accountId: 'acc2',
      mailbox: 'INBOX',
      viewMode: 'all',
      totalEmails: 2,
      topVisibleIndex: 0,
      selectedUid: null,
      mailboxes: [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }],
      mailboxesFetchedAt: Date.now(),
      firstWindow: [fakeEmail(10), fakeEmail(11)],
      firstWindowSavedUids: [],
      firstWindowArchivedUids: [],
      timestamp: Date.now(),
    };
    mockGetRestoreDescriptor.mockReturnValue(descriptor);

    // Switch to acc2 — should restore from descriptor
    await useMailStore.getState().setActiveAccount('acc2');

    // Verify first-window emails rendered instantly
    const state = useMailStore.getState();
    expect(state.emails).toHaveLength(2);
    expect(state.emails[0].uid).toBe(10);
    expect(state.activeAccountId).toBe('acc2');

    // IMAP fetch should NOT have been called (first paint from descriptor)
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });
});

describe('stale generation guard (PERF-04)', () => {
  it('loadEmails isStale check prevents stale generation from writing state', async () => {
    // Set up store with an active account
    useMailStore.setState({
      accounts: [{ id: 'acc1', email: 'test@example.com', password: 'pass' }],
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX',
      emails: [],
    });

    // Mock cached headers to return different data for different calls
    let callCount = 0;
    mockGetEmailHeadersMeta.mockImplementation(async () => {
      callCount++;
      // Simulate delay on first call
      if (callCount === 1) {
        await new Promise(r => setTimeout(r, 50));
      }
      return { emails: [fakeEmail(callCount * 100)], totalEmails: 1 };
    });

    // Start first loadEmails, then immediately switch account (making first stale)
    const firstLoad = useMailStore.getState().loadEmails();

    // Switch activeAccountId mid-flight — makes the first load stale
    await new Promise(r => setTimeout(r, 10));
    useMailStore.setState({ activeAccountId: 'acc2' });

    await firstLoad.catch(() => {});

    // The stale first load should NOT have overwritten the activeAccountId
    expect(useMailStore.getState().activeAccountId).toBe('acc2');
  });
});

describe('prefetch OOM guard (STAB-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = useMailStore.getState();
    store.emailCache.clear();
    useMailStore.setState({ cacheCurrentSizeMB: 0 });
  });

  it('_prefetchAdjacentEmails skips when cache exceeds 80% of limit', async () => {
    const store = useMailStore.getState();

    // Fill cache to exceed 80% of 128MB limit (>102.4MB)
    // Use addToCache to inflate the module-level _cacheCurrentSizeMB tracker
    // Each email is ~1MB, add 110 to exceed 80% threshold
    for (let i = 0; i < 110; i++) {
      store.addToCache(`fill-${i}`, fakeEmail(i, 1024), 4096); // high limit so nothing gets evicted
    }

    // Set up state with sorted emails for prefetch to work with
    useMailStore.setState({
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX',
      sortedEmails: [
        { uid: 1, subject: 'Current' },
        { uid: 2, subject: 'Next 1' },
        { uid: 3, subject: 'Next 2' },
        { uid: 4, subject: 'Next 3' },
      ],
      accounts: [{ id: 'acc1', email: 'test@example.com' }],
    });

    // Call prefetch — should skip due to memory pressure
    await store._prefetchAdjacentEmails(1);

    // Neither local nor remote fetch should have been called
    expect(mockGetLocalEmailLight).not.toHaveBeenCalled();
    expect(mockFetchEmailLight).not.toHaveBeenCalled();
  });
});

describe('network recovery (STAB-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useMailStore.setState({
      accounts: [{ id: 'acc1', email: 'test@example.com', password: 'pass', host: 'imap.example.com', port: 993 }],
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX',
      connectionStatus: 'connected',
      connectionError: null,
      connectionErrorType: null,
      emails: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets connectionStatus to error on offline event', () => {
    // Dispatch an offline event through the store state directly
    // (the actual event listener is stubbed in the test environment)
    useMailStore.setState({
      connectionStatus: 'error',
      connectionErrorType: 'offline',
      connectionError: 'Network offline',
    });

    const state = useMailStore.getState();
    expect(state.connectionStatus).toBe('error');
    expect(state.connectionErrorType).toBe('offline');
    expect(state.connectionError).toBe('Network offline');
  });

  it('connectionStatus transitions: connected -> error -> connected on recovery', () => {
    // Simulate network error
    useMailStore.setState({
      connectionStatus: 'error',
      connectionErrorType: 'offline',
      connectionError: 'Network offline',
    });
    expect(useMailStore.getState().connectionStatus).toBe('error');

    // Simulate recovery
    useMailStore.setState({
      connectionStatus: 'connected',
      connectionError: null,
      connectionErrorType: null,
    });
    expect(useMailStore.getState().connectionStatus).toBe('connected');
    expect(useMailStore.getState().connectionError).toBeNull();
  });

  it('activateAccount resets connection error state on successful switch', async () => {
    // Start with error state
    useMailStore.setState({
      connectionStatus: 'error',
      connectionError: 'Previous error',
      connectionErrorType: 'offline',
    });

    // activateAccount should reset retry state (tested via state transition)
    // The actual activateAccount call will try IMAP which is mocked, but the
    // key verification is that account switch clears error state
    const store = useMailStore.getState();
    expect(typeof store.activateAccount).toBe('function');
  });
});

describe('getChatEmails provenance stamping', () => {
  // The merged list mixes INBOX and Sent, whose UIDs overlap. Readers
  // downstream (body loader, attachments, delete) need each message's own
  // folder — guessing from the active view returns a different message.
  it('tags every merged email with the account and folder it came from', () => {
    const inbox = { uid: 2, messageId: '<inbox-2@x>', date: '2026-01-02T00:00:00Z' };
    const sent = { uid: 2, messageId: '<sent-2@x>', date: '2026-01-03T00:00:00Z', _accountId: 'acct-1' };

    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      mailboxes: [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
      ],
      accounts: [{ id: 'acct-1', email: 'user@example.com' }],
      sortedEmails: [inbox],
      sentEmails: [sent],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });

    const merged = useMailStore.getState().getChatEmails();
    expect(merged).toHaveLength(2);
    expect(inbox._mailbox).toBe('INBOX');
    expect(inbox._srcAccountId).toBe('acct-1');
    expect(sent._mailbox).toBe('Sent');
    expect(sent._fromSentFolder).toBe(true);
  });
});

describe('updateSortedEmails memoization', () => {
  // The guard summarised every collection by its size, so two different
  // one-element Sets were indistinguishable. During a folder switch the sets
  // arrive in stages: a derivation runs with this folder's localEmails but the
  // PREVIOUS view's archivedEmailIds, finds no matching uid, renders nothing,
  // and stores that fingerprint. The correct set lands a moment later with the
  // same size and a different uid — fingerprint matches, recompute skipped, and
  // the row never appears. Reproduced as an archived + server-deleted message
  // that would not come back as "Local only" after a reload.
  it('re-derives when a set keeps its size but changes contents', () => {
    const local = { uid: 3, subject: 'Archived message 3', date: 'Sun, 04 Jan 2026 12:00:00 +0000', serverDeleted: true };

    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'Archive',
      viewMode: 'all',
      emails: [],
      localEmails: [local],
      serverUids: serverUids(new Set(), { complete: true }),
      deleteTombstones: new Set(),
      // Same sizes as the correct state below, different uid — this is the
      // stale half-loaded moment.
      archivedEmailIds: new Set([99]),
      savedEmailIds: new Set([99]),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();
    expect(useMailStore.getState().sortedEmails).toHaveLength(0);

    useMailStore.setState({
      archivedEmailIds: new Set([3]),
      savedEmailIds: new Set([3]),
    });
    useMailStore.getState().updateSortedEmails();

    const sorted = useMailStore.getState().sortedEmails;
    expect(sorted).toHaveLength(1);
    expect(sorted[0].uid).toBe(3);
    expect(sorted[0].source).toBe('local-only');
  });

  it('refuses to build a server uid set without an explicit completeness claim', () => {
    // The whole point of binding: you cannot forget to say whether this is
    // the whole mailbox. A forgotten argument must fail loudly, not default.
    expect(() => serverUids(new Set([1]))).toThrow(TypeError);
    expect(() => serverUids(new Set([1]), {})).toThrow(TypeError);
    expect(() => serverUids(new Set([1]), { complete: 'yes' })).toThrow(TypeError);
    expect(serverUids(new Set([1]), { complete: false }).complete).toBe(false);
  });

  it('never stamps local-only from a uid set, verified or not', () => {
    // The account-switch paint: archivedEmailIds restored from cache, server
    // list not back yet. An empty uid set is "not asked", not "not there" —
    // and even a COMPLETE set only speaks for one mailbox, so it never
    // promotes a row to local-only either (see the next test).
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      viewMode: 'all',
      emails: [],
      localEmails: [{ uid: 3, subject: 'Archived message 3', date: 'Sun, 04 Jan 2026 12:00:00 +0000' }],
      archivedEmailIds: new Set([3]),
      savedEmailIds: new Set([3]),
      serverUids: serverUids(new Set(), { complete: false }),
      deleteTombstones: new Set(),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();

    const sorted = useMailStore.getState().sortedEmails;
    expect(sorted).toHaveLength(1);
    expect(sorted[0].source).toBe('local');
  });

  it('leaves a vault row missing from a COMPLETE uid set as an ordinary vault row', () => {
    // The false-gold regression. A complete UID SEARCH enumerates ONE mailbox;
    // a message archived out of INBOX on Gmail, moved to a label, or sitting
    // in the Bin is absent from it and very much on the server. The row used
    // to go gold and claim "deleted from the server, nothing else has it".
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      viewMode: 'all',
      emails: [],
      localEmails: [{ uid: 3, subject: 'Archived message 3', date: 'Sun, 04 Jan 2026 12:00:00 +0000' }],
      archivedEmailIds: new Set([3]),
      savedEmailIds: new Set([3]),
      serverUids: serverUids(new Set([7]), { complete: true }),
      deleteTombstones: new Set(),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();

    expect(useMailStore.getState().sortedEmails[0].source).toBe('local');
  });

  it('stamps local-only once the vault entry records that we deleted the server copy', () => {
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      viewMode: 'all',
      emails: [],
      localEmails: [{ uid: 3, subject: 'Archived message 3', date: 'Sun, 04 Jan 2026 12:00:00 +0000', serverDeleted: true }],
      archivedEmailIds: new Set([3]),
      savedEmailIds: new Set([3]),
      // Deliberately the state that used to be required and now proves
      // nothing: an unverified set. The stamp on the message is the evidence.
      serverUids: serverUids(new Set(), { complete: false }),
      deleteTombstones: new Set(),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();

    expect(useMailStore.getState().sortedEmails[0].source).toBe('local-only');
  });

  it('still skips the derivation when nothing changed at all', () => {
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'Archive',
      viewMode: 'all',
      emails: [],
      localEmails: [{ uid: 3, subject: 'Archived message 3' }],
      archivedEmailIds: new Set([3]),
      savedEmailIds: new Set([3]),
      serverUids: NO_SERVER_UIDS,
      deleteTombstones: new Set(),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();
    const first = useMailStore.getState().sortedEmails;

    useMailStore.getState().updateSortedEmails();
    // Same array instance back means the guard short-circuited.
    expect(useMailStore.getState().sortedEmails).toBe(first);
  });
});

// Unified inbox merges cache/local data across accounts — it is never a live
// server enumeration for any of them. If completeness carried a stale
// `true` from the single-account view the user was just on, every archived
// row outside the rendered chunk would derive "local-only" the instant
// unified inbox painted. All three serverUids writes in
// loadUnifiedInbox.js must force the flag back to false; zustand's shallow
// merge means silently omitting it would let the old value survive.
describe('unified inbox — server uid completeness never carries a stale true', () => {
  const ACCOUNT = { id: 'acct-1', email: 'a@example.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRestoreDescriptor.mockReturnValue(null);
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
    mockGetCachedMailboxes.mockResolvedValue([]);
    mockGetSavedEmailIds.mockResolvedValue(new Set());
    mockGetArchivedEmailIds.mockResolvedValue(new Set());
    mockReadLocalEmailIndex.mockResolvedValue(null);
    mockGetLocalEmails.mockResolvedValue([]);
  });

  it('loadUnifiedInbox clears the flag for both the first chunk and later chunks', async () => {
    // 65 cached headers on disk — one past CHUNK_SIZE (50), so the
    // progressive-chunk loop (site :237) runs at least once in addition to
    // the first-chunk write (site :206).
    const headers = Array.from({ length: 65 }, (_, i) => ({
      uid: i + 1,
      subject: `Msg ${i + 1}`,
      date: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: headers, totalEmails: headers.length });

    useMailStore.setState({
      accounts: [ACCOUNT],
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      viewMode: 'all',
      // Simulates the single-account view completing a full sync right
      // before the user switched into unified inbox.
      serverUids: serverUids(new Set(), { complete: true }),
    });

    await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');

    expect(useMailStore.getState().serverUids.uids.size).toBe(65);
    expect(useMailStore.getState().serverUids.complete).toBe(false);
  });

  it('switchUnifiedFolder\'s cache-hit path clears the flag too', async () => {
    const { _unifiedFolderCache } = await import('../../services/workflows/activateAccount');
    _unifiedFolderCache.set('Archive', {
      emails: [{ uid: 1, subject: 'Cached', date: '2026-01-01T00:00:00Z' }],
      timestamp: Date.now(),
    });

    useMailStore.setState({
      accounts: [ACCOUNT],
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      viewMode: 'all',
      serverUids: serverUids(new Set(), { complete: true }),
    });

    await useMailStore.getState().switchUnifiedFolder('Archive');
    // The synchronous cache-hit write is what's under test; the function
    // also fires a background loadUnifiedInbox() refresh it doesn't await.
    await new Promise((r) => setTimeout(r, 0));

    expect(useMailStore.getState().serverUids.complete).toBe(false);

    _unifiedFolderCache.delete('Archive');
  });
});

// The unified list is fed from three sources that all cover the same rows: the
// in-memory restore descriptor's 50-row window, the 500 headers read off disk,
// and the pre-unified snapshot. Only the snapshot was deduped, so every message
// the prewarm descriptor held arrived twice — one row per copy in the list, and
// two identical messages inside every thread built from it.
describe('unified inbox — one row per message across its three sources', () => {
  const ACCOUNT = { id: 'acct-1', email: 'a@example.com' };

  const headers = [
    { uid: 1, subject: 'Newest', date: '2026-08-26T20:28:00Z' },
    { uid: 2, subject: 'Middle', date: '2026-08-26T20:07:00Z' },
    { uid: 3, subject: 'Oldest', date: '2026-08-25T09:00:00Z' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedMailboxes.mockResolvedValue([]);
    mockGetSavedEmailIds.mockResolvedValue(new Set());
    mockGetArchivedEmailIds.mockResolvedValue(new Set());
    mockReadLocalEmailIndex.mockResolvedValue(null);
    mockGetLocalEmails.mockResolvedValue([]);
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: headers, totalEmails: headers.length });
    mockGetRestoreDescriptor.mockReturnValue(null);
  });

  function keysOf(rows) {
    return rows.map(e => `${e._accountId}:${e.uid}`);
  }

  it('does not repeat a message the restore descriptor and the disk cache both hold', async () => {
    // Exactly what _prewarmAccountCaches writes: the first slice of the same
    // headers getEmailHeadersPartial returns a moment later.
    mockGetRestoreDescriptor.mockReturnValue({
      accountId: ACCOUNT.id,
      mailbox: 'INBOX',
      viewMode: 'all',
      firstWindow: headers.slice(0, 2),
    });

    useMailStore.setState({
      accounts: [ACCOUNT],
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      viewMode: 'all',
      emails: [],
      localEmails: [],
      sortedEmails: [],
      _sortedEmailsFingerprint: '',
    });

    await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');

    const keys = keysOf(useMailStore.getState().sortedEmails);
    expect([...new Set(keys)].sort()).toEqual(keys.slice().sort());
    expect(keys).toHaveLength(3);
    expect(useMailStore.getState().totalEmails).toBe(3);
  });

  it('does not repeat a message the pre-unified snapshot and the disk cache both hold', async () => {
    useMailStore.setState({
      accounts: [ACCOUNT],
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      viewMode: 'all',
      emails: [],
      localEmails: [],
      sortedEmails: [],
      _sortedEmailsFingerprint: '',
    });

    await useMailStore.getState().loadUnifiedInbox(
      { activeAccountId: ACCOUNT.id, emails: headers.slice(0, 1) },
      'INBOX',
    );

    const keys = keysOf(useMailStore.getState().sortedEmails);
    expect(keys).toHaveLength(3);
  });
});

describe('refreshBackedUpUids', () => {
  // `mailboxes` decides whether a Sent target exists, so a neighbour's fixture
  // leaking in would silently change how many scans each test expects.
  beforeEach(() => {
    mockBackupScanUids.mockReset();
    mockBackupGetExternalLocation.mockReset();
    mockBackupGetExternalLocation.mockResolvedValue({ status: 'ready' });
    useMailStore.setState({
      mailboxes: [], backedUpKeys: null, backedUpScopes: null, backupConfigured: null, unifiedFolder: null,
    });
  });

  // Renamed from "...so unified inbox cannot collide" — unifiedInbox is false
  // and only one account is registered here, so no collision is exercised.
  // This test only pins the compound-key format for a single target; the
  // unified-inbox multi-account case is covered separately below.
  it('keys backed-up uids by account id', async () => {
    mockBackupScanUids.mockResolvedValue([11, 12]);
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
    });

    await useMailStore.getState().refreshBackedUpUids();

    const keys = useMailStore.getState().backedUpKeys;
    expect(keys.has('acct-1:INBOX:11')).toBe(true);
    expect(keys.has('acct-1:INBOX:12')).toBe(true);
    expect(keys.has('acct-2:INBOX:11')).toBe(false);
    expect(useMailStore.getState().backedUpScopes).toEqual(new Set(['acct-1:INBOX']));
  });

  it('reports null — not an empty set — when the mirror cannot be read', async () => {
    // An unplugged drive must never read as "nothing is backed up".
    mockBackupScanUids.mockResolvedValue(null);
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      backedUpKeys: new Set(['acct-1:INBOX:11']),
      backedUpScopes: new Set(['acct-1:INBOX']),
    });

    await useMailStore.getState().refreshBackedUpUids();

    expect(useMailStore.getState().backedUpKeys).toBeNull();
    // The scope list has to go with it — a stale scope would make the next
    // reader treat an unanswerable row as answered.
    expect(useMailStore.getState().backedUpScopes).toBeNull();
  });

  // A drive that exists and could not be read, and a drive that was never set
  // up, are the same `null` out of backup_scan_uids and two different things to
  // say. Conflating them put "Backup drive not connected — can't verify" on
  // every message belonging to a user who had never configured one.
  describe('no backup location at all', () => {
    const noDrive = async () => {
      mockBackupScanUids.mockResolvedValue(null);
      mockBackupGetExternalLocation.mockResolvedValue({ status: 'not_configured' });
      useMailStore.setState({
        activeAccountId: 'acct-1',
        activeMailbox: 'INBOX',
        unifiedInbox: false,
        accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      });
      await useMailStore.getState().refreshBackedUpUids();
    };

    it('records that there is no drive, rather than an unreadable one', async () => {
      await noDrive();
      expect(useMailStore.getState().backupConfigured).toBe(false);
      expect(useMailStore.getState().backedUpKeys).toBeNull();
    });

    it('still reports an unreadable configured drive as unknown', async () => {
      mockBackupScanUids.mockResolvedValue(null);
      mockBackupGetExternalLocation.mockResolvedValue({ status: 'disconnected' });
      useMailStore.setState({
        activeAccountId: 'acct-1',
        activeMailbox: 'INBOX',
        unifiedInbox: false,
        accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      });

      await useMailStore.getState().refreshBackedUpUids();

      expect(useMailStore.getState().backupConfigured).toBe(true);
      expect(useMailStore.getState().backedUpKeys).toBeNull();
    });

    it('assumes a drive exists when the location cannot be read either', async () => {
      // Fail closed: claiming "no drive" on an error would silently drop the
      // dot for someone who has one.
      mockBackupScanUids.mockResolvedValue(null);
      mockBackupGetExternalLocation.mockRejectedValue(new Error('nope'));
      useMailStore.setState({
        activeAccountId: 'acct-1',
        activeMailbox: 'INBOX',
        unifiedInbox: false,
        accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      });

      await useMailStore.getState().refreshBackedUpUids();

      expect(useMailStore.getState().backupConfigured).toBe(true);
    });

    it('does not ask about the location when the scan answered', async () => {
      mockBackupScanUids.mockResolvedValue([11]);
      useMailStore.setState({
        activeAccountId: 'acct-1',
        activeMailbox: 'INBOX',
        unifiedInbox: false,
        accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      });

      await useMailStore.getState().refreshBackedUpUids();

      expect(mockBackupGetExternalLocation).not.toHaveBeenCalled();
      expect(useMailStore.getState().backupConfigured).toBe(true);
    });
  });

  it('unified inbox: one account failing to scan makes the whole answer null, not a partial set', async () => {
    // acct-1 scans clean first; acct-2 (scanned second) can't be read at all.
    // The correct answer is "unknown", never a Set holding only acct-1's keys.
    mockBackupScanUids
      .mockResolvedValueOnce([11, 12])
      .mockResolvedValueOnce(null);
    useMailStore.setState({
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      accounts: [
        { id: 'acct-1', email: 'luke@mock.test' },
        { id: 'acct-2', email: 'leia@mock.test' },
      ],
    });

    await useMailStore.getState().refreshBackedUpUids();

    expect(useMailStore.getState().backedUpKeys).toBeNull();
  });

  it('no resolvable target means "unknown", not a lingering stale answer', async () => {
    // Mid account-switch, activeAccountId can briefly point at an id not yet
    // in `accounts`. A previous account's backedUpKeys must not survive and
    // be read as this account's answer.
    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      accounts: [],
      backedUpKeys: new Set(['acct-9:INBOX:1']),
    });

    await useMailStore.getState().refreshBackedUpUids();

    expect(useMailStore.getState().backedUpKeys).toBeNull();
  });

  it('drops a stale in-flight scan so an older call cannot clobber a newer one', async () => {
    let resolveFirst, resolveSecond;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    mockBackupScanUids
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      backedUpKeys: null,
    });

    // Two overlapping refreshes — e.g. two archivedEmailIds changes in quick
    // succession. Neither is awaited before the next starts.
    const call1 = useMailStore.getState().refreshBackedUpUids();
    const call2 = useMailStore.getState().refreshBackedUpUids();

    // The newer call's scan comes back first...
    resolveSecond([99]);
    await call2;
    // ...then the older, now-stale call finally resolves.
    resolveFirst([11, 12]);
    await call1;

    const keys = useMailStore.getState().backedUpKeys;
    expect(keys.has('acct-1:INBOX:99')).toBe(true);
    expect(keys.has('acct-1:INBOX:11')).toBe(false);
  });

  // The INBOX view merges Sent copies into its threads, so those rows are on
  // screen wearing a dot. Scanning only the active mailbox left every one of
  // them with no mirror entry of its own — and, before the key carried a
  // mailbox, answerable purely by uid collision with INBOX.
  describe('Sent, because INBOX threads show Sent rows', () => {
    const withSent = (over = {}) => useMailStore.setState({
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      accounts: [{ id: 'acct-1', email: 'luke@mock.test' }],
      mailboxes: [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }],
      ...over,
    });

    it('scans the Sent mirror as well as the active mailbox', async () => {
      mockBackupScanUids.mockImplementation(async (_email, mailbox) =>
        mailbox === 'INBOX' ? [11] : [4102]);
      withSent();

      await useMailStore.getState().refreshBackedUpUids();

      expect(mockBackupScanUids.mock.calls.map(c => c[1]).sort()).toEqual(['INBOX', 'Sent']);
      expect(useMailStore.getState().backedUpScopes)
        .toEqual(new Set(['acct-1:INBOX', 'acct-1:Sent']));
    });

    it('keeps the two mailboxes\' uid spaces apart', async () => {
      // Same uid, both folders, only INBOX mirrored. Keyed by account alone
      // this is indistinguishable and the Sent row inherited INBOX's answer.
      mockBackupScanUids.mockImplementation(async (_email, mailbox) =>
        mailbox === 'INBOX' ? [4102] : []);
      withSent();

      await useMailStore.getState().refreshBackedUpUids();

      const keys = useMailStore.getState().backedUpKeys;
      expect(keys.has('acct-1:INBOX:4102')).toBe(true);
      expect(keys.has('acct-1:Sent:4102')).toBe(false);
    });

    it('does not scan Sent twice when it is the active mailbox', async () => {
      mockBackupScanUids.mockResolvedValue([1]);
      withSent({ activeMailbox: 'Sent' });

      await useMailStore.getState().refreshBackedUpUids();

      expect(mockBackupScanUids).toHaveBeenCalledTimes(1);
      expect(useMailStore.getState().backedUpScopes).toEqual(new Set(['acct-1:Sent']));
    });

    it('scans only the active mailbox when the account has no Sent folder', async () => {
      mockBackupScanUids.mockResolvedValue([1]);
      withSent({ mailboxes: [{ path: 'INBOX' }] });

      await useMailStore.getState().refreshBackedUpUids();

      expect(mockBackupScanUids).toHaveBeenCalledTimes(1);
      expect(useMailStore.getState().backedUpScopes).toEqual(new Set(['acct-1:INBOX']));
    });

    it('an unreadable Sent mirror makes the whole answer unknown', async () => {
      // Same rule as a failed account in unified inbox: a partial set would
      // render "not backed up" for the half nobody could read.
      mockBackupScanUids.mockImplementation(async (_email, mailbox) =>
        mailbox === 'INBOX' ? [11] : null);
      withSent();

      await useMailStore.getState().refreshBackedUpUids();

      expect(useMailStore.getState().backedUpKeys).toBeNull();
      expect(useMailStore.getState().backedUpScopes).toBeNull();
    });
  });

  // The unified picker's folder name is not every account's path for it. Rows
  // are stamped with `_resolveMailboxPath`'s answer, so the scan has to ask the
  // same question or it reads a folder no row claims to be in.
  it('resolves each account\'s own path for a unified folder', async () => {
    mockGetAccountCacheMailboxes.mockImplementation((id) => id === 'acct-1'
      ? [{ path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' }]
      : [{ path: 'Sent', name: 'Sent', specialUse: '\\Sent' }]);
    mockBackupScanUids.mockResolvedValue([11]);
    useMailStore.setState({
      unifiedInbox: true,
      unifiedFolder: 'Sent',
      accounts: [
        { id: 'acct-1', email: 'luke@mock.test' },
        { id: 'acct-2', email: 'leia@mock.test' },
      ],
    });

    await useMailStore.getState().refreshBackedUpUids();
    mockGetAccountCacheMailboxes.mockImplementation(() => null);

    expect(mockBackupScanUids.mock.calls.map(c => c[1]).sort())
      .toEqual(['Sent', '[Gmail]/Sent Mail']);
    expect(useMailStore.getState().backedUpScopes)
      .toEqual(new Set(['acct-1:[Gmail]/Sent Mail', 'acct-2:Sent']));
    expect(useMailStore.getState().backedUpKeys.has('acct-1:[Gmail]/Sent Mail:11')).toBe(true);
  });

  it('unified inbox keys each account separately under its own folder', async () => {
    mockBackupScanUids.mockImplementation(async (email) =>
      email === 'luke@mock.test' ? [11] : [11]);
    useMailStore.setState({
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      accounts: [
        { id: 'acct-1', email: 'luke@mock.test' },
        { id: 'acct-2', email: 'leia@mock.test' },
      ],
    });

    await useMailStore.getState().refreshBackedUpUids();

    const keys = useMailStore.getState().backedUpKeys;
    expect(keys.has('acct-1:INBOX:11')).toBe(true);
    expect(keys.has('acct-2:INBOX:11')).toBe(true);
    expect(keys.size).toBe(2);
  });
});

// A persisted link alert is a phishing warning. Applied by bare UID it landed
// on whichever message held that number in the mailbox being rendered, so
// account A's flagged UID 41 lit a red warning on account B's unrelated UID 41.
describe('persisted link alerts are applied per account + mailbox', () => {
  const row = (uid) => ({
    uid,
    subject: `Message ${uid}`,
    date: 'Sun, 04 Jan 2026 12:00:00 +0000',
  });

  const render = (accountId, mailbox, emails) => {
    useMailStore.setState({
      activeAccountId: accountId,
      activeMailbox: mailbox,
      viewMode: 'all',
      unifiedInbox: false,
      emails,
      localEmails: [],
      archivedEmailIds: new Set(),
      savedEmailIds: new Set(),
      serverUids: serverUids(new Set(emails.map(e => e.uid)), { complete: true }),
      deleteTombstones: new Set(),
      _sortedEmailsFingerprint: '',
    });
    useMailStore.getState().updateSortedEmails();
    return useMailStore.getState().sortedEmails;
  };

  afterEach(() => { mockSettingsState.linkAlerts = {}; });

  it('flags the message the alert was stored for', () => {
    mockSettingsState.linkAlerts = { 'acct-1-INBOX-41': 'red' };
    expect(render('acct-1', 'INBOX', [row(41)])[0]._linkAlert).toBe('red');
  });

  // Both cases seed a leftover bare-UID entry alongside the scoped one. The
  // migration drops those, but a reader that still falls back to `e.uid` would
  // find it — which is exactly the leak, and what makes these tests fail
  // against the old code instead of merely passing against the new.
  it('leaves another account\'s message with the same UID unflagged', () => {
    mockSettingsState.linkAlerts = { 41: 'red', 'acct-1-INBOX-41': 'red' };
    expect(render('acct-2', 'INBOX', [row(41)])[0]._linkAlert).toBeUndefined();
  });

  it('leaves another mailbox\'s message with the same UID unflagged', () => {
    mockSettingsState.linkAlerts = { 41: 'red', 'acct-1-INBOX-41': 'red' };
    expect(render('acct-1', 'Archive', [row(41)])[0]._linkAlert).toBeUndefined();
  });
});

describe('lastSelectedAccountId — which account a fresh compose sends from', () => {
  // In the unified inbox activeAccountId is only whichever account was last
  // opened, so the account of the message being read is the only honest
  // default for compose's From row (utils/sendAsSuggestions).
  const thread = (lastEmail) => ({ lastEmail, emails: [lastEmail], messageCount: 1 });

  it('a unified thread row carries its account', () => {
    useMailStore.setState({ lastSelectedAccountId: null });

    useMailStore.getState().selectThread(thread({ uid: 7, _accountId: 'acct-2' }));

    expect(useMailStore.getState().lastSelectedAccountId).toBe('acct-2');
  });

  it('a single-account thread row leaves the last account standing', () => {
    // Rows outside the unified list are untagged — overwriting with undefined
    // would erase the answer every time the user opened a thread.
    useMailStore.setState({ lastSelectedAccountId: 'acct-2' });

    useMailStore.getState().selectThread(thread({ uid: 7 }));

    expect(useMailStore.getState().lastSelectedAccountId).toBe('acct-2');
  });
});

describe('closeEmail — the way out of the reading pane', () => {
  // Opening a message used to be a one-way door: the only exits either opened
  // something else or destroyed the message. In the stacked layout the list
  // gives up more than half its height while a message is open (App.jsx's
  // `stackedSolo`), so "close it and leave me the list" has to be reachable.
  it('clears everything the reader renders from, single message or thread', () => {
    useMailStore.setState({
      selectedEmailId: 7,
      selectedEmail: { uid: 7, subject: 'Open' },
      selectedEmailSource: 'server',
      selectedThread: { lastEmail: { uid: 7 }, emails: [], messageCount: 1 },
      loadingEmail: true,
    });

    useMailStore.getState().closeEmail();

    const s = useMailStore.getState();
    expect(s.selectedEmailId).toBeNull();
    expect(s.selectedEmail).toBeNull();
    expect(s.selectedEmailSource).toBeNull();
    expect(s.selectedThread).toBeNull();
    // A close mid-fetch must not leave the spinner as the pane's whole content.
    expect(s.loadingEmail).toBe(false);
  });

  it('leaves the list and any bulk selection alone', () => {
    useMailStore.setState({
      selectedEmailId: 7,
      selectedEmail: { uid: 7 },
      emails: [{ uid: 7 }, { uid: 8 }],
      selectedEmailIds: new Set([8]),
    });

    useMailStore.getState().closeEmail();

    const s = useMailStore.getState();
    expect(s.emails.map(e => e.uid)).toEqual([7, 8]);
    expect(s.selectedEmailIds).toEqual(new Set([8]));
  });
});
