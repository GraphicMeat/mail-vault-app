// "Hide mail views hold" (hideViewMail): the daemon answers which messages
// any saved view holds (views.hidden_members, kept in useViewHideStore), and
// the folder list leaves them out while the setting is on. A new answer, or
// the setting going off, repaints the list on screen; nothing waits for a
// folder switch.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
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
// A real store: viewStore's watcher subscribes to `hideViewMail` flips.
vi.mock('../settingsStore', async () => {
  const { create } = await import('zustand');
  return {
    effectiveSearchMailboxConcurrency: () => 1,
    useSettingsStore: create(() => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      unreadPerAccount: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      hideViewMail: true,
      setUnreadForAccount: (...a) => mockSetUnread(...a),
      addSearchToHistory: () => {},
    })),
  };
});

const { useMailStore } = await import('../mailStore');
const { useViewHideStore } = await import('../viewHideStore');
const { useSettingsStore } = await import('../settingsStore');
const { daemonCall } = await import('../../services/daemonClient');
const { invalidateChatAndThreadCaches } = await import('../slices/messageListSlice');

const A1 = { id: 'a1', email: 'me@one.co', imapHost: 'h', password: 'x' };
const row = (uid) => ({
  uid, messageId: `<m${uid}@x>`, flags: ['\\Seen'], subject: `Message ${uid}`, source: 'server',
  from: { address: 'them@x.co' }, date: `2026-09-2${uid}T10:00:00Z`,
});
const held = (...uids) => ({ available: true, members: { a1: { INBOX: { uids, unread: 0 } } } });
const shown = () => useMailStore.getState().sortedEmails.map(e => e.uid);

describe('mail a saved view holds, in the folder on screen', () => {
  beforeEach(() => {
    useSettingsStore.setState({ hideViewMail: true });
    useViewHideStore.setState({ keys: null, unreadByMailbox: null, hiddenByMailbox: null });
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

  it('leaves the list when the daemon says a view holds it', () => {
    expect(shown()).toEqual([5, 4]);

    useViewHideStore.getState().setMembers(held(5));

    expect(shown()).toEqual([4]);
    // The folder still holds two messages: the hide is the list's, not the count's.
    expect(useMailStore.getState().totalEmails).toBe(2);
  });

  it('comes back when the setting goes off', () => {
    useViewHideStore.getState().setMembers(held(5));
    expect(shown()).toEqual([4]);

    // What viewStore does when the setting flips off: it forgets the answer.
    useSettingsStore.setState({ hideViewMail: false });
    useViewHideStore.getState().clear();

    expect(shown()).toEqual([5, 4]);
  });

  it('comes back with the setting off even while an answer is still held', () => {
    useViewHideStore.getState().setMembers(held(5));
    expect(shown()).toEqual([4]);

    useSettingsStore.setState({ hideViewMail: false });
    useMailStore.getState().updateSortedEmails();

    expect(shown()).toEqual([5, 4]);
  });

  it('an unknown answer hides nothing', () => {
    useViewHideStore.getState().setMembers(held(5));
    useViewHideStore.getState().setMembers({ available: false });

    expect(shown()).toEqual([5, 4]);
  });

  // Imported last, on purpose: from here on viewStore's watcher answers every
  // flip of the setting, which the cases above drive by hand.
  it('follows the setting itself: on asks the daemon, off brings the mail back', async () => {
    const { refreshHiddenMembers } = await import('../viewStore');
    daemonCall.mockImplementation(async (method) => (method === 'views.hidden_members' ? held(5) : []));
    try {
      useSettingsStore.setState({ hideViewMail: false });
      await refreshHiddenMembers();
      expect(shown()).toEqual([5, 4]);

      useSettingsStore.setState({ hideViewMail: true });
      await vi.waitFor(() => expect(shown()).toEqual([4]));

      useSettingsStore.setState({ hideViewMail: false });
      expect(shown()).toEqual([5, 4]);
    } finally {
      daemonCall.mockReset().mockResolvedValue([]);
    }
  });
});
