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
}));

vi.mock('../../api', () => ({
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
  normalizeGraphFolderName: (n) => n,
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

      await vi.advanceTimersByTimeAsync(3000);
      expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 1, ['\\Seen'], 'add', 'INBOX');
      expect(seenOf(1)).toBe(true);
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

describe('markEmailReadStatus', () => {
  it('closes the viewer when the open email is marked unread', async () => {
    primeStore(['\\Seen']);
    useMailStore.setState({ selectedEmailId: 1, selectedEmail: { uid: 1, flags: ['\\Seen'] }, selectedEmailSource: 'server' });

    await useMailStore.getState().markEmailReadStatus(1, false);

    expect(seenOf(1)).toBe(false);
    expect(useMailStore.getState().selectedEmail).toBe(null);
    expect(useMailStore.getState().selectedEmailId).toBe(null);
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
});
