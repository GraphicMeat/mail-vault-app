// The bug this file pins: `success:false` from the daemon cannot tell "no
// internet" from "the server refused", and the app rendered the wrong one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetCachedMailboxEntry = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockSaveMailboxes = vi.fn().mockResolvedValue(undefined);
const mockClearMailboxCache = vi.fn().mockResolvedValue(undefined);
const mockGetArchivedEmails = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getCachedMailboxEntry: (...a) => mockGetCachedMailboxEntry(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  saveMailboxes: (...a) => mockSaveMailboxes(...a),
  // Referenced as plain properties (not necessarily called) when
  // loadLocalEmails() builds headerMemo.recall()'s `io` argument — accessing
  // an unmocked property throws under vitest's strict module mock, even
  // though recall() only invokes them on a memo hit (never true here).
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: (...a) => mockClearMailboxCache(...a),
  getArchivedEmails: (...a) => mockGetArchivedEmails(...a),
}));

const mockFetchEmails = vi.fn();
const mockCheckMailboxStatus = vi.fn();
const mockFetchMailboxes = vi.fn().mockResolvedValue([]);
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  fetchMailboxes: (...a) => mockFetchMailboxes(...a),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  GRAPH_FOLDER_NAME_MAP: {},
  graphFoldersToMailboxes: () => [],
  inferSpecialUse: () => null,
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
const mockGetRestoreDescriptor = vi.fn().mockReturnValue(null);
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: (...a) => mockGetRestoreDescriptor(...a),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setLastMailbox: vi.fn(),
      setUnreadForAccount: vi.fn(),
      getLastMailbox: () => 'INBOX',
    }),
  },
}));
const mockGetDaemonHealth = vi.fn().mockReturnValue({ alive: false });
vi.mock('../../transport', () => ({
  getDaemonHealth: () => mockGetDaemonHealth(),
}));
const mockMailboxIsUnchanged = vi.fn();
const mockSyncNow = vi.fn().mockResolvedValue(undefined);
const mockWaitForSync = vi.fn();
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: (...a) => mockMailboxIsUnchanged(...a),
  markVerified: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: (...a) => mockSyncNow(...a),
  waitForSync: (...a) => mockWaitForSync(...a),
}));

const { useMailStore } = await import('../../../stores/mailStore');
// Real module — an in-memory, module-level cache (see headerMemo.js). Not
// mocked, but explicitly cleared per test below so a header set memoized by
// one test's activation can't be recalled (and reconciled against an io that
// this file doesn't mock) by the next.
const { forget: forgetMemo } = await import('../../headerMemo');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };

const { useConnectivityStore, __resetConnectivityForTests } =
  await import('../../../stores/connectivityStore');

function prime() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: null,
    activeMailbox: 'INBOX',
    emails: [],
    localEmails: [],
    sentEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    mailboxes: [],
    unifiedInbox: false,
    connectionError: null,
    connectionErrorType: null,
    loadSentHeaders: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConnectivityForTests();
  mockGetCachedMailboxEntry.mockResolvedValue(null);
  mockGetEmailHeadersMeta.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockFetchMailboxes.mockResolvedValue([]);
  mockGetRestoreDescriptor.mockReturnValue(null);
  // The path under test: the daemon IS alive, which is the normal case and the
  // one the old code never checked connectivity on.
  mockGetDaemonHealth.mockReturnValue({ alive: true });
  // The daemon branch probes before it syncs, and reads `.unchanged` off the
  // result — an undefined probe throws straight into the IMAP fallback and
  // this file would test nothing.
  mockMailboxIsUnchanged.mockResolvedValue({ unchanged: false, reason: 'test' });
  forgetMemo(ACCOUNT.id);
});

// With the daemon alive, activateAccount returns from the daemon branch long
// before it reaches the connectivity check below it. Every offline sync was
// therefore reported as `serverError` — "The server refused the sync" — with a
// ServerOff icon and a "check your server settings" remedy for a user whose
// Wi-Fi is simply off.
describe('activateAccount daemon path — offline vs server error', () => {
  it('labels a sync the daemon never dialled as offline', async () => {
    prime();
    mockWaitForSync.mockResolvedValue({
      success: false,
      offline: true,
      error: 'No internet connection',
    });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');

    const state = useMailStore.getState();
    expect(state.connectionErrorType).toBe('offline');
    expect(state.connectionStatus).toBe('error');
  });

  it('tells the global banner, so one failed account speaks for the machine', async () => {
    prime();
    mockWaitForSync.mockResolvedValue({ success: false, offline: true, error: 'No internet connection' });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');

    expect(useConnectivityStore.getState().online).toBe(false);
  });

  // The control: a server that answered must still read as a server error, or
  // one provider's outage would claim the whole machine is offline.
  it('still calls a refused sync a server error', async () => {
    prime();
    mockWaitForSync.mockResolvedValue({
      success: false,
      error: 'NO [AUTHENTICATIONFAILED] Invalid credentials',
    });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');

    const state = useMailStore.getState();
    expect(state.connectionErrorType).toBe('serverError');
    expect(state.connectionError).toContain('AUTHENTICATIONFAILED');
    expect(useConnectivityStore.getState().online).toBe(true);
  });
});
