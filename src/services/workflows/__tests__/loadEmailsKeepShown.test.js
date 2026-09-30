// loadEmails reads `emails` into `previousEmails` before it awaits the credential
// lookup and the connectivity probe. Its degraded exits (credentials missing,
// offline, probe failed) and its catch mean "keep what is shown", but they wrote
// that snapshot back: a flag the user wrote during the awaits (opening a message
// marks it read) was reverted in the list, the reader kept "read", and the next
// complete INBOX recount then moved the unread badge by one. They no longer
// write `emails` at all.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetEmailHeadersMeta = vi.fn();
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });

vi.mock('../../db', () => ({
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  listCachedUids: vi.fn().mockResolvedValue({ uids: [], changed: [] }),
  getEmailHeadersByUids: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  // Graph only: a complete, fresh folder list, so the loader goes straight to the listing.
  getCachedMailboxEntry: vi.fn().mockResolvedValue({
    mailboxes: [{ path: 'INBOX', _graphFolderId: 'gid' }, { path: 'Sent', _graphFolderId: 'gsent' }],
    fetchedAt: Date.now(),
  }),
  saveMailboxes: vi.fn(),
}));

const mockCheckMailboxStatus = vi.fn();
const mockFetchEmails = vi.fn();
const mockSearchAllUids = vi.fn();
const mockFetchHeadersByUids = vi.fn();
const mockFetchChangedFlags = vi.fn();
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  searchAllUids: (...a) => mockSearchAllUids(...a),
  fetchHeadersByUids: (...a) => mockFetchHeadersByUids(...a),
  fetchChangedFlags: (...a) => mockFetchChangedFlags(...a),
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
}));

const mockResolveServer = vi.fn();
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (...a) => mockResolveServer(...a),
}));
const mockIsGraph = vi.fn(() => false);
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraph(...a),
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
}));
const mockListGraphMessages = vi.fn();
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  getAccountCacheMailboxes: vi.fn().mockReturnValue([]),
  listGraphMessages: (...a) => mockListGraphMessages(...a),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ setUnreadForAccount: vi.fn(), hiddenAccounts: {} }),
  },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { applySeenLocally } = await import('../messageMutations');

const { useConnectivityStore } = await import('../../../stores/connectivityStore');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const UIDS = Array.from({ length: 10 }, (_, i) => 10 - i); // 10..1
const mkHeader = (uid, flags = []) => ({
  uid,
  subject: `Msg ${uid}`,
  date: new Date(1_700_000_000_000 + uid * 1000).toISOString(),
  flags,
  from: { address: 'sender@mock.test' },
});

function primeInbox(uids = UIDS) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    emails: uids.map(u => mkHeader(u)),
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(uids), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: uids.length,
    loading: false,
    connectionStatus: 'connected',
  });
}

function parked() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const markRead = (uid) =>
  applySeenLocally(useMailStore, { accountId: ACCOUNT.id, mailbox: 'INBOX', uid, read: true });
const storeRow = (uid) => useMailStore.getState().emails.find(e => e.uid === uid);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGraph.mockReturnValue(false);
  mockSaveEmailHeaders.mockResolvedValue(undefined);
  mockGetEmailHeadersMeta.mockResolvedValue({ totalEmails: 10, totalCached: 10 });
  delete window.__TAURI__;
  vi.stubGlobal('navigator', { onLine: true });
});

describe('loadEmails — a degraded exit keeps what is shown, flags written meanwhile included', () => {
  it('credentials missing: the row marked read during the lookup stays read', async () => {
    primeInbox();
    const lookup = parked();
    mockResolveServer.mockReturnValue(lookup.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockResolveServer).toHaveBeenCalledTimes(1); // the load IS mid-flight

    markRead(7);
    lookup.resolve({ ok: false });
    await done;

    expect(useMailStore.getState().connectionErrorType).toBe('passwordMissing');
    expect(storeRow(7).flags).toContain('\\Seen');
  });

  it('offline probe: the row marked read during the probe stays read', async () => {
    primeInbox();
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    mockResolveServer.mockImplementation((id, account) => Promise.resolve({ ok: true, account }));
    const probe = parked();
    vi.spyOn(useConnectivityStore.getState(), 'probe').mockReturnValue(probe.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();

    markRead(7);
    probe.resolve(false);
    await done;

    expect(useMailStore.getState().connectionErrorType).toBe('offline');
    expect(storeRow(7).flags).toContain('\\Seen');
  });

  it('probe failure: the row marked read during the probe stays read', async () => {
    primeInbox();
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    mockResolveServer.mockImplementation((id, account) => Promise.resolve({ ok: true, account }));
    const probe = parked();
    vi.spyOn(useConnectivityStore.getState(), 'probe').mockReturnValue(probe.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();

    markRead(7);
    probe.reject(new Error('probe blew up'));
    await done;

    expect(useMailStore.getState().connectionErrorType).toBe('offline');
    expect(storeRow(7).flags).toContain('\\Seen');
  });

  it('browser offline: the row marked read during the credential lookup stays read', async () => {
    primeInbox();
    const lookup = parked();
    mockResolveServer.mockReturnValue(lookup.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();

    markRead(7);
    vi.stubGlobal('navigator', { onLine: false });
    lookup.resolve({ ok: true, account: ACCOUNT });
    await done;

    expect(useMailStore.getState().connectionErrorType).toBe('offline');
    expect(storeRow(7).flags).toContain('\\Seen');
  });

  it('a failed fetch: the row marked read while it was on the wire stays read', async () => {
    primeInbox();
    mockResolveServer.mockImplementation((id, account) => Promise.resolve({ ok: true, account }));
    mockGetEmailHeadersMeta.mockResolvedValue(null); // no sync stamp: page 1 is fetched
    const page = parked();
    mockFetchEmails.mockReturnValue(page.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockFetchEmails).toHaveBeenCalledTimes(1);

    markRead(7);
    page.reject(new Error('Login failed')); // no retry is scheduled for this one
    await done;

    expect(useMailStore.getState().connectionErrorType).toBe('passwordMissing');
    expect(storeRow(7).flags).toContain('\\Seen');
  });
});
