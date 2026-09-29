// A local snooze (no Snoozed folder on the server) holds its message out of
// the list while the row it came from stays in `emails`, read. The wake clears
// \Seen on the server, and the daemon's sync writes that into the header cache
// together with the mailbox's new modseq before the `snooze` event goes out.
// So the reload the event triggers compares that modseq with the server's,
// finds them equal (condstore-noop) and never reads a cache row: the message
// came back to the list still read, and the inbox badge did not count it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { serverUids } from '../slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); },
  emit: () => Promise.resolve(),
}));

vi.mock('../../services/daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: vi.fn().mockResolvedValue([]),
}));

const mockGetEmailHeadersMeta = vi.fn();
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersByUids = vi.fn().mockResolvedValue([]);
vi.mock('../../services/db', () => ({
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getEmailHeaders: vi.fn().mockResolvedValue(null),
  listCachedUids: vi.fn().mockResolvedValue({ uids: [], changed: [] }),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX' }]),
  readLocalEmailIndex: vi.fn().mockResolvedValue([]),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckMailboxStatus = vi.fn();
const mockFetchChangedFlags = vi.fn().mockResolvedValue([]);
vi.mock('../../services/api', () => ({
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  fetchChangedFlags: (...a) => mockFetchChangedFlags(...a),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchEmails: vi.fn().mockResolvedValue({ emails: [], total: 0 }),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
}));

vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../services/graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
  graphFoldersToMailboxes: () => [],
}));
vi.mock('../../services/mailSearch.js', () => ({
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
}));
vi.mock('../../services/workflows/probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));
vi.mock('../../services/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
// The banner is snoozeLocalWake.test.js's subject.
vi.mock('../../hooks/useEmailScheduler', () => ({ notifyArrival: vi.fn() }));

// All Inboxes reloads through a refetch of every account: parked here, so
// what the list shows is what the wake itself put there.
const mockRefreshCurrentView = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/workflows/refreshAccounts', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshCurrentView: (...a) => mockRefreshCurrentView(...a),
}));

const mockSetUnread = vi.fn();
vi.mock('../settingsStore', () => ({
  effectiveSearchMailboxConcurrency: () => 1,
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      unreadPerAccount: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: (...a) => mockSetUnread(...a),
      addSearchToHistory: () => {},
    }),
  },
}));

const { useMailStore } = await import('../mailStore');
const { initSnooze, useSnoozeStore } = await import('../snoozeStore');
const { invalidateChatAndThreadCaches } = await import('../slices/messageListSlice');
const { saveRestoreDescriptor } = await import('../../services/cacheManager');

const A1 = { id: 'a1', email: 'me@one.co', imapHost: 'h', password: 'x' };
const A2 = { id: 'a2', email: 'me@two.co', imapHost: 'h', password: 'x' };
const LOCAL = { id: 'local', accountId: 'a1', fromMailbox: 'INBOX', snoozedMailbox: '', uidInSnoozed: 5, messageId: '<held@x>', wakeAt: 1, state: 'snoozed' };

const row = (uid, messageId, flags, extra = {}) => ({
  uid, messageId, flags, subject: `Message ${uid}`, source: 'server',
  from: { address: 'them@x.co' }, date: `2026-09-2${uid}T10:00:00Z`, ...extra,
});
// The message a local snooze holds, read when it was snoozed, and one that stays read.
const HELD = row(5, '<held@x>', ['\\Seen']);
const OTHER = row(4, '<other@x>', ['\\Seen']);

const fire = (payload) => listeners.snooze({ payload });
const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const of = (accountId, uid) => (e) => e.uid === uid && (e._accountId || useMailStore.getState().activeAccountId) === accountId;
const flagsOf = (accountId, uid) => useMailStore.getState().emails.find(of(accountId, uid))?.flags;
const shown = (accountId, uid) => useMailStore.getState().sortedEmails.some(of(accountId, uid));
const lastUnread = (accountId) => mockSetUnread.mock.calls.filter(([id]) => id === accountId).at(-1)?.[1];

function prime(state) {
  useMailStore.setState({
    accounts: [A1, A2],
    activeAccountId: 'a1',
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    viewMode: 'all',
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    deleteTombstones: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    loading: false,
    loadingMore: false,
    _sortedEmailsFingerprint: '',
    ...state,
    serverUids: serverUids(new Set(state.emails.map(e => e.uid)), { complete: true }),
    totalEmails: state.emails.length,
  });
  useSnoozeStore.setState({ rows: [LOCAL] });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
  expect(shown('a1', 5)).toBe(false); // held out of the list
}

