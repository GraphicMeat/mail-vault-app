// The daemon's Auto Tag worker tags new mail a second after it lands, while
// its row is on screen with an empty tag list cached. A hide-from-Inbox rule
// has to take that row out of the list then, not on the next folder switch.
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
vi.mock('../../hooks/useEmailScheduler', () => ({ notifyArrival: vi.fn() }));

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
const { useTagStore, tagRowKey } = await import('../tagStore');
const { useAutoTagStore } = await import('../autoTagStore');
const { invalidateChatAndThreadCaches } = await import('../slices/messageListSlice');

const A1 = { id: 'a1', email: 'me@one.co', imapHost: 'h', password: 'x' };
const row = (uid) => ({
  uid, messageId: `<m${uid}@x>`, flags: ['\\Seen'], subject: `Message ${uid}`, source: 'server',
  from: { address: 'them@x.co' }, date: `2026-09-2${uid}T10:00:00Z`,
});
const HIDE_RULE = {
  id: 'r1', name: 'Newsletters', instruction: 'newsletters', constraints: {}, tagId: 't1',
  inboxAction: 'hide', minConfidence: 0.7, allowRemote: false, provider: null,
  enabled: true, enabledAt: 1, createdAt: 0, updatedAt: 0,
};
const shown = () => useMailStore.getState().sortedEmails.map(e => e.uid);

describe('a tag the daemon assigns to a row on screen', () => {
  beforeEach(() => {
    useAutoTagStore.setState({ rules: [HIDE_RULE], backfills: {} });
    useTagStore.setState({ tags: [{ id: 't1', name: 'Newsletters', color: '', position: 0, count: 0 }], byRow: {
      [tagRowKey('a1', 'INBOX', 5)]: [], [tagRowKey('a1', 'INBOX', 4)]: [],
    } });
    useMailStore.setState({
      accounts: [A1], activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      unifiedFolder: 'INBOX', viewMode: 'all', localEmails: [], sentEmails: [],
      savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(),
      selectedEmail: null, selectedEmailId: null, selectedThread: null, emailCache: new Map(),
      loading: false, loadingMore: false, _sortedEmailsFingerprint: '',
      emails: [row(5), row(4)], serverUids: serverUids(new Set([5, 4]), { complete: true }), totalEmails: 2,
    });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();
  });

  it('takes it out of the Inbox when its rule hides the tag', async () => {
    expect(shown()).toEqual([5, 4]);

    await useTagStore.getState().applyAssigned({ tagId: 't1', items: [{ accountId: 'a1', mailbox: 'INBOX', uid: 5 }] });

    expect(shown()).toEqual([4]);
  });
});
