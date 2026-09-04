// The per-account "last mailbox" is what the sidebar re-opens when you come
// back to an account. It used to be written only at the tail of the cold
// load path, so a folder click that painted from the restore descriptor
// returned early and never recorded itself — and the account-switch restore
// lookup keyed on the OUTGOING account's folder instead of the requested one.
// Switching accounts quickly then brought an account back on a folder the
// user had already left.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

vi.mock('../../db', () => ({
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  getArchivedEmails: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../api', () => ({
  fetchEmails: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  checkMailboxStatus: vi.fn().mockResolvedValue(null),
  fetchMailboxes: vi.fn().mockResolvedValue([]),
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
const setLastMailbox = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setLastMailbox,
      setUnreadForAccount: vi.fn(),
      getLastMailbox: () => 'INBOX',
    }),
  },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }) }));
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn().mockResolvedValue(false),
  markVerified: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn().mockResolvedValue({ started: false }),
  waitForSync: vi.fn().mockResolvedValue(null),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { forget: forgetMemo } = await import('../../headerMemo');

const A = { id: 'acct-a', email: 'a@mock.test', password: 'pw' };
const B = { id: 'acct-b', email: 'b@mock.test', password: 'pw' };
const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });
const MAILBOXES = [{ path: 'INBOX', name: 'INBOX', children: [] }, { path: 'Archive', name: 'Archive', children: [] }];

function primeOn(account, mailbox) {
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: account.id,
    activeMailbox: mailbox,
    viewMode: 'all',
    emails: [mkHeader(1)],
    sortedEmails: [mkHeader(1)],
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([1]), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    mailboxes: MAILBOXES,
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

const descriptorFor = (account, mailbox) => ({
  accountId: account.id,
  mailbox,
  viewMode: 'all',
  totalEmails: 1,
  topVisibleIndex: 0,
  selectedUid: null,
  mailboxes: MAILBOXES,
  mailboxesFetchedAt: Date.now(),
  firstWindow: [mkHeader(7)],
  firstWindowSavedUids: [],
  firstWindowArchivedUids: [],
  serverUids: serverUids(new Set([7]), { complete: true }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRestoreDescriptor.mockReturnValue(null);
  forgetMemo(A.id);
  forgetMemo(B.id);
});

describe('activateAccount remembers the folder the user chose', () => {
  it('records a folder click that paints from the restore descriptor', async () => {
    primeOn(A, 'Archive');
    mockGetRestoreDescriptor.mockImplementation((id, mailbox) =>
      id === A.id && mailbox === 'INBOX' ? descriptorFor(A, 'INBOX') : null);

    await useMailStore.getState().activateAccount(A.id, 'INBOX');

    expect(useMailStore.getState().activeMailbox).toBe('INBOX');
    expect(setLastMailbox).toHaveBeenCalledWith(A.id, 'INBOX');
  });

  it('looks the incoming account up by the folder it was asked for, not the outgoing one', async () => {
    primeOn(A, 'Archive');

    await useMailStore.getState().activateAccount(B.id, 'INBOX');

    expect(mockGetRestoreDescriptor).toHaveBeenCalledWith(B.id, 'INBOX', 'all');
    expect(mockGetRestoreDescriptor).not.toHaveBeenCalledWith(B.id, 'Archive', 'all');
    expect(useMailStore.getState().activeMailbox).toBe('INBOX');
  });

  it('does not record anything for a background refresh', async () => {
    primeOn(A, 'INBOX');

    await useMailStore.getState().activateAccount(A.id, 'INBOX', { _backgroundRefresh: true });

    expect(setLastMailbox).not.toHaveBeenCalled();
  });
});
