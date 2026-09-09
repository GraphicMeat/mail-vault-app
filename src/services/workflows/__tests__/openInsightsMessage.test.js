import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGraphGetMessage = vi.fn();
const mockGraphCacheMime = vi.fn().mockResolvedValue(undefined);
const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockGetMeta = vi.fn().mockResolvedValue(null);
const mockEnsureToken = vi.fn(async a => a);
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: (...a) => mockGetMeta(...a),
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
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: (...a) => mockGraphGetMessage(...a),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: (...a) => mockGraphCacheMime(...a),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (...a) => mockEnsureToken(...a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
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
  resolveGraphMessageId: async () => 'graph-message-id',
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
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');

const { openInsightsMessage, cancelInsightsSelection } = await import('../openInsightsMessage.js');
const accountA = { id: 'a1', email: 'a@example.test' };
const accountB = { id: 'a2', email: 'b@example.test' };
const inbox = { uid: 7, messageId: '<inbox-a@test>', subject: 'Visible inbox', flags: [], _accountId: 'a1', _mailbox: 'INBOX' };
const copy = (over = {}) => ({ accountId: 'a2', mailbox: 'Archive/2026', uid: 7, uidValidity: 4, source: 'server-cache',
  origin: null, messageId: '<insight-b@test>', subject: 'Insights message', from: { address: 'friend@example.test' },
  flags: [], serverDeleted: false, serverAbsent: false, serverMailbox: 'Archive/2026', localMailbox: null, locationLimitation: null, ...over });
const body = (over = {}) => ({ uid: 7, messageId: '<insight-b@test>', subject: 'Insights message', html: '<p>right body</p>', flags: [], ...over });
const match = (...copies) => ({ key: 'match', copies });
const stamped = c => ({ ...c, _accountId: c.accountId, _mailbox: c.mailbox, _origin: c.origin });

beforeEach(() => {
  cancelInsightsSelection();
  vi.clearAllMocks();
  mockIsGraphAccount.mockReturnValue(false);
  mockGraphGetMessage.mockResolvedValue(body());
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockGetMeta.mockResolvedValue({ uidValidity: 4 });
  mockEnsureToken.mockImplementation(async a => a);
  mockFetchEmailLight.mockResolvedValue(body());
  useMailStore.setState({
    accounts: [accountA, accountB], activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
    emails: [inbox], sortedEmails: [inbox], localEmails: [], sentEmails: [], selectedEmail: null, selectedEmailId: null,
    selectedThread: null, selectedEmailSource: null, loadingEmail: false, error: null, emailCache: new Map(),
    selectedEmailIds: new Set(), savedEmailIds: new Set(), archivedEmailIds: new Set(),
    _prefetchAdjacentEmails: vi.fn(), updateSortedEmails: vi.fn(),
  });
});

it('opens the explicit account and nested folder without replacing mailbox lists', async () => {
  const emails = useMailStore.getState().emails;
  const sorted = useMailStore.getState().sortedEmails;
  expect(await openInsightsMessage(match(copy()))).toBe(true);
  const state = useMailStore.getState();
  expect(state.selectedEmail).toMatchObject({ _accountId: 'a2', _mailbox: 'Archive/2026', messageId: '<insight-b@test>', html: '<p>right body</p>' });
  expect(mockFetchEmailLight).toHaveBeenCalledWith(accountB, 7, 'Archive/2026', 'a2');
  expect(state.emails).toBe(emails); expect(state.sortedEmails).toBe(sorted);
  expect(state.activeAccountId).toBe('a1'); expect(state.activeMailbox).toBe('INBOX');
  expect(state._prefetchAdjacentEmails).not.toHaveBeenCalled();
});

it('selection slice forwards the explicit fourth argument even in a spanning view', async () => {
  useMailStore.setState({ activeMailbox: 'UNIFIED' });
  const c = copy();
  await useMailStore.getState().selectEmail(7, 'server', c.mailbox, { accountId: c.accountId, mailbox: c.mailbox, uid: c.uid, header: stamped(c) });
  expect(useMailStore.getState().selectedEmail).toMatchObject({ _accountId: 'a2', _mailbox: 'Archive/2026' });
});

it('rejects inconsistent explicit header stamps before any body read', async () => {
  const c = copy();
  await expect(useMailStore.getState().selectEmail(7, 'server', c.mailbox,
    { accountId: c.accountId, mailbox: c.mailbox, uid: 7, header: { ...stamped(c), _accountId: 'a1' } })).rejects.toThrow();
  expect(mockGetLocalEmailLight).not.toHaveBeenCalled(); expect(mockFetchEmailLight).not.toHaveBeenCalled();
});

it('discards an in-memory body with a conflicting Message-ID', async () => {
  useMailStore.getState().addToCache('a2-Archive/2026-7', body({ messageId: '<reused-uid@test>', html: '<p>wrong</p>' }), 128);
  await openInsightsMessage(match(copy()));
  expect(useMailStore.getState().selectedEmail.html).toBe('<p>right body</p>');
  expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
});

it('opens local sent provenance without refreshing credentials or fetching server mail', async () => {
  mockGetLocalEmailLight.mockResolvedValue(body());
  await openInsightsMessage(match(copy({ source: 'vault', origin: 'local_sent', localMailbox: 'Archive_2026', serverAbsent: true })));
  expect(useMailStore.getState().selectedEmail).toMatchObject({ _origin: 'local_sent', serverAbsent: true, html: '<p>right body</p>' });
  expect(useMailStore.getState().selectedEmailSource).toBe('local-only');
  expect(mockEnsureToken).not.toHaveBeenCalled(); expect(mockFetchEmailLight).not.toHaveBeenCalled();
});

it('uses the verified local locator for an unresolved folder and disables server actions', async () => {
  mockGetLocalEmailLight.mockResolvedValue(body());
  await openInsightsMessage(match(copy({ source: 'vault', mailbox: 'Unknown folder', localMailbox: 'Ambiguous_Name', serverMailbox: null, locationLimitation: 'server-mailbox-unresolved' })));
  expect(mockGetLocalEmailLight).toHaveBeenCalledWith('a2', 'Ambiguous_Name', 7);
  expect(useMailStore.getState().selectedEmail._insightsNoServerActions).toBe(true);
  expect(mockFetchEmailLight).not.toHaveBeenCalled();
});

it('refuses a server body whose identity conflicts with the snapshot header', async () => {
  mockFetchEmailLight.mockResolvedValue(body({ messageId: '<reused-uid@test>', html: '<p>wrong body</p>' }));
  await expect(openInsightsMessage(match(copy()))).rejects.toThrow();
  expect(useMailStore.getState().selectedEmail?.html).not.toBe('<p>wrong body</p>');
});

it('rejects a changed known UIDVALIDITY before spending the stale UID', async () => {
  mockGetMeta.mockResolvedValue({ uidValidity: 99 });
  await expect(openInsightsMessage(match(copy()))).rejects.toThrow();
  expect(mockFetchEmailLight).not.toHaveBeenCalled();
});

it('falls through an unavailable vault copy to its compatible server locator', async () => {
  mockGetLocalEmailLight.mockResolvedValue(body({ messageId: '<wrong-vault@test>' }));
  await openInsightsMessage(match(copy({ source: 'vault', localMailbox: 'Archive_2026' }), copy()));
  expect(useMailStore.getState().selectedEmail.html).toBe('<p>right body</p>');
  expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
});

it('does not publish a late body after Insights detail closes', async () => {
  let finish;
  mockFetchEmailLight.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = openInsightsMessage(match(copy()));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  cancelInsightsSelection();
  useMailStore.setState({ selectedEmail: inbox, loadingEmail: false });
  finish(body());
  expect(await pending).toBe(false);
  expect(useMailStore.getState().selectedEmail).toBe(inbox);
});

it('a later open wins when two body reads finish in reverse order', async () => {
  let finishFirst;
  mockFetchEmailLight.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValueOnce(body({ uid: 8, messageId: '<second@test>' }));
  const first = openInsightsMessage(match(copy()));
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
  expect(await openInsightsMessage(match(copy({ uid: 8, messageId: '<second@test>' })))).toBe(true);
  finishFirst(body());
  expect(await first).toBe(false);
  expect(useMailStore.getState().selectedEmail.messageId).toBe('<second@test>');
});

it('does not persist Insights action restrictions into ordinary cached reader opens', async () => {
  await openInsightsMessage(match(copy()));
  expect(useMailStore.getState().selectedEmail._insightsReadOnly).toBe(true);
  useMailStore.setState({ activeAccountId: 'a2', activeMailbox: 'Archive/2026', emails: [stamped(copy())], sortedEmails: [stamped(copy())] });
  await useMailStore.getState().selectEmail(7);
  expect(useMailStore.getState().selectedEmail._insightsReadOnly).not.toBe(true);
});

it('restores an ordinary explicit reader header without Insights action restrictions', async () => {
  const c = copy();
  await useMailStore.getState().selectEmail(7, 'server', c.mailbox,
    { accountId: c.accountId, mailbox: c.mailbox, uid: 7, header: stamped(c) });
  expect(useMailStore.getState().selectedEmail._insightsReadOnly).not.toBe(true);
});


it.each([
  ['sender with shared ID', { from: { address: 'stranger@example.test' } }],
  ['subject with shared ID', { subject: 'Another subject' }],
  ['original date with shared ID', { date: '2026-09-03T11:00:00Z' }],
  ['subject with missing ID', { messageId: null, subject: 'Another subject' }],
])('refuses server content that conflicts on %s', async (_label, changes) => {
  mockFetchEmailLight.mockResolvedValue(body({ ...changes, html: '<p>wrong body</p>' }));
  await expect(openInsightsMessage(match(copy({ messageDate: '2026-09-02T11:00:00Z' })))).rejects.toThrow();
  expect(useMailStore.getState().selectedEmail?.html).not.toBe('<p>wrong body</p>');
});

it('discards a cached same-ID body with conflicting identity before fetching the matching body', async () => {
  useMailStore.getState().addToCache('a2-Archive/2026-7', body({ subject: 'Other subject', html: '<p>wrong</p>' }), 128);
  await openInsightsMessage(match(copy()));
  expect(useMailStore.getState().selectedEmail.html).toBe('<p>right body</p>');
  expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
});

it('refuses a local same-ID body with conflicting sender without server fallback', async () => {
  mockGetLocalEmailLight.mockResolvedValue(body({ from: { address: 'other@example.test' }, html: '<p>wrong</p>' }));
  await expect(openInsightsMessage(match(copy({ source: 'vault', localMailbox: 'Archive_2026' })))).rejects.toThrow();
  expect(mockFetchEmailLight).not.toHaveBeenCalled();
});

it('accepts equivalent original instants and normalized sender while keeping Graph received date separate', async () => {
  mockFetchEmailLight.mockResolvedValue(body({ from: { address: ' FRIEND@example.test ' },
    messageDate: '2026-09-02T14:00:00+03:00', date: '2026-09-05T12:00:00Z', provider: 'graph' }));
  expect(await openInsightsMessage(match(copy({ messageDate: '2026-09-02T11:00:00Z' })))).toBe(true);
});

it('restores the ordinary single-folder selection key', async () => {
  const header = { ...inbox, _insightsReadOnly: false };
  mockFetchEmailLight.mockResolvedValue({ ...inbox, html: '<p>ordinary body</p>' });
  await useMailStore.getState().selectEmail(7, 'server', 'INBOX', { accountId: 'a1', mailbox: 'INBOX', uid: 7, header });
  expect(useMailStore.getState().selectedEmailId).toBe(7);
});

it('an ordinary fetch started before entering Insights cannot publish after cancellation', async () => {
  let finish;
  mockFetchEmailLight.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = useMailStore.getState().selectEmail(7);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  cancelInsightsSelection();
  useMailStore.setState({ selectedEmail: null, loadingEmail: false });
  finish({ ...inbox, html: '<p>late ordinary body</p>' });
  await pending;
  expect(useMailStore.getState().selectedEmail).toBeNull();
  expect(useMailStore.getState().loadingEmail).toBe(false);
  expect(useMailStore.getState()._prefetchAdjacentEmails).not.toHaveBeenCalled();
});

it('an earlier ordinary fetch cannot overwrite a later Insights body', async () => {
  let finish;
  mockFetchEmailLight.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(body());
  const pending = useMailStore.getState().selectEmail(7);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await openInsightsMessage(match(copy()));
  finish({ ...inbox, html: '<p>late ordinary body</p>' });
  await pending;
  expect(useMailStore.getState().selectedEmail).toMatchObject({ _accountId: 'a2', html: '<p>right body</p>' });
});

it('caches Graph MIME only after the explicit body passes identity validation', async () => {
  mockIsGraphAccount.mockReturnValue(true);
  mockGraphGetMessage.mockResolvedValue(body());
  await openInsightsMessage(match(copy()));
  expect(mockGraphCacheMime).toHaveBeenCalledWith(undefined, 'graph-message-id', 'a2', 'Archive/2026', 7);
  mockGraphCacheMime.mockClear();
  useMailStore.setState({ emailCache: new Map() });
  mockGraphGetMessage.mockResolvedValue(body({ subject: 'Another subject' }));
  await expect(openInsightsMessage(match(copy()))).rejects.toThrow();
  expect(mockGraphCacheMime).not.toHaveBeenCalled();
});


it('restores current ordinary row flags instead of stale cached body flags', async () => {
  const header = { ...inbox, flags: ['\\Seen'], _insightsReadOnly: false };
  useMailStore.getState().addToCache('a1-INBOX-7', { ...inbox, html: '<p>ordinary body</p>', flags: [] }, 128);
  await useMailStore.getState().selectEmail(7, 'server', 'INBOX', { accountId: 'a1', mailbox: 'INBOX', uid: 7, header });
  expect(useMailStore.getState().selectedEmail.flags).toEqual(['\\Seen']);
});