describe('a woken local snooze comes back unread', () => {
  beforeAll(async () => {
    initSnooze();
    await vi.waitFor(() => expect(listeners.snooze).toBeTypeOf('function'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // What the daemon left behind: its sync already wrote the server's
    // modseq, and the store holds every cached row.
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: 9, totalEmails: 2, totalCached: 2 });
  });

  describe('in a folder list', () => {
    beforeEach(() => prime({ activeMailbox: 'INBOX', unifiedInbox: false, emails: [HELD, OTHER] }));

    // The reload the event triggers is parked until the wake has run, then
    // answered the way the server answers after the daemon's sync.
    async function wakeAndReload(payload) {
      let answerStatus;
      mockCheckMailboxStatus.mockImplementation(() => new Promise((r) => { answerStatus = r; }));
      await fire(payload);
      await vi.waitFor(() => expect(mockCheckMailboxStatus).toHaveBeenCalledTimes(1));
      answerStatus({ uidValidity: 1, uidNext: 6, highestModseq: 9, exists: 2 });
      await tick();
      // The reload took its "nothing changed" exit and read no cache row.
      expect(mockFetchChangedFlags).not.toHaveBeenCalled();
      expect(mockGetEmailHeadersByUids).not.toHaveBeenCalled();
    }

    it('shows the message unread and counts it on the badge, though the reload reads nothing', async () => {
      await wakeAndReload({ id: 'local', state: 'woken', woke: true });

      expect(shown('a1', 5)).toBe(true);
      expect(flagsOf('a1', 5)).not.toContain('\\Seen');
      expect(flagsOf('a1', 4)).toContain('\\Seen');
      expect(lastUnread('a1')).toBe(1);
    });

    // A local undo never touched the server's \Seen (handlers/snooze.rs).
    it('leaves an undone snooze read', async () => {
      await wakeAndReload({ id: 'local', state: 'woken', woke: false });

      expect(shown('a1', 5)).toBe(true);
      expect(flagsOf('a1', 5)).toContain('\\Seen');
      expect(lastUnread('a1')).toBe(0);
    });
  });

  describe('in All Inboxes', () => {
    // The same message delivered to the other account too: that copy was not snoozed.
    const unifiedRow = (r, accountId) => ({ ...r, _accountId: accountId, _mailbox: 'INBOX', _accountEmail: `${accountId}@x` });

    beforeEach(() => {
      // Saved while a1's INBOX was open, before the snooze: it holds the message read.
      saveRestoreDescriptor({
        accountId: 'a1', mailbox: 'INBOX', viewMode: 'all', totalEmails: 2,
        mailboxes: [{ path: 'INBOX', name: 'INBOX' }], firstWindow: [HELD, OTHER],
        firstWindowSavedUids: [], firstWindowArchivedUids: [],
      });
      prime({
        activeMailbox: 'UNIFIED', unifiedInbox: true,
        emails: [unifiedRow(HELD, 'a1'), unifiedRow(OTHER, 'a1'), unifiedRow(HELD, 'a2')],
      });
    });

    it('shows the message unread, counts it on its account, and a repaint from the caches agrees', async () => {
      await fire({ id: 'local', state: 'woken', woke: true });
      await vi.waitFor(() => expect(mockRefreshCurrentView).toHaveBeenCalled());

      expect(shown('a1', 5)).toBe(true);
      expect(flagsOf('a1', 5)).not.toContain('\\Seen');
      expect(flagsOf('a2', 5)).toContain('\\Seen');
      expect(lastUnread('a1')).toBe(1);

      // The change feed's repaint of All Inboxes (useEmailScheduler) reads
      // each account's cache, which the daemon's sync already patched.
      useMailStore.setState({ loadSentHeaders: vi.fn() });
      mockGetEmailHeadersPartial.mockImplementation(async (accountId) => ({
        emails: accountId === 'a1' ? [row(5, '<held@x>', []), OTHER] : [HELD],
      }));
      await useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
      await tick();

      expect(flagsOf('a1', 5)).not.toContain('\\Seen');
      expect(flagsOf('a2', 5)).toContain('\\Seen');
    });
  });
});
